import type { ProjectIndexMetrics } from "../../index/types.js";
import type { ProjectSummary } from "./types.js";

export function metricsOf(snapshot: {
  filesCount: number;
  symbols: Map<string, unknown>;
  edges: unknown[];
  moduleCycles: unknown[];
  modules: string[];
  prodErrors: unknown[];
}): Record<string, number> {
  return {
    files: snapshot.filesCount,
    symbols: snapshot.symbols.size,
    edges: snapshot.edges.length,
    modules: snapshot.modules.length,
    cycles: snapshot.moduleCycles.length,
    prod_errors: snapshot.prodErrors.length,
  };
}

export function summaryOf(snapshot: {
  filesCount: number;
  symbols: Map<string, unknown>;
  edges: unknown[];
  projectMetrics?: ProjectIndexMetrics;
  graphDigest?: string;
}): ProjectSummary {
  return {
    projects: snapshot.projectMetrics?.projects_total ?? 0,
    projects_empty: snapshot.projectMetrics?.projects_empty ?? 0,
    files: snapshot.filesCount,
    symbols: snapshot.symbols.size,
    edges: snapshot.edges.length,
    graph_digest: snapshot.graphDigest ?? null,
  };
}
