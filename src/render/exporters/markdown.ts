import type { DualCacheStore } from "../../cache/store.js";
import type { IndexSnapshot } from "../../index/types.js";
import { buildReportPayload } from "./payload.js";

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
