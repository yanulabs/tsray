import { useMemo, useRef, useState } from "react";
import type { Selection } from "../types/ui";
import type { Report } from "../types/report";
import { edgePath, layoutModuleGraph, type PositionedNode } from "../lib/graphLayout";
import { Badge, Button } from "./ui";
import { ArrowLeftIcon, ArrowRightIcon, NetworkIcon } from "./icons";

export function GraphView({
  report,
  selection,
  onSelect,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const [hideIsolated, setHideIsolated] = useState(false);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const graph = useMemo(() => {
    const nodes = hideIsolated
      ? report.graphs.modules.nodes.filter((node) => node.fan_in + node.fan_out > 0)
      : report.graphs.modules.nodes;
    const allowed = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: report.graphs.modules.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to)),
    };
  }, [hideIsolated, report.graphs.modules]);

  const layout = useMemo(() => layoutModuleGraph(graph), [graph]);
  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const cycleGroups = useMemo(
    () => report.module_cycles.map((cycle) => new Set(cycle)),
    [report.module_cycles]
  );
  const isCycleEdge = (from: string, to: string): boolean =>
    cycleGroups.some((group) => group.has(from) && group.has(to));
  const selectedModule = selection?.type === "module" ? selection.id : null;

  const zoom = (factor: number): void => {
    setTransform((current) => ({ ...current, k: Math.max(0.45, Math.min(2.4, current.k * factor)) }));
  };

  const reset = (): void => setTransform({ x: 0, y: 0, k: 1 });

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("[data-node]")) return;
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (!drag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = layout.width / Math.max(1, rect.width);
    setTransform((current) => ({
      ...current,
      x: drag.current!.originX + (event.clientX - drag.current!.x) * ratio,
      y: drag.current!.originY + (event.clientY - drag.current!.y) * ratio,
    }));
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <NetworkIcon width={15} height={15} className="text-indigo-500" />
            <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Module dependency graph
            </h2>
            <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {report.metrics.modules} modules
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            Arrow direction is an import. Dashed red edges participate in a module cycle.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant={hideIsolated ? "solid" : "outline"}
            onClick={() => setHideIsolated(!hideIsolated)}
          >
            {hideIsolated ? "Isolated hidden" : "Hide isolated"}
          </Button>
          <div className="flex items-center gap-0.5 rounded-lg border border-zinc-300 bg-white p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
            <Button onClick={() => zoom(0.85)} className="px-2" title="Zoom out">
              −
            </Button>
            <span className="min-w-9 text-center font-mono text-[10px] text-zinc-400">
              {Math.round(transform.k * 100)}%
            </span>
            <Button onClick={() => zoom(1.18)} className="px-2" title="Zoom in">
              +
            </Button>
          </div>
          <Button onClick={reset} variant="outline">
            Reset
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative min-h-[440px] flex-1 overflow-hidden rounded-2xl border border-zinc-200/80 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(113,113,122,0.17)_1px,transparent_0)] [background-size:22px_22px] dark:bg-[radial-gradient(circle_at_1px_1px,rgba(113,113,122,0.22)_1px,transparent_0)]" />
        {layout.nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-zinc-500">
            <NetworkIcon width={28} height={28} className="text-zinc-300 dark:text-zinc-700" />
            <p>No modules match the current filter.</p>
          </div>
        ) : (
          <svg
            className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            preserveAspectRatio="xMidYMid meet"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={(event) => {
              const delta = event.deltaY > 0 ? 0.92 : 1.08;
              setTransform((current) => ({
                ...current,
                k: Math.max(0.45, Math.min(2.4, current.k * delta)),
              }));
            }}
            role="img"
            aria-label="Module dependency graph"
          >
            <defs>
              <marker id="tsray-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-zinc-400 dark:text-zinc-600" />
              </marker>
              <marker id="tsray-arrow-cycle" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" className="text-rose-400" />
              </marker>
            </defs>
            <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
              {layout.edges.map((edge) => {
                const from = positions.get(edge.from);
                const to = positions.get(edge.to);
                if (!from || !to) return null;
                const cycle = isCycleEdge(from.id, to.id);
                const active = hovered === from.id || hovered === to.id || selectedModule === from.id || selectedModule === to.id;
                return (
                  <path
                    key={`${edge.from}|${edge.to}`}
                    d={edgePath(from, to)}
                    fill="none"
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={active ? 2.2 : Math.min(2, 0.9 + Math.log2(edge.weight + 1) * 0.35)}
                    strokeDasharray={cycle ? "5 4" : undefined}
                    markerEnd={cycle ? "url(#tsray-arrow-cycle)" : "url(#tsray-arrow)"}
                    className={
                      cycle
                        ? "stroke-rose-400/80 dark:stroke-rose-500/70"
                        : active
                          ? "stroke-indigo-400 dark:stroke-indigo-500"
                          : "stroke-zinc-300 dark:stroke-zinc-700"
                    }
                  >
                    <title>
                      {edge.from} → {edge.to} · {edge.imports} imports · {edge.symbols} symbol edges
                    </title>
                  </path>
                );
              })}

              {layout.nodes.map((node) => (
                <GraphNode
                  key={node.id}
                  node={node}
                  selected={selectedModule === node.id}
                  onSelect={() => onSelect({ type: "module", id: node.id })}
                  onHover={(value) => setHovered(value ? node.id : null)}
                />
              ))}
            </g>
          </svg>
        )}

        <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200/80 bg-white/90 px-2.5 py-1.5 text-[10px] text-zinc-500 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90 dark:text-zinc-400">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-4 rounded bg-zinc-400" /> import
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-4 border-t border-dashed border-rose-400" /> cycle
          </span>
          <span className="flex items-center gap-1">
            <ArrowLeftIcon width={11} height={11} /> fan-in
            <ArrowRightIcon width={11} height={11} /> fan-out
          </span>
          <span className="hidden sm:inline">scroll to zoom · drag to pan · click a module</span>
        </div>
      </div>
    </div>
  );
}

function GraphNode({
  node,
  selected,
  onSelect,
  onHover,
}: {
  node: PositionedNode;
  selected: boolean;
  onSelect: () => void;
  onHover: (hovered: boolean) => void;
}): React.ReactElement {
  const labelSpace = node.width - (node.cycle ? 68 : 28);
  const label = truncate(node.label, Math.max(8, Math.floor(labelSpace / 7)));
  const coverageWidth = Math.max(0, Math.min(1, node.synced_percent / 100)) * (node.width - 24);
  return (
    <g
      data-node
      transform={`translate(${node.x} ${node.y})`}
      className="cursor-pointer"
      onClick={onSelect}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onSelect();
      }}
    >
      <rect
        width={node.width}
        height={node.height}
        rx={12}
        strokeWidth={selected ? 2 : 1}
        className={`transition-colors ${
          selected
            ? "fill-indigo-50 stroke-indigo-500 dark:fill-indigo-950/50 dark:stroke-indigo-400"
            : node.cycle
              ? "fill-rose-50/80 stroke-rose-300 hover:stroke-rose-400 dark:fill-rose-950/30 dark:stroke-rose-900"
              : "fill-white stroke-zinc-200 hover:stroke-indigo-300 dark:fill-zinc-900 dark:stroke-zinc-700 dark:hover:stroke-indigo-700"
        }`}
      />
      <text
        x={12}
        y={20}
        className={`pointer-events-none select-none font-sans text-[12px] font-semibold ${
          selected ? "fill-indigo-900 dark:fill-indigo-100" : "fill-zinc-800 dark:fill-zinc-100"
        }`}
      >
        {label}
      </text>
      {node.cycle ? (
        <g transform={`translate(${node.width - 48} 8)`}>
          <rect width={40} height={15} rx={7.5} className="fill-rose-100 dark:fill-rose-950" />
          <text x={20} y={10.5} textAnchor="middle" className="fill-rose-600 text-[8px] font-bold uppercase tracking-wider dark:fill-rose-300">
            cycle
          </text>
        </g>
      ) : null}
      <text
        x={12}
        y={37}
        className="pointer-events-none select-none fill-zinc-400 text-[9.5px] dark:fill-zinc-500"
      >
        {node.symbols} sym · {node.components} comp · {node.hooks} hook
      </text>
      <rect
        x={12}
        y={46}
        width={node.width - 24}
        height={3}
        rx={1.5}
        className="pointer-events-none fill-zinc-100 dark:fill-zinc-800"
      />
      <rect
        x={12}
        y={46}
        width={coverageWidth}
        height={3}
        rx={1.5}
        className={`pointer-events-none ${node.cycle ? "fill-rose-400" : "fill-emerald-500"}`}
      />
      <text
        x={12}
        y={65}
        className="pointer-events-none select-none fill-zinc-400 text-[9px] dark:fill-zinc-500"
      >
        in {node.fan_in} · out {node.fan_out}
      </text>
      <text
        x={node.width - 12}
        y={65}
        textAnchor="end"
        className="pointer-events-none select-none fill-zinc-400 text-[9px] dark:fill-zinc-500"
      >
        {node.synced_percent.toFixed(0)}%
      </text>
    </g>
  );
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1))}…`;
}
