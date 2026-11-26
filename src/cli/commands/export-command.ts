import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportDot,
  exportHtml,
  exportJson,
  exportMarkdown,
  exportMermaid,
} from "../../render/exporters.js";
import { openUrl } from "../../mcp/server.js";
import {
  boolValue,
  createContext,
  stringValue,
  UsageError,
  type CliValues,
} from "../command-context.js";

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export function handleExport(rest: string[], values: CliValues): void {
  const format = rest[0];
  const target = rest[1] ?? ".";
  if (!format) {
    throw new UsageError(
      "export requires a format: html, md, dot, mermaid, or json"
    );
  }
  const { indexer, store } = createContext(target, values);
  try {
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    let content: string;
    const scope =
      (stringValue(values.scope) as
        | "module"
        | "file"
        | "symbol"
        | undefined) ?? "module";
    const depthValue = Number(stringValue(values.depth) ?? "2");
    const depth = Number.isFinite(depthValue) && depthValue > 0 ? depthValue : 2;
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
      outputPath = path.join(
        os.tmpdir(),
        `tsray-${slug(indexer.projectId)}-report.html`
      );
    }
    if (outputPath) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, content, "utf8");
      if (boolValue(values.open)) {
        openUrl(`file://${outputPath}`, (message) =>
          process.stderr.write(`[tsray] ${message}\n`)
        );
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
}
