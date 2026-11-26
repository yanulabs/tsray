import { z } from "zod";
import {
  findImplementations,
  getComponentTree,
  getImpactAnalysis,
} from "../../index/queries.js";
import { compactEdge, paginate } from "../response.js";
import { boolArg, numberArg, stringArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { impactSymbolResult } from "../shared/projections.js";
import { jsonResult } from "../shared/results.js";
import {
  compactTrue,
  maxCharsOptional,
  offsetOptional,
} from "../shared/schema.js";
import { resolveSymbol, symbolResult } from "../shared/symbols.js";

export function registerReactTools(context: ToolContext): void {
  const { controller, store, register } = context;

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
        direction:
          (stringArg(args, "direction") as
            | "children"
            | "parents"
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
      const contextPage = paginate(
        graph.contexts,
        numberArg(args, "context_offset", 0),
        numberArg(args, "context_limit", 100)
      );
      const hookPage = paginate(
        graph.hooks,
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
      const page = paginate(
        interfaces,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 100)
      );
      const implementationLimit = numberArg(args, "implementation_limit", 50);
      const implementationOffset = numberArg(args, "implementation_offset", 0);
      const items = page.items.map((entry) => {
        const implementationPage = paginate(
          entry.implementations,
          implementationOffset,
          implementationLimit
        );
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
      const componentPage = paginate(
        impact.impactedComponents,
        impactOffset,
        impactLimit
      );
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
          next_impact_offset: [
            componentPage,
            hookPage,
            callerPage,
            filePage,
            testPage,
            modulePage,
          ].some((page) => page.next_offset !== null)
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
}
