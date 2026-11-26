import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DualCacheStore } from "../../cache/store.js";
import type { IndexSnapshot, SymbolRecord } from "../../index/types.js";
import {
  getFanCounts,
  getSymbolDependencies,
  getSymbolMatches,
} from "../../index/queries.js";
import { compactSymbol, paginate, truncateText } from "../response.js";
import { errorResult } from "./results.js";

export function resolveSymbol(
  snapshot: IndexSnapshot,
  query: string | undefined
): { symbol: SymbolRecord } | { error: CallToolResult } {
  if (!query) {
    return {
      error: errorResult({
        error: "symbol_required",
        hint: "pass symbol_id with a canonical ID or a symbol name",
      }),
    };
  }
  const direct = snapshot.symbols.get(query);
  if (direct) return { symbol: direct };

  const matches = getSymbolMatches(snapshot, query, 10);
  const exactName = matches.filter(
    (symbol) => symbol.name.toLowerCase() === query.toLowerCase()
  );
  if (exactName.length === 1) return { symbol: exactName[0]! };
  if (matches.length === 1) return { symbol: matches[0]! };
  if (matches.length === 0) {
    return {
      error: errorResult({
        error: "symbol_not_found",
        input: query,
        expected_format:
          "sym:<repo-relative-file>#<name> or sym:<file>:<Class>#<name>",
        hint: "use lookup_symbol to discover candidate IDs",
      }),
    };
  }
  return {
    error: errorResult({
      error: "ambiguous_symbol",
      input: query,
      candidates: matches.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        line: symbol.line,
      })),
      hint: "retry with one of the canonical candidate IDs",
    }),
  };
}

export function leanSymbol(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbol: SymbolRecord
): Record<string, unknown> {
  const resolved = store.resolveSummary(symbol);
  const fan = getFanCounts(snapshot, symbol.id);
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    end_line: symbol.endLine,
    loc: symbol.loc,
    members: symbol.members,
    exported: symbol.exported,
    default_export: symbol.defaultExport,
    is_entrypoint: symbol.isEntrypoint,
    is_test: symbol.isTest,
    is_generated: symbol.isGenerated,
    eligible: symbol.eligible,
    directive: symbol.directive,
    complexity: symbol.complexity,
    props_type: symbol.propsType,
    signature: symbol.signature,
    doc: symbol.doc,
    fan_in: fan.fanIn,
    fan_out: fan.fanOut,
    sync_state: resolved.state,
    summary: resolved.summary,
    sig_hash: symbol.sigHash,
    self_hash: symbol.selfHash,
    dep_hash: symbol.depHash,
    content_hash: symbol.contentHash,
  };
}

export function symbolResult(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbol: SymbolRecord,
  compact = false
): Record<string, unknown> {
  return compact
    ? compactSymbol(symbol, store.getStaleness(symbol))
    : leanSymbol(snapshot, store, symbol);
}

export function symbolDependencyContext(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbolId: string,
  options: {
    limit?: number;
    offset?: number;
    includeSource?: boolean;
    compact?: boolean;
  } = {}
): {
  items: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  truncated: boolean;
} {
  const dependencies = getSymbolDependencies(snapshot, symbolId);
  const seen = new Set<string>();
  const unique: Array<{ target: SymbolRecord; edgeKind: string }> = [];
  for (const dependency of dependencies) {
    const key = `${dependency.id}|${dependency.edge_kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = snapshot.symbols.get(dependency.id);
    if (target) unique.push({ target, edgeKind: dependency.edge_kind });
  }
  const page = paginate(unique, options.offset ?? 0, options.limit ?? 25);
  const items = page.items.map(({ target, edgeKind }) => {
    const resolved = store.resolveSummary(target);
    return {
      ...symbolResult(snapshot, store, target, options.compact ?? false),
      edge_kind: edgeKind,
      summary: resolved.summary,
      source:
        options.includeSource && !target.eligible
          ? truncateText(target.sourcePreview, 2000).text
          : undefined,
    };
  });
  return {
    items,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    next_offset: page.next_offset,
    truncated: page.truncated,
  };
}
