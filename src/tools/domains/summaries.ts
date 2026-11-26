import { z } from "zod";
import type { SummaryUpsertEntry } from "../../cache/store.js";
import { SUMMARY_SCHEMA, isCallableKind } from "../../cache/summary.js";
import { getFanCounts, getFunctionBody } from "../../index/queries.js";
import type { IndexSnapshot } from "../../index/types.js";
import { paginate, truncateText } from "../response.js";
import { boolArg, numberArg, parseIdList, stringArg, stringArrayArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { compactCoverage } from "../shared/projections.js";
import { errorResult, jsonResult } from "../shared/results.js";
import {
  compactTrue,
  maxCharsOptional,
  offsetOptional,
} from "../shared/schema.js";
import {
  resolveSymbol,
  symbolDependencyContext,
  symbolResult,
} from "../shared/symbols.js";

export function registerSummaryTools(context: ToolContext): void {
  const { controller, store, register } = context;

  register(
    "list_stale_summaries",
    "Eligible symbols missing or stale in the shared summary cache, ordered bottom-up.",
    {
      limit: z.number().int().min(1).max(500).default(25),
      offset: offsetOptional,
      module: z.string().optional(),
      kind: z.string().optional(),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const kindFilter = stringArg(args, "kind");
      const stale = store
        .listStale(snapshot, Math.max(1, snapshot.symbols.size))
        .filter(
          (item) =>
            (!moduleFilter || item.module === moduleFilter) &&
            (!kindFilter || item.kind === kindFilter)
        );
      const page = paginate(
        stale,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 25)
      );
      return jsonResult(
        {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          truncated: page.truncated,
          symbols: page.items.map((item) => ({
            ...item,
            fan_in: getFanCounts(snapshot, item.id).fanIn,
          })),
        },
        numberArg(args, "max_chars", 20_000)
      );
    }
  );

  register(
    "get_summary_context",
    "Source, schema, hashes, staleness, previous summary, and dependency context for up to 25 symbols.",
    {
      symbol_ids: z.array(z.string()).min(1).max(25).optional(),
      symbolIds: z.array(z.string()).min(1).max(25).optional(),
      symbol_id: z.string().optional(),
      include_source: z.boolean().default(true),
      source_chars: z.number().int().min(0).max(50_000).default(12_000),
      dependency_limit: z.number().int().min(1).max(200).default(25),
      dependency_offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const ids = [
        ...stringArrayArg(args, "symbol_ids"),
        ...stringArrayArg(args, "symbolIds"),
        ...parseIdList(stringArg(args, "symbol_id") ?? ""),
      ];
      if (ids.length === 0) return errorResult({ error: "symbol_ids_required" });
      const uniqueIds = [...new Set(ids)];
      const includeSource = boolArg(args, "include_source", true);
      const compact = boolArg(args, "compact", true);
      const items = uniqueIds.slice(0, 25).map((id) => {
        const resolved = resolveSymbol(snapshot, id);
        if ("error" in resolved) return { id, error: "not_found" };
        const symbol = resolved.symbol;
        const resolvedSummary = store.resolveSummary(symbol);
        const body = includeSource ? getFunctionBody(snapshot, symbol.id) : null;
        const source = body
          ? truncateText(body.source, numberArg(args, "source_chars", 12_000))
          : null;
        return {
          symbol: symbolResult(snapshot, store, symbol, compact),
          hashes: {
            self: symbol.selfHash,
            dep: symbol.depHash,
            content: symbol.contentHash,
          },
          prompt_version: store.promptVersion,
          schema: isCallableKind(symbol.kind)
            ? SUMMARY_SCHEMA.callable
            : SUMMARY_SCHEMA.type,
          sync_state: resolvedSummary.state,
          reason: resolvedSummary.reason,
          deps_changed: resolvedSummary.depsChanged,
          previous_summary:
            resolvedSummary.previousSummary ??
            (resolvedSummary.state === "soft_stale"
              ? resolvedSummary.summary
              : null),
          source: source?.text,
          source_truncated: source?.truncated ?? false,
          source_original_chars: source?.originalChars ?? 0,
          dependencies: symbolDependencyContext(snapshot, store, symbol.id, {
            limit: numberArg(args, "dependency_limit", 25),
            offset: numberArg(args, "dependency_offset", 0),
            compact,
          }),
        };
      });
      return jsonResult(
        {
          total: uniqueIds.length,
          returned: items.length,
          truncated: uniqueIds.length > items.length,
          items,
        },
        numberArg(args, "max_chars", 60_000)
      );
    }
  );

  register(
    "upsert_summaries",
    "Validate and store structured summaries with optimistic content-hash checks.",
    {
      entries: z
        .array(
          z.object({
            symbol_id: z.string().optional(),
            symbolId: z.string().optional(),
            summary: z.record(z.string(), z.unknown()),
            expected_content_hash: z.string().optional(),
            expectedContentHash: z.string().optional(),
            expected_self_hash: z.string().optional(),
            expected_dep_hash: z.string().optional(),
            model_id: z.string().optional(),
          })
        )
        .min(1)
        .max(50),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const rawEntries =
        (args.entries as Array<Record<string, unknown>> | undefined) ?? [];
      const entries: SummaryUpsertEntry[] = rawEntries.map((entry) => ({
        symbolId: String(entry.symbol_id ?? entry.symbolId ?? ""),
        summary: entry.summary,
        expectedContentHash:
          typeof entry.expected_content_hash === "string"
            ? entry.expected_content_hash
            : typeof entry.expectedContentHash === "string"
              ? entry.expectedContentHash
              : undefined,
        expectedSelfHash:
          typeof entry.expected_self_hash === "string"
            ? entry.expected_self_hash
            : undefined,
        expectedDepHash:
          typeof entry.expected_dep_hash === "string"
            ? entry.expected_dep_hash
            : undefined,
        modelId: typeof entry.model_id === "string" ? entry.model_id : undefined,
      }));
      return jsonResult(
        store.upsertSummaries(entries, snapshot),
        numberArg(args, "max_chars", 20_000)
      );
    }
  );

  register(
    "get_summary_coverage",
    "Summary cache coverage by kind and module.",
    {
      module: z.string().optional(),
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const coverageSnapshot: IndexSnapshot = moduleFilter
        ? {
            ...snapshot,
            symbols: new Map(
              [...snapshot.symbols].filter(
                ([, symbol]) => symbol.module === moduleFilter
              )
            ),
          }
        : snapshot;
      const coverage = store.getCoverage(coverageSnapshot);
      return jsonResult(
        boolArg(args, "compact", true) ? compactCoverage(coverage) : coverage,
        numberArg(args, "max_chars", 20_000)
      );
    }
  );
}
