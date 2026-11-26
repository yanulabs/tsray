import type {
  EdgeRecord,
  HotspotRecord,
  IndexSnapshot,
  ModuleEdgeSummary,
  ModuleSummary,
} from "../types.js";
import { getHotspots } from "./audit.js";
import { graphOf } from "./graph-index.js";

export function getModuleSummaries(snapshot: IndexSnapshot): ModuleSummary[] {
  return [...graphOf(snapshot).modules.values()].sort(
    (a, b) => b.prodLoc - a.prodLoc || a.name.localeCompare(b.name)
  );
}

export function getModuleEdges(snapshot: IndexSnapshot): ModuleEdgeSummary[] {
  return graphOf(snapshot).moduleEdges;
}

export function getFanCounts(
  snapshot: IndexSnapshot,
  id: string
): { fanIn: number; fanOut: number } {
  const graph = graphOf(snapshot);
  return { fanIn: graph.fanIn.get(id) ?? 0, fanOut: graph.fanOut.get(id) ?? 0 };
}

export function getTestReachable(snapshot: IndexSnapshot): ReadonlySet<string> {
  return graphOf(snapshot).testReachable;
}

export function getModuleOverview(
  snapshot: IndexSnapshot,
  moduleName: string
): {
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
  options: {
    root?: string;
    depth?: number;
    scope?: "module" | "file";
    direction?: "out" | "in" | "both";
  } = {}
): {
  scope: "module" | "file";
  nodes: Array<{
    id: string;
    label: string;
    module: string;
    fan_in: number;
    fan_out: number;
    loc?: number;
  }>;
  edges: Array<{ from: string; to: string; weight: number }>;
  rank: Array<{ id: string; fan_in: number; fan_out: number }>;
} {
  const scope = options.scope ?? "module";
  const requestedDepth = options.depth ?? 2;
  const depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(requestedDepth, 1), 10)
    : 2;
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
              ? fileEdges
                  .filter((edge) => edge.toFile === current)
                  .map((edge) => edge.fromFile)
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
        .map((node) => ({
          id: node.id,
          fan_in: node.fan_in,
          fan_out: node.fan_out,
        }))
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
            ? moduleEdges
                .filter((edge) => edge.to === current)
                .map((edge) => edge.from)
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
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      weight: Math.max(1, edge.imports + edge.symbols),
    }));
  return {
    scope,
    nodes,
    edges,
    rank: nodes
      .map((node) => ({
        id: node.id,
        fan_in: node.fan_in,
        fan_out: node.fan_out,
      }))
      .sort((a, b) => b.fan_in - a.fan_in || a.id.localeCompare(b.id)),
  };
}

export function explainDependency(
  snapshot: IndexSnapshot,
  from: string,
  to: string,
  options: { includeTests?: boolean } = {}
): {
  from: string;
  to: string;
  file_imports: Array<{
    file: string;
    line: number;
    target: string;
    specifier: string;
    type_only: boolean;
  }>;
  symbol_edges: EdgeRecord[];
  symbols: Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    line: number;
  }>;
} {
  const fileImports = snapshot.fileImports
    .filter(
      (edge) =>
        edge.fromModule === from &&
        edge.toModule === to &&
        (options.includeTests || !edge.isTest)
    )
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
    if (!source || !target) return false;
    if (!options.includeTests && (source.isTest || target.isTest)) return false;
    return (
      source.module === from &&
      target.module === to &&
      edge.kind !== "imports" &&
      edge.kind !== "re_exports"
    );
  });
  const seenSymbols = new Set<string>();
  const symbols: Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    line: number;
  }> = [];
  for (const edge of symbolEdges) {
    const symbol = snapshot.symbols.get(edge.toId);
    if (!symbol || seenSymbols.has(symbol.id)) continue;
    seenSymbols.add(symbol.id);
    symbols.push({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      line: symbol.line,
    });
  }
  return {
    from,
    to,
    file_imports: fileImports.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line
    ),
    symbol_edges: symbolEdges,
    symbols,
  };
}

export function getCycleMembers(snapshot: IndexSnapshot): Set<string> {
  return new Set(snapshot.moduleCycles.flat());
}
