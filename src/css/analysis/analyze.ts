import fs from "node:fs";
import path from "node:path";
import { toPosix } from "../../util/paths.js";
import { validateGlobalClasses } from "../global-classes.js";
import { extractCssBindings } from "../tsx-extractor.js";
import type { CssAnalysis, CssAnalyzeOptions } from "../types.js";
import { CssAnalysisBuilder } from "./builder.js";

export function analyzeCss(options: CssAnalyzeOptions): CssAnalysis {
  const { root, projects } = options;
  const extraction = extractCssBindings(projects, root);
  const builder = new CssAnalysisBuilder(root);

  const initialFiles = new Set<string>();
  const explicitFiles = new Set<string>();
  for (const file of extraction.cssFiles) initialFiles.add(path.resolve(file));
  for (const extra of options.extraCssFiles ?? []) {
    const absolute = path.isAbsolute(extra) ? path.resolve(extra) : path.resolve(root, extra);
    if (fs.existsSync(absolute)) {
      initialFiles.add(absolute);
      explicitFiles.add(absolute);
    } else {
      builder.skippedFiles.push({
        file: toPosix(extra),
        reason: "not-found",
        detail: "The extra CSS file does not exist.",
      });
    }
  }

  builder.addSkippedPreprocessors(extraction.skippedPreprocessors);
  builder.addUnresolvedImports(extraction.unresolvedImports);

  // `extractCssBindings` returns evaluation order (entry components first), so
  // keep it: layer statements depend on the first stylesheet that declares a
  // layer name. Do not re-sort alphabetically.
  for (const file of initialFiles) {
    builder.addFile(
      file,
      explicitFiles.has(file) || Boolean(options.includeGenerated)
    );
  }

  const bindings = builder.addBindings(extraction.bindings);
  if (options.auditGlobalClasses) {
    builder.diagnostics.push(
      ...validateGlobalClasses({ rules: builder.rules, bindings })
    );
  }
  const diagnostics = builder.finish();

  return {
    root,
    files: builder.files,
    tailwindFiles: builder.tailwindFiles,
    bindings,
    rules: builder.rules,
    variables: builder.variables,
    layers: builder.layers,
    skippedPreprocessors: extraction.skippedPreprocessors,
    skippedFiles: builder.skippedFiles,
    diagnostics,
    stats: {
      cssFiles: builder.files.length,
      rules: builder.rules.length,
      declarations: builder.rules.reduce(
        (total, rule) => total + rule.declarations.length,
        0
      ),
      variables: builder.variables.length,
      bindings: bindings.length,
      layers: builder.layers.length,
    },
    indexedAt: new Date().toISOString(),
  };
}
