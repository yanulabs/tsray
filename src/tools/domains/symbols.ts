import { z } from "zod";
import {
  getApiSurface,
  getCallGraph,
  getFunctionBody,
  getReferences,
  getSymbolMatches,
} from "../../index/queries.js";
import { compactSymbol, paginate, truncateText } from "../response.js";
import { boolArg, numberArg, stringArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { errorResult, jsonResult } from "../shared/results.js";
import {
  compactTrue,
  maxCharsOptional,
  offsetOptional,
} from "../shared/schema.js";
import {
  leanSymbol,
  resolveSymbol,
  symbolResult,
} from "../shared/symbols.js";

export function registerSymbolTools(context: ToolContext): void {
  const { controller, store, register } = context;

  register(
    "lookup_symbol",
    "Find symbols by canonical ID, name, file path, or fuzzy text with summary cache metadata.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
      offset: offsetOptional,
      compact: compactTrue,
      include_source: z.boolean().default(false),
      source_chars: z.number().int().min(0).max(20_000).default(1200),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const query = stringArg(args, "query");
      if (!query) return errorResult({ error: "query_required" });
      const allMatches = getSymbolMatches(
        snapshot,
        query,
        Math.max(1, snapshot.symbols.size)
      );
      const page = paginate(
        allMatches,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 10)
      );
      const compact = boolArg(args, "compact", true);
      const includeSource = boolArg(args, "include_source", false);
      const sourceChars = numberArg(args, "source_chars", 1200);
      const symbols = page.items.map((symbol) => {
        const resolved = store.resolveSummary(symbol);
        const projected = compact
          ? { ...compactSymbol(symbol, resolved.state), summary: resolved.summary }
          : leanSymbol(snapshot, store, symbol);
        return includeSource
          ? {
              ...projected,
              source_preview: truncateText(symbol.sourcePreview, sourceChars).text,
            }
          : projected;
      });
      return jsonResult(
        {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          symbols,
        },
        numberArg(args, "max_chars", 20_000)
      );
    }
  );

  register(
    "get_api_surface",
    "Paginated exported API surface with kind and module filters.",
    {
      module: z.string().optional(),
      kind: z.string().optional(),
      limit: z.number().int().min(0).max(1000).default(100),
      offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const limit = numberArg(args, "limit", 100);
      const offset = numberArg(args, "offset", 0);
      const result = getApiSurface(snapshot, {
        module: stringArg(args, "module"),
        kind: stringArg(args, "kind"),
        limit: limit > 0 ? limit : 0,
        offset,
      });
      const compact = boolArg(args, "compact", true);
      return jsonResult(
        {
          total: result.total,
          offset,
          limit,
          next_offset:
            offset + result.symbols.length < result.total
              ? offset + result.symbols.length
              : null,
          symbols: result.symbols.map((symbol) =>
            symbolResult(snapshot, store, symbol, compact)
          ),
        },
        numberArg(args, "max_chars", 30_000)
      );
    }
  );

  register(
    "get_references",
    "Type-checked references with enclosing source symbol and file:line.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      include_imports: z.boolean().default(false),
      limit: z.number().int().min(1).max(2000).default(500),
      offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const allReferences = getReferences(snapshot, resolved.symbol.id, {
        includeImports: boolArg(args, "include_imports", false),
        limit: Math.max(1, snapshot.edges.length + 1),
      });
      const page = paginate(
        allReferences,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 500)
      );
      return jsonResult(
        {
          symbol: symbolResult(
            snapshot,
            store,
            resolved.symbol,
            boolArg(args, "compact", true)
          ),
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          references: page.items,
        },
        numberArg(args, "max_chars", 30_000)
      );
    }
  );

  register(
    "get_call_graph",
    "BFS callers/callees around a symbol with typed edges.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      depth: z.number().int().min(1).max(6).default(2),
      direction: z.enum(["callers", "callees", "both"]).default("both"),
      max_nodes: z.number().int().min(1).max(2000).default(200),
      max_edges: z.number().int().min(1).max(10_000).default(1000),
      node_offset: offsetOptional,
      edge_offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const graph = getCallGraph(snapshot, resolved.symbol.id, {
        depth: numberArg(args, "depth", 2),
        direction:
          (stringArg(args, "direction") as
            | "callers"
            | "callees"
            | "both"
            | undefined) ?? "both",
      });
      const nodePage = paginate(
        graph.nodes,
        numberArg(args, "node_offset", 0),
        numberArg(args, "max_nodes", 200)
      );
      const allowed = new Set(nodePage.items.map((node) => node.id));
      const pageEdges = graph.edges.filter(
        (edge) => allowed.has(edge.from) && allowed.has(edge.to)
      );
      const edgePage = paginate(
        pageEdges,
        numberArg(args, "edge_offset", 0),
        numberArg(args, "max_edges", 1000)
      );
      return jsonResult(
        {
          root: graph.root,
          nodes: nodePage.items.map((node) => ({ ...node })),
          edges: edgePage.items,
          total_nodes: nodePage.total,
          node_offset: nodePage.offset,
          node_limit: nodePage.limit,
          next_node_offset: nodePage.next_offset,
          total_edges: graph.edges.length,
          page_total_edges: pageEdges.length,
          edge_offset: edgePage.offset,
          edge_limit: edgePage.limit,
          next_edge_offset: edgePage.next_offset,
          truncated:
            nodePage.truncated ||
            edgePage.truncated ||
            graph.truncated ||
            pageEdges.length !== graph.edges.length,
        },
        numberArg(args, "max_chars", 30_000)
      );
    }
  );

  register(
    "get_function_body",
    "Source body, LOC, and cyclomatic complexity for one symbol.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      source_chars: z.number().int().min(0).max(100_000).default(20_000),
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const body = getFunctionBody(snapshot, resolved.symbol.id);
      if (!body) return errorResult({ error: "symbol_not_found" });
      const source = truncateText(
        body.source,
        numberArg(args, "source_chars", 20_000)
      );
      return jsonResult(
        {
          symbol: symbolResult(
            snapshot,
            store,
            resolved.symbol,
            boolArg(args, "compact", true)
          ),
          source: source.text,
          source_truncated: source.truncated,
          source_original_chars: source.originalChars,
          loc: body.loc,
          complexity: body.complexity,
        },
        numberArg(args, "max_chars", 30_000)
      );
    }
  );
}
