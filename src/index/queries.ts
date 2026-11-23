import fs from "node:fs";
import path from "node:path";
import type {
  EdgeRecord,
  HotspotRecord,
  ImpactAnalysis,
  ImpactSymbol,
  IndexSnapshot,
  ModuleEdgeSummary,
  ModuleSummary,
  SymbolRecord,
} from "./types.js";

interface GraphIndex {
  incoming: Map<string, EdgeRecord[]>;
  outgoing: Map<string, EdgeRecord[]>;
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
  testReachable: Set<string>;
  modules: Map<string, ModuleSummary>;
  moduleEdges: ModuleEdgeSummary[];
}

const REFERENCE_EDGE_KINDS = new Set([
  "calls",
  "renders",
  "wraps",
  "uses_hook",
  "provides_context",
  "consumes_context",
  "implements",
  "references",
]);

const REACT_EDGE_KINDS = new Set([
  "renders",
  "wraps",
  "uses_hook",
  "provides_context",
  "consumes_context",
]);

const CALL_EDGE_KINDS = new Set(["calls", "renders", "uses_hook", "wraps"]);

const graphCache = new WeakMap<IndexSnapshot, GraphIndex>();

function graphOf(snapshot: IndexSnapshot): GraphIndex {
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
    if (REFERENCE_EDGE_KINDS.has(edge.kind) && !edge.fromId.startsWith("file:")) {
      fanIn.set(edge.toId, (fanIn.get(edge.toId) ?? 0) + 1);
      fanOut.set(edge.fromId, (fanOut.get(edge.fromId) ?? 0) + 1);
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
  const result: GraphIndex = { incoming, outgoing, fanIn, fanOut, testReachable, modules, moduleEdges };
  graphCache.set(snapshot, result);
  return result;
}

function isTestPath(file: string): boolean {
  return /(\.(test|spec|stories)\.[cm]?[jt]sx?$|\/__(tests|mocks)__\/|(^|\/)(test|tests)\/)/.test(file);
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
    if (edge.isTest || edge.fromModule === edge.toModule) continue;
    const summary = get(edge.fromModule, edge.toModule);
    summary.imports++;
    if (!summary.files.includes(edge.fromFile)) summary.files.push(edge.fromFile);
  }

  for (const edge of snapshot.edges) {
    if (!REFERENCE_EDGE_KINDS.has(edge.kind)) continue;
    const from = snapshot.symbols.get(edge.fromId);
    const to = snapshot.symbols.get(edge.toId);
    if (!from || !to || from.module === to.module) continue;
    get(from.module, to.module).symbols++;
  }

  return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function buildModuleSummaries(
  snapshot: IndexSnapshot,
  moduleEdges: ModuleEdgeSummary[],
  testReachable: Set<string>
): Map<string, ModuleSummary> {
  const modules = new Map<string, ModuleSummary>();
  for (const name of snapshot.modules) {
    modules.set(name, {
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
  }

  for (const file of snapshot.files.values()) {
    let summary = modules.get(file.module);
    if (!summary) {
      summary = {
        name: file.module,
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
      };
      modules.set(file.module, summary);
    }
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

export function getModuleSummaries(snapshot: IndexSnapshot): ModuleSummary[] {
  return [...graphOf(snapshot).modules.values()].sort((a, b) => b.prodLoc - a.prodLoc || a.name.localeCompare(b.name));
}

export function getModuleEdges(snapshot: IndexSnapshot): ModuleEdgeSummary[] {
  return graphOf(snapshot).moduleEdges;
}

export function getFanCounts(snapshot: IndexSnapshot, id: string): { fanIn: number; fanOut: number } {
  const graph = graphOf(snapshot);
  return { fanIn: graph.fanIn.get(id) ?? 0, fanOut: graph.fanOut.get(id) ?? 0 };
}

export function getTestReachable(snapshot: IndexSnapshot): ReadonlySet<string> {
  return graphOf(snapshot).testReachable;
}

export function getSymbolMatches(snapshot: IndexSnapshot, query: string, limit = 20): SymbolRecord[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const exact: SymbolRecord[] = [];
  const byName: SymbolRecord[] = [];
  const byFile: SymbolRecord[] = [];
  const fuzzy: SymbolRecord[] = [];

  for (const symbol of snapshot.symbols.values()) {
    if (symbol.id === trimmed) exact.push(symbol);
    else if (symbol.name === trimmed) byName.push(symbol);
    else if (symbol.name.toLowerCase() === lower) byName.push(symbol);
    else if (symbol.file === trimmed || symbol.file.endsWith(trimmed)) byFile.push(symbol);
    else if (symbol.name.toLowerCase().includes(lower) || symbol.id.toLowerCase().includes(lower)) fuzzy.push(symbol);
  }

  const sort = (items: SymbolRecord[]): void => {
    items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
  sort(exact);
  sort(byName);
  sort(byFile);
  sort(fuzzy);
  return [...exact, ...byName, ...byFile, ...fuzzy].slice(0, limit);
}

export function getApiSurface(
  snapshot: IndexSnapshot,
  options: { module?: string; kind?: string; limit?: number; offset?: number } = {}
): { total: number; symbols: SymbolRecord[] } {
  const symbols = [...snapshot.symbols.values()]
    .filter((symbol) => symbol.exported && !symbol.isTest && !symbol.isGenerated)
    .filter((symbol) => !options.module || symbol.module === options.module)
    .filter((symbol) => !options.kind || symbol.kind === options.kind)
    .sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file) || a.line - b.line);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit && options.limit > 0 ? options.limit : symbols.length;
  return { total: symbols.length, symbols: symbols.slice(offset, offset + limit) };
}

export function getReferences(
  snapshot: IndexSnapshot,
  targetId: string,
  options: { includeImports?: boolean; limit?: number } = {}
): Array<{
  from_id: string;
  from_name: string | null;
  kind: string;
  file: string;
  line: number;
  is_test: boolean;
  via?: string;
}> {
  const graph = graphOf(snapshot);
  const limit = options.limit && options.limit > 0 ? options.limit : 500;
  const references: Array<{
    from_id: string;
    from_name: string | null;
    kind: string;
    file: string;
    line: number;
    is_test: boolean;
    via?: string;
  }> = [];

  for (const edge of graph.incoming.get(targetId) ?? []) {
    if (!options.includeImports && (edge.kind === "imports" || edge.kind === "re_exports")) continue;
    const source = snapshot.symbols.get(edge.fromId);
    references.push({
      from_id: edge.fromId,
      from_name: source?.name ?? null,
      kind: edge.kind,
      file: edge.file,
      line: edge.line,
      is_test: source?.isTest ?? isTestPath(edge.file),
      ...(edge.via ? { via: edge.via } : {}),
    });
    if (references.length >= limit) break;
  }

  return references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export interface GraphViewNode {
  id: string;
  name: string;
  kind: string;
  module: string;
  file: string;
  line: number;
  is_test: boolean;
}

export interface GraphViewEdge {
  from: string;
  to: string;
  kind: string;
  file: string;
  line: number;
}

export function getCallGraph(
  snapshot: IndexSnapshot,
  rootId: string,
  options: { depth?: number; direction?: "callers" | "callees" | "both" } = {}
): { root: string; nodes: GraphViewNode[]; edges: GraphViewEdge[]; truncated: boolean } {
  const graph = graphOf(snapshot);
  const depth = Math.min(Math.max(options.depth ?? 2, 1), 6);
  const direction = options.direction ?? "both";
  const nodes = new Map<string, GraphViewNode>();
  const edges = new Map<string, GraphViewEdge>();
  const seenPairs = new Set<string>();
  let truncated = false;

  const addNode = (id: string): void => {
    const symbol = snapshot.symbols.get(id);
    if (!symbol || nodes.has(id)) return;
    nodes.set(id, {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      module: symbol.module,
      file: symbol.file,
      line: symbol.line,
      is_test: symbol.isTest,
    });
  };

  addNode(rootId);
  let frontier = [rootId];
  for (let level = 0; level < depth && frontier.length > 0 && !truncated; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      const outgoing = direction !== "callers" ? graph.outgoing.get(current) ?? [] : [];
      const incoming = direction !== "callees" ? graph.incoming.get(current) ?? [] : [];
      for (const edge of [...outgoing, ...incoming]) {
        if (!CALL_EDGE_KINDS.has(edge.kind)) continue;
        const other = edge.fromId === current ? edge.toId : edge.fromId;
        if (!snapshot.symbols.has(other)) continue;
        addNode(other);
        const key = `${edge.fromId}|${edge.toId}|${edge.kind}|${edge.file}:${edge.line}`;
        if (!seenPairs.has(key)) {
          seenPairs.add(key);
          edges.set(key, {
            from: edge.fromId,
            to: edge.toId,
            kind: edge.kind,
            file: edge.file,
            line: edge.line,
          });
        }
        if (!nodes.has(other) && nodes.size >= 2000) {
          truncated = true;
          break;
        }
        if (!next.includes(other)) next.push(other);
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return { root: rootId, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

export function getComponentTree(
  snapshot: IndexSnapshot,
  rootId: string,
  options: { depth?: number; direction?: "children" | "parents" | "both" } = {}
): { root: string; nodes: GraphViewNode[]; edges: GraphViewEdge[]; contexts: GraphViewNode[]; hooks: GraphViewNode[] } {
  const graph = graphOf(snapshot);
  const depth = Math.min(Math.max(options.depth ?? 2, 1), 6);
  const direction = options.direction ?? "both";
  const nodes = new Map<string, GraphViewNode>();
  const edges = new Map<string, GraphViewEdge>();
  const contexts = new Map<string, GraphViewNode>();
  const hooks = new Map<string, GraphViewNode>();

  const addNode = (symbol: SymbolRecord): void => {
    const node: GraphViewNode = {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      module: symbol.module,
      file: symbol.file,
      line: symbol.line,
      is_test: symbol.isTest,
    };
    nodes.set(symbol.id, node);
    if (symbol.kind === "context") contexts.set(symbol.id, node);
    if (symbol.kind === "hook") hooks.set(symbol.id, node);
  };

  const root = snapshot.symbols.get(rootId);
  if (!root) return { root: rootId, nodes: [], edges: [], contexts: [], hooks: [] };
  addNode(root);

  let frontier = [rootId];
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      const outgoing = direction !== "parents" ? graph.outgoing.get(current) ?? [] : [];
      const incoming = direction !== "children" ? graph.incoming.get(current) ?? [] : [];
      for (const edge of [...outgoing, ...incoming]) {
        if (!REACT_EDGE_KINDS.has(edge.kind) && edge.kind !== "calls") continue;
        const otherSymbol = snapshot.symbols.get(edge.fromId === current ? edge.toId : edge.fromId);
        if (!otherSymbol || otherSymbol.id === current) continue;
        addNode(otherSymbol);
        const key = `${edge.fromId}|${edge.toId}|${edge.kind}|${edge.file}:${edge.line}`;
        if (!edges.has(key)) {
          edges.set(key, {
            from: edge.fromId,
            to: edge.toId,
            kind: edge.kind,
            file: edge.file,
            line: edge.line,
          });
        }
        if (!next.includes(otherSymbol.id)) next.push(otherSymbol.id);
      }
    }
    frontier = next;
  }

  return {
    root: rootId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    contexts: [...contexts.values()],
    hooks: [...hooks.values()],
  };
}

export interface InterfaceImplementation {
  interface: SymbolRecord;
  implementations: Array<{
    id: string;
    name: string;
    kind: string;
    module: string;
    file: string;
    line: number;
    via: string;
  }>;
}

export function findImplementations(snapshot: IndexSnapshot, interfaceId?: string): InterfaceImplementation[] {
  const graph = graphOf(snapshot);
  const result = new Map<string, InterfaceImplementation>();

  for (const symbol of snapshot.symbols.values()) {
    if (symbol.kind !== "interface") continue;
    if (interfaceId && symbol.id !== interfaceId) continue;
    result.set(symbol.id, { interface: symbol, implementations: [] });
  }

  for (const [targetId, incoming] of graph.incoming) {
    const target = snapshot.symbols.get(targetId);
    if (target?.kind !== "interface") continue;
    const entry = result.get(targetId) ?? { interface: target, implementations: [] };
    for (const edge of incoming) {
      if (edge.kind !== "implements") continue;
      const source = snapshot.symbols.get(edge.fromId);
      if (!source) continue;
      entry.implementations.push({
        id: source.id,
        name: source.name,
        kind: source.kind,
        module: source.module,
        file: source.file,
        line: source.line,
        via: edge.via ?? "declared",
      });
    }
    result.set(targetId, entry);
  }

  return [...result.values()]
    .map((entry) => ({
      ...entry,
      implementations: entry.implementations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    }))
    .sort((a, b) => a.interface.file.localeCompare(b.interface.file) || a.interface.line - b.interface.line);
}

export function getHotspots(snapshot: IndexSnapshot, limit = 25): HotspotRecord[] {
  const graph = graphOf(snapshot);
  const records: HotspotRecord[] = [];

  for (const symbol of snapshot.symbols.values()) {
    if (!symbol.eligible) continue;
    if (!["component", "hook", "function", "method"].includes(symbol.kind)) continue;
    const fanIn = graph.fanIn.get(symbol.id) ?? 0;
    const tested = graph.testReachable.has(symbol.id);
    const riskScore = Number(
      (symbol.complexity * (1 + Math.log2(1 + fanIn)) * (tested ? 1 : 1.8)).toFixed(2)
    );
    records.push({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      module: symbol.module,
      file: symbol.file,
      line: symbol.line,
      loc: symbol.loc,
      complexity: symbol.complexity,
      fanIn,
      testReachable: tested,
      riskScore,
    });
  }

  return records.sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id)).slice(0, limit);
}

export function getDeadCode(snapshot: IndexSnapshot, includeExported = false): SymbolRecord[] {
  const graph = graphOf(snapshot);
  const roots = new Set<string>();

  for (const symbol of snapshot.symbols.values()) {
    if (symbol.isTest) {
      roots.add(symbol.id);
      continue;
    }
    if (!symbol.eligible) continue;
    if (snapshot.files.get(symbol.file)?.isEntrypoint) roots.add(symbol.id);
    if (symbol.isEntrypoint) roots.add(symbol.id);
    if (!includeExported && symbol.exported) roots.add(symbol.id);
  }

  const reachable = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph.outgoing.get(current) ?? []) {
      if (edge.kind === "imports" || edge.kind === "re_exports") continue;
      if (reachable.has(edge.toId)) continue;
      reachable.add(edge.toId);
      queue.push(edge.toId);
    }
  }

  return [...snapshot.symbols.values()]
    .filter((symbol) => symbol.eligible && !reachable.has(symbol.id))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function getImpactAnalysis(
  snapshot: IndexSnapshot,
  targetId: string,
  maxDepth = 4
): ImpactAnalysis {
  const graph = graphOf(snapshot);
  const target = snapshot.symbols.get(targetId) ?? null;
  const direct = (graph.incoming.get(targetId) ?? []).filter(
    (edge) => edge.kind !== "imports" && edge.kind !== "re_exports"
  );

  const visited = new Set<string>([targetId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
  const impactedComponents = new Map<string, ImpactSymbol>();
  const impactedHooks = new Map<string, ImpactSymbol>();
  const impactedCallers = new Map<string, ImpactSymbol>();
  const impactedFiles = new Set<string>();
  const impactedModules = new Set<string>();
  const impactedTests = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of graph.incoming.get(current.id) ?? []) {
      if (edge.kind === "imports" || edge.kind === "re_exports") continue;
      const source = snapshot.symbols.get(edge.fromId);
      if (!source) {
        if (isTestPath(edge.file)) impactedTests.add(edge.file);
        impactedFiles.add(edge.file);
        const moduleName = snapshot.files.get(edge.file)?.module;
        if (moduleName) impactedModules.add(moduleName);
        continue;
      }
      if (visited.has(source.id)) continue;
      visited.add(source.id);
      impactedFiles.add(source.file);
      impactedModules.add(source.module);
      if (source.isTest) {
        impactedTests.add(source.file);
      } else if (source.kind === "component") {
        impactedComponents.set(source.id, toImpactSymbol(source));
      } else if (source.kind === "hook") {
        impactedHooks.set(source.id, toImpactSymbol(source));
      } else {
        impactedCallers.set(source.id, toImpactSymbol(source));
      }
      queue.push({ id: source.id, depth: current.depth + 1 });
    }
  }

  const transitiveCount =
    impactedComponents.size + impactedHooks.size + impactedCallers.size + impactedTests.size;
  const risk =
    transitiveCount >= 30
      ? "critical"
      : transitiveCount >= 10
        ? "high"
        : transitiveCount >= 3
          ? "medium"
          : "low";
  const testFiles = [...impactedTests].sort();

  return {
    target,
    risk,
    directReferencesCount: direct.length,
    directReferences: direct.slice(0, 100),
    impactedComponents: [...impactedComponents.values()].sort(bySymbol),
    impactedHooks: [...impactedHooks.values()].sort(bySymbol),
    impactedCallers: [...impactedCallers.values()].sort(bySymbol),
    impactedFiles: [...impactedFiles].sort(),
    impactedModules: [...impactedModules].sort(),
    impactedTestFiles: testFiles,
    transitiveCount,
    suggestedCommands: [
      ...(testFiles.length > 0 ? [`npx vitest run ${testFiles.join(" ")}`] : []),
      "npm run typecheck",
      "npm run build",
    ],
  };
}

function toImpactSymbol(symbol: SymbolRecord): ImpactSymbol {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    isTest: symbol.isTest,
  };
}

function bySymbol(a: ImpactSymbol, b: ImpactSymbol): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}

export function getFunctionBody(
  snapshot: IndexSnapshot,
  symbolId: string
): { symbol: SymbolRecord; source: string; loc: number; complexity: number } | null {
  const symbol = snapshot.symbols.get(symbolId);
  if (!symbol) return null;
  try {
    const absolute = path.join(snapshot.root, symbol.file);
    const text = fs.readFileSync(absolute, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, symbol.line - 1);
    const end = Math.min(lines.length, symbol.endLine);
    return {
      symbol,
      source: lines.slice(start, end).join("\n"),
      loc: symbol.loc,
      complexity: symbol.complexity,
    };
  } catch {
    return { symbol, source: symbol.sourcePreview, loc: symbol.loc, complexity: symbol.complexity };
  }
}

export interface SymbolContextDependency {
  id: string;
  name: string;
  kind: string;
  edge_kind: string;
  file: string;
  line: number;
}

export function getSymbolDependencies(snapshot: IndexSnapshot, symbolId: string): SymbolContextDependency[] {
  const graph = graphOf(snapshot);
  return (graph.outgoing.get(symbolId) ?? [])
    .filter((edge) => edge.kind !== "imports" && edge.kind !== "re_exports")
    .map((edge) => {
      const target = snapshot.symbols.get(edge.toId);
      return {
        id: edge.toId,
        name: target?.name ?? edge.toId,
        kind: target?.kind ?? "unknown",
        edge_kind: edge.kind,
        file: edge.file,
        line: edge.line,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id) || a.edge_kind.localeCompare(b.edge_kind));
}

export function getModuleOverview(snapshot: IndexSnapshot, moduleName: string): {
  module: ModuleSummary | null;
  dependencies: ModuleEdgeSummary[];
  hotspots: HotspotRecord[];
  files: Array<{ path: string; loc: number; exports: number; is_test: boolean }>;
} {
  const graph = graphOf(snapshot);
  const module = graph.modules.get(moduleName) ?? null;
  const dependencies = graph.moduleEdges.filter(
    (edge) => edge.from === moduleName || edge.to === moduleName
  );
  const hotspots = getHotspots(snapshot, 1000)
    .filter((hotspot) => hotspot.module === moduleName)
    .slice(0, 20);
  const files = [...snapshot.files.values()]
    .filter((file) => file.module === moduleName)
    .map((file) => ({
      path: file.path,
      loc: file.loc,
      exports: file.exports,
      is_test: file.isTest,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { module, dependencies, hotspots, files };
}

export function getDependencyGraph(
  snapshot: IndexSnapshot,
  options: { root?: string; depth?: number; scope?: "module" | "file"; direction?: "out" | "in" | "both" } = {}
): {
  scope: "module" | "file";
  nodes: Array<{ id: string; label: string; module: string; fan_in: number; fan_out: number; loc?: number }>;
  edges: Array<{ from: string; to: string; weight: number }>;
  rank: Array<{ id: string; fan_in: number; fan_out: number }>;
} {
  const scope = options.scope ?? "module";
  const depth = Math.min(Math.max(options.depth ?? 2, 1), 10);
  const direction = options.direction ?? "both";

  if (scope === "file") {
    const fileEdges = snapshot.fileImports.filter((edge) => !edge.isTest);
    const adjacency = new Map<string, Set<string>>();
    for (const edge of fileEdges) {
      if (!adjacency.has(edge.fromFile)) adjacency.set(edge.fromFile, new Set());
      adjacency.get(edge.fromFile)!.add(edge.toFile);
      if (!adjacency.has(edge.toFile)) adjacency.set(edge.toFile, new Set());
    }
    const selected = new Set<string>();
    if (options.root) {
      let frontier = [options.root];
      selected.add(options.root);
      for (let level = 0; level < depth; level++) {
        const next: string[] = [];
        for (const current of frontier) {
          const outgoing = direction !== "in" ? adjacency.get(current) ?? [] : [];
          const incoming =
            direction !== "out"
              ? fileEdges.filter((edge) => edge.toFile === current).map((edge) => edge.fromFile)
              : [];
          for (const other of [...outgoing, ...incoming]) {
            if (!selected.has(other)) {
              selected.add(other);
              next.push(other);
            }
          }
        }
        frontier = next;
      }
    } else {
      for (const file of snapshot.files.keys()) selected.add(file);
    }
    const nodes = [...selected].map((file) => {
      const record = snapshot.files.get(file);
      return {
        id: file,
        label: file,
        module: record?.module ?? "unknown",
        fan_in: fileEdges.filter((edge) => edge.toFile === file).length,
        fan_out: fileEdges.filter((edge) => edge.fromFile === file).length,
        loc: record?.loc ?? 0,
      };
    });
    const edges = fileEdges
      .filter((edge) => selected.has(edge.fromFile) && selected.has(edge.toFile))
      .map((edge) => ({ from: edge.fromFile, to: edge.toFile, weight: 1 }));
    return {
      scope,
      nodes,
      edges,
      rank: nodes
        .map((node) => ({ id: node.id, fan_in: node.fan_in, fan_out: node.fan_out }))
        .sort((a, b) => b.fan_in - a.fan_in || a.id.localeCompare(b.id)),
    };
  }

  const moduleEdges = getModuleEdges(snapshot);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of moduleEdges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
  }
  const selected = new Set<string>();
  if (options.root) {
    let frontier = [options.root];
    selected.add(options.root);
    for (let level = 0; level < depth; level++) {
      const next: string[] = [];
      for (const current of frontier) {
        const outgoing = direction !== "in" ? adjacency.get(current) ?? [] : [];
        const incoming =
          direction !== "out"
            ? moduleEdges.filter((edge) => edge.to === current).map((edge) => edge.from)
            : [];
        for (const other of [...outgoing, ...incoming]) {
          if (!selected.has(other)) {
            selected.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
  } else {
    for (const module of snapshot.modules) selected.add(module);
  }

  const summaries = graphOf(snapshot).modules;
  const nodes = [...selected].map((module) => {
    const summary = summaries.get(module);
    return {
      id: module,
      label: module,
      module,
      fan_in: summary?.fanIn ?? 0,
      fan_out: summary?.fanOut ?? 0,
      loc: summary?.prodLoc ?? 0,
    };
  });
  const edges = moduleEdges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, weight: Math.max(1, edge.imports + edge.symbols) }));
  return {
    scope,
    nodes,
    edges,
    rank: nodes
      .map((node) => ({ id: node.id, fan_in: node.fan_in, fan_out: node.fan_out }))
      .sort((a, b) => b.fan_in - a.fan_in || a.id.localeCompare(b.id)),
  };
}

export function explainDependency(
  snapshot: IndexSnapshot,
  from: string,
  to: string
): {
  from: string;
  to: string;
  file_imports: Array<{ file: string; line: number; target: string; specifier: string; type_only: boolean }>;
  symbol_edges: EdgeRecord[];
  symbols: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
} {
  const fileImports = snapshot.fileImports
    .filter((edge) => edge.fromModule === from && edge.toModule === to)
    .map((edge) => ({
      file: edge.fromFile,
      line: edge.line,
      target: edge.toFile,
      specifier: edge.specifier,
      type_only: edge.typeOnly,
    }));
  const symbolEdges = snapshot.edges.filter((edge) => {
    const source = snapshot.symbols.get(edge.fromId);
    const target = snapshot.symbols.get(edge.toId);
    return source?.module === from && target?.module === to && edge.kind !== "imports" && edge.kind !== "re_exports";
  });
  return {
    from,
    to,
    file_imports: fileImports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    symbol_edges: symbolEdges,
    symbols: symbolEdges.map((edge) => snapshot.symbols.get(edge.toId)!).filter(Boolean).map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
    })),
  };
}

export function getCycleMembers(snapshot: IndexSnapshot): Set<string> {
  return new Set(snapshot.moduleCycles.flat());
}
