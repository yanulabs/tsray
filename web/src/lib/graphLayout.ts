import type { ReportGraph, ReportGraphEdge, ReportGraphNode } from "../types/report";

export interface PositionedNode extends ReportGraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface ModuleGraphLayout {
  nodes: PositionedNode[];
  edges: ReportGraphEdge[];
  width: number;
  height: number;
  maxLayer: number;
}

const COLUMN_GAP = 110;
const NODE_GAP = 30;
const NODE_HEIGHT = 76;
const PADDING = 56;

export function layoutModuleGraph(graph: ReportGraph): ModuleGraphLayout {
  const nodes = graph.nodes.slice();
  const edges = graph.edges.filter(
    (edge) => nodes.some((node) => node.id === edge.from) && nodes.some((node) => node.id === edge.to)
  );

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
      layer.set(node.id, 0);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layer.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      layer.set(target, Math.max(layer.get(target) ?? 0, currentLayer + 1));
      if ((indegree.get(target) ?? 0) === 0) queue.push(target);
    }
  }

  let maxLayer = Math.max(0, ...layer.values());
  const remaining = nodes.filter((node) => !layer.has(node.id));
  if (remaining.length > 0) {
    if (layer.size === 0) {
      for (const node of remaining) layer.set(node.id, 0);
    } else {
      maxLayer += 1;
      for (const node of remaining) layer.set(node.id, maxLayer);
    }
  }

  const groups = new Map<number, ReportGraphNode[]>();
  for (const node of nodes) {
    const value = layer.get(node.id) ?? 0;
    const group = groups.get(value) ?? [];
    group.push(node);
    groups.set(value, group);
  }

  const positioned: PositionedNode[] = [];
  const heights: number[] = [];
  let widest = 0;
  for (const [layerIndex, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => b.fan_in - a.fan_in || a.label.localeCompare(b.label));
    let y = PADDING;
    for (const node of group) {
      const width = Math.min(268, Math.max(180, node.label.length * 7.2 + 52));
      const height = NODE_HEIGHT;
      positioned.push({
        ...node,
        x: PADDING + layerIndex * (260 + COLUMN_GAP),
        y,
        width,
        height,
        layer: layerIndex,
      });
      widest = Math.max(widest, PADDING * 2 + layerIndex * (260 + COLUMN_GAP) + width);
      heights[layerIndex] = (heights[layerIndex] ?? 0) + height + NODE_GAP;
      y += height + NODE_GAP;
    }
  }

  const tallest = Math.max(...heights, 320);
  // Center each layer vertically.
  for (const node of positioned) {
    const groupHeight = (heights[node.layer] ?? tallest) - NODE_GAP;
    node.y = PADDING + (tallest - groupHeight) / 2 + (node.y - PADDING);
  }

  return {
    nodes: positioned,
    edges,
    width: Math.max(widest, 720),
    height: tallest + PADDING * 2,
    maxLayer,
  };
}

export function edgePath(from: PositionedNode, to: PositionedNode): string {
  if (from.id === to.id) {
    const x = from.x + from.width;
    const y = from.y + from.height / 2;
    return `M ${x} ${y} C ${x + 60} ${y - 50}, ${x + 60} ${y + 50}, ${x} ${y + 10}`;
  }
  if (to.x >= from.x) {
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    const bend = Math.max(40, (x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }
  // Back edge: route below the nodes.
  const x1 = from.x + from.width / 2;
  const y1 = from.y + from.height;
  const x2 = to.x + to.width / 2;
  const y2 = to.y + to.height;
  const dip = Math.max(y1, y2) + 40;
  return `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`;
}
