import { z } from "zod";
import { boolArg, numberArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { jsonResult } from "../shared/results.js";
import { maxCharsOptional } from "../shared/schema.js";

export function registerMaintenanceTools(context: ToolContext): void {
  const { controller, store, register } = context;

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
}
