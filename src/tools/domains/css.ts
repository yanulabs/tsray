import { z } from "zod";
import { resolveCascade, resolveCssImpact } from "../../css/queries.js";
import { runRuntimeCheck } from "../../css/runtime-check.js";
import type { CssAnalysisRequest } from "../../css/service.js";
import { boolArg, numberArg, stringArg, stringArrayArg } from "../shared/args.js";
import type { ToolArgs } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { errorResult, jsonResult } from "../shared/results.js";
import { maxCharsOptional } from "../shared/schema.js";

function cssAnalysisRequest(
  args: ToolArgs,
  auditGlobalClasses = false
): CssAnalysisRequest {
  return {
    extraCssFiles: stringArrayArg(args, "extra_css_files"),
    includeGenerated: boolArg(args, "include_generated", false),
    auditGlobalClasses:
      auditGlobalClasses && boolArg(args, "audit_global_classes", false),
  };
}

export function registerCssTools(context: ToolContext): void {
  const { cssAnalysis, register } = context;

  register(
    "css_diagnostics",
    "Deterministically analyze imported CSS and CSS Modules plus TypeScript className bindings. Detects syntax/value errors, undefined or cyclic custom properties, inert declarations, duplicate properties, missing or unused CSS Module classes, and opt-in possibly-unused global classes.",
    {
      extra_css_files: z
        .array(z.string())
        .optional()
        .describe(
          "Additional CSS files not imported from TypeScript, relative to the project root."
        ),
      include_generated: z
        .boolean()
        .default(false)
        .describe("Also analyze auto-discovered dist/build/generated CSS."),
      audit_global_classes: z
        .boolean()
        .default(false)
        .describe(
          "Report plain CSS classes without a statically resolved className binding."
        ),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const analysis = cssAnalysis.analyze(cssAnalysisRequest(args, true));
      const errors = analysis.diagnostics.filter(
        (item) => item.severity === "error"
      );
      return jsonResult(
        {
          ok: errors.length === 0,
          root: analysis.root,
          indexed_at: analysis.indexedAt,
          css_files: analysis.files,
          tailwind_files: analysis.tailwindFiles,
          stats: analysis.stats,
          error_count: errors.length,
          warning_count: analysis.diagnostics.length - errors.length,
          possibly_unused_global_classes: analysis.diagnostics.filter(
            (item) => item.code === "POSSIBLY_UNUSED_GLOBAL_CLASS"
          ).length,
          skipped_preprocessors: analysis.skippedPreprocessors,
          skipped_files: analysis.skippedFiles,
          diagnostics: analysis.diagnostics,
        },
        numberArg(args, "max_chars", 40_000)
      );
    }
  );

  register(
    "css_impact",
    "Returns definitions, consumers, rules, and TypeScript components impacted by a CSS custom property (--token) or class selector (.name).",
    {
      symbol: z
        .string()
        .describe(
          "CSS custom property (e.g. '--color-primary'), class (e.g. '.card'), or ID ('#header')."
        ),
      extra_css_files: z.array(z.string()).optional(),
      include_generated: z
        .boolean()
        .default(false)
        .describe("Also analyze auto-discovered dist/build/generated CSS."),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const symbol = stringArg(args, "symbol");
      if (!symbol) return errorResult({ error: "symbol_required" });
      const analysis = cssAnalysis.analyze(cssAnalysisRequest(args));
      return jsonResult(
        resolveCssImpact(analysis, symbol),
        numberArg(args, "max_chars", 30_000)
      );
    }
  );

  register(
    "css_cascade",
    "Resolves CSS Cascade Level 5 priority (!important, @layer order, specificity, source order) per property for rules whose subject (rightmost compound selector) matches the query.",
    {
      selector_query: z
        .string()
        .describe(
          "Selector fragment to inspect, e.g. '.card', '#header', or 'button.primary'."
        ),
      property: z
        .string()
        .optional()
        .describe("Optional property filter, e.g. 'color'."),
      extra_css_files: z.array(z.string()).optional(),
      include_generated: z
        .boolean()
        .default(false)
        .describe("Also analyze auto-discovered dist/build/generated CSS."),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const query = stringArg(args, "selector_query");
      if (!query) return errorResult({ error: "selector_query_required" });
      const analysis = cssAnalysis.analyze(cssAnalysisRequest(args));
      return jsonResult(
        {
          selector_query: query,
          properties: resolveCascade(
            analysis,
            query,
            stringArg(args, "property")
          ),
        },
        numberArg(args, "max_chars", 40_000)
      );
    }
  );

  register(
    "css_runtime_check",
    "Optional headless Playwright check (lazy-loaded) across mobile and desktop viewports. Verifies horizontal overflow, clipped text, and collapsed or obscured interactive elements while ignoring SVG and screen-reader utility nodes.",
    {
      url: z
        .string()
        .min(1)
        .describe("Local dev server, application, or file:// URL to inspect."),
      viewports: z
        .array(
          z.object({
            name: z.string().min(1),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
        )
        .optional()
        .describe(
          "Viewports to inspect (defaults to 375x812 mobile and 1440x900 desktop)."
        ),
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const url = stringArg(args, "url");
      if (!url) return errorResult({ error: "url_required" });
      const rawViewports = Array.isArray(args.viewports) ? args.viewports : [];
      const viewports = rawViewports
        .filter(
          (item): item is { name: string; width: number; height: number } =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as { name?: unknown }).name === "string" &&
            typeof (item as { width?: unknown }).width === "number" &&
            typeof (item as { height?: unknown }).height === "number"
        )
        .map((item) => ({
          name: item.name,
          width: Math.max(1, Math.trunc(item.width)),
          height: Math.max(1, Math.trunc(item.height)),
        }));
      const result = await runRuntimeCheck(
        url,
        viewports.length > 0 ? viewports : undefined
      );
      return jsonResult(result, numberArg(args, "max_chars", 40_000));
    }
  );
}
