import { boolValue, createContext, type CliValues } from "../command-context.js";

export function handleIndex(rest: string[], values: CliValues): void {
  const target = rest[0] ?? ".";
  const { indexer, store } = createContext(target, values);
  try {
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    const diagnosticLimit = boolValue(values.json) ? 0 : 20;
    for (const warning of snapshot.warnings.slice(0, diagnosticLimit)) {
      process.stderr.write(
        `[tsray] warning ${warning.file}:${warning.line} TS${warning.code} ${warning.message}\n`
      );
    }
    if (diagnosticLimit > 0 && snapshot.warnings.length > diagnosticLimit) {
      process.stderr.write(
        `[tsray] ${snapshot.warnings.length - diagnosticLimit} more warning(s) omitted\n`
      );
    }
    if (snapshot.prodErrors.length > 0) {
      process.stderr.write(
        `[tsray] ${snapshot.prodErrors.length} production TypeScript error(s); ` +
          (indexer.allowErrors
            ? "index updated with diagnostics\n"
            : "working database not updated\n")
      );
      for (const error of snapshot.prodErrors.slice(0, diagnosticLimit)) {
        process.stderr.write(
          `[tsray] error ${error.file}:${error.line} TS${error.code} ${error.message}\n`
        );
      }
      if (diagnosticLimit > 0 && snapshot.prodErrors.length > diagnosticLimit) {
        process.stderr.write(
          `[tsray] ${snapshot.prodErrors.length - diagnosticLimit} more error(s) omitted\n`
        );
      }
      if (!indexer.allowErrors) {
        process.exitCode = 1;
        return;
      }
    }

    store.syncWorking(snapshot);
    const coverage = store.getCoverage(snapshot);
    const result = {
      root: snapshot.root,
      project_id: snapshot.projectId,
      tsconfig_path: snapshot.tsconfigPath,
      tsconfig_paths: snapshot.tsconfigPaths,
      workspace: indexer.workspace,
      typescript_version: snapshot.typescriptVersion,
      db_path: store.workingPath,
      summary_db_path: store.summaryPath,
      files: snapshot.filesCount,
      modules: snapshot.modules.length,
      symbols: snapshot.symbols.size,
      eligible: coverage.eligible,
      edges: snapshot.edges.length,
      module_cycles: snapshot.moduleCycles.length,
      warnings: snapshot.warnings.length,
      prod_errors: snapshot.prodErrors.length,
      diagnostics_cached: snapshot.diagnosticsCached ?? 0,
      projects_total: snapshot.projectMetrics?.projects_total ?? 0,
      projects_cached: snapshot.projectMetrics?.projects_cached ?? 0,
      projects_rebuilt: snapshot.projectMetrics?.projects_rebuilt ?? 0,
      projects_empty: snapshot.projectMetrics?.projects_empty ?? 0,
      workers_spawned: snapshot.projectMetrics?.workers_spawned ?? 0,
      summary_coverage_percent: coverage.percent,
      duration_ms: snapshot.durationMs,
    };
    if (boolValue(values.json)) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Indexed ${result.project_id}\n` +
          `  Root:       ${result.root}\n` +
          `  TypeScript: ${result.typescript_version}\n` +
          `  Files:      ${result.files}\n` +
          `  Modules:    ${result.modules}\n` +
          `  Symbols:    ${result.symbols} (${result.eligible} eligible)\n` +
          `  Edges:      ${result.edges}\n` +
          `  Cycles:     ${result.module_cycles}\n` +
          `  Projects:   ${result.projects_cached} cached / ${result.projects_rebuilt} rebuilt / ${result.projects_empty} empty\n` +
          `  Workers:    ${result.workers_spawned}\n` +
          `  Duration:   ${result.duration_ms}ms\n` +
          (result.diagnostics_cached > 0
            ? `  Cached:     ${result.diagnostics_cached} diagnostic file(s)\n`
            : "") +
          `  Working DB: ${result.db_path}\n` +
          `  Summary DB: ${result.summary_db_path}\n`
      );
    }
  } finally {
    store.close();
  }
}
