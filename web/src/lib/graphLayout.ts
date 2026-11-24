import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode, ElkPoint } from "elkjs/lib/elk-api.js";
import { formatCompact } from "./format";
import type { ReportGraph, ReportGraphNode } from "../types/report";

export type RankDirection = "LR" | "TB";

export interface PositionedNode {
  node: ReportGraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
  inCycle: boolean;
}

export interface EdgePoint {
  x: number;
  y: number;
}

export interface PositionedEdge {
  id: string;
  from: string;
  to: string;
  weight: number;
  imports: number;
  symbols: number;
  cycle: boolean;
  transitive: boolean;
  backEdge: boolean;
  points: EdgePoint[];
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

export interface AnalyzedEdge {
  id: string;
  from: string;
  to: string;
  weight: number;
  imports: number;
  symbols: number;
  cycle: boolean;
  backEdge: boolean;
  transitive: boolean;
}

export interface GraphAnalysis {
  edges: AnalyzedEdge[];
  nodesInCycle: Set<string>;
  hiddenByNode: Map<string, number>;
  transitiveCount: number;
}

export interface GraphHub {
  node: ReportGraphNode;
  fanIn: number;
  fanOut: number;
}

export interface LayoutOptions {
  simplifyPaths: boolean;
  hiddenNodeIds: ReadonlySet<string>;
}

export interface NodeVisual {
  width: number;
  height: number;
  label: string;
  metrics: string;
  color: string;
}

const NODE_MIN_WIDTH = 204;
const NODE_MAX_WIDTH = 320;
const NODE_HEIGHT = 46;
const NODE_PADDING_X = 10;
const TITLE_FONT_SIZE = 11;
const METRICS_FONT_SIZE = 9;
const TITLE_CHAR_WIDTH = TITLE_FONT_SIZE * 0.62;
const METRICS_CHAR_WIDTH = METRICS_FONT_SIZE * 0.62;

const MODULE_COLORS = [
  "#ec4899",
  "#f59e0b",
  "#84cc16",
  "#a855f7",
  "#3b82f6",
  "#14b8a6",
  "#ef4444",
  "#06b6d4",
  "#8b5cf6",
  "#10b981",
];

function colorFor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return MODULE_COLORS[hash % MODULE_COLORS.length]!;
}

export function nodeVisual(node: ReportGraphNode): NodeVisual {
  const metrics = `in ${node.fan_in} · out ${node.fan_out} · ${formatCompact(node.loc)} LOC`;
  const titleWidth = node.label.length * TITLE_CHAR_WIDTH;
  const metricsWidth = metrics.length * METRICS_CHAR_WIDTH;
  const width = Math.round(
    Math.min(
      NODE_MAX_WIDTH,
      Math.max(NODE_MIN_WIDTH, NODE_PADDING_X * 2 + titleWidth, NODE_PADDING_X * 2 + metricsWidth)
    )
  );
  const labelSpace = width - NODE_PADDING_X * 2;
  const maxCharacters = Math.max(1, Math.floor(labelSpace / TITLE_CHAR_WIDTH));
  const label =
    node.label.length <= maxCharacters
      ? node.label
      : `${node.label.slice(0, Math.max(1, maxCharacters - 1))}…`;

  return {
    width,
    height: NODE_HEIGHT,
    label,
    metrics,
    color: colorFor(node.id),
  };
}

export function graphSignature(graph: ReportGraph): string {
  const nodes = graph.nodes
    .map(
      (node) =>
        `${node.id}\u0001${node.label}\u0001${node.loc}\u0001${node.fan_in}\u0001${node.fan_out}\u0001${node.cycle ? 1 : 0}\u0001${node.sync_state}`
    )
    .sort()
    .join("\u0002");
  const edges = graph.edges
    .map((edge) => `${edge.from}\u0001${edge.to}\u0001${edge.weight}\u0001${edge.imports}\u0001${edge.symbols}`)
    .sort()
    .join("\u0002");
  return `${nodes}\u0003${edges}`;
}

const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.aspectRatio": "1.8",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.mergeEdges": "false",
  "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
  "elk.layered.compaction.postCompaction.constraints": "QUADRATIC",
  "elk.spacing.nodeNode": "32",
  "elk.layered.spacing.nodeNodeBetweenLayers": "52",
  "elk.spacing.edgeEdge": "13",
  "elk.spacing.edgeNode": "22",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
  "elk.layered.spacing.edgeNodeBetweenLayers": "22",
  "elk.portConstraints": "FREE",
} as const;

const elk = new ELK();

function safeDimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function fallbackGridLayout(
  nodes: ReportGraphNode[],
  dimensions: Map<string, { width: number; height: number }>
): ElkNode {
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.8)));
  const gapX = 52;
  const gapY = 32;
  const rows: ReportGraphNode[][] = [];
  for (let index = 0; index < nodes.length; index += columns) {
    rows.push(nodes.slice(index, index + columns));
  }
  const columnWidths = new Array<number>(columns).fill(NODE_MIN_WIDTH);
  for (const row of rows) {
    row.forEach((node, column) => {
      const width = safeDimension(dimensions.get(node.id)?.width, NODE_MIN_WIDTH);
      columnWidths[column] = Math.max(columnWidths[column]!, width);
    });
  }
  const rowHeights = rows.map((row) =>
    Math.max(...row.map((node) => safeDimension(dimensions.get(node.id)?.height, NODE_HEIGHT)))
  );
  const children: ElkNode[] = [];
  let y = 0;
  rows.forEach((row, rowIndex) => {
    let x = 0;
    row.forEach((node, column) => {
      children.push({
        id: node.id,
        x,
        y,
        width: safeDimension(dimensions.get(node.id)?.width, NODE_MIN_WIDTH),
        height: safeDimension(dimensions.get(node.id)?.height, NODE_HEIGHT),
      });
      x += columnWidths[column]! + gapX;
    });
    y += rowHeights[rowIndex]! + gapY;
  });
  const width =
    columnWidths.reduce((total, value) => total + value, 0) + gapX * Math.max(0, columns - 1);
  const height =
    rowHeights.reduce((total, value) => total + value, 0) + gapY * Math.max(0, rows.length - 1);
  return { id: "tsray-fallback-root", children, width, height };
}

function stronglyConnectedComponents(
  nodeIDs: string[],
  adjacency: Map<string, string[]>
): string[][] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodeIDs) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbors = adjacency.get(frame.id) ?? [];
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next]!;
        frame.next++;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ id: next, next: 0 });
        }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }

  const reverse = new Map<string, string[]>();
  for (const id of nodeIDs) reverse.set(id, []);
  adjacency.forEach((neighbors, from) => {
    for (const to of neighbors) reverse.get(to)?.push(from);
  });

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = order.length - 1; index >= 0; index--) {
    const start = order[index]!;
    if (assigned.has(start)) continue;
    assigned.add(start);
    const component: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const previous of reverse.get(current) ?? []) {
        if (!assigned.has(previous)) {
          assigned.add(previous);
          stack.push(previous);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function hasAlternatePath(
  from: string,
  to: string,
  direct: AnalyzedEdge,
  outgoing: Map<string, AnalyzedEdge[]>
): boolean {
  const stack: string[] = [];
  for (const candidate of outgoing.get(from) ?? []) {
    if (candidate !== direct) stack.push(candidate.to);
  }
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) stack.push(next.to);
  }
  return false;
}

export function analyzeGraph(graph: ReportGraph): GraphAnalysis {
  const nodeIDs = new Set(graph.nodes.map((node) => node.id));
  const edges: AnalyzedEdge[] = [];
  const seenPairs = new Set<string>();

  graph.edges.forEach((edge, index) => {
    if (!nodeIDs.has(edge.from) || !nodeIDs.has(edge.to)) return;
    const pair = `${edge.from}\u0000${edge.to}`;
    if (seenPairs.has(pair)) return;
    seenPairs.add(pair);
    edges.push({
      id: `edge-${index}`,
      from: edge.from,
      to: edge.to,
      weight: Math.max(0, edge.weight),
      imports: edge.imports,
      symbols: edge.symbols,
      cycle: edge.from === edge.to,
      backEdge: false,
      transitive: false,
    });
  });

  const adjacency = new Map<string, string[]>();
  const edgeByPair = new Map<string, AnalyzedEdge>();
  for (const node of graph.nodes) adjacency.set(node.id, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    edgeByPair.set(`${edge.from}\u0000${edge.to}`, edge);
  }

  // Directed DFS back edges are the red circuit-board traces in goray. Unlike
  // a coordinate heuristic, this never paints ordinary acyclic edges red just
  // because ELK placed two layers at a similar x-position.
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const target of adjacency.get(id) ?? []) {
      const state = color.get(target) ?? 0;
      if (state === 0) visit(target);
      else if (state === 1) {
        const edge = edgeByPair.get(`${id}\u0000${target}`);
        if (edge) edge.backEdge = true;
      }
    }
    color.set(id, 2);
  };
  for (const node of graph.nodes) {
    if ((color.get(node.id) ?? 0) === 0) visit(node.id);
  }

  const cycleNodes = new Set<string>();
  const componentByNode = new Map<string, number>();
  const componentSizes: number[] = [];
  for (const component of stronglyConnectedComponents(
    graph.nodes.map((node) => node.id),
    adjacency
  )) {
    const componentIndex = componentSizes.length;
    componentSizes.push(component.length);
    for (const id of component) componentByNode.set(id, componentIndex);
    if (component.length > 1) {
      for (const id of component) cycleNodes.add(id);
    }
  }
  for (const edge of edges) {
    if (edge.from === edge.to) {
      cycleNodes.add(edge.from);
      edge.cycle = true;
      continue;
    }
    const fromComponent = componentByNode.get(edge.from);
    const toComponent = componentByNode.get(edge.to);
    if (
      fromComponent !== undefined &&
      fromComponent === toComponent &&
      (componentSizes[fromComponent] ?? 0) > 1
    ) {
      edge.cycle = true;
    }
  }

  const outgoing = new Map<string, AnalyzedEdge[]>();
  for (const edge of edges) {
    if (edge.cycle) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  let transitiveCount = 0;
  const hiddenByNode = new Map<string, number>();
  for (const edge of edges) {
    if (edge.cycle) continue;
    if (hasAlternatePath(edge.from, edge.to, edge, outgoing)) {
      edge.transitive = true;
      transitiveCount++;
      hiddenByNode.set(edge.from, (hiddenByNode.get(edge.from) ?? 0) + 1);
    }
  }

  return { edges, nodesInCycle: cycleNodes, hiddenByNode, transitiveCount };
}

export function findHubs(graph: ReportGraph): GraphHub[] {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    incoming.set(node.id, new Set());
    outgoing.set(node.id, new Set());
  }
  for (const edge of graph.edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from) || edge.from === edge.to) continue;
    incoming.get(edge.to)!.add(edge.from);
    outgoing.get(edge.from)!.add(edge.to);
  }

  const threshold = Math.max(4, Math.ceil(graph.nodes.length * 0.5));
  const hubs: GraphHub[] = [];
  for (const node of graph.nodes) {
    const fanIn = incoming.get(node.id)?.size ?? 0;
    const fanOut = outgoing.get(node.id)?.size ?? 0;
    if (fanIn >= threshold && fanOut <= 1) hubs.push({ node, fanIn, fanOut });
  }
  return hubs.sort(
    (left, right) => right.fanIn - left.fanIn || left.node.label.localeCompare(right.node.label)
  );
}

function cleanPolyline(points: EdgePoint[]): EdgePoint[] {
  const deduped: EdgePoint[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (
      previous === undefined ||
      Math.abs(previous.x - point.x) > 0.01 ||
      Math.abs(previous.y - point.y) > 0.01
    ) {
      deduped.push(point);
    }
  }
  if (deduped.length <= 2) return deduped;
  const cleaned: EdgePoint[] = [deduped[0]!];
  for (let index = 1; index < deduped.length - 1; index++) {
    const previous = cleaned[cleaned.length - 1]!;
    const current = deduped[index]!;
    const next = deduped[index + 1]!;
    const cross =
      (current.x - previous.x) * (next.y - current.y) -
      (current.y - previous.y) * (next.x - current.x);
    const dot =
      (current.x - previous.x) * (next.x - current.x) +
      (current.y - previous.y) * (next.y - current.y);
    const span = Math.hypot(next.x - previous.x, next.y - previous.y);
    const perpendicular = span > 0 ? Math.abs(cross) / span : Math.abs(cross);
    if ((Math.abs(cross) < 0.01 || perpendicular < 0.75) && dot > 0) continue;
    cleaned.push(current);
  }
  cleaned.push(deduped[deduped.length - 1]!);
  return cleaned;
}

function numberText(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function roundedEdgePath(points: EdgePoint[], radius = 6): string {
  const cleaned = cleanPolyline(points);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return `M ${numberText(cleaned[0]!.x)} ${numberText(cleaned[0]!.y)}`;
  const parts: string[] = [`M ${numberText(cleaned[0]!.x)} ${numberText(cleaned[0]!.y)}`];
  for (let index = 1; index < cleaned.length - 1; index++) {
    const previous = cleaned[index - 1]!;
    const current = cleaned[index]!;
    const next = cleaned[index + 1]!;
    const incoming = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outgoing = Math.hypot(next.x - current.x, next.y - current.y);
    const corner = Math.min(radius, incoming / 2, outgoing / 2);
    if (corner < 0.5 || incoming === 0 || outgoing === 0) {
      parts.push(`L ${numberText(current.x)} ${numberText(current.y)}`);
      continue;
    }
    const beforeX = current.x - ((current.x - previous.x) / incoming) * corner;
    const beforeY = current.y - ((current.y - previous.y) / incoming) * corner;
    const afterX = current.x + ((next.x - current.x) / outgoing) * corner;
    const afterY = current.y + ((next.y - current.y) / outgoing) * corner;
    parts.push(
      `L ${numberText(beforeX)} ${numberText(beforeY)}`,
      `Q ${numberText(current.x)} ${numberText(current.y)} ${numberText(afterX)} ${numberText(afterY)}`
    );
  }
  const last = cleaned[cleaned.length - 1]!;
  parts.push(`L ${numberText(last.x)} ${numberText(last.y)}`);
  return parts.join(" ");
}

export function polylineMidpoint(points: EdgePoint[]): EdgePoint | null {
  const cleaned = cleanPolyline(points);
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) return cleaned[0]!;
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < cleaned.length; index++) {
    const length = Math.hypot(cleaned[index]!.x - cleaned[index - 1]!.x, cleaned[index]!.y - cleaned[index - 1]!.y);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return cleaned[0]!;
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!;
    if (length === 0) continue;
    if (remaining <= length) {
      const ratio = remaining / length;
      return {
        x: cleaned[index]!.x + (cleaned[index + 1]!.x - cleaned[index]!.x) * ratio,
        y: cleaned[index]!.y + (cleaned[index + 1]!.y - cleaned[index]!.y) * ratio,
      };
    }
    remaining -= length;
  }
  return cleaned[cleaned.length - 1]!;
}

function sectionPoints(section: {
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
}): EdgePoint[] {
  return [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({
    x: point.x,
    y: point.y,
  }));
}

function fallbackPoints(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
  direction: RankDirection
): EdgePoint[] {
  if (direction === "TB") {
    return [
      { x: from.x + from.width / 2, y: from.y + from.height },
      { x: to.x + to.width / 2, y: to.y },
    ];
  }
  return [
    { x: from.x + from.width, y: from.y + from.height / 2 },
    { x: to.x, y: to.y + to.height / 2 },
  ];
}

export async function layoutGraph(
  graph: ReportGraph,
  analysis: GraphAnalysis,
  direction: RankDirection,
  options: LayoutOptions
): Promise<GraphLayout> {
  const visibleNodes = graph.nodes.filter((node) => !options.hiddenNodeIds.has(node.id));
  if (visibleNodes.length === 0) return { nodes: [], edges: [], width: 1, height: 1 };
  const visibleIDs = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = analysis.edges.filter(
    (edge) =>
      visibleIDs.has(edge.from) &&
      visibleIDs.has(edge.to) &&
      !(options.simplifyPaths && edge.transitive)
  );

  const dimensions = new Map<string, { width: number; height: number }>();
  for (const node of visibleNodes) {
    const visual = nodeVisual(node);
    dimensions.set(node.id, { width: visual.width, height: visual.height });
  }

  const elkNodes: ElkNode[] = visibleNodes.map((node) => ({
    id: node.id,
    width: safeDimension(dimensions.get(node.id)?.width, NODE_MIN_WIDTH),
    height: safeDimension(dimensions.get(node.id)?.height, NODE_HEIGHT),
  }));
  const elkEdges: ElkExtendedEdge[] = visibleEdges.map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
  }));
  const directionOption = direction === "LR" ? "RIGHT" : "DOWN";
  const elkGraph: ElkNode = {
    id: "tsray-root",
    layoutOptions: { ...ELK_LAYOUT_OPTIONS, "elk.direction": directionOption },
    children: elkNodes,
    edges: elkEdges,
  };

  let result: ElkNode;
  try {
    result = await elk.layout(elkGraph);
  } catch {
    const withoutCompaction = { ...ELK_LAYOUT_OPTIONS } as Record<string, string>;
    delete withoutCompaction["elk.layered.compaction.postCompaction.strategy"];
    delete withoutCompaction["elk.layered.compaction.postCompaction.constraints"];
    try {
      result = await elk.layout({
        ...elkGraph,
        layoutOptions: { ...withoutCompaction, "elk.direction": directionOption },
      });
    } catch {
      result = fallbackGridLayout(visibleNodes, dimensions);
    }
  }

  const positionedByID = new Map<string, PositionedNode>();
  const nodes: PositionedNode[] = [];
  const sourceByID = new Map(visibleNodes.map((node) => [node.id, node]));
  for (const child of result.children ?? []) {
    const source = sourceByID.get(child.id);
    if (!source) continue;
    const positioned: PositionedNode = {
      node: source,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: safeDimension(child.width ?? dimensions.get(child.id)?.width, NODE_MIN_WIDTH),
      height: safeDimension(child.height ?? dimensions.get(child.id)?.height, NODE_HEIGHT),
      inCycle: analysis.nodesInCycle.has(source.id),
    };
    positionedByID.set(source.id, positioned);
    nodes.push(positioned);
  }

  const edgesByID = new Map(visibleEdges.map((edge) => [edge.id, edge]));
  const edges: PositionedEdge[] = [];
  for (const elkEdge of result.edges ?? []) {
    const source = edgesByID.get(elkEdge.id);
    if (!source) continue;
    const section = elkEdge.sections?.[0];
    let points = section ? sectionPoints(section) : [];
    const from = positionedByID.get(source.from);
    const to = positionedByID.get(source.to);
    if (points.length < 2 && from && to) points = fallbackPoints(from, to, direction);
    if (points.length < 2 || !from || !to) continue;
    edges.push({
      id: source.id,
      from: source.from,
      to: source.to,
      weight: source.weight,
      imports: source.imports,
      symbols: source.symbols,
      cycle: source.cycle,
      transitive: source.transitive,
      backEdge: source.backEdge,
      points,
    });
  }

  return {
    nodes,
    edges,
    width: Math.max(1, result.width ?? 1),
    height: Math.max(1, result.height ?? 1),
  };
}
