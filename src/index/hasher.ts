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

  // Tarjan emits SCCs dependency-first, which lets us compute content hashes
  // in a single pass without reversing the condensation graph.
  const components = stronglyConnectedComponents(adjacency);
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

interface TarjanFrame {
  id: string;
  neighbors: Iterator<string>;
  parent: string | null;
}

/**
 * Iterative Tarjan SCC decomposition. The returned components are dependency
 * first: every callee SCC is emitted before the SCC that references it.
 * Iteration avoids call-stack limits on large React applications.
 */
export function stronglyConnectedComponents(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const enter = (id: string, parent: string | null, frames: TarjanFrame[]): void => {
    indices.set(id, index);
    lowlink.set(id, index);
    index++;
    stack.push(id);
    onStack.add(id);
    frames.push({
      id,
      neighbors: (adjacency.get(id) ?? new Set<string>()).values(),
      parent,
    });
  };

  for (const start of adjacency.keys()) {
    if (indices.has(start)) continue;
    const frames: TarjanFrame[] = [];
    enter(start, null, frames);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const next = frame.neighbors.next();
      if (!next.done) {
        const neighbor = next.value;
        if (!indices.has(neighbor)) {
          enter(neighbor, frame.id, frames);
        } else if (onStack.has(neighbor)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, indices.get(neighbor)!));
        }
        continue;
      }

      frames.pop();
      if (lowlink.get(frame.id) === indices.get(frame.id)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.id);
        components.push(component);
      }
      if (frame.parent !== null) {
        lowlink.set(frame.parent, Math.min(lowlink.get(frame.parent)!, lowlink.get(frame.id)!));
      }
    }
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
