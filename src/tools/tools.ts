import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DualCacheStore, SummaryUpsertEntry } from "../cache/store.js";
import { SUMMARY_SCHEMA, isCallableKind } from "../cache/summary.js";
import type { IndexController } from "../index/watch.js";
import type { IndexSnapshot, SymbolRecord } from "../index/types.js";
import {
  explainDependency,
  findImplementations,
  getApiSurface,
  getCallGraph,
  getComponentTree,
  getDeadCode,
  getDependencyGraph,
  getFanCounts,
  getFunctionBody,
  getHotspots,
  getImpactAnalysis,
  getModuleEdges,
  getModuleOverview,
  getModuleSummaries,
  getReferences,
  getSymbolDependencies,
  getSymbolMatches,
} from "../index/queries.js";
import {
  buildReportPayload,
  exportDot,
  exportMarkdown,
  exportMermaid,
} from "../render/exporters.js";
import { detectLintRunner, detectTestRunner, detectTypecheckRunner, runCommand } from "./runner.js";
import { VERSION } from "../version.js";

type ToolArgs = Record<string, unknown>;

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: true };
}

function stringArg(args: ToolArgs, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberArg(args: ToolArgs, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolArg(args: ToolArgs, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayArg(args: ToolArgs, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseIdList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveSymbol(
  snapshot: IndexSnapshot,
  query: string | undefined
): { symbol: SymbolRecord } | { error: CallToolResult } {
  if (!query) {
    return {
      error: errorResult({ error: "symbol_required", hint: "pass symbol_id with a canonical ID or a symbol name" }),
    };
  }
  const direct = snapshot.symbols.get(query);
  if (direct) return { symbol: direct };

  const matches = getSymbolMatches(snapshot, query, 10);
  const exactName = matches.filter((symbol) => symbol.name.toLowerCase() === query.toLowerCase());
  if (exactName.length === 1) return { symbol: exactName[0]! };
  if (matches.length === 1) return { symbol: matches[0]! };
  if (matches.length === 0) {
    return {
      error: errorResult({
        error: "symbol_not_found",
        input: query,
        expected_format: "sym:<repo-relative-file>#<name> or sym:<file>:<Class>#<name>",
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

function leanSymbol(snapshot: IndexSnapshot, store: DualCacheStore, symbol: SymbolRecord): Record<string, unknown> {
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

function symbolDependencyContext(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbolId: string
): Array<Record<string, unknown>> {
  const dependencies = getSymbolDependencies(snapshot, symbolId);
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const dependency of dependencies) {
    const key = `${dependency.id}|${dependency.edge_kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length >= 50) break;
    const target = snapshot.symbols.get(dependency.id);
    if (!target) continue;
    const resolved = store.resolveSummary(target);
    out.push({
      id: target.id,
      name: target.name,
      kind: target.kind,
      module: target.module,
      file: target.file,
      line: target.line,
      edge_kind: dependency.edge_kind,
      eligible: target.eligible,
      sync_state: resolved.state,
      summary: resolved.summary,
      source: target.eligible ? undefined : target.sourcePreview,
    });
  }
  return out;
}

function moduleMarkdown(snapshot: IndexSnapshot, moduleName: string): string {
  const overview = getModuleOverview(snapshot, moduleName);
  if (!overview.module) return `# Module ${moduleName}\n\nNo module named \`${moduleName}\` was indexed.\n`;
  const module = overview.module;
  const lines = [
    `# Module ${module.name}`,
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Files | ${module.files} |`,
    `| Symbols | ${module.symbols} |`,
    `| Components | ${module.components} |`,
    `| Hooks | ${module.hooks} |`,
    `| Exported | ${module.exported} |`,
    `| Prod LOC | ${module.prodLoc} |`,
    `| Test LOC | ${module.testLoc} |`,
    `| Entrypoints | ${module.entrypoints} |`,
    `| Fan-in | ${module.fanIn} |`,
    `| Fan-out | ${module.fanOut} |`,
    `| Test reachable symbols | ${module.testReachable} |`,
  ];
  if (overview.dependencies.length > 0) {
    lines.push("", "## Dependencies", "", "| Direction | Module | Imports | Symbol edges |", "| --- | --- | ---: | ---: |");
    for (const edge of overview.dependencies) {
      lines.push(
        `| ${edge.from === module.name ? "out" : "in"} | \`${edge.from === module.name ? edge.to : edge.from}\` | ${edge.imports} | ${edge.symbols} |`
      );
    }
  }
  if (overview.hotspots.length > 0) {
    lines.push("", "## Hotspots", "", "| Symbol | Kind | File | Complexity | Fan-in | Risk |", "| --- | --- | --- | ---: | ---: | ---: |");
    for (const hotspot of overview.hotspots) {
      lines.push(
        `| \`${hotspot.name}\` | ${hotspot.kind} | \`${hotspot.file}:${hotspot.line}\` | ${hotspot.complexity} | ${hotspot.fanIn} | ${hotspot.riskScore} |`
      );
    }
  }
  lines.push("", "## Files", "", "| File | LOC | Exports | Test |", "| --- | ---: | ---: | --- |");
  for (const file of overview.files) {
    lines.push(`| \`${file.path}\` | ${file.loc} | ${file.exports} | ${file.is_test ? "yes" : "no"} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function registerMcpTools(
  server: McpServer,
  controller: IndexController,
  store: DualCacheStore
): string[] {
  const tools: string[] = [];
  const register = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
    handler: (args: ToolArgs) => Promise<CallToolResult>
  ): void => {
    tools.push(name);
    server.registerTool(
      name,
      {
        description,
        inputSchema,
      },
      async (args) => {
        try {
          return await handler((args ?? {}) as ToolArgs);
        } catch (error) {
          return errorResult({
            error: "tool_failed",
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );
  };

  register("project_info", "Index state, project metadata, DB paths, symbol counts, and diagnostics.", {}, async () => {
    const snapshot = await controller.getSnapshot();
    return jsonResult({
      version: VERSION,
      project_id: snapshot.projectId,
      root: snapshot.root,
      tsconfig_path: snapshot.tsconfigPath,
      tsconfig_paths: snapshot.tsconfigPaths,
      project_configs: snapshot.projectConfigs,
      workspace: controller.indexer.workspace,
      typescript_version: snapshot.typescriptVersion,
      index_state: controller.status(),
      indexed_at: snapshot.indexedAt,
      duration_ms: snapshot.durationMs,
      files: snapshot.filesCount,
      modules: snapshot.modules.length,
      symbols: snapshot.symbols.size,
      edges: snapshot.edges.length,
      eligible: [...snapshot.symbols.values()].filter((symbol) => symbol.eligible).length,
      summary_prompt_version: store.promptVersion,
      tools: tools.slice(),
      prod_errors: snapshot.prodErrors.slice(0, 20),
      warnings: snapshot.warnings.slice(0, 20),
      current_prod_errors:
        controller.status().prod_errors > 0
          ? controller.indexer.getLastSnapshot()?.prodErrors.slice(0, 20) ?? []
          : [],
      storage: store.getInfo(),
    });
  });

  register(
    "get_codebase_map",
    "Module scorecard, cross-module edges, cycles, hotspots, and summary coverage (md|json|dot|mermaid).",
    {
      format: z.enum(["md", "json", "dot", "mermaid"]).default("md"),
      top_modules: z.number().int().min(0).max(200).default(0),
      sort_by: z.enum(["loc", "symbols", "fan_in", "fan_out", "name"]).default("loc"),
      detail: z.enum(["compact", "full"]).default("compact"),
      summary_only: z.boolean().default(false),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const format = stringArg(args, "format") ?? "md";
      if (format === "md") return textResult(exportMarkdown(snapshot, store));
      if (format === "dot") return textResult(exportDot(snapshot, { scope: "module" }));
      if (format === "mermaid") return textResult(exportMermaid(snapshot, { scope: "module" }));

      const sortBy = stringArg(args, "sort_by") ?? "loc";
      const moduleSummaries = getModuleSummaries(snapshot).sort((a, b) => {
        switch (sortBy) {
          case "symbols":
            return b.symbols - a.symbols;
          case "fan_in":
            return b.fanIn - a.fanIn;
          case "fan_out":
            return b.fanOut - a.fanOut;
          case "name":
            return a.name.localeCompare(b.name);
          default:
            return b.prodLoc - a.prodLoc;
        }
      });
      const topModules = numberArg(args, "top_modules", 0);
      const selected = topModules > 0 ? moduleSummaries.slice(0, topModules) : moduleSummaries;
      const payload = buildReportPayload(snapshot, store);
      return jsonResult({
        metrics: payload.metrics,
        coverage: payload.coverage,
        modules: selected,
        module_edges: getModuleEdges(snapshot),
        module_cycles: snapshot.moduleCycles,
        hotspots: boolArg(args, "summary_only", false) ? [] : payload.hotspots.slice(0, 20),
        detail: stringArg(args, "detail") ?? "compact",
      });
    }
  );

  register(
    "get_module_overview",
    "Compact module rollup with files, dependencies, hotspots, and test reachability.",
    {
      module: z.string(),
      format: z.enum(["md", "json"]).default("json"),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleName = stringArg(args, "module");
      if (!moduleName) return errorResult({ error: "module_required" });
      if (stringArg(args, "format") === "md") return textResult(moduleMarkdown(snapshot, moduleName));
      return jsonResult(getModuleOverview(snapshot, moduleName));
    }
  );

  register(
    "get_dependency_graph",
    "Module or file dependency BFS with fan-in/fan-out ranking (json|dot|mermaid).",
    {
      format: z.enum(["json", "dot", "mermaid"]).default("json"),
      scope: z.enum(["module", "file"]).default("module"),
      root: z.string().optional(),
      depth: z.number().int().min(1).max(10).default(2),
      direction: z.enum(["out", "in", "both"]).default("both"),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const format = stringArg(args, "format") ?? "json";
      const scope = (stringArg(args, "scope") as "module" | "file" | undefined) ?? "module";
      const root = stringArg(args, "root");
      const depth = numberArg(args, "depth", 2);
      const direction = (stringArg(args, "direction") as "out" | "in" | "both" | undefined) ?? "both";
      if (format === "dot") {
        return textResult(exportDot(snapshot, { scope, root, depth, direction }));
      }
      if (format === "mermaid") {
        return textResult(exportMermaid(snapshot, { scope, root, depth, direction }));
      }
      return jsonResult(getDependencyGraph(snapshot, { scope, root, depth, direction }));
    }
  );

  register(
    "explain_dependency",
    "Exact imports, symbol edges, and file:line sites behind a module-to-module dependency.",
    {
      from: z.string(),
      to: z.string(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const from = stringArg(args, "from");
      const to = stringArg(args, "to");
      if (!from || !to) return errorResult({ error: "from_and_to_required" });
      return jsonResult(explainDependency(snapshot, from, to));
    }
  );

  register(
    "lookup_symbol",
    "Find symbols by canonical ID, name, file path, or fuzzy text with summary cache metadata.",
    {
      query: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const query = stringArg(args, "query");
      if (!query) return errorResult({ error: "query_required" });
      const matches = getSymbolMatches(snapshot, query, numberArg(args, "limit", 10));
      return jsonResult(
        matches.map((symbol) => ({
          ...leanSymbol(snapshot, store, symbol),
          source_preview: symbol.sourcePreview.slice(0, 1200),
        }))
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
      offset: z.number().int().min(0).default(0),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const result = getApiSurface(snapshot, {
        module: stringArg(args, "module"),
        kind: stringArg(args, "kind"),
        limit: numberArg(args, "limit", 100),
        offset: numberArg(args, "offset", 0),
      });
      return jsonResult({
        total: result.total,
        symbols: result.symbols.map((symbol) => leanSymbol(snapshot, store, symbol)),
      });
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
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      return jsonResult({
        symbol: leanSymbol(snapshot, store, resolved.symbol),
        references: getReferences(snapshot, resolved.symbol.id, {
          includeImports: boolArg(args, "include_imports", false),
          limit: numberArg(args, "limit", 500),
        }),
      });
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
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        getCallGraph(snapshot, resolved.symbol.id, {
          depth: numberArg(args, "depth", 2),
          direction: (stringArg(args, "direction") as "callers" | "callees" | "both" | undefined) ?? "both",
        })
      );
    }
  );

  register(
    "get_component_tree",
    "React render graph, wrapper HOCs, hooks, and context providers/consumers.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      depth: z.number().int().min(1).max(6).default(2),
      direction: z.enum(["children", "parents", "both"]).default("both"),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        getComponentTree(snapshot, resolved.symbol.id, {
          depth: numberArg(args, "depth", 2),
          direction: (stringArg(args, "direction") as "children" | "parents" | "both" | undefined) ?? "both",
        })
      );
    }
  );

  register(
    "find_implementations",
    "Interface-to-class/type implementation matrix including structural matches.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const query = stringArg(args, "symbol_id", "symbolId");
      if (query) {
        const resolved = resolveSymbol(snapshot, query);
        if ("error" in resolved) return resolved.error;
        return jsonResult(findImplementations(snapshot, resolved.symbol.id));
      }
      return jsonResult(findImplementations(snapshot));
    }
  );

  register(
    "get_impact_analysis",
    "Kind-aware blast radius: components, hooks, callers, test files, modules, and suggested commands.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      max_depth: z.number().int().min(1).max(8).default(4),
      maxDepth: z.number().int().min(1).max(8).optional(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      return jsonResult(
        getImpactAnalysis(snapshot, resolved.symbol.id, numberArg(args, "max_depth", numberArg(args, "maxDepth", 4)))
      );
    }
  );

  register(
    "get_dead_code",
    "Unreachable symbols after entrypoint, test, generated-file, and React framework exemptions.",
    {
      include_exported: z.boolean().default(false),
      module: z.string().optional(),
      kind: z.string().optional(),
      group_by: z.enum(["none", "module", "kind"]).default("none"),
      limit: z.number().int().min(1).max(1000).default(200),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const kindFilter = stringArg(args, "kind");
      let symbols = getDeadCode(snapshot, boolArg(args, "include_exported", false));
      if (moduleFilter) symbols = symbols.filter((symbol) => symbol.module === moduleFilter);
      if (kindFilter) symbols = symbols.filter((symbol) => symbol.kind === kindFilter);
      const total = symbols.length;
      symbols = symbols.slice(0, numberArg(args, "limit", 200));
      const lean = symbols.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        module: symbol.module,
        file: symbol.file,
        line: symbol.line,
        loc: symbol.loc,
        complexity: symbol.complexity,
        exported: symbol.exported,
      }));
      const groupBy = stringArg(args, "group_by") ?? "none";
      if (groupBy === "none") return jsonResult({ total, symbols: lean });
      const groups: Record<string, unknown[]> = {};
      for (const symbol of lean) {
        const key = groupBy === "module" ? symbol.module : symbol.kind;
        (groups[key] ??= []).push(symbol);
      }
      return jsonResult({ total, groups });
    }
  );

  register(
    "get_hotspots",
    "Rank components/hooks/functions/methods by complexity, fan-in, and test reachability.",
    {
      limit: z.number().int().min(1).max(500).default(25),
      module: z.string().optional(),
      untested_only: z.boolean().default(false),
      min_complexity: z.number().int().min(1).default(1),
      sort_by: z.enum(["risk", "complexity", "loc", "fan_in"]).default("risk"),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const untestedOnly = boolArg(args, "untested_only", false);
      const minComplexity = numberArg(args, "min_complexity", 1);
      let hotspots = getHotspots(snapshot, 5000).filter(
        (hotspot) =>
          (!moduleFilter || hotspot.module === moduleFilter) &&
          (!untestedOnly || !hotspot.testReachable) &&
          hotspot.complexity >= minComplexity
      );
      const sortBy = stringArg(args, "sort_by") ?? "risk";
      hotspots = hotspots.sort((a, b) => {
        switch (sortBy) {
          case "complexity":
            return b.complexity - a.complexity;
          case "loc":
            return b.loc - a.loc;
          case "fan_in":
            return b.fanIn - a.fanIn;
          default:
            return b.riskScore - a.riskScore;
        }
      });
      const total = hotspots.length;
      return jsonResult({ total, hotspots: hotspots.slice(0, numberArg(args, "limit", 25)) });
    }
  );

  register(
    "get_function_body",
    "Source body, LOC, and cyclomatic complexity for one symbol.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const body = getFunctionBody(snapshot, resolved.symbol.id);
      if (!body) return errorResult({ error: "symbol_not_found" });
      return jsonResult({
        symbol: leanSymbol(snapshot, store, resolved.symbol),
        source: body.source,
        loc: body.loc,
        complexity: body.complexity,
      });
    }
  );

  register(
    "list_stale_summaries",
    "Eligible symbols missing or stale in the shared summary cache, ordered bottom-up.",
    {
      limit: z.number().int().min(1).max(500).default(25),
      module: z.string().optional(),
      kind: z.string().optional(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const kindFilter = stringArg(args, "kind");
      const stale = store
        .listStale(snapshot, Math.max(numberArg(args, "limit", 25) * 4, 100))
        .filter((item) => (!moduleFilter || item.module === moduleFilter) && (!kindFilter || item.kind === kindFilter))
        .slice(0, numberArg(args, "limit", 25))
        .map((item) => ({
          ...item,
          fan_in: getFanCounts(snapshot, item.id).fanIn,
        }));
      return jsonResult(stale);
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
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const ids = [
        ...stringArrayArg(args, "symbol_ids"),
        ...stringArrayArg(args, "symbolIds"),
        ...parseIdList(stringArg(args, "symbol_id") ?? ""),
      ];
      if (ids.length === 0) return errorResult({ error: "symbol_ids_required" });
      const includeSource = boolArg(args, "include_source", true);
      const items = ids.slice(0, 25).map((id) => {
        const resolved = resolveSymbol(snapshot, id);
        if ("error" in resolved) return { id, error: "not_found" };
        const symbol = resolved.symbol;
        const resolvedSummary = store.resolveSummary(symbol);
        const body = includeSource ? getFunctionBody(snapshot, symbol.id) : null;
        return {
          symbol: leanSymbol(snapshot, store, symbol),
          prompt_version: store.promptVersion,
          schema: isCallableKind(symbol.kind) ? SUMMARY_SCHEMA.callable : SUMMARY_SCHEMA.type,
          sync_state: resolvedSummary.state,
          reason: resolvedSummary.reason,
          deps_changed: resolvedSummary.depsChanged,
          previous_summary:
            resolvedSummary.previousSummary ??
            (resolvedSummary.state === "soft_stale" ? resolvedSummary.summary : null),
          source: body?.source,
          dependencies: symbolDependencyContext(snapshot, store, symbol.id),
        };
      });
      return jsonResult(items);
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
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const rawEntries = (args.entries as Array<Record<string, unknown>> | undefined) ?? [];
      const entries: SummaryUpsertEntry[] = rawEntries.map((entry) => ({
        symbolId: String(entry.symbol_id ?? entry.symbolId ?? ""),
        summary: entry.summary,
        expectedContentHash:
          typeof entry.expected_content_hash === "string"
            ? entry.expected_content_hash
            : typeof entry.expectedContentHash === "string"
              ? entry.expectedContentHash
              : undefined,
        expectedSelfHash: typeof entry.expected_self_hash === "string" ? entry.expected_self_hash : undefined,
        expectedDepHash: typeof entry.expected_dep_hash === "string" ? entry.expected_dep_hash : undefined,
        modelId: typeof entry.model_id === "string" ? entry.model_id : undefined,
      }));
      return jsonResult(store.upsertSummaries(entries, snapshot));
    }
  );

  register(
    "get_summary_coverage",
    "Summary cache coverage by kind and module.",
    {
      module: z.string().optional(),
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      if (!moduleFilter) return jsonResult(store.getCoverage(snapshot));
      const filteredSnapshot: IndexSnapshot = {
        ...snapshot,
        symbols: new Map(
          [...snapshot.symbols].filter(([, symbol]) => symbol.module === moduleFilter)
        ),
      };
      return jsonResult(store.getCoverage(filteredSnapshot));
    }
  );

  register("run_tests", "Run the project's configured test runner.", { timeout_seconds: z.number().int().min(10).max(1800).default(900) }, async (args) => {
    const snapshot = await controller.getSnapshot();
    const runner = detectTestRunner(snapshot.root, controller.indexer.config);
    if (!runner.available || !runner.command) {
      return errorResult({ error: "test_runner_not_found", hint: runner.hint, source: runner.source });
    }
    const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 900) * 1000);
    return {
      ...jsonResult({ runner: runner.source, ...result }),
      ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
    };
  });

  register("run_typecheck", "Run the project's type checker (tsc --noEmit by default).", { timeout_seconds: z.number().int().min(10).max(1800).default(900) }, async (args) => {
    const snapshot = await controller.getSnapshot();
    const runner = detectTypecheckRunner(snapshot.root, controller.indexer.config);
    if (!runner.available || !runner.command) {
      return errorResult({ error: "typecheck_runner_not_found", hint: runner.hint, source: runner.source });
    }
    const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 900) * 1000);
    return {
      ...jsonResult({ runner: runner.source, ...result }),
      ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
    };
  });

  register("run_lint", "Run the project's configured linter (eslint, biome, or package script).", { timeout_seconds: z.number().int().min(10).max(1800).default(600) }, async (args) => {
    const snapshot = await controller.getSnapshot();
    const runner = detectLintRunner(snapshot.root, controller.indexer.config);
    if (!runner.available || !runner.command) {
      return errorResult({ error: "lint_runner_not_found", hint: runner.hint, source: runner.source });
    }
    const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 600) * 1000);
    return {
      ...jsonResult({ runner: runner.source, ...result }),
      ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
    };
  });

  register("reindex", "Force a full index rebuild and working database sync.", { full_diagnostics: z.boolean().default(true) }, async (args) => {
    const snapshot = await controller.rebuild({
      fullDiagnostics: boolArg(args, "full_diagnostics", true),
    });
    return jsonResult({
      project_id: snapshot.projectId,
      indexed_at: snapshot.indexedAt,
      duration_ms: snapshot.durationMs,
      symbols: snapshot.symbols.size,
      edges: snapshot.edges.length,
      files: snapshot.filesCount,
      modules: snapshot.modules.length,
      prod_errors: snapshot.prodErrors.length,
      warnings: snapshot.warnings.length,
      storage: store.getInfo(),
    });
  });

  return tools;
}
