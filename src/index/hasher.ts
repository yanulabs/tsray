import crypto from "node:crypto";
import ts from "typescript";
import type { EdgeRecord, SymbolRecord } from "./types.js";

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: false });

/**
 * Prints a node back to source form when possible and collapses whitespace so
 * line shifts and formatting changes do not invalidate cached summaries.
 */
export function normalizeNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
  try {
    return printer
      .printNode(ts.EmitHint.Unspecified, node, sourceFile)
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return node.getText(sourceFile).replace(/\s+/g, " ").trim();
  }
}

export function computeDirectHashes(
  signature: string,
  normalizedBody: string,
  directive: string | null
): { sigHash: string; selfHash: string } {
  const sigHash = sha256(`sig:v1:${signature}`);
  const selfHash = sha256(`self:v1:${directive ?? ""}:${sigHash}:${normalizedBody}`);
  return { sigHash, selfHash };
}

/**
 * Computes semantic hashes in dependency-first order.
 *
 * Strongly connected components are collapsed so recursive React component
 * trees and circular module imports terminate. Every member of a cycle shares
 * the same canonical SCC digest plus the digests of external dependencies.
 */
export function computeGraphHashes(symbols: Map<string, SymbolRecord>, edges: EdgeRecord[]): void {
  const adjacency = new Map<string, Set<string>>();
  for (const id of symbols.keys()) adjacency.set(id, new Set());
  for (const edge of edges) {
    if (edge.fromId === edge.toId) continue;
    if (!symbols.has(edge.fromId) || !symbols.has(edge.toId)) continue;
    adjacency.get(edge.fromId)!.add(edge.toId);
  }

  const components = stronglyConnectedComponents(adjacency);
  // SCCs are returned in condensation-source order, so reverse them to visit
  // dependencies before their callers.
  components.reverse();

  const contentHashes = new Map<string, string>();
  for (const component of components) {
    const componentSet = new Set(component);
    const externalHashes = new Set<string>();
    const internalSignatures: string[] = [];

    for (const id of component) {
      const symbol = symbols.get(id)!;
      internalSignatures.push(`${id}=${symbol.selfHash}`);
      for (const dependency of adjacency.get(id) ?? []) {
        if (componentSet.has(dependency)) continue;
        externalHashes.add(`${dependency}=${contentHashes.get(dependency) ?? ""}`);
      }
    }

    internalSignatures.sort();
    const external = [...externalHashes].sort();
    const sccBase = component.length > 1 ? sha256(`scc:${internalSignatures.join("|")}`) : "";
    const dependencyInput = [sccBase, ...external].filter(Boolean).join("|");
    const depHash = sha256(`dep:v1:${dependencyInput}`);

    for (const id of component) {
      const symbol = symbols.get(id)!;
      symbol.depHash = depHash;
      symbol.contentHash = sha256(`content:v1:${symbol.selfHash}:${depHash}`);
      contentHashes.set(id, symbol.contentHash);
    }
  }
}

/**
 * Returns directed cycles (SCCs with more than one node) sorted for stable
 * output. Self loops are intentionally ignored by architecture reports.
 */
export function findDirectedCycles(
  nodes: Iterable<string>,
  edges: Array<[string, string]>
): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node, new Set());
  for (const [from, to] of edges) {
    if (from === to) continue;
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    adjacency.get(from)!.add(to);
  }

  return stronglyConnectedComponents(adjacency)
    .filter((component) => component.length > 1)
    .map((component) => component.slice().sort())
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

/**
 * Iterative Kosaraju SCC decomposition. The returned components are in
 * topological order of the condensation: upstream components first.
 */
export function stronglyConnectedComponents(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): string[][] {
  const order: string[] = [];
  const visited = new Set<string>();

  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; iterator: Iterator<string> }> = [];
    visited.add(start);
    stack.push({ id: start, iterator: (adjacency.get(start) ?? new Set<string>()).values() });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.iterator.next();
      if (next.done) {
        order.push(frame.id);
        stack.pop();
        continue;
      }
      const neighbor = next.value;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      stack.push({
        id: neighbor,
        iterator: (adjacency.get(neighbor) ?? new Set<string>()).values(),
      });
    }
  }

  const reverse = new Map<string, string[]>();
  for (const id of adjacency.keys()) reverse.set(id, []);
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      reverse.get(to)?.push(from);
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i]!;
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of reverse.get(current) ?? []) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }

  return components;
}

/** Stable JSON used for hashing configuration and summary payloads. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
}
