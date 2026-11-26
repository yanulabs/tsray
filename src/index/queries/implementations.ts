import type { IndexSnapshot, SymbolRecord } from "../types.js";
import { graphOf } from "./graph-index.js";

export interface InterfaceImplementation {
  interface: SymbolRecord;
  implementations: Array<{
    id: string;
    name: string;
    kind: string;
    module: string;
    file: string;
    line: number;
    via: string;
  }>;
}

export function findImplementations(
  snapshot: IndexSnapshot,
  interfaceId?: string
): InterfaceImplementation[] {
  const graph = graphOf(snapshot);
  const result = new Map<string, InterfaceImplementation>();

  for (const symbol of snapshot.symbols.values()) {
    if (symbol.kind !== "interface") continue;
    if (interfaceId && symbol.id !== interfaceId) continue;
    result.set(symbol.id, { interface: symbol, implementations: [] });
  }

  for (const [targetId, incoming] of graph.incoming) {
    if (interfaceId && targetId !== interfaceId) continue;
    const target = snapshot.symbols.get(targetId);
    if (target?.kind !== "interface") continue;
    const entry = result.get(targetId) ?? {
      interface: target,
      implementations: [],
    };
    const bySource = new Map(
      entry.implementations.map((item) => [item.id, item])
    );
    for (const edge of incoming) {
      if (edge.kind !== "implements") continue;
      const source = snapshot.symbols.get(edge.fromId);
      if (!source) continue;
      const via = edge.via ?? "declared";
      const existing = bySource.get(source.id);
      // A declared implements/extends edge is stronger than a structural match.
      if (existing && existing.via !== "structural" && via === "structural") {
        continue;
      }
      bySource.set(source.id, {
        id: source.id,
        name: source.name,
        kind: source.kind,
        module: source.module,
        file: source.file,
        line: source.line,
        via,
      });
    }
    entry.implementations = [...bySource.values()];
    result.set(targetId, entry);
  }

  return [...result.values()]
    .map((entry) => ({
      ...entry,
      implementations: entry.implementations.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line
      ),
    }))
    .sort(
      (a, b) =>
        a.interface.file.localeCompare(b.interface.file) ||
        a.interface.line - b.interface.line
    );
}
