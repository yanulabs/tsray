import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import {
  analyzeGraph,
  findHubs,
  graphSignature,
  layoutGraph,
  nodeVisual,
  polylineMidpoint,
  roundedEdgePath,
  type EdgePoint,
  type GraphAnalysis,
  type GraphLayout,
  type PositionedEdge,
  type PositionedNode,
  type RankDirection,
} from "../lib/graphLayout";
import { EmptyState, IconButton } from "./ui";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  XIcon,
} from "./icons";

interface Transform {
  x: number;
  y: number;
  k: number;
}

type EdgeTone = "muted" | "unrelated" | "hover" | "outgoing" | "incoming" | "cycle";
type HighlightMode = "none" | "fan_in" | "cycles";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const FIT_PADDING = 24;

const SIMPLIFY_KEY = "tsray-graph-simplify";
const HIDE_HUBS_KEY = "tsray-graph-hide-hubs";
const HIDE_ISOLATED_KEY = "tsray-graph-hide-isolated";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fitTransform(layout: GraphLayout, width: number, height: number): Transform {
  const scale = clamp(
    Math.min((width - FIT_PADDING * 2) / layout.width, (height - FIT_PADDING * 2) / layout.height),
    0.2,
    1.35
  );
  return {
    k: scale,
    x: (width - layout.width * scale) / 2,
    y: (height - layout.height * scale) / 2,
  };
}

function readStoredToggle(key: string): boolean | null {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // View state is best effort.
  }
  return null;
}

function writeStoredToggle(key: string, value: boolean | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // View state is best effort.
  }
}

function edgeTone(
  edge: PositionedEdge,
  activeNodeId: string | null,
  activeEdges: Set<string> | undefined
): EdgeTone {
  if (edge.cycle || edge.backEdge) return "cycle";
  if (activeNodeId === null) return "muted";
  if (activeEdges === undefined || !activeEdges.has(edge.id)) return "unrelated";
  return edge.from === activeNodeId ? "outgoing" : "incoming";
}

function ToolbarToggle({
  label,
  active,
  onClick,
  badge,
  title,
  disabled = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string | null;
  title: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded border px-1.5 font-mono text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
      }`}
    >
      <span>{label}</span>
      {badge ? (
        <span
          className={`rounded px-1 py-px text-[9px] tabular-nums ${
            active
              ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200"
              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function GraphView({
  report,
  selection,
  onSelect,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [direction, setDirection] = useState<RankDirection>("LR");
  const [view, setView] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [moduleFilter, setModuleFilter] = useState("all");
  const [highlight, setHighlight] = useState<HighlightMode>("none");
  const [simplifyPaths, setSimplifyPaths] = useState<boolean | null>(() =>
    readStoredToggle(SIMPLIFY_KEY)
  );
  const [hideHubs, setHideHubs] = useState<boolean>(
    () => readStoredToggle(HIDE_HUBS_KEY) ?? false
  );
  const [hideIsolated, setHideIsolated] = useState<boolean | null>(() =>
    readStoredToggle(HIDE_ISOLATED_KEY)
  );
  const [layoutState, setLayoutState] = useState<{
    key: string;
    layout: GraphLayout;
  } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const fittedKey = useRef("");
  const fittedSize = useRef({ width: 0, height: 0 });
  const userMoved = useRef(false);
  const requestedKey = useRef<string | null>(null);

  const graph = report.graphs.modules;
  const selectedModule = selection?.type === "module" ? selection.id : null;
  const moduleOptions = useMemo(
    () => graph.nodes.map((node) => node.label).sort((a, b) => a.localeCompare(b)),
    [graph.nodes]
  );
  const graphHubs = useMemo(() => findHubs(graph), [graph]);
  const connectedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of graph.edges) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [graph.edges]);
  const isolatedNodes = useMemo(
    () => graph.nodes.filter((node) => !connectedNodeIds.has(node.id)),
    [connectedNodeIds, graph.nodes]
  );
  const hideIsolatedActive =
    isolatedNodes.length > 0 && (hideIsolated ?? connectedNodeIds.size > 0);
  const hiddenNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (hideHubs) for (const hub of graphHubs) ids.add(hub.node.id);
    if (hideIsolatedActive) for (const node of isolatedNodes) ids.add(node.id);
    return ids;
  }, [graphHubs, hideHubs, hideIsolatedActive, isolatedNodes]);

  const visibleGraph = useMemo(() => {
    const nodes = graph.nodes.filter(
      (node) =>
        !hiddenNodeIds.has(node.id) &&
        (moduleFilter === "all" || node.label === moduleFilter || node.id === moduleFilter)
    );
    const allowed = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graph.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to)),
    };
  }, [graph, hiddenNodeIds, moduleFilter]);
  const analysis = useMemo<GraphAnalysis>(() => analyzeGraph(visibleGraph), [visibleGraph]);
  const simplifyEnabled = simplifyPaths ?? visibleGraph.edges.length > 15;
  const hiddenIdKey = useMemo(() => [...hiddenNodeIds].sort().join(","), [hiddenNodeIds]);
  const layoutKey = useMemo(
    () =>
      `${graphSignature(visibleGraph)}:${direction}:${simplifyEnabled ? 1 : 0}:${moduleFilter}:${hiddenIdKey}`,
    [direction, hiddenIdKey, moduleFilter, simplifyEnabled, visibleGraph]
  );
  const layout =
    layoutState !== null && layoutState.key === layoutKey ? layoutState.layout : null;
  const visuals = useMemo(() => {
    const byID = new Map<string, ReturnType<typeof nodeVisual>>();
    for (const positioned of layout?.nodes ?? []) byID.set(positioned.node.id, nodeVisual(positioned.node));
    return byID;
  }, [layout]);

  const highlightedNodes = useMemo<ReadonlySet<string> | null>(() => {
    if (highlight === "none") return null;
    if (highlight === "cycles") {
      return analysis.nodesInCycle.size > 0 ? analysis.nodesInCycle : null;
    }
    const maxFanIn = Math.max(0, ...visibleGraph.nodes.map((node) => node.fan_in));
    const threshold = Math.max(3, Math.ceil(maxFanIn * 0.6));
    const ids = new Set(
      visibleGraph.nodes.filter((node) => node.fan_in >= threshold).map((node) => node.id)
    );
    return ids.size > 0 ? ids : null;
  }, [analysis.nodesInCycle, highlight, visibleGraph.nodes]);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (requestedKey.current === layoutKey) return;
    requestedKey.current = layoutKey;
    let cancelled = false;
    setLayoutState(null);
    setLayoutError(null);
    layoutGraph(visibleGraph, analysis, direction, {
      simplifyPaths: simplifyEnabled,
      hiddenNodeIds,
    })
      .then((next) => {
        if (!cancelled) setLayoutState({ key: layoutKey, layout: next });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLayoutError(error instanceof Error ? error.message : "Layout failed");
      });
    return () => {
      cancelled = true;
      if (requestedKey.current === layoutKey) requestedKey.current = null;
    };
    // layoutKey includes graph content, direction, transitive reduction, module
    // filter, and hidden node IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  useEffect(() => {
    if (!layout || size.width <= 0 || size.height <= 0) return;
    const sameLayout = fittedKey.current === layoutKey;
    const sameSize =
      fittedSize.current.width === size.width && fittedSize.current.height === size.height;
    if (sameLayout && (sameSize || userMoved.current)) return;
    fittedKey.current = layoutKey;
    fittedSize.current = { width: size.width, height: size.height };
    userMoved.current = false;
    setView(fitTransform(layout, size.width, size.height));
  }, [layout, layoutKey, size.height, size.width]);

  useEffect(() => {
    setHoveredNodeId(null);
    setHoveredEdgeId(null);
  }, [layoutKey]);

  useEffect(() => {
    writeStoredToggle(SIMPLIFY_KEY, simplifyPaths);
  }, [simplifyPaths]);
  useEffect(() => {
    writeStoredToggle(HIDE_HUBS_KEY, hideHubs);
  }, [hideHubs]);
  useEffect(() => {
    writeStoredToggle(HIDE_ISOLATED_KEY, hideIsolated);
  }, [hideIsolated]);

  useEffect(() => {
    if (focusId && hiddenNodeIds.has(focusId)) setFocusId(null);
    if (moduleFilter !== "all" && !visibleGraph.nodes.some((node) => node.id === focusId)) {
      setFocusId(null);
    }
  }, [focusId, hiddenNodeIds, moduleFilter, visibleGraph.nodes]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      userMoved.current = true;
      setView((previous) => {
        const nextScale = clamp(previous.k * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
        const ratio = nextScale / previous.k;
        return {
          k: nextScale,
          x: mouseX - (mouseX - previous.x) * ratio,
          y: mouseY - (mouseY - previous.y) * ratio,
        };
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setFocusId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const activeNodeId = useMemo(() => {
    const candidate = hoveredNodeId ?? selectedModule ?? focusId;
    if (candidate === null || !layout) return null;
    return layout.nodes.some((node) => node.node.id === candidate) ? candidate : null;
  }, [focusId, hoveredNodeId, layout, selectedModule]);

  const activeState = useMemo(() => {
    if (activeNodeId === null || !layout) return null;
    const nodes = new Set<string>([activeNodeId]);
    const edges = new Set<string>();
    for (const edge of layout.edges) {
      if (edge.from === activeNodeId || edge.to === activeNodeId) {
        edges.add(edge.id);
        nodes.add(edge.from === activeNodeId ? edge.to : edge.from);
      }
    }
    return { nodes, edges };
  }, [activeNodeId, layout]);

  useEffect(() => {
    if (selectedModule === null || !layout || size.width <= 0 || size.height <= 0) return;
    const selected = layout.nodes.find((node) => node.node.id === selectedModule);
    if (!selected) return;
    const margin = 48;
    setView((previous) => {
      const left = selected.x * previous.k + previous.x;
      const right = (selected.x + selected.width) * previous.k + previous.x;
      const top = selected.y * previous.k + previous.y;
      const bottom = (selected.y + selected.height) * previous.k + previous.y;
      let deltaX = 0;
      let deltaY = 0;
      if (left < margin) deltaX = margin - left;
      else if (right > size.width - margin) deltaX = size.width - margin - right;
      if (top < margin) deltaY = margin - top;
      else if (bottom > size.height - margin) deltaY = size.height - margin - bottom;
      if (deltaX === 0 && deltaY === 0) return previous;
      return { ...previous, x: previous.x + deltaX, y: previous.y + deltaY };
    });
  }, [layout, selectedModule, size.height, size.width]);

  const zoomBy = (factor: number): void => {
    userMoved.current = true;
    setView((previous) => {
      const nextScale = clamp(previous.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = nextScale / previous.k;
      const centerX = size.width / 2;
      const centerY = size.height / 2;
      return {
        k: nextScale,
        x: centerX - (centerX - previous.x) * ratio,
        y: centerY - (centerY - previous.y) * ratio,
      };
    });
  };

  const fit = (): void => {
    if (!layout) return;
    userMoved.current = false;
    fittedSize.current = { width: size.width, height: size.height };
    setView(fitTransform(layout, size.width, size.height));
  };

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    if (!current) return;
    const deltaX = event.clientX - current.x;
    const deltaY = event.clientY - current.y;
    if (Math.abs(event.clientX - current.startX) + Math.abs(event.clientY - current.startY) > 3) {
      current.moved = true;
    }
    current.x = event.clientX;
    current.y = event.clientY;
    if (current.moved) {
      userMoved.current = true;
      setView((previous) => ({ ...previous, x: previous.x + deltaX, y: previous.y + deltaY }));
    }
  };

  const endPan = (event: React.PointerEvent<SVGSVGElement>): void => {
    const current = drag.current;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current && !current.moved) setFocusId(null);
  };

  const labels = useMemo(
    () => new Map((layout?.nodes ?? []).map((positioned) => [positioned.node.id, positioned.node.label])),
    [layout]
  );
  const orderedEdges = useMemo(() => {
    if (!layout) return [];
    const rank = (edge: PositionedEdge): number => {
      if (hoveredEdgeId === edge.id) return 3;
      if (edge.cycle || edge.backEdge) return 1;
      if (activeState?.edges.has(edge.id)) return 2;
      return 0;
    };
    return [...layout.edges].sort(
      (left, right) => rank(left) - rank(right) || left.id.localeCompare(right.id)
    );
  }, [activeState, hoveredEdgeId, layout]);

  if (graph.nodes.length === 0) {
    return (
      <div className="h-full overflow-hidden">
        <EmptyState title="No graph nodes" hint="The index produced no modules for this project." />
      </div>
    );
  }

  const focusLabel = focusId ? labels.get(focusId) ?? focusId : "";
  const simplifyBadge =
    simplifyEnabled && analysis.transitiveCount > 0
      ? `${analysis.transitiveCount} hidden`
      : analysis.transitiveCount > 0
        ? `${analysis.transitiveCount} reducible`
        : null;
  const hubBadge =
    graphHubs.length === 0
      ? null
      : hideHubs
        ? `${graphHubs.length} hidden`
        : `${graphHubs.length} ${graphHubs.length === 1 ? "hub" : "hubs"}`;
  const isolatedBadge =
    isolatedNodes.length === 0
      ? null
      : hideIsolatedActive
        ? `${isolatedNodes.length} hidden`
        : `${isolatedNodes.length} isolated`;
  const hiddenDirectForSelection =
    simplifyEnabled && selectedModule !== null
      ? analysis.edges.reduce(
          (count, edge) =>
            count +
            (edge.transitive && (edge.from === selectedModule || edge.to === selectedModule) ? 1 : 0),
          0
        )
      : 0;

  return (
    <div ref={containerRef} className="relative h-full min-w-0 overflow-hidden bg-white dark:bg-zinc-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(113,113,122,0.22)_1px,transparent_0)] [background-size:18px_18px] dark:bg-[radial-gradient(circle_at_1px_1px,rgba(113,113,122,0.25)_1px,transparent_0)]" />

      {layout && layout.nodes.length > 0 ? (
        <svg
          width={size.width}
          height={size.height}
          className={`block h-full w-full touch-none ${panning ? "cursor-grabbing" : "cursor-grab"}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onPointerLeave={() => {
            setHoveredNodeId(null);
            setHoveredEdgeId(null);
          }}
          role="application"
          aria-label="Module dependency graph. Drag to pan, scroll to zoom, select a node to inspect it."
        >
          <defs>
            <marker id="tsray-arrow-muted" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-zinc-400 dark:fill-zinc-500" />
            </marker>
            <marker id="tsray-arrow-out" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-indigo-500" />
            </marker>
            <marker id="tsray-arrow-in" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-emerald-500" />
            </marker>
            <marker id="tsray-arrow-cycle" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-red-500" />
            </marker>
          </defs>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g fill="none">
              {orderedEdges.map((edge) => {
                const baseTone = edgeTone(edge, activeNodeId, activeState?.edges);
                const hovered = hoveredEdgeId === edge.id;
                const tone: EdgeTone =
                  hovered && (baseTone === "muted" || baseTone === "unrelated") ? "hover" : baseTone;
                const active = activeState?.edges.has(edge.id) ?? false;
                const path = roundedEdgePath(edge.points);
                const labelPoint: EdgePoint | null = hovered ? polylineMidpoint(edge.points) : null;
                const strokeClass =
                  tone === "outgoing"
                    ? "stroke-indigo-500"
                    : tone === "incoming"
                      ? "stroke-emerald-500"
                      : tone === "cycle"
                        ? "stroke-red-500"
                        : tone === "hover"
                          ? "stroke-zinc-700 dark:stroke-zinc-200"
                          : "stroke-zinc-400 dark:stroke-zinc-500";
                const opacityClass =
                  tone === "unrelated"
                    ? "opacity-[0.12]"
                    : tone === "cycle"
                      ? "opacity-90"
                      : tone === "muted"
                        ? "opacity-[0.55] dark:opacity-[0.42]"
                        : "opacity-100";
                const strokeWidth =
                  tone === "outgoing" || tone === "incoming" || tone === "hover"
                    ? 2
                    : tone === "cycle"
                      ? active
                        ? 2
                        : 1.75
                      : 1.35;
                const marker =
                  tone === "outgoing"
                    ? "url(#tsray-arrow-out)"
                    : tone === "incoming"
                      ? "url(#tsray-arrow-in)"
                      : tone === "cycle"
                        ? "url(#tsray-arrow-cycle)"
                        : "url(#tsray-arrow-muted)";
                const labelText = `${edge.weight} symbol refs`;
                const labelWidth = Math.max(54, labelText.length * 5.2 + 10);
                return (
                  <g key={edge.id}>
                    <path d={path} strokeWidth={4.5} vectorEffect="non-scaling-stroke" pointerEvents="none" className="stroke-white dark:stroke-zinc-950" />
                    <path
                      d={path}
                      className={`${strokeClass} ${opacityClass}`}
                      strokeWidth={strokeWidth}
                      strokeDasharray={tone === "cycle" ? "4 3" : undefined}
                      markerEnd={marker}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                    <path
                      d={path}
                      stroke="transparent"
                      strokeWidth={14}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="stroke"
                      onPointerEnter={() => setHoveredEdgeId(edge.id)}
                      onPointerLeave={() => setHoveredEdgeId((current) => (current === edge.id ? null : current))}
                    >
                      <title>
                        {`${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}\n${edge.imports} imports · ${edge.symbols} symbol edges${tone === "cycle" ? " · cycle/back-edge" : ""}${edge.transitive ? " · redundant path" : ""}`}
                      </title>
                    </path>
                    {labelPoint ? (
                      <g transform={`translate(${labelPoint.x} ${labelPoint.y})`} pointerEvents="none">
                        <rect
                          x={-labelWidth / 2}
                          y={-8}
                          width={labelWidth}
                          height={16}
                          rx={3}
                          strokeWidth={0.75}
                          vectorEffect="non-scaling-stroke"
                          className="fill-white stroke-zinc-300 dark:fill-zinc-950 dark:stroke-zinc-700"
                        />
                        <text y={3} textAnchor="middle" className="fill-zinc-700 font-mono dark:fill-zinc-300" style={{ fontSize: 9 }}>
                          {labelText}
                        </text>
                      </g>
                    ) : null}
                  </g>
                );
              })}
            </g>

            {layout.nodes.map((positioned) => {
              const visible = activeState === null || activeState.nodes.has(positioned.node.id);
              const highlighted =
                highlightedNodes === null || highlightedNodes.has(positioned.node.id);
              return (
                <GraphNode
                  key={positioned.node.id}
                  positioned={positioned}
                  visual={visuals.get(positioned.node.id) ?? nodeVisual(positioned.node)}
                  selected={selectedModule === positioned.node.id}
                  dimmed={!visible || !highlighted}
                  onHover={(value) => setHoveredNodeId(value ? positioned.node.id : null)}
                  onSelect={() => {
                    setFocusId(positioned.node.id);
                    onSelect({ type: "module", id: positioned.node.id });
                  }}
                />
              );
            })}
          </g>
        </svg>
      ) : (
        <div className="flex h-full items-center justify-center px-6">
          {layoutError ? (
            <div className="max-w-md text-center">
              <div className="font-mono text-[11px] uppercase tracking-widest text-red-500">Layout failed</div>
              <p className="mt-1 font-mono text-[10px] leading-5 text-zinc-500 dark:text-zinc-400">{layoutError}</p>
            </div>
          ) : visibleGraph.nodes.length === 0 ? (
            <EmptyState title="All nodes hidden" hint="Choose another module or turn off the active graph filters." />
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-400 dark:text-zinc-500">laying out…</span>
          )}
        </div>
      )}

      <div className="absolute left-2 top-2 flex max-w-[calc(100%-11rem)] flex-wrap items-center gap-1 rounded border border-zinc-200 bg-white/95 p-1 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="inline-flex h-7 items-center rounded border border-zinc-200 bg-zinc-100 px-2 font-mono text-[10px] font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          Modules
        </div>
        <select
          value={moduleFilter}
          onChange={(event) => setModuleFilter(event.target.value)}
          aria-label="Filter modules"
          className="h-7 rounded border border-zinc-200 bg-white px-1.5 font-mono text-[10px] text-zinc-600 outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
        >
          <option value="all">All modules</option>
          {moduleOptions.map((module) => (
            <option key={module} value={module}>{module}</option>
          ))}
        </select>
        <select
          value={highlight}
          onChange={(event) => setHighlight(event.target.value as HighlightMode)}
          aria-label="Highlight nodes"
          className="h-7 rounded border border-zinc-200 bg-white px-1.5 font-mono text-[10px] text-zinc-600 outline-none dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
        >
          <option value="none">Highlight nodes…</option>
          <option value="fan_in">High fan-in</option>
          <option value="cycles">Cycles</option>
        </select>
        <ToolbarToggle
          label="Transitive"
          active={simplifyEnabled}
          onClick={() => setSimplifyPaths(!simplifyEnabled)}
          badge={simplifyBadge}
          title={
            simplifyEnabled
              ? `Transitive reduction is on: ${analysis.transitiveCount} redundant edges hidden`
              : `Transitive reduction is off: ${analysis.transitiveCount} redundant edges can be hidden`
          }
        />
        <ToolbarToggle
          label="Hide hubs"
          active={hideHubs}
          onClick={() => setHideHubs(!hideHubs)}
          badge={hubBadge}
          disabled={graphHubs.length === 0}
          title={graphHubs.length === 0 ? "No high fan-in hub modules detected" : "Hide high fan-in hub modules"}
        />
        <ToolbarToggle
          label="Hide isolated"
          active={hideIsolatedActive}
          onClick={() => setHideIsolated(!hideIsolatedActive)}
          badge={isolatedBadge}
          disabled={isolatedNodes.length === 0}
          title={isolatedNodes.length === 0 ? "Every module is connected" : "Hide modules with no dependencies"}
        />
      </div>

      <div className="absolute right-2 top-2 flex items-center gap-1 rounded border border-zinc-200 bg-white/95 p-1 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <IconButton label={`Switch to ${direction === "LR" ? "top-to-bottom" : "left-to-right"} layout`} onClick={() => setDirection((current) => (current === "LR" ? "TB" : "LR"))}>
          {direction === "LR" ? <ArrowRightIcon width={13} height={13} /> : <ArrowDownIcon width={13} height={13} />}
        </IconButton>
        <span className="mx-0.5 h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
        <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><MinusIcon width={13} height={13} /></IconButton>
        <IconButton label="Zoom in" onClick={() => zoomBy(1.25)}><PlusIcon width={13} height={13} /></IconButton>
        <IconButton label="Fit to view" onClick={fit}><MaximizeIcon width={13} height={13} /></IconButton>
        <IconButton label="Reset zoom" onClick={() => { userMoved.current = true; setView({ x: 0, y: 0, k: 1 }); }}><RotateCcwIcon width={13} height={13} /></IconButton>
      </div>

      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-3 rounded border border-zinc-200 bg-white/95 px-2 py-1 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        {focusId ? (
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
            <span className="text-zinc-400 dark:text-zinc-500">focus</span>
            <span className="max-w-56 truncate text-zinc-700 dark:text-zinc-300">{focusLabel}</span>
            <button type="button" onClick={() => setFocusId(null)} className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200" title="Clear focus (Esc)" aria-label="Clear focus">
              <XIcon width={11} height={11} />
            </button>
          </span>
        ) : (
          <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
            {layout ? `${layout.nodes.length} nodes · ${layout.edges.length} edges` : "laying out…"}
          </span>
        )}
        {hiddenDirectForSelection > 0 ? (
          <span className="font-mono text-[9px] text-indigo-600 dark:text-indigo-300">{hiddenDirectForSelection} direct hidden</span>
        ) : null}
        <span className="flex items-center gap-1 font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
          <span className="h-px w-4 bg-indigo-500" /> outgoing
        </span>
        <span className="flex items-center gap-1 font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
          <span className="h-px w-4 bg-emerald-500" /> incoming
        </span>
        <span className="flex items-center gap-1 font-mono text-[9px] text-zinc-400 dark:text-zinc-500">
          <span className="h-px w-4 border-t border-dashed border-red-500" /> back-edge
        </span>
        <span className="hidden font-mono text-[9px] text-zinc-400 lg:inline dark:text-zinc-500">scroll · drag · click</span>
      </div>
    </div>
  );
}

function GraphNode({
  positioned,
  visual,
  selected,
  dimmed,
  onHover,
  onSelect,
}: {
  positioned: PositionedNode;
  visual: ReturnType<typeof nodeVisual>;
  selected: boolean;
  dimmed: boolean;
  onHover: (hovered: boolean) => void;
  onSelect: () => void;
}): React.ReactElement {
  const { node, x, y, width, height, inCycle } = positioned;
  const statusColor =
    node.sync_state === "synced"
      ? "fill-emerald-500"
      : node.sync_state === "soft_stale"
        ? "fill-amber-500"
        : node.sync_state === "hard_stale"
          ? "fill-orange-500"
          : node.sync_state === "missing"
            ? "fill-blue-500"
            : "fill-zinc-400";
  return (
    <g
      transform={`translate(${x} ${y})`}
      opacity={dimmed ? 0.18 : 1}
      role="button"
      tabIndex={0}
      aria-label={`module ${node.label}`}
      aria-pressed={selected}
      className="cursor-pointer outline-none"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect
        width={width}
        height={height}
        rx={4}
        strokeWidth={selected ? 2 : 1}
        vectorEffect="non-scaling-stroke"
        className={
          selected
            ? "fill-white stroke-indigo-500 dark:fill-zinc-900"
            : inCycle
              ? "fill-white stroke-red-400 dark:fill-zinc-900 dark:stroke-red-700"
              : "fill-white stroke-zinc-300 hover:stroke-indigo-400 dark:fill-zinc-900 dark:stroke-zinc-700 dark:hover:stroke-indigo-500"
        }
      />
      <rect x={0} y={4} width={3} height={height - 8} rx={1.5} fill={visual.color} pointerEvents="none" />
      <text x={10} y={19} className="pointer-events-none fill-zinc-800 font-mono font-medium dark:fill-zinc-100" style={{ fontSize: 11 }}>
        {visual.label}
      </text>
      <text x={10} y={35} className="pointer-events-none fill-zinc-500 font-mono tabular-nums dark:fill-zinc-400" style={{ fontSize: 9 }}>
        {visual.metrics}
      </text>
      <circle cx={width - 10} cy={10} r={2.5} className={`pointer-events-none ${statusColor}`} />
      {selected ? (
        <rect x={1} y={1} width={width - 2} height={height - 2} rx={3} fill="none" className="stroke-indigo-200 dark:stroke-indigo-900" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ) : null}
      <title>
        {`${node.label} · ${node.symbols} symbols · ${node.components} components · ${node.hooks} hooks · fan-in ${node.fan_in} · fan-out ${node.fan_out} · ${node.synced_percent}% summaries${inCycle ? " · cycle" : ""}`}
      </title>
    </g>
  );
}
