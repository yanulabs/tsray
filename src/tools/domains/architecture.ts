import { z } from "zod";
import type { IndexSnapshot } from "../../index/types.js";
import {
  explainDependency,
  getDeadCode,
  getDependencyGraph,
  getHotspots,
  getModuleEdges,
  getModuleSummaries,
  getModuleOverview,
} from "../../index/queries.js";
import { exportDot, exportMarkdown, exportMermaid } from "../../render/exporters.js";
import { compactEdge, paginate } from "../response.js";
import { boolArg, numberArg, stringArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import {
  compactCoverage,
  compactModuleEdge,
  compactModuleSummary,
  fullModuleSummary,
  hotspotResult,
} from "../shared/projections.js";
import { errorResult, jsonResult, textResult } from "../shared/results.js";
import { compactTrue, maxCharsOptional, offsetOptional } from "../shared/schema.js";

function moduleMarkdown(snapshot: IndexSnapshot, moduleName: string): string {
  const overview = getModuleOverview(snapshot, moduleName);
  if (!overview.module) {
    return `# Module ${moduleName}\n\nNo module named \`${moduleName}\` was indexed.\n`;
  }
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
    lines.push(
      "",
      "## Dependencies",
      "",
      "| Direction | Module | Imports | Symbol edges |",
      "| --- | --- | ---: | ---: |"
    );
    for (const edge of overview.dependencies) {
      lines.push(
        `| ${edge.from === module.name ? "out" : "in"} | \`${
          edge.from === module.name ? edge.to : edge.from
        }\` | ${edge.imports} | ${edge.symbols} |`
      );
    }
  }
  if (overview.hotspots.length > 0) {
    lines.push(
      "",
      "## Hotspots",
      "",
      "| Symbol | Kind | File | Complexity | Fan-in | Risk |",
      "| --- | --- | --- | ---: | ---: | ---: |"
    );
    for (const hotspot of overview.hotspots) {
      lines.push(
        `| \`${hotspot.name}\` | ${hotspot.kind} | \`${hotspot.file}:${hotspot.line}\` | ${hotspot.complexity} | ${hotspot.fanIn} | ${hotspot.riskScore} |`
      );
    }
  }
  lines.push("", "## Files", "", "| File | LOC | Exports | Test |", "| --- | ---: | ---: | --- |");
  for (const file of overview.files) {
    lines.push(
      `| \`${file.path}\` | ${file.loc} | ${file.exports} | ${file.is_test ? "yes" : "no"} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerArchitectureTools(context: ToolContext): void {
  const { controller, store, register } = context;

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
      if (format === "dot") {
        return textResult(exportDot(snapshot, { scope: "module" }), maxChars);
      }
      if (format === "mermaid") {
        return textResult(exportMermaid(snapshot, { scope: "module" }), maxChars);
      }

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
            components: symbols.filter(
              (symbol) => symbol.kind === "component" && !symbol.isTest
            ).length,
            hooks: symbols.filter((symbol) => symbol.kind === "hook" && !symbol.isTest)
              .length,
            contexts: symbols.filter(
              (symbol) => symbol.kind === "context" && !symbol.isTest
            ).length,
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
      if (stringArg(args, "format") === "md") {
        return textResult(moduleMarkdown(snapshot, moduleName), maxChars);
      }
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
          dependencies: dependencyPage.items.map((edge) =>
            compactModuleEdge(edge, compact)
          ),
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
      const direction =
        (stringArg(args, "direction") as "out" | "in" | "both" | undefined) ??
        "both";
      if (format === "dot") {
        return textResult(
          exportDot(snapshot, { scope, root, depth, direction }),
          maxChars
        );
      }
      if (format === "mermaid") {
        return textResult(
          exportMermaid(snapshot, { scope, root, depth, direction }),
          maxChars
        );
      }
      const graph = getDependencyGraph(snapshot, { scope, root, depth, direction });
      const nodePage = paginate(
        graph.nodes,
        numberArg(args, "node_offset", 0),
        numberArg(args, "max_nodes", 500)
      );
      const allowed = new Set(nodePage.items.map((node) => node.id));
      const pageEdges = graph.edges.filter(
        (edge) => allowed.has(edge.from) && allowed.has(edge.to)
      );
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
          truncated:
            nodePage.truncated ||
            edgePage.truncated ||
            pageEdges.length !== graph.edges.length,
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
}
