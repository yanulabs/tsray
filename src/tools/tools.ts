import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DualCacheStore, SummaryCoverage, SummaryUpsertEntry } from "../cache/store.js";
import { SUMMARY_SCHEMA, isCallableKind } from "../cache/summary.js";
import type { IndexController } from "../index/watch.js";
import type {
  HotspotRecord,
  ImpactSymbol,
  IndexSnapshot,
  ModuleEdgeSummary,
  ModuleSummary,
  SymbolRecord,
} from "../index/types.js";
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
import { exportDot, exportMarkdown, exportMermaid } from "../render/exporters.js";
import { detectLintRunner, detectTestRunner, detectTypecheckRunner, runCommand } from "./runner.js";
import type { CommandResult } from "./runner.js";
import {
  compactEdge,
  compactSymbol,
  jsonToolResult,
  paginate,
  textToolResult,
  truncateLog,
  truncateText,
} from "./response.js";
import { VERSION } from "../version.js";
import { matchesAny } from "../util/glob.js";

type ToolArgs = Record<string, unknown>;

const compactTrue = z.boolean().default(true);
const maxCharsOptional = z.number().int().min(1000).max(200_000).optional();
const outputChars = z.number().int().min(0).max(100_000).default(12_000);
const offsetOptional = z.number().int().min(0).default(0);

function jsonResult(value: unknown, maxChars = Number.POSITIVE_INFINITY): CallToolResult {
  return jsonToolResult(value, maxChars);
}

function textResult(text: string, maxChars = Number.POSITIVE_INFINITY): CallToolResult {
  return textToolResult(text, maxChars);
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

function symbolResult(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbol: SymbolRecord,
  compact = false
): Record<string, unknown> {
  return compact
    ? compactSymbol(symbol, store.getStaleness(symbol))
    : leanSymbol(snapshot, store, symbol);
}

function symbolDependencyContext(
  snapshot: IndexSnapshot,
  store: DualCacheStore,
  symbolId: string,
  options: { limit?: number; offset?: number; includeSource?: boolean; compact?: boolean } = {}
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

function compactModuleSummary(module: ModuleSummary): Record<string, unknown> {
  return {
    name: module.name,
    files: module.files,
    symbols: module.symbols,
    components: module.components,
    hooks: module.hooks,
    exported: module.exported,
    prod_loc: module.prodLoc,
    test_loc: module.testLoc,
    fan_in: module.fanIn,
    fan_out: module.fanOut,
    entrypoints: module.entrypoints,
    generated_files: module.generatedFiles,
    test_reachable: module.testReachable,
    in_modules: module.inModules,
    out_modules: module.outModules,
  };
}

function fullModuleSummary(module: ModuleSummary): Record<string, unknown> {
  return { ...compactModuleSummary(module), loc: module.loc };
}

function compactModuleEdge(edge: ModuleEdgeSummary, compact: boolean): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    imports: edge.imports,
    symbols: edge.symbols,
    ...(compact ? { files_count: edge.files.length } : { files: edge.files }),
  };
}

function hotspotResult(hotspot: HotspotRecord): Record<string, unknown> {
  return {
    id: hotspot.id,
    name: hotspot.name,
    kind: hotspot.kind,
    module: hotspot.module,
    file: hotspot.file,
    line: hotspot.line,
    loc: hotspot.loc,
    complexity: hotspot.complexity,
    fan_in: hotspot.fanIn,
    test_reachable: hotspot.testReachable,
    risk_score: hotspot.riskScore,
  };
}

function impactSymbolResult(symbol: ImpactSymbol): Record<string, unknown> {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    is_test: symbol.isTest,
  };
}

function compactCoverage(coverage: SummaryCoverage): Record<string, unknown> {
  return {
    eligible: coverage.eligible,
    synced: coverage.synced,
    soft_stale: coverage.soft_stale,
    hard_stale: coverage.hard_stale,
    missing: coverage.missing,
    not_eligible: coverage.not_eligible,
    percent: coverage.percent,
  };
}

function commandResult(
  runner: string,
  result: CommandResult,
  outputLimit: number,
  maxChars: number
): CallToolResult {
  let streamLimit = outputLimit;
  let payload: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 12; attempt++) {
    const stdout = truncateLog(result.stdout, streamLimit);
    const stderr = truncateLog(result.stderr, streamLimit);
    payload = {
      runner,
      command: result.command,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_original_chars: result.stdout_chars,
      stderr_original_chars: result.stderr_chars,
      truncated: result.truncated || stdout.truncated || stderr.truncated,
    };
    if (!Number.isFinite(maxChars) || JSON.stringify(payload, null, 2).length <= maxChars) break;
    streamLimit = Math.floor(streamLimit / 2);
  }
  return jsonResult(payload, maxChars);
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

  register(
    "project_info",
    "Compact index state, graph counts, cache metrics, storage paths, and diagnostic samples.",
    {
      compact: compactTrue,
      verbose: z.boolean().default(false),
      project_filter: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const status = controller.status();
      const compact = boolArg(args, "compact", true);
      const verbose = boolArg(args, "verbose", false) || !compact;
      const storage = store.getInfo();
      const metrics = snapshot.projectMetrics ?? {
        projects_total: 0,
        projects_cached: 0,
        projects_rebuilt: 0,
        projects_empty: 0,
        workers_spawned: 0,
        diagnostics_cached: 0,
      };
      const summary = {
        project_id: snapshot.projectId,
        projectId: snapshot.projectId,
        root: snapshot.root,
        index_state: status.index_state,
        indexState: status.index_state,
        indexed_at: snapshot.indexedAt,
        indexedAt: snapshot.indexedAt,
        duration_ms: snapshot.durationMs,
        durationMs: snapshot.durationMs,
        graph_digest: snapshot.graphDigest,
        graphDigest: snapshot.graphDigest,
        files: snapshot.filesCount,
        symbols: snapshot.symbols.size,
        edges: snapshot.edges.length,
        modules: snapshot.modules.length,
        module_cycles: snapshot.moduleCycles.length,
        prod_errors_count: snapshot.prodErrors.length,
        warnings_count: snapshot.warnings.length,
        ...metrics,
        prod_errors: snapshot.prodErrors.slice(0, 5).map((item) =>
          `${item.file}:${item.line} TS${item.code} ${item.message}`.slice(0, 50)
        ),
        prod_errors_truncated: snapshot.prodErrors.length > 5,
        warnings: snapshot.warnings.slice(0, 5).map((item) =>
          `${item.file}:${item.line} TS${item.code} ${item.message}`.slice(0, 50)
        ),
        warnings_truncated: snapshot.warnings.length > 5,
        db_path: storage.db_path,
        summary_db_path: storage.summary_db_path,
        summary_coverage_percent: store.getCoverage(snapshot).percent,
      };
      if (!verbose) return jsonResult(summary, numberArg(args, "max_chars", 20_000));

      const filter = stringArg(args, "project_filter")?.toLowerCase();
      const matchesProject = (value: string): boolean =>
        !filter || value.toLowerCase().includes(filter) || matchesAny([filter], value);
      const allProjects = (snapshot.projectDetails ?? []).filter((project) => matchesProject(project.project));
      const allConfigs = snapshot.projectConfigs.filter((project) => matchesProject(project.path));
      const offset = Math.max(0, numberArg(args, "offset", 0));
      const limit = Math.max(1, numberArg(args, "limit", 20));
      const projects = allProjects.slice(offset, offset + limit);
      const projectConfigs = allConfigs.slice(offset, offset + limit);
      const diagnosticSample = (items: typeof snapshot.prodErrors) => items.slice(0, 5).map((item) => ({
        ...item,
        message: item.message.slice(0, 60),
      }));
      const hasMore = offset + projects.length < allProjects.length;
      return jsonResult(
        {
          ...summary,
          prod_errors: undefined,
          warnings: undefined,
          prod_errors_truncated: undefined,
          warnings_truncated: undefined,
          projectId: undefined,
          indexState: undefined,
          indexedAt: undefined,
          durationMs: undefined,
          graphDigest: undefined,
          version: VERSION,
          tsconfig_path: snapshot.tsconfigPath,
          project_configs: projectConfigs.map((project) => ({
            path: project.path,
            fileCount: project.fileCount,
          })),
          projects,
          total_projects: allProjects.length,
          returned: projects.length,
          offset,
          limit,
          has_more: hasMore,
          next_offset: hasMore ? offset + projects.length : null,
          project_filter: filter ?? null,
          workspace: controller.indexer.workspace,
          typescript_version: snapshot.typescriptVersion,
          eligible: [...snapshot.symbols.values()].filter((symbol) => symbol.eligible).length,
          summary_prompt_version: store.promptVersion,
          tool_count: tools.length,
          diagnostics: {
            prod_errors: diagnosticSample(snapshot.prodErrors),
            warnings: diagnosticSample(snapshot.warnings),
            current_prod_errors:
              status.prod_errors > 0
                ? diagnosticSample(controller.indexer.getLastSnapshot()?.prodErrors ?? [])
                : [],
          },
          storage,
        },
        Math.min(numberArg(args, "max_chars", 12_000), 12_000)
      );
    }
  );

  register(
    "get_codebase_map",
    "Module scorecard, cross-module edges, cycles, hotspots, and summary coverage (md|json|dot|mermaid).",
    {
      format: z.enum(["md", "json", "dot", "mermaid"]).default("md"),
      top_modules: z.number().int().min(0).max(200).default(0),
      sort_by: z.enum(["loc", "symbols", "fan_in", "fan_out", "name"]).default("loc"),
      detail: z.enum(["compact", "full"]).default("compact"),
      summary_only: z.boolean().default(false),
      offset: offsetOptional,
      edge_limit: z.number().int().min(1).max(1000).default(200),
      edge_offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const maxChars = numberArg(args, "max_chars", 30_000);
      const format = stringArg(args, "format") ?? "md";
      if (format === "md") return textResult(exportMarkdown(snapshot, store), maxChars);
      if (format === "dot") return textResult(exportDot(snapshot, { scope: "module" }), maxChars);
      if (format === "mermaid") return textResult(exportMermaid(snapshot, { scope: "module" }), maxChars);

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
      const requestedLimit = numberArg(args, "top_modules", 0);
      const modulePage = paginate(
        moduleSummaries,
        numberArg(args, "offset", 0),
        requestedLimit > 0 ? requestedLimit : moduleSummaries.length
      );
      const coverage = store.getCoverage(snapshot);
      const detail = stringArg(args, "detail") ?? "compact";
      const compact = detail === "compact";
      const edgePage = paginate(
        getModuleEdges(snapshot),
        numberArg(args, "edge_offset", 0),
        numberArg(args, "edge_limit", 200)
      );
      const symbols = [...snapshot.symbols.values()];
      return jsonResult(
        {
          metrics: {
            files: snapshot.filesCount,
            symbols: symbols.length,
            components: symbols.filter((symbol) => symbol.kind === "component" && !symbol.isTest).length,
            hooks: symbols.filter((symbol) => symbol.kind === "hook" && !symbol.isTest).length,
            contexts: symbols.filter((symbol) => symbol.kind === "context" && !symbol.isTest).length,
            edges: snapshot.edges.length,
            modules: snapshot.modules.length,
            cycles: snapshot.moduleCycles.length,
            dead: getDeadCode(snapshot, false).length,
            prod_errors: snapshot.prodErrors.length,
            warnings: snapshot.warnings.length,
            loc: moduleSummaries.reduce((total, module) => total + module.prodLoc, 0),
          },
          coverage: compact ? compactCoverage(coverage) : coverage,
          modules: modulePage.items.map((module) =>
            compact ? compactModuleSummary(module) : fullModuleSummary(module)
          ),
          total_modules: modulePage.total,
          offset: modulePage.offset,
          limit: modulePage.limit,
          next_offset: modulePage.next_offset,
          module_edges: edgePage.items.map((edge) => compactModuleEdge(edge, compact)),
          total_module_edges: edgePage.total,
          edge_offset: edgePage.offset,
          edge_limit: edgePage.limit,
          next_edge_offset: edgePage.next_offset,
          module_cycles: snapshot.moduleCycles,
          hotspots: boolArg(args, "summary_only", false)
            ? []
            : getHotspots(snapshot, 20).map(hotspotResult),
          detail,
        },
        maxChars
      );
    }
  );

  register(
    "get_module_overview",
    "Compact module rollup with files, dependencies, hotspots, and test reachability.",
    {
      module: z.string(),
      format: z.enum(["md", "json"]).default("json"),
      file_limit: z.number().int().min(1).max(1000).default(100),
      file_offset: offsetOptional,
      dependency_limit: z.number().int().min(1).max(1000).default(100),
      dependency_offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleName = stringArg(args, "module");
      if (!moduleName) return errorResult({ error: "module_required" });
      const maxChars = numberArg(args, "max_chars", 20_000);
      if (stringArg(args, "format") === "md") return textResult(moduleMarkdown(snapshot, moduleName), maxChars);
      const overview = getModuleOverview(snapshot, moduleName);
      const compact = boolArg(args, "compact", true);
      const filePage = paginate(
        overview.files,
        numberArg(args, "file_offset", 0),
        numberArg(args, "file_limit", 100)
      );
      const dependencyPage = paginate(
        overview.dependencies,
        numberArg(args, "dependency_offset", 0),
        numberArg(args, "dependency_limit", 100)
      );
      return jsonResult(
        {
          module: overview.module
            ? compact
              ? compactModuleSummary(overview.module)
              : fullModuleSummary(overview.module)
            : null,
          dependencies: dependencyPage.items.map((edge) => compactModuleEdge(edge, compact)),
          total_dependencies: dependencyPage.total,
          dependency_offset: dependencyPage.offset,
          dependency_limit: dependencyPage.limit,
          next_dependency_offset: dependencyPage.next_offset,
          hotspots: overview.hotspots.map(hotspotResult),
          files: filePage.items,
          total_files: filePage.total,
          file_offset: filePage.offset,
          file_limit: filePage.limit,
          next_file_offset: filePage.next_offset,
        },
        maxChars
      );
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
      max_nodes: z.number().int().min(1).max(5000).default(500),
      max_edges: z.number().int().min(1).max(20_000).default(2000),
      node_offset: offsetOptional,
      edge_offset: offsetOptional,
      rank_limit: z.number().int().min(1).max(1000).default(100),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const maxChars = numberArg(args, "max_chars", 30_000);
      const format = stringArg(args, "format") ?? "json";
      const scope = (stringArg(args, "scope") as "module" | "file" | undefined) ?? "module";
      const root = stringArg(args, "root");
      const depth = numberArg(args, "depth", 2);
      const direction = (stringArg(args, "direction") as "out" | "in" | "both" | undefined) ?? "both";
      if (format === "dot") {
        return textResult(exportDot(snapshot, { scope, root, depth, direction }), maxChars);
      }
      if (format === "mermaid") {
        return textResult(exportMermaid(snapshot, { scope, root, depth, direction }), maxChars);
      }
      const graph = getDependencyGraph(snapshot, { scope, root, depth, direction });
      const nodePage = paginate(
        graph.nodes,
        numberArg(args, "node_offset", 0),
        numberArg(args, "max_nodes", 500)
      );
      const allowed = new Set(nodePage.items.map((node) => node.id));
      const pageEdges = graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
      const edgePage = paginate(
        pageEdges,
        numberArg(args, "edge_offset", 0),
        numberArg(args, "max_edges", 2000)
      );
      return jsonResult(
        {
          scope,
          nodes: nodePage.items,
          edges: edgePage.items,
          rank: graph.rank.slice(0, numberArg(args, "rank_limit", 100)),
          total_nodes: nodePage.total,
          node_offset: nodePage.offset,
          node_limit: nodePage.limit,
          next_node_offset: nodePage.next_offset,
          total_edges: graph.edges.length,
          page_total_edges: pageEdges.length,
          edge_offset: edgePage.offset,
          edge_limit: edgePage.limit,
          next_edge_offset: edgePage.next_offset,
          truncated: nodePage.truncated || edgePage.truncated || pageEdges.length !== graph.edges.length,
        },
        maxChars
      );
    }
  );

  register(
    "explain_dependency",
    "Exact imports, symbol edges, and file:line sites behind a module-to-module dependency.",
    {
      from: z.string(),
      to: z.string(),
      include_tests: z.boolean().default(false),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: offsetOptional,
      symbol_limit: z.number().int().min(1).max(1000).default(100),
      symbol_offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const from = stringArg(args, "from");
      const to = stringArg(args, "to");
      if (!from || !to) return errorResult({ error: "from_and_to_required" });
      const result = explainDependency(snapshot, from, to, {
        includeTests: boolArg(args, "include_tests", false),
      });
      const page = paginate(
        result.file_imports,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 100)
      );
      const symbolPage = paginate(
        result.symbol_edges,
        numberArg(args, "symbol_offset", 0),
        numberArg(args, "symbol_limit", 100)
      );
      const symbolsPage = paginate(
        result.symbols,
        numberArg(args, "symbol_offset", 0),
        numberArg(args, "symbol_limit", 100)
      );
      return jsonResult(
        {
          from,
          to,
          file_imports: page.items,
          total_file_imports: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          symbol_edges: symbolPage.items.map(compactEdge),
          total_symbol_edges: symbolPage.total,
          symbol_offset: symbolPage.offset,
          symbol_limit: symbolPage.limit,
          next_symbol_offset: symbolPage.next_offset,
          symbol_edges_truncated: symbolPage.truncated,
          symbols: symbolsPage.items,
          total_symbols: symbolsPage.total,
          symbols_truncated: symbolsPage.truncated,
        },
        numberArg(args, "max_chars", 20_000)
      );
    }
  );

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
      const allMatches = getSymbolMatches(snapshot, query, Math.max(1, snapshot.symbols.size));
      const page = paginate(allMatches, numberArg(args, "offset", 0), numberArg(args, "limit", 10));
      const compact = boolArg(args, "compact", true);
      const includeSource = boolArg(args, "include_source", false);
      const sourceChars = numberArg(args, "source_chars", 1200);
      const symbols = page.items.map((symbol) => {
        const resolved = store.resolveSummary(symbol);
        const projected = compact
          ? { ...compactSymbol(symbol, resolved.state), summary: resolved.summary }
          : leanSymbol(snapshot, store, symbol);
        return includeSource
          ? { ...projected, source_preview: truncateText(symbol.sourcePreview, sourceChars).text }
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
      offset: z.number().int().min(0).default(0),
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
          next_offset: offset + result.symbols.length < result.total ? offset + result.symbols.length : null,
          symbols: result.symbols.map((symbol) => symbolResult(snapshot, store, symbol, compact)),
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
      const page = paginate(allReferences, numberArg(args, "offset", 0), numberArg(args, "limit", 500));
      return jsonResult(
        {
          symbol: symbolResult(snapshot, store, resolved.symbol, boolArg(args, "compact", true)),
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
        direction: (stringArg(args, "direction") as "callers" | "callees" | "both" | undefined) ?? "both",
      });
      const nodePage = paginate(
        graph.nodes,
        numberArg(args, "node_offset", 0),
        numberArg(args, "max_nodes", 200)
      );
      const allowed = new Set(nodePage.items.map((node) => node.id));
      const pageEdges = graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
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
          truncated: nodePage.truncated || edgePage.truncated || graph.truncated || pageEdges.length !== graph.edges.length,
        },
        numberArg(args, "max_chars", 30_000)
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
      max_nodes: z.number().int().min(1).max(2000).default(200),
      max_edges: z.number().int().min(1).max(10_000).default(1000),
      node_offset: offsetOptional,
      edge_offset: offsetOptional,
      context_limit: z.number().int().min(1).max(1000).default(100),
      context_offset: offsetOptional,
      hook_limit: z.number().int().min(1).max(1000).default(100),
      hook_offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const graph = getComponentTree(snapshot, resolved.symbol.id, {
        depth: numberArg(args, "depth", 2),
        direction: (stringArg(args, "direction") as "children" | "parents" | "both" | undefined) ?? "both",
      });
      const nodePage = paginate(
        graph.nodes,
        numberArg(args, "node_offset", 0),
        numberArg(args, "max_nodes", 200)
      );
      const allowed = new Set(nodePage.items.map((node) => node.id));
      const pageEdges = graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
      const edgePage = paginate(
        pageEdges,
        numberArg(args, "edge_offset", 0),
        numberArg(args, "max_edges", 1000)
      );
      const compact = boolArg(args, "compact", true);
      const projectNode = (node: (typeof graph.nodes)[number]): Record<string, unknown> =>
        compact
          ? {
              id: node.id,
              name: node.name,
              kind: node.kind,
              module: node.module,
              file: node.file,
              line: node.line,
            }
          : { ...node };
      const contexts = graph.contexts;
      const hooks = graph.hooks;
      const contextPage = paginate(
        contexts,
        numberArg(args, "context_offset", 0),
        numberArg(args, "context_limit", 100)
      );
      const hookPage = paginate(
        hooks,
        numberArg(args, "hook_offset", 0),
        numberArg(args, "hook_limit", 100)
      );
      return jsonResult(
        {
          root: graph.root,
          nodes: nodePage.items.map(projectNode),
          edges: edgePage.items,
          contexts: contextPage.items.map(projectNode),
          hooks: hookPage.items.map(projectNode),
          total_nodes: nodePage.total,
          node_offset: nodePage.offset,
          node_limit: nodePage.limit,
          next_node_offset: nodePage.next_offset,
          total_edges: graph.edges.length,
          page_total_edges: pageEdges.length,
          edge_offset: edgePage.offset,
          edge_limit: edgePage.limit,
          next_edge_offset: edgePage.next_offset,
          total_contexts: contextPage.total,
          context_offset: contextPage.offset,
          context_limit: contextPage.limit,
          next_context_offset: contextPage.next_offset,
          total_hooks: hookPage.total,
          hook_offset: hookPage.offset,
          hook_limit: hookPage.limit,
          next_hook_offset: hookPage.next_offset,
          contexts_truncated: contextPage.truncated,
          hooks_truncated: hookPage.truncated,
          truncated:
            nodePage.truncated ||
            edgePage.truncated ||
            contextPage.truncated ||
            hookPage.truncated ||
            pageEdges.length !== graph.edges.length,
        },
        numberArg(args, "max_chars", 30_000)
      );
    }
  );

  register(
    "find_implementations",
    "Interface-to-class/type implementation matrix including structural matches.",
    {
      symbol_id: z.string().optional(),
      symbolId: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      offset: offsetOptional,
      implementation_limit: z.number().int().min(1).max(1000).default(50),
      implementation_offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const query = stringArg(args, "symbol_id", "symbolId");
      let interfaces: ReturnType<typeof findImplementations>;
      if (query) {
        const resolved = resolveSymbol(snapshot, query);
        if ("error" in resolved) return resolved.error;
        interfaces = findImplementations(snapshot, resolved.symbol.id);
      } else {
        interfaces = findImplementations(snapshot);
      }
      const page = paginate(interfaces, numberArg(args, "offset", 0), numberArg(args, "limit", 100));
      const implementationLimit = numberArg(args, "implementation_limit", 50);
      const implementationOffset = numberArg(args, "implementation_offset", 0);
      const items = page.items.map((entry) => {
        const implementationPage = paginate(entry.implementations, implementationOffset, implementationLimit);
        return {
          id: entry.interface.id,
          name: entry.interface.name,
          kind: entry.interface.kind,
          module: entry.interface.module,
          file: entry.interface.file,
          line: entry.interface.line,
          members: entry.interface.members,
          total_implementations: implementationPage.total,
          implementations: implementationPage.items.map((implementation) => ({
            id: implementation.id,
            name: implementation.name,
            kind: implementation.kind,
            module: implementation.module,
            file: implementation.file,
            line: implementation.line,
            via: implementation.via,
          })),
          implementation_offset: implementationPage.offset,
          implementation_limit: implementationPage.limit,
          next_implementation_offset: implementationPage.next_offset,
          implementations_truncated: implementationPage.truncated,
        };
      });
      return jsonResult(
        {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          interfaces: items,
        },
        numberArg(args, "max_chars", 30_000)
      );
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
      direct_limit: z.number().int().min(1).max(500).default(25),
      direct_offset: offsetOptional,
      impact_limit: z.number().int().min(1).max(1000).default(100),
      impact_offset: offsetOptional,
      compact: compactTrue,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const resolved = resolveSymbol(snapshot, stringArg(args, "symbol_id", "symbolId"));
      if ("error" in resolved) return resolved.error;
      const impact = getImpactAnalysis(
        snapshot,
        resolved.symbol.id,
        numberArg(args, "max_depth", numberArg(args, "maxDepth", 4))
      );
      const directPage = paginate(
        impact.directReferences,
        numberArg(args, "direct_offset", 0),
        numberArg(args, "direct_limit", 25)
      );
      const impactLimit = numberArg(args, "impact_limit", 100);
      const impactOffset = numberArg(args, "impact_offset", 0);
      const compact = boolArg(args, "compact", true);
      const componentPage = paginate(impact.impactedComponents, impactOffset, impactLimit);
      const hookPage = paginate(impact.impactedHooks, impactOffset, impactLimit);
      const callerPage = paginate(impact.impactedCallers, impactOffset, impactLimit);
      const filePage = paginate(impact.impactedFiles, impactOffset, impactLimit);
      const testPage = paginate(impact.impactedTestFiles, impactOffset, impactLimit);
      const modulePage = paginate(impact.impactedModules, impactOffset, impactLimit);
      return jsonResult(
        {
          target: symbolResult(snapshot, store, resolved.symbol, compact),
          risk: impact.risk,
          direct_references_count: impact.directReferencesCount,
          direct_references: directPage.items.map(compactEdge),
          direct_offset: directPage.offset,
          direct_limit: directPage.limit,
          next_direct_offset: directPage.next_offset,
          impacted_components: componentPage.items.map(impactSymbolResult),
          impacted_hooks: hookPage.items.map(impactSymbolResult),
          impacted_callers: callerPage.items.map(impactSymbolResult),
          total_impacted_components: componentPage.total,
          total_impacted_hooks: hookPage.total,
          total_impacted_callers: callerPage.total,
          impacted_files: filePage.items,
          impacted_modules: modulePage.items,
          impacted_test_files: testPage.items,
          total_impacted_files: filePage.total,
          total_impacted_modules: modulePage.total,
          total_impacted_test_files: testPage.total,
          impact_offset: impactOffset,
          impact_limit: impactLimit,
          next_impact_offset: [componentPage, hookPage, callerPage, filePage, testPage, modulePage].some(
            (page) => page.next_offset !== null
          )
            ? impactOffset + impactLimit
            : null,
          transitive_count: impact.transitiveCount,
          impact_truncated:
            directPage.truncated ||
            componentPage.truncated ||
            hookPage.truncated ||
            callerPage.truncated ||
            filePage.truncated ||
            testPage.truncated ||
            modulePage.truncated,
          suggested_commands: impact.suggestedCommands,
        },
        numberArg(args, "max_chars", 20_000)
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
      offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const kindFilter = stringArg(args, "kind");
      let symbols = getDeadCode(snapshot, boolArg(args, "include_exported", false));
      if (moduleFilter) symbols = symbols.filter((symbol) => symbol.module === moduleFilter);
      if (kindFilter) symbols = symbols.filter((symbol) => symbol.kind === kindFilter);
      const page = paginate(symbols, numberArg(args, "offset", 0), numberArg(args, "limit", 200));
      const lean = page.items.map((symbol) => ({
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
      const pagination = {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        next_offset: page.next_offset,
        truncated: page.truncated,
      };
      const groupBy = stringArg(args, "group_by") ?? "none";
      if (groupBy === "none") {
        return jsonResult({ ...pagination, symbols: lean }, numberArg(args, "max_chars", 20_000));
      }
      const groups: Record<string, unknown[]> = {};
      for (const symbol of lean) {
        const key = groupBy === "module" ? symbol.module : symbol.kind;
        (groups[key] ??= []).push(symbol);
      }
      return jsonResult({ ...pagination, groups }, numberArg(args, "max_chars", 20_000));
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
      offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const untestedOnly = boolArg(args, "untested_only", false);
      const minComplexity = numberArg(args, "min_complexity", 1);
      let hotspots = getHotspots(snapshot, Math.max(1, snapshot.symbols.size)).filter(
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
      const page = paginate(hotspots, numberArg(args, "offset", 0), numberArg(args, "limit", 25));
      return jsonResult(
        {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          truncated: page.truncated,
          hotspots: page.items.map(hotspotResult),
        },
        numberArg(args, "max_chars", 20_000)
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
      const source = truncateText(body.source, numberArg(args, "source_chars", 20_000));
      return jsonResult(
        {
          symbol: symbolResult(snapshot, store, resolved.symbol, boolArg(args, "compact", true)),
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
        .filter((item) => (!moduleFilter || item.module === moduleFilter) && (!kindFilter || item.kind === kindFilter));
      const page = paginate(stale, numberArg(args, "offset", 0), numberArg(args, "limit", 25));
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
        const source = body ? truncateText(body.source, numberArg(args, "source_chars", 12_000)) : null;
        return {
          symbol: symbolResult(snapshot, store, symbol, compact),
          hashes: {
            self: symbol.selfHash,
            dep: symbol.depHash,
            content: symbol.contentHash,
          },
          prompt_version: store.promptVersion,
          schema: isCallableKind(symbol.kind) ? SUMMARY_SCHEMA.callable : SUMMARY_SCHEMA.type,
          sync_state: resolvedSummary.state,
          reason: resolvedSummary.reason,
          deps_changed: resolvedSummary.depsChanged,
          previous_summary:
            resolvedSummary.previousSummary ??
            (resolvedSummary.state === "soft_stale" ? resolvedSummary.summary : null),
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
      return jsonResult(store.upsertSummaries(entries, snapshot), numberArg(args, "max_chars", 20_000));
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
              [...snapshot.symbols].filter(([, symbol]) => symbol.module === moduleFilter)
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

  register(
    "run_tests",
    "Run the project's configured test runner with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(900),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectTestRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({ error: "test_runner_not_found", hint: runner.hint, source: runner.source });
      }
      const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 900) * 1000);
      return {
        ...commandResult(runner.source, result, numberArg(args, "output_chars", 12_000), numberArg(args, "max_chars", 30_000)),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );

  register(
    "run_typecheck",
    "Run the project's type checker (tsc --noEmit by default) with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(900),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectTypecheckRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({ error: "typecheck_runner_not_found", hint: runner.hint, source: runner.source });
      }
      const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 900) * 1000);
      return {
        ...commandResult(runner.source, result, numberArg(args, "output_chars", 12_000), numberArg(args, "max_chars", 30_000)),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );

  register(
    "run_lint",
    "Run the project's configured linter with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(600),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectLintRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({ error: "lint_runner_not_found", hint: runner.hint, source: runner.source });
      }
      const result = await runCommand(snapshot.root, runner.command, numberArg(args, "timeout_seconds", 600) * 1000);
      return {
        ...commandResult(runner.source, result, numberArg(args, "output_chars", 12_000), numberArg(args, "max_chars", 30_000)),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );

  register(
    "reindex",
    "Force a full index rebuild and working database sync.",
    { full_diagnostics: z.boolean().default(true), max_chars: maxCharsOptional },
    async (args) => {
      const snapshot = await controller.rebuild({
        fullDiagnostics: boolArg(args, "full_diagnostics", true),
      });
      return jsonResult(
        {
          project_id: snapshot.projectId,
          indexed_at: snapshot.indexedAt,
          duration_ms: snapshot.durationMs,
          symbols: snapshot.symbols.size,
          edges: snapshot.edges.length,
          files: snapshot.filesCount,
          modules: snapshot.modules.length,
          prod_errors: snapshot.prodErrors.length,
          warnings: snapshot.warnings.length,
          index_state: controller.status(),
          storage: store.getInfo(),
        },
        numberArg(args, "max_chars", 20_000)
      );
    }
  );

  return tools;
}
