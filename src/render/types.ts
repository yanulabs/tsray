import type { HotspotRecord, SymbolKind } from "../index/types.js";

export type ReportSyncState = "synced" | "soft_stale" | "hard_stale" | "missing" | "not_eligible";

export interface ReportSummary {
  intent?: string;
  side_effects?: string[];
  invariants?: string[];
  concurrency?: string;
  key_invariants?: string[];
  boundaries?: string[];
}

export interface ReportSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  module: string;
  file: string;
  line: number;
  end_line: number;
  loc: number;
  members: number;
  parent_id: string | null;
  complexity: number;
  fan_in: number;
  fan_out: number;
  exported: boolean;
  default_export: boolean;
  entrypoint: boolean;
  eligible: boolean;
  is_test: boolean;
  is_generated: boolean;
  dead: boolean;
  directive: "use client" | "use server" | null;
  props_type: string | null;
  signature: string;
  doc: string;
  sync_state: ReportSyncState;
  summary: ReportSummary | null;
  callers: string[];
  callees: string[];
}

export interface ReportEdge {
  from: string;
  to: string;
  kind: string;
  file: string;
  line: number;
}

export interface ReportModule {
  id: string;
  name: string;
  files: number;
  symbols: number;
  components: number;
  hooks: number;
  exported: number;
  prod_loc: number;
  test_loc: number;
  fan_in: number;
  fan_out: number;
  entrypoints: number;
  generated_files: number;
  test_reachable: number;
  cycle: boolean;
  in_modules: string[];
  out_modules: string[];
  sync_state: ReportSyncState;
  synced_percent: number;
}

export interface ReportGraphNode {
  id: string;
  label: string;
  module: string;
  loc: number;
  fan_in: number;
  fan_out: number;
  symbols: number;
  components: number;
  hooks: number;
  cycle: boolean;
  sync_state: ReportSyncState;
  synced_percent: number;
}

export interface ReportGraphEdge {
  from: string;
  to: string;
  weight: number;
  imports: number;
  symbols: number;
}

export interface ReportGraph {
  nodes: ReportGraphNode[];
  edges: ReportGraphEdge[];
}

export interface ReportInterfaceImplementation {
  id: string;
  name: string;
  kind: string;
  module: string;
  file: string;
  line: number;
  via: string;
}

export interface ReportInterface {
  id: string;
  name: string;
  module: string;
  file: string;
  line: number;
  members: number;
  implementations: ReportInterfaceImplementation[];
}

export interface ReportDeadSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  module: string;
  file: string;
  line: number;
  loc: number;
  complexity: number;
  exported: boolean;
}

export interface ReportMetrics {
  files: number;
  symbols: number;
  components: number;
  hooks: number;
  contexts: number;
  edges: number;
  modules: number;
  cycles: number;
  dead: number;
  prod_errors: number;
  warnings: number;
  loc: number;
}

export interface ReportCoverage {
  eligible: number;
  synced: number;
  soft_stale: number;
  hard_stale: number;
  missing: number;
  not_eligible: number;
  percent: number;
}

export interface ReportPayload {
  repo: string;
  project: string;
  generated_at: string;
  duration_ms: number;
  typescript_version: string;
  metrics: ReportMetrics;
  coverage: ReportCoverage;
  modules: ReportModule[];
  symbols: ReportSymbol[];
  edges: ReportEdge[];
  hotspots: HotspotRecord[];
  dead_code: ReportDeadSymbol[];
  interfaces: ReportInterface[];
  graphs: {
    modules: ReportGraph;
  };
  module_cycles: string[][];
  prod_errors: Array<{ file: string; line: number; code: number; message: string }>;
  warnings: Array<{ file: string; line: number; code: number; message: string }>;
}
