#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  DualCacheStore,
  planDatabaseRemoval,
  pruneWorktreeDatabases,
  removeDatabases,
  resolveDbPaths,
  type StoreOptions,
} from "../cache/store.js";
import { TsReactIndexer, type IndexerOptions } from "../index/indexer.js";
import { IndexController } from "../index/watch.js";
import { startServe, openUrl } from "../mcp/server.js";
import { exportDot, exportHtml, exportJson, exportMarkdown, exportMermaid } from "../render/exporters.js";
import { resolveProject } from "../util/paths.js";
import { VERSION } from "../version.js";
import { GitDiffError, diffMarkdown, runArchitecturalDiff } from "./diff.js";

const USAGE = `tsray ${VERSION}

Semantic TypeScript/React indexer, MCP stdio server, and offline architecture reporter.

Usage:
  tsray <command> [path] [options]

Commands:
  serve [path]                       Run the MCP stdio server and live report UI
  index [path]                       Build and sync the semantic index once
  export <html|md|dot|mermaid|json> [path]
                                     Export an architecture report
  diff [base-ref] [path]             Compare the working tree against a git ref
  db <path|info|rm|prune> [path]     Inspect or maintain local SQLite databases
  version                            Print the version
  help [command]                     Show help

Common options:
  --db <path>                        Single database override (env: TSRAY_DB)
  --tsconfig <path>                  Explicit tsconfig (relative to the target path)
  --workspace                        Force workspace-root discovery
  -o, --out <path>                   Write export output to a file
  --json                             Emit machine-readable JSON

serve options:
  --port <n>                         Report UI port (default: 4321, env: TSRAY_PORT)
  --port-range <n>                   Port fallback window (default: 100)
  --strict-port                      Fail if the preferred port is busy
  --host <addr>                      Bind address (default: 127.0.0.1)
  --port-file <path>                 Write the chosen URL and PID to a file
  --open                             Open the report in the default browser
  --no-watch                         Disable file watching
  --log-level <off|error|info>       Stderr verbosity (default: info)

export options:
  --scope <module|file|symbol>       Graph scope for dot/mermaid (default: module)
  --root <symbol-id>                 Root symbol for --scope symbol
  --depth <n>                        Graph BFS depth
  --open                             Open the HTML report after writing

diff options:
  --fail-on <gates>                  cycles,breaking_api,dead_code,untested_hotspots
  --format <md|json>                 Output format (default: json)

db options:
  --summaries                        Target the shared summary database
  --all                              Target working and summary databases
  --dry-run                          Print the deletion plan only
  --force                            Delete even when another process holds the DB
`;

interface Context {
  indexer: TsReactIndexer;
  store: DualCacheStore;
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolValue(value: string | boolean | undefined): boolean {
  return value === true;
}

function storeOptions(values: Record<string, string | boolean | undefined>, indexer: TsReactIndexer): StoreOptions {
  return {
    overrideDb: stringValue(values.db) ?? process.env.TSRAY_DB,
    promptVersion: indexer.config.summaries.promptVersion,
  };
}

function createContext(target: string, values: Record<string, string | boolean | undefined>): Context {
  const indexerOptions: IndexerOptions = {
    tsconfig: stringValue(values.tsconfig),
    workspace: boolValue(values.workspace),
  };
  const indexer = new TsReactIndexer(target, indexerOptions);
  const store = new DualCacheStore(indexer.root, indexer.projectId, storeOptions(values, indexer));
  return { indexer, store };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      out: { type: "string", short: "o" },
      port: { type: "string" },
      "port-range": { type: "string" },
      "strict-port": { type: "boolean", default: false },
      host: { type: "string" },
      "no-watch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "" },
      format: { type: "string" },
      open: { type: "boolean", default: false },
      "port-file": { type: "string" },
      tsconfig: { type: "string" },
      workspace: { type: "boolean", default: false },
      "log-level": { type: "string" },
      scope: { type: "string" },
      root: { type: "string" },
      depth: { type: "string" },
      summaries: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (boolValue(values.version) && positionals.length === 0) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (boolValue(values.help) && positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  const [command, ...rest] = positionals;
  if (!command) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === "serve") {
    const target = rest[0] ?? ".";
    const indexerOptions: IndexerOptions = {
      tsconfig: stringValue(values.tsconfig),
      workspace: boolValue(values.workspace),
    };
    const indexer = new TsReactIndexer(target, indexerOptions);
    const store = new DualCacheStore(indexer.root, indexer.projectId, storeOptions(values, indexer));
    const logLevel = (stringValue(values["log-level"]) ?? process.env.TSRAY_LOG_LEVEL ?? "info") as
      | "off"
      | "error"
      | "info";
    if (!["off", "error", "info"].includes(logLevel)) {
      store.close();
      throw new Error(`Invalid --log-level: ${logLevel}`);
    }
    const log = (message: string): void => {
      if (logLevel === "off") return;
      if (logLevel === "error" && !/error|failed|warning/i.test(message)) return;
      process.stderr.write(`${message}\n`);
    };
    const controller = new IndexController(indexer, store, log);
    try {
      await startServe(controller, store, {
        host: stringValue(values.host) ?? process.env.TSRAY_HOST ?? "127.0.0.1",
        port: Number(stringValue(values.port) ?? process.env.TSRAY_PORT ?? "4321"),
        portRange: Number(stringValue(values["port-range"]) ?? process.env.TSRAY_PORT_RANGE ?? "100"),
        strictPort:
          boolValue(values["strict-port"]) || process.env.TSRAY_STRICT_PORT === "true",
        watch: !boolValue(values["no-watch"]),
        open: boolValue(values.open),
        portFile: stringValue(values["port-file"]) ?? process.env.TSRAY_PORT_FILE,
        logLevel,
      });
    } catch (error) {
      store.close();
      throw error;
    }
    return;
  }

  if (command === "index") {
    const target = rest[0] ?? ".";
    const { indexer, store } = createContext(target, values);
    try {
      const snapshot = indexer.buildIndex({ fullDiagnostics: true });
      for (const warning of snapshot.warnings) {
        process.stderr.write(`[tsray] warning ${warning.file}:${warning.line} TS${warning.code} ${warning.message}\n`);
      }
      if (snapshot.prodErrors.length > 0) {
        process.stderr.write(
          `[tsray] ${snapshot.prodErrors.length} production TypeScript error(s); working database not updated\n`
        );
        for (const error of snapshot.prodErrors.slice(0, 50)) {
          process.stderr.write(`[tsray] error ${error.file}:${error.line} TS${error.code} ${error.message}\n`);
        }
        process.exitCode = 1;
        return;
      }

      store.syncWorking(snapshot);
      const coverage = store.getCoverage(snapshot);
      const result = {
        root: snapshot.root,
        project_id: snapshot.projectId,
        tsconfig_path: snapshot.tsconfigPath,
        tsconfig_paths: snapshot.tsconfigPaths,
        workspace: indexer.workspace,
        typescript_version: snapshot.typescriptVersion,
        db_path: store.workingPath,
        summary_db_path: store.summaryPath,
        files: snapshot.filesCount,
        modules: snapshot.modules.length,
        symbols: snapshot.symbols.size,
        eligible: coverage.eligible,
        edges: snapshot.edges.length,
        module_cycles: snapshot.moduleCycles.length,
        warnings: snapshot.warnings.length,
        prod_errors: snapshot.prodErrors.length,
        summary_coverage_percent: coverage.percent,
        duration_ms: snapshot.durationMs,
      };
      if (boolValue(values.json)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          `Indexed ${result.project_id}\n` +
            `  Root:       ${result.root}\n` +
            `  TypeScript: ${result.typescript_version}\n` +
            `  Files:      ${result.files}\n` +
            `  Modules:    ${result.modules}\n` +
            `  Symbols:    ${result.symbols} (${result.eligible} eligible)\n` +
            `  Edges:      ${result.edges}\n` +
            `  Cycles:     ${result.module_cycles}\n` +
            `  Duration:   ${result.duration_ms}ms\n` +
            `  Working DB: ${result.db_path}\n` +
            `  Summary DB: ${result.summary_db_path}\n`
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "export") {
    const format = rest[0];
    const target = rest[1] ?? ".";
    if (!format) throw new UsageError("export requires a format: html, md, dot, mermaid, or json");
    const { indexer, store } = createContext(target, values);
    try {
      const snapshot = indexer.buildIndex({ fullDiagnostics: true });
      let content: string;
      const scope = (stringValue(values.scope) as "module" | "file" | "symbol" | undefined) ?? "module";
      const depth = Number(stringValue(values.depth) ?? "2");
      const root = stringValue(values.root);
      switch (format) {
        case "html":
          content = exportHtml(snapshot, store, { live: false });
          break;
        case "md":
          content = exportMarkdown(snapshot, store);
          break;
        case "dot":
          content = exportDot(snapshot, { scope, root, depth });
          break;
        case "mermaid":
          content = exportMermaid(snapshot, { scope, root, depth });
          break;
        case "json":
          content = exportJson(snapshot, store);
          break;
        default:
          throw new UsageError(`Unsupported export format: ${format}`);
      }

      const out = stringValue(values.out);
      let outputPath: string | null = out ? path.resolve(out) : null;
      if (!out && boolValue(values.open) && format === "html") {
        outputPath = path.join(os.tmpdir(), `tsray-${slug(indexer.projectId)}-report.html`);
      }
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, content, "utf8");
        if (boolValue(values.open)) {
          openUrl(`file://${outputPath}`, (message) => process.stderr.write(`[tsray] ${message}\n`));
        }
        process.stderr.write(`${outputPath}\n`);
      } else {
        process.stdout.write(content);
      }
      if (snapshot.prodErrors.length > 0) {
        process.stderr.write(
          `[tsray] exported with ${snapshot.prodErrors.length} production TypeScript error(s)\n`
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "diff") {
    const baseRef = rest[0] ?? "HEAD";
    const target = rest[1] ?? ".";
    const gates = (stringValue(values["fail-on"]) ?? "")
      .split(",")
      .map((gate) => gate.trim())
      .filter(Boolean);
    try {
      const result = runArchitecturalDiff(target, baseRef, gates, {
        tsconfig: stringValue(values.tsconfig),
        workspace: boolValue(values.workspace),
      });
      const format = stringValue(values.format) ?? "json";
      process.stdout.write(format === "md" ? diffMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.failed_gates.length > 0 ? 1 : 0;
    } catch (error) {
      if (error instanceof GitDiffError) {
        process.stderr.write(`[tsray] git error: ${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      throw error;
    }
    return;
  }

  if (command === "db") {
    const sub = rest[0];
    const target = rest[1] ?? ".";
    const overrideDb = stringValue(values.db) ?? process.env.TSRAY_DB;
    if (sub === "path") {
      const project = resolveProject(target, {
        tsconfig: stringValue(values.tsconfig),
        workspace: boolValue(values.workspace),
      });
      const paths = resolveDbPaths(project.root, project.projectId, overrideDb);
      process.stdout.write(`${boolValue(values.summaries) ? paths.summaryPath : paths.workingPath}\n`);
      return;
    }
    if (sub === "info") {
      const { store } = createContext(target, values);
      try {
        process.stdout.write(`${JSON.stringify(store.getInfo(), null, 2)}\n`);
      } finally {
        store.close();
      }
      return;
    }
    if (sub === "rm") {
      if (overrideDb === ":memory:") {
        throw new UsageError("db rm cannot remove an in-memory database (--db :memory:)");
      }
      const project = resolveProject(target, {
        tsconfig: stringValue(values.tsconfig),
        workspace: boolValue(values.workspace),
      });
      const plan = planDatabaseRemoval(project.root, project.projectId, {
        overrideDb,
        summaries: boolValue(values.summaries),
        all: boolValue(values.all),
      });
      if (boolValue(values["dry-run"])) {
        process.stdout.write(
          `${JSON.stringify(
            {
              dry_run: true,
              files: plan.existing,
              total_bytes: plan.totalBytes,
            },
            null,
            2
          )}\n`
        );
        return;
      }
      const result = removeDatabases(plan, {
        force: boolValue(values.force),
      });
      if (result.removed.length === 0 && result.skipped.length === 0) {
        process.stdout.write("nothing to remove\n");
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
      if (result.skipped.length > 0) process.exitCode = 1;
      return;
    }
    if (sub === "prune") {
      const result = pruneWorktreeDatabases({ dryRun: boolValue(values["dry-run"]) });
      process.stdout.write(`${JSON.stringify({ dry_run: boolValue(values["dry-run"]), ...result }, null, 2)}\n`);
      return;
    }
    throw new UsageError(`Unknown db subcommand: ${sub ?? "(missing)"}`);
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

class UsageError extends Error {}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`[tsray] ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`[tsray] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  if (process.env.TSRAY_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
