import type {
  EdgeRecord,
  IndexSnapshot,
  ModuleEdgeSummary,
  ModuleSummary,
} from "../types.js";
import { REFERENCE_EDGE_KINDS } from "./edge-kinds.js";

export interface GraphIndex {
  incoming: Map<string, EdgeRecord[]>;
  outgoing: Map<string, EdgeRecord[]>;
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  testReachable: Set<string>;
  modules: Map<string, ModuleSummary>;
  moduleEdges: ModuleEdgeSummary[];
}

const graphCache = new WeakMap<IndexSnapshot, GraphIndex>();

export function isTestPath(file: string): boolean {
  return /(\.(test|spec|stories)\.[cm]?[jt]sx?$|\/__(tests|mocks)__\/|(^|\/)(test|tests)\/)/.test(
    file
  );
}

function buildModuleEdges(snapshot: IndexSnapshot): ModuleEdgeSummary[] {
  const edges = new Map<string, ModuleEdgeSummary>();
  const keyOf = (from: string, to: string): string => `${from}\u0000${to}`;
  const get = (from: string, to: string): ModuleEdgeSummary => {
    const key = keyOf(from, to);
    let edge = edges.get(key);
    if (!edge) {
      edge = { from, to, imports: 0, symbols: 0, files: [] };
      edges.set(key, edge);
    }
    return edge;
  };

  for (const edge of snapshot.fileImports) {
    if (edge.isTest || edge.typeOnly || edge.fromModule === edge.toModule) continue;
    // Type-only imports are erased at runtime; keep them in file-level
    // explanations but out of the production architecture graph.
    const summary = get(edge.fromModule, edge.toModule);
    summary.imports++;
    if (!summary.files.includes(edge.fromFile)) summary.files.push(edge.fromFile);
  }

  for (const edge of snapshot.edges) {
    if (!REFERENCE_EDGE_KINDS.has(edge.kind)) continue;
    const from = snapshot.symbols.get(edge.fromId);
    const to = snapshot.symbols.get(edge.toId);
    if (!from || !to || from.module === to.module) continue;
    // Production architecture excludes test/story coupling. Symbol edges add
    // weight to an existing import edge but never invent a runtime dependency
    // that the value-import graph does not contain.
    if (from.isTest || to.isTest) continue;
    const key = keyOf(from.module, to.module);
    const existing = edges.get(key);
    if (existing) existing.symbols++;
  }

  return [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
}

function buildModuleSummaries(
  snapshot: IndexSnapshot,
  moduleEdges: ModuleEdgeSummary[],
  testReachable: Set<string>
): Map<string, ModuleSummary> {
  const modules = new Map<string, ModuleSummary>();
  const emptySummary = (name: string): ModuleSummary => ({
    name,
    files: 0,
    symbols: 0,
    components: 0,
    hooks: 0,
    exported: 0,
    loc: 0,
    prodLoc: 0,
    testLoc: 0,
    generatedFiles: 0,
    entrypoints: 0,
    fanIn: 0,
    fanOut: 0,
    inModules: [],
    outModules: [],
    testReachable: 0,
  });
  for (const name of snapshot.modules) modules.set(name, emptySummary(name));

  for (const file of snapshot.files.values()) {
    const summary = modules.get(file.module) ?? emptySummary(file.module);
    modules.set(file.module, summary);
    summary.files++;
    summary.loc += file.loc;
    summary.prodLoc += file.prodLoc;
    summary.testLoc += file.testLoc;
    if (file.generated) summary.generatedFiles++;
    if (file.isEntrypoint) summary.entrypoints++;
  }

  for (const symbol of snapshot.symbols.values()) {
    const summary = modules.get(symbol.module);
    if (!summary) continue;
    if (symbol.isTest || symbol.isGenerated) continue;
    summary.symbols++;
    if (symbol.kind === "component") summary.components++;
    if (symbol.kind === "hook") summary.hooks++;
    if (symbol.exported) summary.exported++;
    if (testReachable.has(symbol.id)) summary.testReachable++;
  }

  for (const edge of moduleEdges) {
    const from = modules.get(edge.from);
    const to = modules.get(edge.to);
    if (!from || !to) continue;
    if (!from.outModules.includes(to.name)) from.outModules.push(to.name);
    if (!to.inModules.includes(from.name)) to.inModules.push(from.name);
  }
  for (const summary of modules.values()) {
    summary.inModules.sort();
    summary.outModules.sort();
    summary.fanIn = summary.inModules.length;
    summary.fanOut = summary.outModules.length;
  }

  return modules;
}

export function graphOf(snapshot: IndexSnapshot): GraphIndex {
  const cached = graphCache.get(snapshot);
  if (cached) return cached;

  const incoming = new Map<string, EdgeRecord[]>();
  const outgoing = new Map<string, EdgeRecord[]>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const edge of snapshot.edges) {
    if (!snapshot.symbols.has(edge.toId)) continue;
    if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, []);
    outgoing.get(edge.fromId)!.push(edge);
    if (!incoming.has(edge.toId)) incoming.set(edge.toId, []);
    incoming.get(edge.toId)!.push(edge);
    if (REFERENCE_EDGE_KINDS.has(edge.kind)) {
      fanIn.set(edge.toId, (fanIn.get(edge.toId) ?? 0) + 1);
      if (!edge.fromId.startsWith("file:")) {
        fanOut.set(edge.fromId, (fanOut.get(edge.fromId) ?? 0) + 1);
      }
    }
  }

  // Static test reachability starts at test declarations and test-file edges.
  const testReachable = new Set<string>();
  const queue: string[] = [];
  for (const symbol of snapshot.symbols.values()) {
    if (symbol.isTest) {
      testReachable.add(symbol.id);
      queue.push(symbol.id);
    }
  }
  for (const edge of snapshot.edges) {
    if (!snapshot.symbols.get(edge.fromId)?.isTest && !isTestPath(edge.file)) continue;
    if (!testReachable.has(edge.toId)) {
      testReachable.add(edge.toId);
      queue.push(edge.toId);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current) ?? []) {
      if (edge.kind === "imports" || edge.kind === "re_exports") continue;
      if (!testReachable.has(edge.toId)) {
        testReachable.add(edge.toId);
        queue.push(edge.toId);
      }
    }
  }

  const moduleEdges = buildModuleEdges(snapshot);
  const modules = buildModuleSummaries(snapshot, moduleEdges, testReachable);
  const result: GraphIndex = {
    incoming,
    outgoing,
    fanIn,
    fanOut,
    testReachable,
    modules,
    moduleEdges,
  };
  graphCache.set(snapshot, result);
  return result;
}
