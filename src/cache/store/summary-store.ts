import type { DatabaseSync, StatementSync } from "node:sqlite";
import { validateSummary } from "../summary.js";
import type { IndexSnapshot, StalenessState, SymbolRecord } from "../../index/types.js";
import { initSummarySchema } from "./schema.js";
import { kindOrder, parseSummary } from "./summary-utils.js";
import type {
  SummaryCoverage,
  SummaryState,
  SummaryUpsertEntry,
  SummaryUpsertResult,
} from "./types.js";

export class SummaryStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(
    private readonly summaryDb: DatabaseSync,
    readonly promptVersion: string
  ) {
    initSummarySchema(summaryDb);
  }

  private stmt(key: string, sql: string): StatementSync {
    let statement = this.statements.get(key);
    if (!statement) {
      statement = this.summaryDb.prepare(sql);
      this.statements.set(key, statement);
    }
    return statement;
  }

  getStaleness(symbol: SymbolRecord): StalenessState {
    return this.resolveSummary(symbol, false).state;
  }

  /**
   * Resolves the best cached summary for a symbol and returns the staleness
   * state, previous summary, and whether only dependencies changed.
   *
   * Bulk report reads pass `trackAccess: false` so a five-second UI poll does
   * not write thousands of LRU timestamps.
   */
  resolveSummary(symbol: SymbolRecord, trackAccess = true): SummaryState {
    if (!symbol.eligible) {
      return { state: "not_eligible", summary: null, previousSummary: null, depsChanged: false };
    }

    const exact = this.stmt(
      "exactSummary",
      "SELECT summary_json FROM summary_cache WHERE content_hash = ? AND prompt_version = ?"
    ).get(symbol.contentHash, this.promptVersion) as { summary_json: string } | undefined;
    if (exact) {
      if (trackAccess) this.touch(symbol.contentHash);
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
      if (trackAccess) this.touch(history.last_content_hash);
      let summary = previousSummary;
      if (!summary) {
        const fallback = this.stmt(
          "summaryBySelf",
          "SELECT summary_json FROM summary_cache WHERE self_hash = ? AND prompt_version = ? AND kind = ? ORDER BY last_accessed_at DESC LIMIT 1"
        ).get(symbol.selfHash, this.promptVersion, symbol.kind) as { summary_json: string } | undefined;
        summary = fallback ? parseSummary(fallback.summary_json) : null;
      }
      return {
        state: "soft_stale",
        reason: "deps_changed",
        summary,
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
      try {
        this.summaryDb.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed by SQLite.
      }
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

  countSummaries(): number {
    const row = this.summaryDb
      .prepare("SELECT COUNT(*) AS c FROM summary_cache")
      .get() as { c: number };
    return row.c;
  }

  close(): void {
    this.statements.clear();
    this.summaryDb.close();
  }
}
