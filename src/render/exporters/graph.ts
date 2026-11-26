import type { IndexSnapshot } from "../../index/types.js";
import { getCallGraph, getDependencyGraph } from "../../index/queries.js";

export interface GraphExportOptions {
  scope?: "module" | "file" | "symbol";
  root?: string;
  depth?: number;
  direction?: "out" | "in" | "both" | "callers" | "callees";
}

export function exportDot(snapshot: IndexSnapshot, options: GraphExportOptions = {}): string {
  const scope = options.scope ?? "module";
  const lines: string[] = [
    "digraph tsray {",
    '  rankdir="LR";',
    '  graph [fontname="ui-sans-serif", bgcolor="transparent"];',
    '  node [shape=box, style="rounded,filled", fontname="ui-sans-serif", fillcolor="#eef2ff", color="#6366f1"];',
    '  edge [color="#94a3b8", fontname="ui-sans-serif"];',
  ];

  if (scope === "symbol") {
    if (!options.root) throw new Error("Symbol graph export requires --root <symbol-id>");
    const graph = getCallGraph(snapshot, options.root, {
      depth: options.depth ?? 2,
      direction: symbolGraphDirection(options.direction),
    });
    for (const node of graph.nodes) {
      const symbol = snapshot.symbols.get(node.id);
      const fill = symbol?.kind === "component" ? "#dbeafe" : symbol?.kind === "hook" ? "#fef3c7" : "#f1f5f9";
      lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(node.name)}\\n${escapeDot(node.kind)}", fillcolor="${fill}"];`);
    }
    for (const edge of graph.edges) {
      lines.push(
        `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.kind)}"];`
      );
    }
    lines.push("}");
    return `${lines.join("\n")}\n`;
  }

  const graph = getDependencyGraph(snapshot, {
    scope: scope === "file" ? "file" : "module",
    root: options.root,
    depth: options.depth ?? 2,
    direction:
      options.direction === "callers" ? "in" : options.direction === "callees" ? "out" : options.direction ?? "both",
  });
  const cycleMembers = new Set(snapshot.moduleCycles.flat());
  for (const node of graph.nodes) {
    const cycle = cycleMembers.has(node.id) && scope === "module";
    lines.push(
      `  "${escapeDot(node.id)}" [label="${escapeDot(node.label)}\\n${node.fan_in} in / ${node.fan_out} out", fillcolor="${cycle ? "#fee2e2" : "#eef2ff"}", color="${cycle ? "#ef4444" : "#6366f1"}"];`
    );
  }
  for (const edge of graph.edges) {
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${edge.weight}"];`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function exportMermaid(snapshot: IndexSnapshot, options: GraphExportOptions = {}): string {
  if (options.scope === "symbol") {
    if (!options.root) throw new Error("Symbol graph export requires --root <symbol-id>");
    const graph = getCallGraph(snapshot, options.root, {
      depth: options.depth ?? 2,
      direction: symbolGraphDirection(options.direction),
    });
    const lines = ["flowchart LR"];
    const ids = new Map<string, string>();
    graph.nodes.forEach((node, index) => {
      const id = `n${index}`;
      ids.set(node.id, id);
      lines.push(`  ${id}["${escapeMermaid(node.name)}<br/>${escapeMermaid(node.kind)}"]`);
    });
    for (const edge of graph.edges) {
      const from = ids.get(edge.from);
      const to = ids.get(edge.to);
      if (from && to) lines.push(`  ${from} -->|${escapeMermaid(edge.kind)}| ${to}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const scope = options.scope === "file" ? "file" : "module";
  const graph = getDependencyGraph(snapshot, {
    scope,
    root: options.root,
    depth: options.depth ?? 2,
    direction: options.direction === "callers" ? "in" : options.direction === "callees" ? "out" : "both",
  });
  const lines = ["flowchart LR"];
  const ids = new Map<string, string>();
  graph.nodes.forEach((node, index) => {
    const id = `n${index}`;
    ids.set(node.id, id);
    lines.push(`  ${id}["${escapeMermaid(node.label)}"]`);
  });
  for (const edge of graph.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (from && to) lines.push(`  ${from} -->|${edge.weight}| ${to}`);
  }
  return `${lines.join("\n")}\n`;
}
function symbolGraphDirection(
  direction: GraphExportOptions["direction"]
): "callers" | "callees" | "both" {
  if (direction === "callers" || direction === "in") return "callers";
  if (direction === "callees" || direction === "out") return "callees";
  return "both";
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeMermaid(value: string): string {
  return value
    .replace(/"/g, "&quot;")
    .replace(/\|/g, "&#124;")
    .replace(/`/g, "&#96;")
    .replace(/[[\]{}]/g, "");
}
