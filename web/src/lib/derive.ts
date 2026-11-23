import type {
  Hotspot,
  Report,
  ReportEdge,
  ReportModule,
  ReportSymbol,
  SyncState,
} from "../types/report";

export interface ReportIndex {
  symbolById: Map<string, ReportSymbol>;
  moduleByName: Map<string, ReportModule>;
  symbolsByModule: Map<string, ReportSymbol[]>;
  edgesByFrom: Map<string, ReportEdge[]>;
  edgesByTo: Map<string, ReportEdge[]>;
  cycleMembers: Set<string>;
  deadIds: Set<string>;
  hotspotById: Map<string, Hotspot>;
}

const cache = new WeakMap<Report, ReportIndex>();

export function indexReport(report: Report): ReportIndex {
  const cached = cache.get(report);
  if (cached) return cached;

  const symbolById = new Map<string, ReportSymbol>();
  const moduleByName = new Map<string, ReportModule>();
  const symbolsByModule = new Map<string, ReportSymbol[]>();
  const edgesByFrom = new Map<string, ReportEdge[]>();
  const edgesByTo = new Map<string, ReportEdge[]>();
  const hotspotById = new Map<string, Hotspot>();

  for (const symbol of report.symbols) symbolById.set(symbol.id, symbol);
  for (const module of report.modules) moduleByName.set(module.name, module);
  for (const symbol of report.symbols) {
    const list = symbolsByModule.get(symbol.module) ?? [];
    list.push(symbol);
    symbolsByModule.set(symbol.module, list);
  }
  for (const symbol of symbolsByModule.values()) {
    symbol.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }
  for (const edge of report.edges) {
    if (!symbolById.has(edge.from) || !symbolById.has(edge.to)) continue;
    const outgoing = edgesByFrom.get(edge.from) ?? [];
    outgoing.push(edge);
    edgesByFrom.set(edge.from, outgoing);
    const incoming = edgesByTo.get(edge.to) ?? [];
    incoming.push(edge);
    edgesByTo.set(edge.to, incoming);
  }
  for (const hotspot of report.hotspots) hotspotById.set(hotspot.id, hotspot);

  const index: ReportIndex = {
    symbolById,
    moduleByName,
    symbolsByModule,
    edgesByFrom,
    edgesByTo,
    cycleMembers: new Set(report.module_cycles.flat()),
    deadIds: new Set(report.dead_code.map((symbol) => symbol.id)),
    hotspotById,
  };
  cache.set(report, index);
  return index;
}

export interface MetricCard {
  label: string;
  value: string;
  hint: string;
  tone: "default" | "warn" | "danger" | "good";
}

export function metricCards(report: Report): MetricCard[] {
  const percent = report.coverage.percent;
  return [
    {
      label: "Files",
      value: formatCompact(report.metrics.files),
      hint: `${formatCompact(report.metrics.loc)} prod LOC`,
      tone: "default",
    },
    {
      label: "Symbols",
      value: formatCompact(report.metrics.symbols),
      hint: `${formatCompact(report.metrics.components)} components · ${formatCompact(report.metrics.hooks)} hooks`,
      tone: "default",
    },
    {
      label: "Modules",
      value: formatCompact(report.metrics.modules),
      hint: `${formatCompact(report.metrics.edges)} symbol edges`,
      tone: "default",
    },
    {
      label: "Cycles",
      value: formatCompact(report.metrics.cycles),
      hint: report.metrics.cycles > 0 ? "architecture risk" : "acyclic",
      tone: report.metrics.cycles > 0 ? "danger" : "good",
    },
    {
      label: "Dead code",
      value: formatCompact(report.metrics.dead),
      hint: report.metrics.dead > 0 ? "unreachable symbols" : "none detected",
      tone: report.metrics.dead > 0 ? "warn" : "good",
    },
    {
      label: "Summaries",
      value: `${percent.toFixed(0)}%`,
      hint: `${formatCompact(report.coverage.synced)} synced`,
      tone: percent >= 80 ? "good" : percent > 0 ? "warn" : "default",
    },
    {
      label: "TS errors",
      value: formatCompact(report.metrics.prod_errors),
      hint: `${formatCompact(report.metrics.warnings)} test warnings`,
      tone: report.metrics.prod_errors > 0 ? "danger" : "good",
    },
  ];
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard" }).format(value);
}

export function moduleHealth(module: ReportModule): {
  tone: "good" | "warn" | "danger";
  label: string;
} {
  if (module.cycle) return { tone: "danger", label: "cycle" };
  if (module.sync_state === "hard_stale") return { tone: "warn", label: "stale" };
  if (module.sync_state === "soft_stale") return { tone: "warn", label: "deps stale" };
  if (module.entrypoints > 0 && module.test_reachable === 0) return { tone: "warn", label: "untested" };
  return { tone: "good", label: "healthy" };
}

export function relatedSymbols(
  index: ReportIndex,
  id: string,
  direction: "callers" | "callees" | "both" = "both"
): ReportSymbol[] {
  const ids = new Set<string>();
  if (direction !== "callees") {
    for (const edge of index.edgesByTo.get(id) ?? []) ids.add(edge.from);
  }
  if (direction !== "callers") {
    for (const edge of index.edgesByFrom.get(id) ?? []) ids.add(edge.to);
  }
  return [...ids]
    .map((symbolId) => index.symbolById.get(symbolId))
    .filter((symbol): symbol is ReportSymbol => Boolean(symbol))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function edgesForSymbols(index: ReportIndex, id: string): ReportEdge[] {
  return [...(index.edgesByTo.get(id) ?? []), ...(index.edgesByFrom.get(id) ?? [])];
}

export function syncRank(state: SyncState): number {
  switch (state) {
    case "synced":
      return 0;
    case "soft_stale":
      return 1;
    case "hard_stale":
      return 2;
    case "missing":
      return 3;
    default:
      return 4;
  }
}

export function topModuleSymbols(index: ReportIndex, module: string, limit = 12): ReportSymbol[] {
  return (index.symbolsByModule.get(module) ?? [])
    .filter((symbol) => !symbol.is_test)
    .sort((a, b) => b.fan_in + b.complexity - (a.fan_in + a.complexity) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function isReactEdge(kind: string): boolean {
  return (
    kind === "renders" ||
    kind === "uses_hook" ||
    kind === "provides_context" ||
    kind === "consumes_context" ||
    kind === "wraps"
  );
}

export function edgeTone(kind: string): string {
  switch (kind) {
    case "renders":
      return "#0ea5e9";
    case "uses_hook":
      return "#f59e0b";
    case "provides_context":
    case "consumes_context":
      return "#8b5cf6";
    case "wraps":
      return "#ec4899";
    case "implements":
      return "#10b981";
    default:
      return "#94a3b8";
  }
}
