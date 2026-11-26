import { z } from "zod";
import { matchesAny } from "../../util/glob.js";
import { VERSION } from "../../version.js";
import { boolArg, numberArg, stringArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { jsonResult } from "../shared/results.js";
import {
  compactTrue,
  maxCharsOptional,
  offsetOptional,
} from "../shared/schema.js";

export function registerProjectTools(context: ToolContext): void {
  const { controller, store, register, toolNames } = context;

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
        prod_errors: snapshot.prodErrors
          .slice(0, 5)
          .map((item) =>
            `${item.file}:${item.line} TS${item.code} ${item.message}`.slice(0, 50)
          ),
        prod_errors_truncated: snapshot.prodErrors.length > 5,
        warnings: snapshot.warnings
          .slice(0, 5)
          .map((item) =>
            `${item.file}:${item.line} TS${item.code} ${item.message}`.slice(0, 50)
          ),
        warnings_truncated: snapshot.warnings.length > 5,
        db_path: storage.db_path,
        summary_db_path: storage.summary_db_path,
        summary_coverage_percent: store.getCoverage(snapshot).percent,
      };
      if (!verbose) {
        return jsonResult(summary, numberArg(args, "max_chars", 20_000));
      }

      const filter = stringArg(args, "project_filter")?.toLowerCase();
      const matchesProject = (value: string): boolean =>
        !filter || value.toLowerCase().includes(filter) || matchesAny([filter], value);
      const allProjects = (snapshot.projectDetails ?? []).filter((project) =>
        matchesProject(project.project)
      );
      const allConfigs = snapshot.projectConfigs.filter((project) =>
        matchesProject(project.path)
      );
      const offset = Math.max(0, numberArg(args, "offset", 0));
      const limit = Math.max(1, numberArg(args, "limit", 20));
      const projects = allProjects.slice(offset, offset + limit);
      const projectConfigs = allConfigs.slice(offset, offset + limit);
      const diagnosticSample = (items: typeof snapshot.prodErrors) =>
        items.slice(0, 5).map((item) => ({
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
          eligible: [...snapshot.symbols.values()].filter((symbol) => symbol.eligible)
            .length,
          summary_prompt_version: store.promptVersion,
          tool_count: toolNames.length,
          diagnostics: {
            prod_errors: diagnosticSample(snapshot.prodErrors),
            warnings: diagnosticSample(snapshot.warnings),
            current_prod_errors:
              status.prod_errors > 0
                ? diagnosticSample(
                    controller.indexer.getLastSnapshot()?.prodErrors ?? []
                  )
                : [],
          },
          storage,
        },
        Math.min(numberArg(args, "max_chars", 12_000), 12_000)
      );
    }
  );
}
