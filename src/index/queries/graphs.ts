import type { IndexSnapshot, SymbolRecord } from "../types.js";
import { CALL_EDGE_KINDS, REACT_EDGE_KINDS } from "./edge-kinds.js";
import { graphOf } from "./graph-index.js";

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
  options: {
    depth?: number;
    direction?: "callers" | "callees" | "both";
  } = {}
): {
  root: string;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  truncated: boolean;
} {
  const graph = graphOf(snapshot);
  const requestedDepth = options.depth ?? 2;
  const depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(requestedDepth, 1), 6)
    : 2;
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
  for (
    let level = 0;
    level < depth && frontier.length > 0 && !truncated;
    level++
  ) {
    const next: string[] = [];
    for (const current of frontier) {
      const outgoing =
        direction !== "callers" ? graph.outgoing.get(current) ?? [] : [];
      const incoming =
        direction !== "callees" ? graph.incoming.get(current) ?? [] : [];
      for (const edge of [...outgoing, ...incoming]) {
        if (!CALL_EDGE_KINDS.has(edge.kind)) continue;
        const other = edge.fromId === current ? edge.toId : edge.fromId;
        if (!snapshot.symbols.has(other)) continue;
        if (!nodes.has(other) && nodes.size >= 2000) {
          truncated = true;
          break;
        }
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
        if (!next.includes(other)) next.push(other);
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return {
    root: rootId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
  };
}

export function getComponentTree(
  snapshot: IndexSnapshot,
  rootId: string,
  options: {
    depth?: number;
    direction?: "children" | "parents" | "both";
  } = {}
): {
  root: string;
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  contexts: GraphViewNode[];
  hooks: GraphViewNode[];
} {
  const graph = graphOf(snapshot);
  const requestedDepth = options.depth ?? 2;
  const depth = Number.isFinite(requestedDepth)
    ? Math.min(Math.max(requestedDepth, 1), 6)
    : 2;
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
      const outgoing =
        direction !== "parents" ? graph.outgoing.get(current) ?? [] : [];
      const incoming =
        direction !== "children" ? graph.incoming.get(current) ?? [] : [];
      for (const edge of [...outgoing, ...incoming]) {
        if (!REACT_EDGE_KINDS.has(edge.kind) && edge.kind !== "calls") continue;
        const otherSymbol = snapshot.symbols.get(
          edge.fromId === current ? edge.toId : edge.fromId
        );
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
