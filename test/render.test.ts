import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";
import {
  buildReportPayload,
  exportDot,
  exportHtml,
  exportJson,
  exportMarkdown,
  exportMermaid,
} from "../src/render/exporters.js";
import type { IndexSnapshot } from "../src/index/types.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
let cached:
  | { snapshot: IndexSnapshot; store: DualCacheStore }
  | null = null;

function report(): { snapshot: IndexSnapshot; store: DualCacheStore } {
  if (!cached) {
    const indexer = new TsReactIndexer(fixture);
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    const store = new DualCacheStore(snapshot.root, snapshot.projectId, { overrideDb: ":memory:" });
    store.syncWorking(snapshot);
    cached = { snapshot, store };
  }
  return cached;
}

afterAll(() => {
  cached?.store.close();
});

describe("report exporters", () => {
  it("builds a JSON-safe report payload", () => {
    const { snapshot, store } = report();
    const payload = buildReportPayload(snapshot, store);
    const parsed = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(parsed.project).toBe("fixture-react-app");
    expect(parsed.metrics.symbols).toBe(snapshot.symbols.size);
    expect(parsed.metrics.components).toBe(4);
    expect(parsed.metrics.hooks).toBe(1);
    expect(parsed.modules.map((module) => module.id).sort()).toEqual(["components", "root"]);
    expect(parsed.symbols.find((symbol) => symbol.name === "App")?.entrypoint).toBe(true);
    expect(parsed.graphs.modules.nodes.length).toBe(2);
    expect(parsed.graphs.modules.edges.some((edge) => edge.from === "root" && edge.to === "components")).toBe(true);
    expect(parsed.interfaces.length).toBeGreaterThan(0);
  });

  it("exports markdown, JSON, DOT, and Mermaid", () => {
    const { snapshot, store } = report();
    const markdown = exportMarkdown(snapshot, store);
    expect(markdown).toContain("# Architecture Report: fixture-react-app");
    expect(markdown).toContain("## Modules");
    expect(markdown).toContain("`components`");

    const json = JSON.parse(exportJson(snapshot, store)) as { project: string };
    expect(json.project).toBe("fixture-react-app");

    const dot = exportDot(snapshot, { scope: "module" });
    expect(dot).toContain("digraph tsray");
    expect(dot).toContain('"root" -> "components"');

    const app = [...snapshot.symbols.values()].find((symbol) => symbol.name === "App")!;
    const symbolDot = exportDot(snapshot, { scope: "symbol", root: app.id, depth: 2 });
    expect(symbolDot).toContain("digraph tsray");
    expect(symbolDot).toContain("Button");

    const mermaid = exportMermaid(snapshot, { scope: "module" });
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain("root");
  });

  it("injects the payload into the single-file HTML report", () => {
    const { snapshot, store } = report();
    const html = exportHtml(snapshot, store);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="tsray-data"');
    expect(html).toContain('data-tsray-live="false"');
    expect(html).toContain("fixture-react-app");
    expect(html).not.toContain(">__TSRAY_REPORT_DATA__</script>");
    expect(html).not.toContain("__TSRAY_LIVE__");
    const dataScript = /<script id="tsray-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(dataScript).not.toBeNull();
    const embedded = JSON.parse(dataScript![1]!) as { project: string };
    expect(embedded.project).toBe("fixture-react-app");

    const live = exportHtml(snapshot, store, { live: true });
    expect(live).toContain('data-tsray-live="true"');
  });

  it("keeps script-breaking payload text escaped", () => {
    const { snapshot, store } = report();
    const target = [...snapshot.symbols.values()].find((symbol) => symbol.name === "Button")!;
    target.doc = "closes </script> safely";
    const html = exportHtml(snapshot, store);
    expect(html).toContain("closes \\u003c/script> safely");
  });
});
