import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DiagnosticCacheProvider,
  DiagnosticCacheSnapshot,
  DiagnosticCacheWrite,
  IndexSnapshot,
  ProjectCacheEntry,
  ProjectCacheProvider,
  StalenessState,
  SymbolRecord,
} from "../../index/types.js";
import { fileSize, resolveDbPaths } from "./paths.js";
import { configureDb } from "./schema.js";
import { SummaryStore } from "./summary-store.js";
import type {
  StoreOptions,
  SummaryCoverage,
  SummaryState,
  SummaryUpsertEntry,
  SummaryUpsertResult,
} from "./types.js";
import { WorkingStore } from "./working-store.js";

/**
 * Facade over the checkout-local working database and the shared summary
 * database. Each database has a dedicated store so working-graph persistence
 * and summary-cache concerns can evolve independently.
 */
export class DualCacheStore implements DiagnosticCacheProvider, ProjectCacheProvider {
  readonly workingPath: string;
  readonly summaryPath: string;
  readonly promptVersion: string;
  readonly singleMode: boolean;
  private readonly working: WorkingStore;
  private readonly summary: SummaryStore;
  private closed = false;

  constructor(canonicalRoot: string, projectId: string, options: StoreOptions = {}) {
    const paths = resolveDbPaths(canonicalRoot, projectId, options.overrideDb);
    this.workingPath = paths.workingPath;
    this.summaryPath = paths.summaryPath;
    this.singleMode = paths.singleMode;
    this.promptVersion =
      options.promptVersion ?? process.env.TSRAY_PROMPT_VERSION ?? "v1";

    if (this.workingPath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.workingPath), { recursive: true });
    }
    if (!this.singleMode) {
      fs.mkdirSync(path.dirname(this.summaryPath), { recursive: true });
    }

    const workingDb = new DatabaseSync(this.workingPath);
    configureDb(workingDb, this.workingPath);
    const summaryDb = this.singleMode
      ? workingDb
      : new DatabaseSync(this.summaryPath);
    if (!this.singleMode) configureDb(summaryDb, this.summaryPath);

    this.working = new WorkingStore(workingDb);
    this.summary = new SummaryStore(summaryDb, this.promptVersion);
  }

  readProjects(projectPaths: string[]): Map<string, ProjectCacheEntry> {
    return this.working.readProjects(projectPaths);
  }

  writeProjects(entries: ProjectCacheEntry[]): void {
    this.working.writeProjects(entries);
  }

  readDiagnostics(
    projectKey: string,
    epoch: string
  ): DiagnosticCacheSnapshot | null {
    return this.working.readDiagnostics(projectKey, epoch);
  }

  writeDiagnostics(entries: DiagnosticCacheWrite[]): void {
    this.working.writeDiagnostics(entries);
  }

  syncWorking(snapshot: IndexSnapshot): void {
    this.working.syncWorking(snapshot);
  }

  getStaleness(symbol: SymbolRecord): StalenessState {
    return this.summary.getStaleness(symbol);
  }

  resolveSummary(symbol: SymbolRecord, trackAccess = true): SummaryState {
    return this.summary.resolveSummary(symbol, trackAccess);
  }

  getSummary(contentHash: string): Record<string, unknown> | null {
    return this.summary.getSummary(contentHash);
  }

  upsertSummaries(
    entries: SummaryUpsertEntry[],
    snapshot: IndexSnapshot
  ): {
    saved: number;
    conflicts: SummaryUpsertResult[];
    results: SummaryUpsertResult[];
  } {
    return this.summary.upsertSummaries(entries, snapshot);
  }

  listStale(
    snapshot: IndexSnapshot,
    limit = 25
  ): Array<{
    id: string;
    name: string;
    kind: string;
    module: string;
    staleness: StalenessState;
    content_hash: string;
    self_hash: string;
    fan_in: number;
  }> {
    return this.summary.listStale(snapshot, limit);
  }

  getCoverage(snapshot: IndexSnapshot): SummaryCoverage {
    return this.summary.getCoverage(snapshot);
  }

  getInfo(): {
    db_path: string;
    summary_db_path: string;
    single_mode: boolean;
    prompt_version: string;
    working_symbols: number;
    working_edges: number;
    working_files: number;
    cached_summaries: number;
    indexed_at: string | null;
    canonical_root: string | null;
    project_id: string | null;
    db_bytes: number;
  } {
    const stats = this.working.getStats();
    return {
      db_path: this.workingPath,
      summary_db_path: this.summaryPath,
      single_mode: this.singleMode,
      prompt_version: this.promptVersion,
      working_symbols: stats.symbols,
      working_edges: stats.edges,
      working_files: stats.files,
      cached_summaries: this.summary.countSummaries(),
      indexed_at: stats.indexed_at,
      canonical_root: stats.canonical_root,
      project_id: stats.project_id,
      db_bytes:
        this.workingPath === ":memory:" ? 0 : fileSize(this.workingPath),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.working.close();
    if (!this.singleMode) this.summary.close();
  }
}
