import type { SummaryCoverage } from "../../cache/store.js";
import type {
  HotspotRecord,
  ImpactSymbol,
  ModuleEdgeSummary,
  ModuleSummary,
} from "../../index/types.js";

export function compactModuleSummary(module: ModuleSummary): Record<string, unknown> {
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

export function fullModuleSummary(module: ModuleSummary): Record<string, unknown> {
  return { ...compactModuleSummary(module), loc: module.loc };
}

export function compactModuleEdge(
  edge: ModuleEdgeSummary,
  compact: boolean
): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    imports: edge.imports,
    symbols: edge.symbols,
    ...(compact ? { files_count: edge.files.length } : { files: edge.files }),
  };
}

export function hotspotResult(hotspot: HotspotRecord): Record<string, unknown> {
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

export function impactSymbolResult(symbol: ImpactSymbol): Record<string, unknown> {
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

export function compactCoverage(coverage: SummaryCoverage): Record<string, unknown> {
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
