import type { DiffResult } from "./types.js";

export function diffMarkdown(result: DiffResult): string {
  const lines = [
    `# Architectural Diff: ${result.base_ref} -> ${result.head_ref.slice(0, 12)}`,
    "",
    `- Gates: ${result.gates.length > 0 ? result.gates.join(", ") : "none"}`,
    `- Failed gates: ${result.failed_gates.length > 0 ? result.failed_gates.join(", ") : "none"}`,
    `- Production TS errors: ${result.base_prod_errors} -> ${result.head_prod_errors}`,
    "",
    "## Metrics",
    "",
    "| Metric | Base | Head |",
    "| --- | ---: | ---: |",
    ...Object.keys(result.metrics.head).map(
      (key) => `| ${key} | ${result.metrics.base[key] ?? 0} | ${result.metrics.head[key] ?? 0} |`
    ),
    "",
    `## New Cycles (${result.new_cycles.length})`,
    ...result.new_cycles.map((cycle) => `- ${cycle.join(" -> ")} -> ${cycle[0]}`),
    "",
    `## Resolved Cycles (${result.resolved_cycles.length})`,
    ...result.resolved_cycles.map((cycle) => `- ${cycle.join(" -> ")} -> ${cycle[0]}`),
    "",
    `## Breaking API Changes (${result.breaking_api.length})`,
    ...result.breaking_api.map(
      (item) => `- **${item.reason}** \`${item.name}\` (${item.kind}) at \`${item.file}:${item.line}\``
    ),
    "",
    `## Added Exports (${result.added_exports.length})`,
    ...result.added_exports.map((item) => `- \`${item.name}\` (${item.kind}) at \`${item.file}:${item.line}\``),
    "",
    `## New Dead Code (${result.new_dead_code.length})`,
    ...result.new_dead_code.map((item) => `- \`${item.name}\` at \`${item.file}:${item.line}\``),
    "",
    `## New Untested Hotspots (${result.new_untested_hotspots.length})`,
    ...result.new_untested_hotspots.map(
      (item) =>
        `- \`${item.name}\` complexity ${item.complexity}, risk ${item.risk_score} at \`${item.file}:${item.line}\``
    ),
  ];
  if (
    result.new_cycles.length === 0 &&
    result.new_dead_code.length === 0 &&
    result.breaking_api.length === 0 &&
    result.new_untested_hotspots.length === 0
  ) {
    lines.push("", "No new architectural regressions detected.");
  }
  return `${lines.join("\n")}\n`;
}
