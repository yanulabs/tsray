import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { DualCacheStore } from "../cache/store.js";
import type { IndexController } from "../index/watch.js";
import type { IndexSnapshot } from "../index/types.js";
import {
  getComponentTree,
  getFunctionBody,
  getImpactAnalysis,
  getReferences,
} from "../index/queries.js";
import { buildReportPayload, exportHtml } from "../render/exporters.js";
import { registerMcpTools } from "../tools/tools.js";
import { VERSION } from "../version.js";

export interface ServeOptions {
  host: string;
  port: number;
  portRange: number;
  strictPort: boolean;
  watch: boolean;
  open: boolean;
  portFile?: string;
  logLevel: "off" | "error" | "info";
}

async function listenWithFallback(
  server: http.Server,
  host: string,
  startPort: number,
  range: number,
  strictPort: boolean,
  onBusy: (port: number) => void
): Promise<{ port: number; tried: number[] }> {
  if (startPort === 0) {
    await listenOnce(server, host, 0);
    return { port: (server.address() as { port: number }).port, tried: [0] };
  }

  const maxPort = strictPort ? startPort : startPort + Math.max(0, range);
  const tried: number[] = [];
  for (let port = startPort; port <= maxPort; port++) {
    tried.push(port);
    try {
      await listenOnce(server, host, port);
      return { port: (server.address() as { port: number }).port, tried };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || port === maxPort) {
        if (code === "EADDRINUSE") {
          throw new Error(`No free port in range ${startPort}-${maxPort}`, { cause: error });
        }
        throw error;
      }
      onBusy(port);
    }
  }
  throw new Error(`No free port in range ${startPort}-${maxPort}`);
}

function listenOnce(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function writePortFile(portFile: string, url: string): void {
  fs.mkdirSync(path.dirname(path.resolve(portFile)), { recursive: true });
  fs.writeFileSync(path.resolve(portFile), `${JSON.stringify({ url, pid: process.pid })}\n`, "utf8");
}

export function openUrl(url: string, log: (message: string) => void): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", (error) => log(`could not open browser: ${String(error)}`));
    child.unref();
  } catch (error) {
    log(`could not open browser: ${String(error)}`);
  }
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export async function startServe(
  controller: IndexController,
  store: DualCacheStore,
  options: ServeOptions
): Promise<void> {
  const logError = (message: string): void => {
    if (options.logLevel !== "off") process.stderr.write(`${message}\n`);
  };
  const logInfo = (message: string): void => {
    if (options.logLevel === "info") process.stderr.write(`${message}\n`);
  };

  // Start indexing immediately; the report endpoint waits for the first
  // healthy snapshot while MCP clients can query project_info meanwhile.
  void controller.rebuild({ fullDiagnostics: true }).catch((error) => {
    logError(`[tsray] initial index error: ${String(error)}`);
  });
  if (options.watch) controller.startWatch();

  if (!isLoopback(options.host)) {
    logError(
      `[tsray] warning: binding report server to ${options.host} exposes it beyond this machine`
    );
  }

  const httpServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/report") {
        const snapshot = await controller.getSnapshot();
        const payload = buildReportPayload(snapshot, store);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(payload));
        return;
      }

      if (url.pathname === "/api/symbol") {
        const id = url.searchParams.get("id");
        const snapshot = await controller.getSnapshot();
        if (!id) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: "id_required" }));
          return;
        }
        const payload = symbolPayload(snapshot, id);
        response.writeHead("error" in payload ? 404 : 200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(payload));
        return;
      }

      if (url.pathname === "/api/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, version: VERSION, index: controller.status() }));
        return;
      }

      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/" || url.pathname === "/report.html" || url.pathname === "/index.html") {
        const snapshot = await controller.getSnapshot();
        const html = exportHtml(snapshot, store, { live: true });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });

  const { port } = await listenWithFallback(
    httpServer,
    options.host,
    options.port,
    options.portRange,
    options.strictPort,
    (busyPort) => logInfo(`Port ${busyPort} is in use, trying another one...`)
  );
  const urlHost = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${urlHost}:${port}/`;
  if (options.portFile) writePortFile(options.portFile, url);

  if (options.logLevel !== "off") {
    process.stderr.write(
      `\n  tsray dev\n\n  -> Local:   ${url}\n  -> MCP:     stdio\n  -> Report:  ${url}api/report\n\n  TSRAY_REPORT_URL=${url}\n\n`
    );
  }
  if (options.open) openUrl(url, logError);

  const mcp = new McpServer({ name: "tsray", version: VERSION });
  registerMcpTools(mcp, controller, store);
  const transport = new StdioServerTransport();
  try {
    await mcp.connect(transport);
  } catch (error) {
    httpServer.closeAllConnections();
    httpServer.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(exitCode), 4000).unref();
    try {
      await controller.stop();
      await mcp.close();
    } catch {
      // Best-effort shutdown.
    }
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    try {
      store.close();
    } catch {
      // Already closed.
    }
    if (options.portFile) {
      try {
        fs.rmSync(path.resolve(options.portFile), { force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("uncaughtException", (error) => {
    logError(`[tsray] uncaught exception: ${error.stack ?? String(error)}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError(`[tsray] unhandled rejection: ${String(reason)}`);
  });
}

function symbolPayload(snapshot: IndexSnapshot, id: string): Record<string, unknown> {
  const symbol = snapshot.symbols.get(id);
  if (!symbol) return { error: "symbol_not_found", id };
  const body = getFunctionBody(snapshot, id);
  return {
    symbol: {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      module: symbol.module,
      file: symbol.file,
      line: symbol.line,
      end_line: symbol.endLine,
      loc: symbol.loc,
      complexity: symbol.complexity,
      signature: symbol.signature,
      doc: symbol.doc,
      props_type: symbol.propsType,
      directive: symbol.directive,
      hashes: {
        sig: symbol.sigHash,
        self: symbol.selfHash,
        dep: symbol.depHash,
        content: symbol.contentHash,
      },
    },
    source: body?.source ?? symbol.sourcePreview,
    references: getReferences(snapshot, id, { limit: 100 }),
    component_tree: getComponentTree(snapshot, id, { depth: 2 }),
    impact: getImpactAnalysis(snapshot, id, 3),
  };
}
