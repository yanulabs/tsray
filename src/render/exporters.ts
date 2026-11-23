import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { DualCacheStore } from "../cache/store.js";
import type { IndexSnapshot, StalenessState } from "../index/types.js";
import {
  findImplementations,
  getCallGraph,
  getDeadCode,
  getDependencyGraph,
  getFanCounts,
  getHotspots,
  getModuleEdges,
  getModuleSummaries,
} from "../index/queries.js";
import { REPORT_TEMPLATE_GZIP_BASE64 } from "./report-template.generated.js";
import type {
  ReportCoverage,
  ReportDeadSymbol,
  ReportEdge,
  ReportGraph,
  ReportGraphEdge,
  ReportGraphNode,
  ReportInterface,
  ReportModule,
  ReportPayload,
  ReportSummary,
  ReportSymbol,
  ReportSyncState,
} from "./types.js";

let cachedTemplate: string | null = null;

export function buildReportPayload(snapshot: IndexSnapshot, store: DualCacheStore): ReportPayload {
  const moduleSummaries = getModuleSummaries(snapshot);
  const moduleEdges = getModuleEdges(snapshot);
  const cycleMembers = new Set(snapshot.moduleCycles.flat());
  const deadSymbols = getDeadCode(snapshot, false);
  const deadIds = new Set(deadSymbols.map((symbol) => symbol.id));
  const coverage = store.getCoverage(snapshot);

  const symbolStates = new Map<string, { state: StalenessState; summary: ReportSummary | null }>();
  const moduleStateBuckets = new Map<
    string,
    { eligible: number; synced: number; soft: number; hard: number; missing: number }
  >();
  for (const symbol of snapshot.symbols.values()) {
    const resolved = store.resolveSummary(symbol, false);
    symbolStates.set(symbol.id, {
      state: resolved.state,
      summary: (resolved.summary as ReportSummary | null) ?? null,
    });
    if (!symbol.eligible) continue;
    const bucket = moduleStateBuckets.get(symbol.module) ?? {
      eligible: 0,
      synced: 0,
      soft: 0,
      hard: 0,
      missing: 0,
    };
    bucket.eligible++;
    if (resolved.state === "synced") bucket.synced++;
    else if (resolved.state === "soft_stale") bucket.soft++;
    else if (resolved.state === "hard_stale") bucket.hard++;
    else if (resolved.state === "missing") bucket.missing++;
    moduleStateBuckets.set(symbol.module, bucket);
  }

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const symbolEdges: ReportEdge[] = [];
  for (const edge of snapshot.edges) {
    if (!snapshot.symbols.has(edge.fromId) || !snapshot.symbols.has(edge.toId)) continue;
    if (edge.kind === "imports" || edge.kind === "re_exports") continue;
    symbolEdges.push({
      from: edge.fromId,
      to: edge.toId,
      kind: edge.kind,
      file: edge.file,
      line: edge.line,
    });
    if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, []);
    outgoing.get(edge.fromId)!.push(edge.toId);
    if (!incoming.has(edge.toId)) incoming.set(edge.toId, []);
    incoming.get(edge.toId)!.push(edge.fromId);
  }

  const symbols: ReportSymbol[] = [...snapshot.symbols.values()]
    .map((symbol) => {
      const resolved = symbolStates.get(symbol.id);
      const fan = getFanCounts(snapshot, symbol.id);
      return {
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        module: symbol.module,
        file: symbol.file,
        line: symbol.line,
        end_line: symbol.endLine,
        loc: symbol.loc,
        members: symbol.members,
        parent_id: symbol.parentId,
        complexity: symbol.complexity,
        fan_in: fan.fanIn,
        fan_out: fan.fanOut,
        exported: symbol.exported,
        default_export: symbol.defaultExport,
        entrypoint: symbol.isEntrypoint,
        eligible: symbol.eligible,
        is_test: symbol.isTest,
        is_generated: symbol.isGenerated,
        dead: deadIds.has(symbol.id),
        directive: symbol.directive,
        props_type: symbol.propsType,
        signature: symbol.signature,
        doc: symbol.doc,
        sig_hash: symbol.sigHash,
        self_hash: symbol.selfHash,
        dep_hash: symbol.depHash,
        content_hash: symbol.contentHash,
        sync_state: resolved?.state ?? "not_eligible",
        summary: resolved?.summary ?? null,
        callers: [...new Set(incoming.get(symbol.id) ?? [])].sort().slice(0, 100),
        callees: [...new Set(outgoing.get(symbol.id) ?? [])].sort().slice(0, 100),
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.line - b.line);

  const modules: ReportModule[] = moduleSummaries.map((module) => {
    const bucket = moduleStateBuckets.get(module.name);
    return {
      id: module.name,
      name: module.name,
      files: module.files,
      symbols: module.symbols,
      components: module.components,
      hooks: module.hooks,
      exported: module.exported,
      prod_loc: module.prodLoc,
      test_loc: module.testLoc,
      fan_in: module.fanIn,
      fan_out: module.fanOut,
      entrypoints: module.entrypoints,
      generated_files: module.generatedFiles,
      test_reachable: module.testReachable,
      cycle: cycleMembers.has(module.name),
      in_modules: module.inModules,
      out_modules: module.outModules,
      sync_state: moduleState(bucket),
      synced_percent: bucket && bucket.eligible > 0 ? Number(((bucket.synced / bucket.eligible) * 100).toFixed(1)) : 0,
    };
  });

  const allGraphEdges: ReportGraphEdge[] = moduleEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    weight: Math.max(1, edge.imports + edge.symbols),
    imports: edge.imports,
    symbols: edge.symbols,
  }));

  const graphNodes: ReportGraphNode[] = modules.map((module) => ({
    id: module.id,
    label: module.name,
    module: module.name,
    loc: module.prod_loc,
    fan_in: module.fan_in,
    fan_out: module.fan_out,
    symbols: module.symbols,
    components: module.components,
    hooks: module.hooks,
    cycle: module.cycle,
    sync_state: module.sync_state,
    synced_percent: module.synced_percent,
  }));

  const graphs: { modules: ReportGraph } = {
    modules: { nodes: graphNodes, edges: allGraphEdges },
  };

  const interfaces: ReportInterface[] = findImplementations(snapshot).map((entry) => ({
    id: entry.interface.id,
    name: entry.interface.name,
    module: entry.interface.module,
    file: entry.interface.file,
    line: entry.interface.line,
    members: entry.interface.members,
    implementations: entry.implementations.map((implementation) => ({
      id: implementation.id,
      name: implementation.name,
      kind: implementation.kind,
      module: implementation.module,
      file: implementation.file,
      line: implementation.line,
      via: implementation.via,
    })),
  }));

  const deadCode: ReportDeadSymbol[] = deadSymbols.map((symbol) => ({
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    loc: symbol.loc,
    complexity: symbol.complexity,
    exported: symbol.exported,
  }));

  const coveragePayload: ReportCoverage = {
    eligible: coverage.eligible,
    synced: coverage.synced,
    soft_stale: coverage.soft_stale,
    hard_stale: coverage.hard_stale,
    missing: coverage.missing,
    not_eligible: coverage.not_eligible,
    percent: coverage.percent,
  };

  return {
    repo: snapshot.root,
    project: snapshot.projectId,
    generated_at: snapshot.indexedAt,
    duration_ms: snapshot.durationMs,
    typescript_version: snapshot.typescriptVersion,
    metrics: {
      files: snapshot.filesCount,
      symbols: snapshot.symbols.size,
      components: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "component" && !symbol.isTest).length,
      hooks: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "hook" && !symbol.isTest).length,
      contexts: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "context" && !symbol.isTest).length,
      edges: snapshot.edges.length,
      modules: snapshot.modules.length,
      cycles: snapshot.moduleCycles.length,
      dead: deadCode.length,
      prod_errors: snapshot.prodErrors.length,
      warnings: snapshot.warnings.length,
      loc: moduleSummaries.reduce((total, module) => total + module.prodLoc, 0),
    },
    coverage: coveragePayload,
    modules,
    symbols,
    edges: symbolEdges,
    hotspots: getHotspots(snapshot, 50),
    dead_code: deadCode,
    interfaces,
    graphs,
    module_cycles: snapshot.moduleCycles,
    prod_errors: snapshot.prodErrors.map((error) => ({
      file: error.file,
      line: error.line,
      code: error.code,
      message: error.message,
    })),
    warnings: snapshot.warnings.map((warning) => ({
      file: warning.file,
      line: warning.line,
      code: warning.code,
      message: warning.message,
    })),
  };
}

function moduleState(
  bucket: { eligible: number; synced: number; soft: number; hard: number; missing: number } | undefined
): ReportSyncState {
  if (!bucket || bucket.eligible === 0) return "not_eligible";
  if (bucket.hard > 0) return "hard_stale";
  if (bucket.soft > 0) return "soft_stale";
  if (bucket.synced === bucket.eligible) return "synced";
  if (bucket.synced > 0) return "soft_stale";
  return "missing";
}

export function exportMarkdown(snapshot: IndexSnapshot, store: DualCacheStore): string {
  const payload = buildReportPayload(snapshot, store);
  const topHotspots = payload.hotspots.slice(0, 15);
  const lines: string[] = [
    `# Architecture Report: ${payload.project}`,
    "",
    `> Generated ${payload.generated_at} with TypeScript ${payload.typescript_version}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Files | ${payload.metrics.files} |`,
    `| Symbols | ${payload.metrics.symbols} |`,
    `| Components | ${payload.metrics.components} |`,
    `| Hooks | ${payload.metrics.hooks} |`,
    `| Contexts | ${payload.metrics.contexts} |`,
    `| Modules | ${payload.metrics.modules} |`,
    `| Edges | ${payload.metrics.edges} |`,
    `| Module cycles | ${payload.metrics.cycles} |`,
    `| Dead symbols | ${payload.metrics.dead} |`,
    `| Production TS errors | ${payload.metrics.prod_errors} |`,
    `| Summary coverage | ${payload.coverage.percent}% (${payload.coverage.synced}/${payload.coverage.eligible}) |`,
    "",
    "## Modules",
    "",
    "| Module | Files | Symbols | Components | Hooks | Prod LOC | Fan-in | Fan-out | Cycle | Summaries |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |",
    ...payload.modules.map(
      (module) =>
        `| \`${module.name}\` | ${module.files} | ${module.symbols} | ${module.components} | ${module.hooks} | ${module.prod_loc} | ${module.fan_in} | ${module.fan_out} | ${module.cycle ? "YES" : "no"} | ${module.synced_percent}% |`
    ),
  ];

  if (payload.module_cycles.length > 0) {
    lines.push("", "## Module Cycles", "");
    for (const cycle of payload.module_cycles) {
      lines.push(`- ${cycle.map((module) => `\`${module}\``).join(" -> ")} -> \`${cycle[0]}\``);
    }
  }

  lines.push(
    "",
    "## Top Hotspots",
    "",
    "| Symbol | Kind | File | LOC | Complexity | Fan-in | Tested | Risk |",
    "| --- | --- | --- | ---: | ---: | ---: | --- | ---: |",
    ...topHotspots.map(
      (hotspot) =>
        `| \`${hotspot.name}\` | ${hotspot.kind} | \`${hotspot.file}:${hotspot.line}\` | ${hotspot.loc} | ${hotspot.complexity} | ${hotspot.fanIn} | ${hotspot.testReachable ? "yes" : "NO"} | ${hotspot.riskScore} |`
    )
  );

  if (payload.dead_code.length > 0) {
    lines.push(
      "",
      "## Dead Code",
      "",
      "| Symbol | Kind | File | LOC | Complexity |",
      "| --- | --- | --- | ---: | ---: |",
      ...payload.dead_code.slice(0, 100).map(
        (symbol) =>
          `| \`${symbol.name}\` | ${symbol.kind} | \`${symbol.file}:${symbol.line}\` | ${symbol.loc} | ${symbol.complexity} |`
      )
    );
    if (payload.dead_code.length > 100) {
      lines.push("", `_${payload.dead_code.length - 100} more dead symbols omitted._`);
    }
  }

  const interfaces = payload.interfaces.filter((entry) => entry.implementations.length > 0);
  if (interfaces.length > 0) {
    lines.push("", "## Interfaces", "");
    for (const entry of interfaces) {
      lines.push(
        `- \`${entry.name}\` (${entry.file}:${entry.line}, ${entry.members} members): ${entry.implementations
          .map((implementation) => `\`${implementation.name}\``)
          .join(", ")}`
      );
    }
  }

  if (payload.prod_errors.length > 0 || payload.warnings.length > 0) {
    lines.push("", "## Diagnostics", "");
    for (const error of payload.prod_errors) {
      lines.push(`- **error** \`${error.file}:${error.line}\` [TS${error.code}] ${error.message}`);
    }
    for (const warning of payload.warnings) {
      lines.push(`- warning \`${warning.file}:${warning.line}\` [TS${warning.code}] ${warning.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface GraphExportOptions {
  scope?: "module" | "file" | "symbol";
  root?: string;
  depth?: number;
  direction?: "out" | "in" | "both" | "callers" | "callees";
}

export function exportDot(snapshot: IndexSnapshot, options: GraphExportOptions = {}): string {
  const scope = options.scope ?? "module";
  const lines: string[] = [
    "digraph tsray {",
    '  rankdir="LR";',
    '  graph [fontname="ui-sans-serif", bgcolor="transparent"];',
    '  node [shape=box, style="rounded,filled", fontname="ui-sans-serif", fillcolor="#eef2ff", color="#6366f1"];',
    '  edge [color="#94a3b8", fontname="ui-sans-serif"];',
  ];

  if (scope === "symbol") {
    if (!options.root) throw new Error("Symbol graph export requires --root <symbol-id>");
    const graph = getCallGraph(snapshot, options.root, {
      depth: options.depth ?? 2,
      direction: symbolGraphDirection(options.direction),
    });
    for (const node of graph.nodes) {
      const symbol = snapshot.symbols.get(node.id);
      const fill = symbol?.kind === "component" ? "#dbeafe" : symbol?.kind === "hook" ? "#fef3c7" : "#f1f5f9";
      lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(node.name)}\\n${escapeDot(node.kind)}", fillcolor="${fill}"];`);
    }
    for (const edge of graph.edges) {
      lines.push(
        `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.kind)}"];`
      );
    }
    lines.push("}");
    return `${lines.join("\n")}\n`;
  }

  const graph = getDependencyGraph(snapshot, {
    scope: scope === "file" ? "file" : "module",
    root: options.root,
    depth: options.depth ?? 2,
    direction:
      options.direction === "callers" ? "in" : options.direction === "callees" ? "out" : options.direction ?? "both",
  });
  const cycleMembers = new Set(snapshot.moduleCycles.flat());
  for (const node of graph.nodes) {
    const cycle = cycleMembers.has(node.id) && scope === "module";
    lines.push(
      `  "${escapeDot(node.id)}" [label="${escapeDot(node.label)}\\n${node.fan_in} in / ${node.fan_out} out", fillcolor="${cycle ? "#fee2e2" : "#eef2ff"}", color="${cycle ? "#ef4444" : "#6366f1"}"];`
    );
  }
  for (const edge of graph.edges) {
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${edge.weight}"];`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function exportMermaid(snapshot: IndexSnapshot, options: GraphExportOptions = {}): string {
  if (options.scope === "symbol") {
    if (!options.root) throw new Error("Symbol graph export requires --root <symbol-id>");
    const graph = getCallGraph(snapshot, options.root, {
      depth: options.depth ?? 2,
      direction: symbolGraphDirection(options.direction),
    });
    const lines = ["flowchart LR"];
    const ids = new Map<string, string>();
    graph.nodes.forEach((node, index) => {
      const id = `n${index}`;
      ids.set(node.id, id);
      lines.push(`  ${id}["${escapeMermaid(node.name)}<br/>${escapeMermaid(node.kind)}"]`);
    });
    for (const edge of graph.edges) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (from && to) lines.push(`  ${from} -->|${escapeMermaid(edge.kind)}| ${to}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const scope = options.scope === "file" ? "file" : "module";
  const graph = getDependencyGraph(snapshot, {
    scope,
    root: options.root,
    depth: options.depth ?? 2,
    direction: options.direction === "callers" ? "in" : options.direction === "callees" ? "out" : "both",
  });
  const lines = ["flowchart LR"];
  const ids = new Map<string, string>();
  graph.nodes.forEach((node, index) => {
    const id = `n${index}`;
    ids.set(node.id, id);
    lines.push(`  ${id}["${escapeMermaid(node.label)}"]`);
  });
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) lines.push(`  ${from} -->|${edge.weight}| ${to}`);
  }
  return `${lines.join("\n")}\n`;
}

export function exportJson(snapshot: IndexSnapshot, store: DualCacheStore): string {
  return `${JSON.stringify(buildReportPayload(snapshot, store), null, 2)}\n`;
}

export interface HtmlExportOptions {
  live?: boolean;
}

export function exportHtml(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  options: HtmlExportOptions = {}
): string {
  const payload = buildReportPayload(snapshot, store);
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const template = loadReportTemplate();
  return injectReport(template, json, options.live ?? false);
}

export function loadReportTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  if (REPORT_TEMPLATE_GZIP_BASE64) {
    try {
      cachedTemplate = gunzipSync(Buffer.from(REPORT_TEMPLATE_GZIP_BASE64, "base64")).toString("utf8");
      return cachedTemplate;
    } catch {
      // Fall through to the on-disk build below.
    }
  }

  const candidates = [
    path.resolve(import.meta.dirname, "../../web/dist/report.html"),
    path.resolve(import.meta.dirname, "../../../web/dist/report.html"),
    path.resolve(process.cwd(), "web/dist/report.html"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    cachedTemplate = fs.readFileSync(candidate, "utf8");
    return cachedTemplate;
  }

  cachedTemplate = FALLBACK_TEMPLATE;
  return cachedTemplate;
}

function injectReport(template: string, json: string, live: boolean): string {
  let output = template;
  if (output.includes("__TSRAY_LIVE__")) {
    output = output.replace(/__TSRAY_LIVE__/g, String(live));
  }

  const marker = 'id="tsray-data"';
  const markerIndex = output.indexOf(marker);
  if (markerIndex >= 0) {
    const contentStart = output.indexOf(">", markerIndex);
    const contentEnd = output.indexOf("</script>", contentStart);
    if (contentStart >= 0 && contentEnd > contentStart) {
      return `${output.slice(0, contentStart + 1)}${json}${output.slice(contentEnd)}`;
    }
  }

  if (output.includes("__TSRAY_REPORT_DATA__")) {
    return output.replace("__TSRAY_REPORT_DATA__", json);
  }

  throw new Error("Report template is missing the tsray-data script tag");
}

function symbolGraphDirection(
  direction: GraphExportOptions["direction"]
): "callers" | "callees" | "both" {
  if (direction === "callers" || direction === "in") return "callers";
  if (direction === "callees" || direction === "out") return "callees";
  return "both";
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeMermaid(value: string): string {
  return value
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/[[\]{}]/g, "");
}

const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tsray · Architecture Report</title>
<style>
  :root { color-scheme: light dark; --bg:#f8fafc; --fg:#0f172a; --muted:#64748b; --card:#ffffff; --line:#e2e8f0; --accent:#4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#09090b; --fg:#f4f4f5; --muted:#a1a1aa; --card:#111113; --line:#27272a; --accent:#818cf8; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:32px 24px 64px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:16px; margin:32px 0 12px; }
  .muted { color:var(--muted); }
  .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:24px 0; }
  .metric { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .metric b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .metric span { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th,td { padding:8px 12px; border-bottom:1px solid var(--line); text-align:left; font-size:13px; }
  th { color:var(--muted); font-weight:600; text-transform:uppercase; font-size:11px; letter-spacing:.05em; }
  tr:last-child td { border-bottom:0; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:1px 8px; font-size:11px; color:var(--muted); }
  .warn { color:#b45309; }
</style>
</head>
<body>
<main>
  <h1 id="title">Architecture Report</h1>
  <p class="muted" id="subtitle"></p>
  <div class="metrics" id="metrics"></div>
  <h2>Modules</h2>
  <div id="modules"></div>
  <h2>Hotspots</h2>
  <div id="hotspots"></div>
  <h2>Dead Code</h2>
  <div id="dead"></div>
</main>
<script id="tsray-data" type="application/json" data-tsray-live="__TSRAY_LIVE__">__TSRAY_REPORT_DATA__</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("tsray-data").textContent);
  document.getElementById("title").textContent = data.project + " · Architecture Report";
  document.getElementById("subtitle").textContent = data.repo + " · " + data.metrics.files + " files · generated " + data.generated_at;
  var metrics = [["Symbols", data.metrics.symbols], ["Components", data.metrics.components], ["Hooks", data.metrics.hooks], ["Modules", data.metrics.modules], ["Edges", data.metrics.edges], ["Cycles", data.metrics.cycles], ["Dead", data.metrics.dead], ["Summary coverage", data.coverage.percent + "%"]];
  document.getElementById("metrics").innerHTML = metrics.map(function (item) { return '<div class="metric"><b>' + item[1] + '</b><span>' + item[0] + '</span></div>'; }).join("");
  function table(headers, rows) {
    return "<table><thead><tr>" + headers.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead><tbody>" + rows.map(function (row) { return "<tr>" + row.map(function (cell) { return "<td>" + cell + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>";
  }
  document.getElementById("modules").innerHTML = table(["Module", "Files", "Symbols", "Prod LOC", "Fan-in", "Fan-out", "Cycle"], data.modules.map(function (m) { return ["<code>" + m.name + "</code>", m.files, m.symbols, m.prod_loc, m.fan_in, m.fan_out, m.cycle ? '<span class="warn">YES</span>' : "no"]; }));
  document.getElementById("hotspots").innerHTML = table(["Symbol", "Kind", "File", "Complexity", "Fan-in", "Tested", "Risk"], data.hotspots.slice(0, 25).map(function (h) { return ["<code>" + h.name + "</code>", '<span class="pill">' + h.kind + "</span>", "<code>" + h.file + ":" + h.line + "</code>", h.complexity, h.fanIn, h.testReachable ? "yes" : "NO", h.riskScore]; }));
  document.getElementById("dead").innerHTML = data.dead_code.length ? table(["Symbol", "Kind", "File"], data.dead_code.slice(0, 100).map(function (s) { return ["<code>" + s.name + "</code>", s.kind, "<code>" + s.file + ":" + s.line + "</code>"]; })) : '<p class="muted">No dead symbols detected.</p>';
})();
</script>
</body>
</html>`;
