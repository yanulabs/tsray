import type { ProjectIndexMetrics } from "../../index/types.js";

export interface DiffResult {
  base_ref: string;
  head_ref: string;
  root: string;
  gates: string[];
  failed_gates: string[];
  new_cycles: string[][];
  resolved_cycles: string[][];
  breaking_api: Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    line: number;
    reason: "removed" | "signature_changed";
  }>;
  added_exports: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  new_dead_code: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  resolved_dead_code: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  new_untested_hotspots: Array<{
    id: string;
    name: string;
    complexity: number;
    file: string;
    line: number;
    risk_score: number;
  }>;
  metrics: {
    base: Record<string, number>;
    head: Record<string, number>;
  };
  head_prod_errors: number;
  base_prod_errors: number;
  base: ProjectSummary;
  head: ProjectSummary;
  /** Non-enumerable timing/cache telemetry for programmatic benchmarks. */
  readonly indexMetrics?: { base: ProjectIndexMetrics; head: ProjectIndexMetrics };
}

export interface ProjectSummary {
  projects: number;
  projects_empty: number;
  files: number;
  symbols: number;
  edges: number;
  graph_digest: string | null;
}
