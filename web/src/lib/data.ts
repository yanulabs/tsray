import type { Report, ReportModule } from "../types/report";

const DATA_SCRIPT_ID = "tsray-data";

export interface ReportSource {
  report: Report;
  live: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReport(value: unknown): Report | null {
  if (!isRecord(value)) return null;
  if (typeof value.repo !== "string" || typeof value.project !== "string") return null;
  if (typeof value.generated_at !== "string") return null;
  if (!isRecord(value.metrics) || !isRecord(value.coverage) || !isRecord(value.graphs)) return null;
  if (
    !Array.isArray(value.modules) ||
    !Array.isArray(value.symbols) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.hotspots) ||
    !Array.isArray(value.dead_code) ||
    !Array.isArray(value.interfaces) ||
    !Array.isArray(value.module_cycles)
  ) {
    return null;
  }
  const graphs = value.graphs;
  if (!isRecord(graphs.modules) || !Array.isArray(graphs.modules.nodes) || !Array.isArray(graphs.modules.edges)) {
    return null;
  }
  return value as unknown as Report;
}

export function readEmbeddedReport(): ReportSource | null {
  const element = document.getElementById(DATA_SCRIPT_ID);
  if (!(element instanceof HTMLScriptElement)) return null;
  const raw = (element.textContent ?? "").trim();
  if (!raw || raw === "__TSRAY_REPORT_DATA__") return null;
  try {
    const report = parseReport(JSON.parse(raw) as unknown);
    if (!report) return null;
    return { report, live: element.dataset.tsrayLive === "true" };
  } catch {
    return null;
  }
}

export async function fetchLiveReport(signal?: AbortSignal): Promise<Report> {
  const response = await fetch("/api/report", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`report endpoint returned HTTP ${response.status}`);
  const report = parseReport((await response.json()) as unknown);
  if (!report) throw new Error("report endpoint returned an invalid payload");
  return report;
}

export interface SymbolDetail {
  symbol: {
    id: string;
    name: string;
    kind: string;
    module: string;
    file: string;
    line: number;
    end_line: number;
    loc: number;
    complexity: number;
    signature: string;
    doc: string;
    props_type: string | null;
    directive: string | null;
    hashes: { sig: string; self: string; dep: string; content: string };
  };
  source: string;
  references: Array<{
    from_id: string;
    from_name: string | null;
    kind: string;
    file: string;
    line: number;
    is_test: boolean;
  }>;
  component_tree: {
    nodes: Array<{ id: string; name: string; kind: string; module: string; file: string; line: number }>;
    edges: Array<{ from: string; to: string; kind: string; file: string; line: number }>;
    contexts: Array<{ id: string; name: string; kind: string }>;
    hooks: Array<{ id: string; name: string; kind: string }>;
  };
  impact: {
    risk: string;
    transitiveCount: number;
    impactedComponents: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
    impactedHooks: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
    impactedCallers: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
    impactedTestFiles: string[];
    suggestedCommands: string[];
  };
}

export async function fetchSymbolDetail(id: string, signal?: AbortSignal): Promise<SymbolDetail> {
  const response = await fetch(`/api/symbol?id=${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`symbol endpoint returned HTTP ${response.status}`);
  return (await response.json()) as SymbolDetail;
}

export function moduleById(report: Report, id: string): ReportModule | null {
  return report.modules.find((module) => module.id === id) ?? null;
}
