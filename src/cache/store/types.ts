import type { StalenessState } from "../../index/types.js";

export interface DbPaths {
  workingPath: string;
  summaryPath: string;
  singleMode: boolean;
}

export interface StoreOptions {
  overrideDb?: string;
  promptVersion?: string;
}

export interface SummaryState {
  state: StalenessState;
  reason?: "self_changed" | "deps_changed" | "unknown";
  summary: Record<string, unknown> | null;
  previousSummary: Record<string, unknown> | null;
  depsChanged: boolean;
}

export interface SummaryUpsertEntry {
  symbolId: string;
  summary: unknown;
  expectedContentHash?: string;
  expectedSelfHash?: string;
  expectedDepHash?: string;
  modelId?: string;
}

export interface SummaryUpsertResult {
  symbol_id: string;
  status:
    | "updated"
    | "not_found"
    | "not_eligible"
    | "validation_error"
    | "hash_mismatch";
  error?: string;
}

export interface SummaryCoverage {
  eligible: number;
  synced: number;
  soft_stale: number;
  hard_stale: number;
  missing: number;
  not_eligible: number;
  percent: number;
  by_kind: Record<
    string,
    { eligible: number; synced: number; stale: number; missing: number }
  >;
  by_module: Record<
    string,
    { eligible: number; synced: number; stale: number; missing: number }
  >;
}

export interface DbRemovalPlan {
  paths: string[];
  existing: Array<{ path: string; bytes: number }>;
  totalBytes: number;
}

export interface PruneResult {
  scanned: number;
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  roots: Array<{ path: string; canonicalRoot: string | null }>;
}
