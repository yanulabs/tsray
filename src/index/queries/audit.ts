import type { HotspotRecord, IndexSnapshot, SymbolRecord } from "../types.js";
import { graphOf } from "./graph-index.js";

export function getHotspots(snapshot: IndexSnapshot, limit = 25): HotspotRecord[] {
  const graph = graphOf(snapshot);
  const records: HotspotRecord[] = [];

  for (const symbol of snapshot.symbols.values()) {
    if (!symbol.eligible) continue;
    if (!["component", "hook", "function", "method"].includes(symbol.kind)) {
      continue;
    }
    const fanIn = graph.fanIn.get(symbol.id) ?? 0;
    const tested = graph.testReachable.has(symbol.id);
    const riskScore = Number(
      (symbol.complexity * (1 + Math.log2(1 + fanIn)) * (tested ? 1 : 1.8)).toFixed(
        2
      )
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

  return records
    .sort((a, b) => b.riskScore - a.riskScore || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function getDeadCode(
  snapshot: IndexSnapshot,
  includeExported = false
): SymbolRecord[] {
  const graph = graphOf(snapshot);
  const roots = new Set<string>();

  // Root file nodes too: an entrypoint can invoke project code from module-level
  // statements before any symbol is declared.
  for (const file of snapshot.files.values()) {
    if (file.isEntrypoint || file.isTest) roots.add(`file:${file.path}`);
  }

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
