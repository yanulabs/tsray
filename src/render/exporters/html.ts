import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { DualCacheStore } from "../../cache/store.js";
import type { IndexSnapshot } from "../../index/types.js";
import { REPORT_TEMPLATE_GZIP_BASE64 } from "../report-template.generated.js";
import { buildReportPayload } from "./payload.js";

let cachedTemplate: string | null = null;

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
