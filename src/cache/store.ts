import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { sha256 } from "../index/hasher.js";
import { validateSummary } from "./summary.js";
import type { IndexSnapshot, StalenessState, SymbolRecord } from "../index/types.js";

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
  status: "updated" | "not_found" | "not_eligible" | "validation_error" | "hash_mismatch";
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
  by_kind: Record<string, { eligible: number; synced: number; stale: number; missing: number }>;
  by_module: Record<string, { eligible: number; synced: number; stale: number; missing: number }>;
}

export function getCacheRoot(): string {
  if (process.env.TSRAY_CACHE_DIR) return path.resolve(process.env.TSRAY_CACHE_DIR);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "tsray");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "tsray");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tsray");
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project"
  );
}

export function resolveDbPaths(canonicalRoot: string, projectId: string, overrideDb?: string): DbPaths {
  if (overrideDb) {
    return { workingPath: overrideDb, summaryPath: overrideDb, singleMode: true };
  }
  const cacheRoot = getCacheRoot();
  const workingPath = path.join(
    cacheRoot,
    "worktrees",
    `${slugify(path.basename(canonicalRoot))}-${sha256(canonicalRoot).slice(0, 12)}.db`
  );
  const summaryPath = path.join(
    cacheRoot,
    "summaries",
    `${slugify(projectId)}-${sha256(projectId).slice(0, 12)}.db`
  );
  return { workingPath, summaryPath, singleMode: false };
}

function sidecarPaths(file: string): string[] {
  return [file, `${file}-wal`, `${file}-shm`];
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export interface DbRemovalPlan {
  paths: string[];
  existing: Array<{ path: string; bytes: number }>;
  totalBytes: number;
}

export function planDatabaseRemoval(
  canonicalRoot: string,
  projectId: string,
  options: { overrideDb?: string; summaries?: boolean; all?: boolean } = {}
): DbRemovalPlan {
  const resolved = resolveDbPaths(canonicalRoot, projectId, options.overrideDb);
  const targets = new Set<string>();
  if (resolved.singleMode) {
    for (const file of sidecarPaths(resolved.workingPath)) targets.add(file);
  } else {
    if (!options.summaries || options.all) {
      for (const file of sidecarPaths(resolved.workingPath)) targets.add(file);
    }
    if (options.summaries || options.all) {
      for (const file of sidecarPaths(resolved.summaryPath)) targets.add(file);
    }
  }
  const existing = [...targets]
    .filter((file) => file !== ":memory:" && fs.existsSync(file))
    .map((file) => ({ path: file, bytes: fileSize(file) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    paths: [...targets].filter((file) => file !== ":memory:").sort(),
    existing,
    totalBytes: existing.reduce((total, item) => total + item.bytes, 0),
  };
}

export function removeDatabases(
  plan: DbRemovalPlan,
  options: { force?: boolean; dryRun?: boolean } = {}
): { removed: string[]; skipped: Array<{ path: string; reason: string }>; dryRun: boolean } {
  if (options.dryRun) return { removed: [], skipped: [], dryRun: true };
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const item of plan.existing) {
    let probe: DatabaseSync | null = null;
    try {
      if (item.path.endsWith("-wal") || item.path.endsWith("-shm")) {
        fs.rmSync(item.path, { force: true });
        removed.push(item.path);
        continue;
      }
      probe = new DatabaseSync(item.path);
      probe.exec("PRAGMA busy_timeout = 250;");
      probe.exec("BEGIN EXCLUSIVE;");
      probe.exec("ROLLBACK;");
      probe.close();
      probe = null;
      fs.rmSync(item.path, { force: true });
      removed.push(item.path);
    } catch (error) {
      probe?.close();
      if (options.force) {
        try {
          fs.rmSync(item.path, { force: true });
          removed.push(item.path);
          continue;
        } catch (forcedError) {
          skipped.push({ path: item.path, reason: String(forcedError) });
          continue;
        }
      }
      skipped.push({
        path: item.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed, skipped, dryRun: false };
}

export interface PruneResult {
  scanned: number;
  removed: string[];
  skipped: Array<{ path: string; reason: string }>;
  roots: Array<{ path: string; canonicalRoot: string | null }>;
}

export function pruneWorktreeDatabases(options: { dryRun?: boolean } = {}): PruneResult {
  const directory = path.join(getCacheRoot(), "worktrees");
  const result: PruneResult = { scanned: 0, removed: [], skipped: [], roots: [] };
  if (!fs.existsSync(directory)) return result;

  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".db")) continue;
    const file = path.join(directory, entry);
    result.scanned++;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file);
      const row = db
        .prepare("SELECT value FROM working_meta WHERE key = 'canonical_root'")
        .get() as { value: string } | undefined;
      const canonicalRoot = row?.value ?? null;
      result.roots.push({ path: file, canonicalRoot });
      if (!canonicalRoot || fs.existsSync(canonicalRoot)) {
        db.close();
        db = null;
        continue;
      }
      db.close();
      db = null;
      if (!options.dryRun) {
        for (const sidecar of sidecarPaths(file)) fs.rmSync(sidecar, { force: true });
      }
      result.removed.push(file);
    } catch (error) {
      db?.close();
      result.skipped.push({
        path: file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export class DualCacheStore {
  readonly workingPath: string;
  readonly summaryPath: string;
  readonly promptVersion: string;
  private readonly workingDb: DatabaseSync;
  private readonly summaryDb: DatabaseSync;
  private readonly singleMode: boolean;
  private readonly statements = new Map<string, StatementSync>();

  constructor(canonicalRoot: string, projectId: string, options: StoreOptions = {}) {
    const paths = resolveDbPaths(canonicalRoot, projectId, options.overrideDb);
    this.workingPath = paths.workingPath;
    this.summaryPath = paths.summaryPath;
    this.singleMode = paths.singleMode;
    this.promptVersion = options.promptVersion ?? process.env.TSRAY_PROMPT_VERSION ?? "v1";

    if (!this.singleMode) {
      fs.mkdirSync(path.dirname(this.workingPath), { recursive: true });
      fs.mkdirSync(path.dirname(this.summaryPath), { recursive: true });
    }

    this.workingDb = new DatabaseSync(this.workingPath);
    this.configureDb(this.workingDb);
    this.initWorkingSchema(this.workingDb);

    this.summaryDb = this.singleMode ? this.workingDb : new DatabaseSync(this.summaryPath);
    if (!this.singleMode) this.configureDb(this.summaryDb);
    this.initSummarySchema(this.summaryDb);
  }

  private configureDb(db: DatabaseSync): void {
    db.exec("PRAGMA busy_timeout = 5000;");
    if (this.workingPath !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
    }
    db.exec("PRAGMA foreign_keys = ON;");
  }

  private initWorkingSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS working_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS working_symbols (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        module TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        loc INTEGER NOT NULL,
        members INTEGER NOT NULL,
        parent_id TEXT,
        exported INTEGER NOT NULL,
        default_export INTEGER NOT NULL,
        is_test INTEGER NOT NULL,
        is_generated INTEGER NOT NULL,
        is_entrypoint INTEGER NOT NULL,
        directive TEXT,
        complexity INTEGER NOT NULL,
        props_type TEXT,
        signature TEXT NOT NULL,
        doc TEXT NOT NULL,
        sig_hash TEXT NOT NULL,
        self_hash TEXT NOT NULL,
        dep_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        eligible INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_working_symbols_module ON working_symbols(module);
      CREATE INDEX IF NOT EXISTS idx_working_symbols_file ON working_symbols(file);
      CREATE INDEX IF NOT EXISTS idx_working_symbols_content ON working_symbols(content_hash);
      CREATE TABLE IF NOT EXISTS working_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        via TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON working_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON working_edges(to_id);
      CREATE TABLE IF NOT EXISTS working_files (
        path TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        loc INTEGER NOT NULL,
        prod_loc INTEGER NOT NULL,
        test_loc INTEGER NOT NULL,
        generated INTEGER NOT NULL,
        is_test INTEGER NOT NULL,
        is_entrypoint INTEGER NOT NULL,
        directive TEXT,
        exports INTEGER NOT NULL,
        imports INTEGER NOT NULL
      );
    `);
  }

  private initSummarySchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_cache (
        content_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        self_hash TEXT NOT NULL,
        dep_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY (content_hash, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS idx_summary_self ON summary_cache(self_hash, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_summary_lru ON summary_cache(last_accessed_at);
      CREATE TABLE IF NOT EXISTS symbol_history (
        symbol_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        last_content_hash TEXT NOT NULL,
        last_self_hash TEXT NOT NULL,
        last_dep_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (symbol_id, prompt_version)
      );
      CREATE TABLE IF NOT EXISTS summary_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private stmt(key: string, sql: string): StatementSync {
    let statement = this.statements.get(key);
    if (!statement) {
      statement = this.summaryDb.prepare(sql);
      this.statements.set(key, statement);
    }
    return statement;
  }

  syncWorking(snapshot: IndexSnapshot): void {
    const insertSymbol = this.workingDb.prepare(`
      INSERT INTO working_symbols (
        id, name, kind, module, file, line, end_line, loc, members, parent_id,
        exported, default_export, is_test, is_generated, is_entrypoint, directive,
        complexity, props_type, signature, doc, sig_hash, self_hash, dep_hash,
        content_hash, eligible
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertEdge = this.workingDb.prepare(`
      INSERT INTO working_edges (from_id, to_id, kind, file, line, via) VALUES (?,?,?,?,?,?)
    `);
    const insertFile = this.workingDb.prepare(`
      INSERT INTO working_files (
        path, module, loc, prod_loc, test_loc, generated, is_test, is_entrypoint,
        directive, exports, imports
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const upsertMeta = this.workingDb.prepare(
      "INSERT OR REPLACE INTO working_meta (key, value) VALUES (?, ?)"
    );

    this.workingDb.exec("BEGIN IMMEDIATE");
    try {
      this.workingDb.exec("DELETE FROM working_symbols; DELETE FROM working_edges; DELETE FROM working_files;");
      for (const symbol of snapshot.symbols.values()) {
        insertSymbol.run(
          symbol.id,
          symbol.name,
          symbol.kind,
          symbol.module,
          symbol.file,
          symbol.line,
          symbol.endLine,
          symbol.loc,
          symbol.members,
          symbol.parentId,
          symbol.exported ? 1 : 0,
          symbol.defaultExport ? 1 : 0,
          symbol.isTest ? 1 : 0,
          symbol.isGenerated ? 1 : 0,
          symbol.isEntrypoint ? 1 : 0,
          symbol.directive,
          symbol.complexity,
          symbol.propsType,
          symbol.signature,
          symbol.doc,
          symbol.sigHash,
          symbol.selfHash,
          symbol.depHash,
          symbol.contentHash,
          symbol.eligible ? 1 : 0
        );
      }
      for (const edge of snapshot.edges) {
        insertEdge.run(edge.fromId, edge.toId, edge.kind, edge.file, edge.line, edge.via ?? null);
      }
      for (const file of snapshot.files.values()) {
        insertFile.run(
          file.path,
          file.module,
          file.loc,
          file.prodLoc,
          file.testLoc,
          file.generated ? 1 : 0,
          file.isTest ? 1 : 0,
          file.isEntrypoint ? 1 : 0,
          file.directive,
          file.exports,
          file.imports
        );
      }
      const meta: Record<string, string> = {
        canonical_root: snapshot.root,
        project_id: snapshot.projectId,
        tsconfig_path: snapshot.tsconfigPath,
        tsconfig_paths: JSON.stringify(snapshot.tsconfigPaths),
        typescript_version: snapshot.typescriptVersion,
        indexed_at: snapshot.indexedAt,
        duration_ms: String(snapshot.durationMs),
        files: String(snapshot.filesCount),
        symbols: String(snapshot.symbols.size),
        edges: String(snapshot.edges.length),
        modules: JSON.stringify(snapshot.modules),
        module_cycles: JSON.stringify(snapshot.moduleCycles),
        prod_errors: String(snapshot.prodErrors.length),
        warnings: String(snapshot.warnings.length),
      };
      for (const [key, value] of Object.entries(meta)) upsertMeta.run(key, value);
      this.workingDb.exec("COMMIT");
    } catch (error) {
      this.workingDb.exec("ROLLBACK");
      throw error;
    }
  }

  getStaleness(symbol: SymbolRecord): StalenessState {
    return this.resolveSummary(symbol).state;
  }

  /**
   * Resolves the best cached summary for a symbol and returns the staleness
   * state, previous summary, and whether only dependencies changed.
   */
  resolveSummary(symbol: SymbolRecord): SummaryState {
    if (!symbol.eligible) {
      return { state: "not_eligible", summary: null, previousSummary: null, depsChanged: false };
    }

    const exact = this.stmt(
      "exactSummary",
      "SELECT summary_json FROM summary_cache WHERE content_hash = ? AND prompt_version = ?"
    ).get(symbol.contentHash, this.promptVersion) as { summary_json: string } | undefined;
    if (exact) {
      this.touch(symbol.contentHash);
      return {
        state: "synced",
        summary: parseSummary(exact.summary_json),
        previousSummary: null,
        depsChanged: false,
      };
    }

    const history = this.stmt(
      "history",
      "SELECT last_content_hash, last_self_hash FROM symbol_history WHERE symbol_id = ? AND prompt_version = ?"
    ).get(symbol.id, this.promptVersion) as
      | { last_content_hash: string; last_self_hash: string }
      | undefined;
    if (!history) {
      return { state: "missing", summary: null, previousSummary: null, depsChanged: false };
    }

    const previous = this.stmt(
      "summaryByHash",
      "SELECT summary_json FROM summary_cache WHERE content_hash = ? AND prompt_version = ?"
    ).get(history.last_content_hash, this.promptVersion) as { summary_json: string } | undefined;
    const previousSummary = previous ? parseSummary(previous.summary_json) : null;

    if (history.last_self_hash === symbol.selfHash) {
      this.touch(history.last_content_hash);
      return {
        state: "soft_stale",
        reason: "deps_changed",
        summary: previousSummary,
        previousSummary: null,
        depsChanged: true,
      };
    }

    return {
      state: "hard_stale",
      reason: "self_changed",
      summary: previousSummary,
      previousSummary,
      depsChanged: false,
    };
  }

  private touch(contentHash: string): void {
    if (!contentHash) return;
    this.stmt(
      "touch",
      "UPDATE summary_cache SET last_accessed_at = ? WHERE content_hash = ? AND prompt_version = ?"
    ).run(Date.now(), contentHash, this.promptVersion);
  }

  getSummary(contentHash: string): Record<string, unknown> | null {
    const row = this.stmt(
      "summaryByHash",
      "SELECT summary_json FROM summary_cache WHERE content_hash = ? AND prompt_version = ?"
    ).get(contentHash, this.promptVersion) as { summary_json: string } | undefined;
    if (!row) return null;
    this.touch(contentHash);
    return parseSummary(row.summary_json);
  }

  upsertSummaries(
    entries: SummaryUpsertEntry[],
    snapshot: IndexSnapshot
  ): { saved: number; conflicts: SummaryUpsertResult[]; results: SummaryUpsertResult[] } {
    const results: SummaryUpsertResult[] = [];
    const prepared: Array<{
      index: number;
      symbol: SymbolRecord;
      summary: Record<string, unknown>;
      modelId: string;
    }> = [];

    entries.forEach((entry, index) => {
      const symbol = snapshot.symbols.get(entry.symbolId);
      if (!symbol) {
        results[index] = { symbol_id: entry.symbolId, status: "not_found", error: "symbol not found in current index" };
        return;
      }
      if (!symbol.eligible) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "not_eligible",
          error: "symbol is not eligible for summarization",
        };
        return;
      }
      if (!entry.expectedContentHash && !(entry.expectedSelfHash && entry.expectedDepHash)) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "validation_error",
          error: "expectedContentHash (or expectedSelfHash + expectedDepHash) is required",
        };
        return;
      }
      if (entry.expectedContentHash && entry.expectedContentHash !== symbol.contentHash) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "hash_mismatch",
          error: "content hash does not match the current index; fetch summary context again",
        };
        return;
      }
      if (entry.expectedSelfHash && entry.expectedSelfHash !== symbol.selfHash) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "hash_mismatch",
          error: "self hash does not match the current index; fetch summary context again",
        };
        return;
      }
      if (entry.expectedDepHash && entry.expectedDepHash !== symbol.depHash) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "hash_mismatch",
          error: "dependency hash does not match the current index; fetch summary context again",
        };
        return;
      }
      const validated = validateSummary(symbol.kind, entry.summary);
      if (!validated.ok) {
        results[index] = {
          symbol_id: entry.symbolId,
          status: "validation_error",
          error: validated.error,
        };
        return;
      }
      prepared.push({
        index,
        symbol,
        summary: validated.value,
        modelId: entry.modelId ?? "",
      });
    });

    if (prepared.length === 0) {
      return { saved: 0, conflicts: results.filter(Boolean), results };
    }

    const now = Date.now();
    this.summaryDb.exec("BEGIN IMMEDIATE");
    try {
      const upsertCache = this.summaryDb.prepare(`
        INSERT INTO summary_cache (
          content_hash, prompt_version, self_hash, dep_hash, kind, model_id,
          summary_json, created_at, last_accessed_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(content_hash, prompt_version) DO UPDATE SET
          self_hash = excluded.self_hash,
          dep_hash = excluded.dep_hash,
          kind = excluded.kind,
          model_id = excluded.model_id,
          summary_json = excluded.summary_json,
          created_at = excluded.created_at,
          last_accessed_at = excluded.last_accessed_at
      `);
      const upsertHistory = this.summaryDb.prepare(`
        INSERT INTO symbol_history (
          symbol_id, prompt_version, last_content_hash, last_self_hash, last_dep_hash, updated_at
        ) VALUES (?,?,?,?,?,?)
        ON CONFLICT(symbol_id, prompt_version) DO UPDATE SET
          last_content_hash = excluded.last_content_hash,
          last_self_hash = excluded.last_self_hash,
          last_dep_hash = excluded.last_dep_hash,
          updated_at = excluded.updated_at
      `);

      for (const item of prepared) {
        upsertCache.run(
          item.symbol.contentHash,
          this.promptVersion,
          item.symbol.selfHash,
          item.symbol.depHash,
          item.symbol.kind,
          item.modelId,
          JSON.stringify(item.summary),
          now,
          now
        );
        upsertHistory.run(
          item.symbol.id,
          this.promptVersion,
          item.symbol.contentHash,
          item.symbol.selfHash,
          item.symbol.depHash,
          now
        );
        results[item.index] = { symbol_id: item.symbol.id, status: "updated" };
      }
      this.summaryDb.exec("COMMIT");
    } catch (error) {
      this.summaryDb.exec("ROLLBACK");
      throw error;
    }

    return {
      saved: prepared.length,
      conflicts: results.filter((result) => result.status !== "updated"),
      results,
    };
  }

  listStale(snapshot: IndexSnapshot, limit = 25): Array<{
    id: string;
    name: string;
    kind: string;
    module: string;
    staleness: StalenessState;
    content_hash: string;
    self_hash: string;
    fan_in: number;
  }> {
    const stale: Array<{
      id: string;
      name: string;
      kind: string;
      module: string;
      staleness: StalenessState;
      content_hash: string;
      self_hash: string;
      fan_in: number;
    }> = [];
    const symbols = [...snapshot.symbols.values()]
      .filter((symbol) => symbol.eligible)
      .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.line - b.line);
    for (const symbol of symbols) {
      const state = this.getStaleness(symbol);
      if (state === "synced" || state === "not_eligible") continue;
      stale.push({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        module: symbol.module,
        staleness: state,
        content_hash: symbol.contentHash,
        self_hash: symbol.selfHash,
        fan_in: 0,
      });
      if (stale.length >= limit) break;
    }
    return stale;
  }

  getCoverage(snapshot: IndexSnapshot): SummaryCoverage {
    const coverage: SummaryCoverage = {
      eligible: 0,
      synced: 0,
      soft_stale: 0,
      hard_stale: 0,
      missing: 0,
      not_eligible: 0,
      percent: 0,
      by_kind: {},
      by_module: {},
    };

    for (const symbol of snapshot.symbols.values()) {
      const state = this.getStaleness(symbol);
      if (state === "not_eligible") {
        coverage.not_eligible++;
        continue;
      }
      coverage.eligible++;
      coverage[state]++;
      const kindBucket = (coverage.by_kind[symbol.kind] ??= { eligible: 0, synced: 0, stale: 0, missing: 0 });
      kindBucket.eligible++;
      if (state === "synced") kindBucket.synced++;
      else if (state === "missing") kindBucket.missing++;
      else kindBucket.stale++;
      const moduleBucket = (coverage.by_module[symbol.module] ??= { eligible: 0, synced: 0, stale: 0, missing: 0 });
      moduleBucket.eligible++;
      if (state === "synced") moduleBucket.synced++;
      else if (state === "missing") moduleBucket.missing++;
      else moduleBucket.stale++;
    }

    coverage.percent =
      coverage.eligible === 0 ? 0 : Number(((coverage.synced / coverage.eligible) * 100).toFixed(1));
    return coverage;
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
    const count = (db: DatabaseSync, table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
      return row.c;
    };
    const meta = (key: string): string | null => {
      const row = this.workingDb
        .prepare("SELECT value FROM working_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    return {
      db_path: this.workingPath,
      summary_db_path: this.summaryPath,
      single_mode: this.singleMode,
      prompt_version: this.promptVersion,
      working_symbols: count(this.workingDb, "working_symbols"),
      working_edges: count(this.workingDb, "working_edges"),
      working_files: count(this.workingDb, "working_files"),
      cached_summaries: count(this.summaryDb, "summary_cache"),
      indexed_at: meta("indexed_at"),
      canonical_root: meta("canonical_root"),
      project_id: meta("project_id"),
      db_bytes: this.workingPath === ":memory:" ? 0 : fileSize(this.workingPath),
    };
  }

  close(): void {
    this.statements.clear();
    this.workingDb.close();
    if (!this.singleMode) this.summaryDb.close();
  }
}

function parseSummary(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function kindOrder(kind: string): number {
  switch (kind) {
    case "interface":
    case "type":
    case "class":
    case "enum":
      return 0;
    case "context":
      return 1;
    case "hook":
      return 2;
    case "function":
    case "method":
      return 3;
    case "component":
      return 4;
    default:
      return 5;
  }
}
