import type { DualCacheStore } from "../../cache/store.js";
import type { IndexSnapshot, StalenessState } from "../../index/types.js";
import {
  findImplementations,
  getDeadCode,
  getFanCounts,
  getHotspots,
  getModuleEdges,
  getModuleSummaries,
} from "../../index/queries.js";
import type {
  ReportCoverage,
  ReportDeadSymbol,
  ReportEdge,
  ReportGraph,
  ReportGraphEdge,
  ReportGraphNode,
  ReportInterface,
  ReportModule,
  ReportPayload,
  ReportSummary,
  ReportSymbol,
  ReportSyncState,
} from "../types.js";

export function buildReportPayload(snapshot: IndexSnapshot, store: DualCacheStore): ReportPayload {
  const moduleSummaries = getModuleSummaries(snapshot);
  const moduleEdges = getModuleEdges(snapshot);
  const cycleMembers = new Set(snapshot.moduleCycles.flat());
  const deadSymbols = getDeadCode(snapshot, false);
  const deadIds = new Set(deadSymbols.map((symbol) => symbol.id));
  const coverage = store.getCoverage(snapshot);

  const symbolStates = new Map<string, { state: StalenessState; summary: ReportSummary | null }>();
  const moduleStateBuckets = new Map<
    string,
    { eligible: number; synced: number; soft: number; hard: number; missing: number }
  >();
  for (const symbol of snapshot.symbols.values()) {
    const resolved = store.resolveSummary(symbol, false);
    symbolStates.set(symbol.id, {
      state: resolved.state,
      summary: (resolved.summary as ReportSummary | null) ?? null,
    });
    if (!symbol.eligible) continue;
    const bucket = moduleStateBuckets.get(symbol.module) ?? {
      eligible: 0,
      synced: 0,
      soft: 0,
      hard: 0,
      missing: 0,
    };
    bucket.eligible++;
    if (resolved.state === "synced") bucket.synced++;
    else if (resolved.state === "soft_stale") bucket.soft++;
    else if (resolved.state === "hard_stale") bucket.hard++;
    else if (resolved.state === "missing") bucket.missing++;
    moduleStateBuckets.set(symbol.module, bucket);
  }

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const symbolEdges: ReportEdge[] = [];
  for (const edge of snapshot.edges) {
    if (!snapshot.symbols.has(edge.fromId) || !snapshot.symbols.has(edge.toId)) continue;
    if (edge.kind === "imports" || edge.kind === "re_exports") continue;
    symbolEdges.push({
      from: edge.fromId,
      to: edge.toId,
      kind: edge.kind,
      file: edge.file,
      line: edge.line,
    });
    if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, []);
    outgoing.get(edge.fromId)!.push(edge.toId);
    if (!incoming.has(edge.toId)) incoming.set(edge.toId, []);
    incoming.get(edge.toId)!.push(edge.fromId);
  }

  const symbols: ReportSymbol[] = [...snapshot.symbols.values()]
    .map((symbol) => {
      const resolved = symbolStates.get(symbol.id);
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
        parent_id: symbol.parentId,
        complexity: symbol.complexity,
        fan_in: fan.fanIn,
        fan_out: fan.fanOut,
        exported: symbol.exported,
        default_export: symbol.defaultExport,
        entrypoint: symbol.isEntrypoint,
        eligible: symbol.eligible,
        is_test: symbol.isTest,
        is_generated: symbol.isGenerated,
        dead: deadIds.has(symbol.id),
        directive: symbol.directive,
        props_type: symbol.propsType,
        signature: symbol.signature,
        doc: symbol.doc,
        sig_hash: symbol.sigHash,
        self_hash: symbol.selfHash,
        dep_hash: symbol.depHash,
        content_hash: symbol.contentHash,
        sync_state: resolved?.state ?? "not_eligible",
        summary: resolved?.summary ?? null,
        callers: [...new Set(incoming.get(symbol.id) ?? [])].sort().slice(0, 100),
        callees: [...new Set(outgoing.get(symbol.id) ?? [])].sort().slice(0, 100),
      };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.line - b.line);

  const modules: ReportModule[] = moduleSummaries.map((module) => {
    const bucket = moduleStateBuckets.get(module.name);
    return {
      id: module.name,
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
      cycle: cycleMembers.has(module.name),
      in_modules: module.inModules,
      out_modules: module.outModules,
      sync_state: moduleState(bucket),
      synced_percent: bucket && bucket.eligible > 0 ? Number(((bucket.synced / bucket.eligible) * 100).toFixed(1)) : 0,
    };
  });

  const allGraphEdges: ReportGraphEdge[] = moduleEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    weight: Math.max(1, edge.imports + edge.symbols),
    imports: edge.imports,
    symbols: edge.symbols,
  }));

  const graphNodes: ReportGraphNode[] = modules.map((module) => ({
    id: module.id,
    label: module.name,
    module: module.name,
    loc: module.prod_loc,
    fan_in: module.fan_in,
    fan_out: module.fan_out,
    symbols: module.symbols,
    components: module.components,
    hooks: module.hooks,
    cycle: module.cycle,
    sync_state: module.sync_state,
    synced_percent: module.synced_percent,
  }));

  const graphs: { modules: ReportGraph } = {
    modules: { nodes: graphNodes, edges: allGraphEdges },
  };

  const interfaces: ReportInterface[] = findImplementations(snapshot).map((entry) => ({
    id: entry.interface.id,
    name: entry.interface.name,
    module: entry.interface.module,
    file: entry.interface.file,
    line: entry.interface.line,
    members: entry.interface.members,
    implementations: entry.implementations.map((implementation) => ({
      id: implementation.id,
      name: implementation.name,
      kind: implementation.kind,
      module: implementation.module,
      file: implementation.file,
      line: implementation.line,
      via: implementation.via,
    })),
  }));

  const deadCode: ReportDeadSymbol[] = deadSymbols.map((symbol) => ({
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

  const coveragePayload: ReportCoverage = {
    eligible: coverage.eligible,
    synced: coverage.synced,
    soft_stale: coverage.soft_stale,
    hard_stale: coverage.hard_stale,
    missing: coverage.missing,
    not_eligible: coverage.not_eligible,
    percent: coverage.percent,
  };

  return {
    repo: snapshot.root,
    project: snapshot.projectId,
    generated_at: snapshot.indexedAt,
    duration_ms: snapshot.durationMs,
    typescript_version: snapshot.typescriptVersion,
    metrics: {
      files: snapshot.filesCount,
      symbols: snapshot.symbols.size,
      components: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "component" && !symbol.isTest).length,
      hooks: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "hook" && !symbol.isTest).length,
      contexts: [...snapshot.symbols.values()].filter((symbol) => symbol.kind === "context" && !symbol.isTest).length,
      edges: snapshot.edges.length,
      modules: snapshot.modules.length,
      cycles: snapshot.moduleCycles.length,
      dead: deadCode.length,
      prod_errors: snapshot.prodErrors.length,
      warnings: snapshot.warnings.length,
      loc: moduleSummaries.reduce((total, module) => total + module.prodLoc, 0),
    },
    coverage: coveragePayload,
    modules,
    symbols,
    edges: symbolEdges,
    hotspots: getHotspots(snapshot, 50),
    dead_code: deadCode,
    interfaces,
    graphs,
    module_cycles: snapshot.moduleCycles,
    prod_errors: snapshot.prodErrors.map((error) => ({
      file: error.file,
      line: error.line,
      code: error.code,
      message: error.message,
    })),
    warnings: snapshot.warnings.map((warning) => ({
      file: warning.file,
      line: warning.line,
      code: warning.code,
      message: warning.message,
    })),
  };
}

function moduleState(
  bucket: { eligible: number; synced: number; soft: number; hard: number; missing: number } | undefined
): ReportSyncState {
  if (!bucket || bucket.eligible === 0) return "not_eligible";
  if (bucket.hard > 0) return "hard_stale";
  if (bucket.soft > 0) return "soft_stale";
  if (bucket.synced === bucket.eligible) return "synced";
  if (bucket.synced > 0) return "soft_stale";
  return "missing";
}
