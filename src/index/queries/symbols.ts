import fs from "node:fs";
import path from "node:path";
import type { IndexSnapshot, SymbolRecord } from "../types.js";
import { graphOf, isTestPath } from "./graph-index.js";

export function getSymbolMatches(
  snapshot: IndexSnapshot,
  query: string,
  limit = 20
): SymbolRecord[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  const exact: SymbolRecord[] = [];
  const byName: SymbolRecord[] = [];
  const byFile: SymbolRecord[] = [];
  const fuzzy: SymbolRecord[] = [];

  for (const symbol of snapshot.symbols.values()) {
    if (symbol.id === trimmed) exact.push(symbol);
    else if (symbol.name === trimmed) byName.push(symbol);
    else if (symbol.name.toLowerCase() === lower) byName.push(symbol);
    else if (symbol.file === trimmed || symbol.file.endsWith(trimmed)) {
      byFile.push(symbol);
    } else if (
      symbol.name.toLowerCase().includes(lower) ||
      symbol.id.toLowerCase().includes(lower)
    ) {
      fuzzy.push(symbol);
    }
  }

  const sort = (items: SymbolRecord[]): void => {
    items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };
  sort(exact);
  sort(byName);
  sort(byFile);
  sort(fuzzy);
  return [...exact, ...byName, ...byFile, ...fuzzy].slice(0, limit);
}

export function getApiSurface(
  snapshot: IndexSnapshot,
  options: {
    module?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {}
): { total: number; symbols: SymbolRecord[] } {
  const symbols = [...snapshot.symbols.values()]
    .filter((symbol) => symbol.exported && !symbol.isTest && !symbol.isGenerated)
    .filter((symbol) => !options.module || symbol.module === options.module)
    .filter((symbol) => !options.kind || symbol.kind === options.kind)
    .sort(
      (a, b) =>
        a.module.localeCompare(b.module) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line
    );
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit && options.limit > 0 ? options.limit : symbols.length;
  return { total: symbols.length, symbols: symbols.slice(offset, offset + limit) };
}

export function getReferences(
  snapshot: IndexSnapshot,
  targetId: string,
  options: { includeImports?: boolean; limit?: number } = {}
): Array<{
  from_id: string;
  from_name: string | null;
  kind: string;
  file: string;
  line: number;
  is_test: boolean;
  via?: string;
}> {
  const graph = graphOf(snapshot);
  const limit = options.limit && options.limit > 0 ? options.limit : 500;
  const references: Array<{
    from_id: string;
    from_name: string | null;
    kind: string;
    file: string;
    line: number;
    is_test: boolean;
    via?: string;
  }> = [];

  for (const edge of graph.incoming.get(targetId) ?? []) {
    if (
      !options.includeImports &&
      (edge.kind === "imports" || edge.kind === "re_exports")
    ) {
      continue;
    }
    const source = snapshot.symbols.get(edge.fromId);
    references.push({
      from_id: edge.fromId,
      from_name: source?.name ?? null,
      kind: edge.kind,
      file: edge.file,
      line: edge.line,
      is_test: source?.isTest ?? isTestPath(edge.file),
      ...(edge.via ? { via: edge.via } : {}),
    });
    if (references.length >= limit) break;
  }

  return references.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}

export function getFunctionBody(
  snapshot: IndexSnapshot,
  symbolId: string
): {
  symbol: SymbolRecord;
  source: string;
  loc: number;
  complexity: number;
} | null {
  const symbol = snapshot.symbols.get(symbolId);
  if (!symbol) return null;
  try {
    const absolute = path.join(snapshot.root, symbol.file);
    const text = fs.readFileSync(absolute, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, symbol.line - 1);
    const end = Math.min(lines.length, symbol.endLine);
    return {
      symbol,
      source: lines.slice(start, end).join("\n"),
      loc: symbol.loc,
      complexity: symbol.complexity,
    };
  } catch {
    return {
      symbol,
      source: symbol.sourcePreview,
      loc: symbol.loc,
      complexity: symbol.complexity,
    };
  }
}

export interface SymbolContextDependency {
  id: string;
  name: string;
  kind: string;
  edge_kind: string;
  file: string;
  line: number;
}

export function getSymbolDependencies(
  snapshot: IndexSnapshot,
  symbolId: string
): SymbolContextDependency[] {
  const graph = graphOf(snapshot);
  return (graph.outgoing.get(symbolId) ?? [])
    .filter((edge) => edge.kind !== "imports" && edge.kind !== "re_exports")
    .map((edge) => {
      const target = snapshot.symbols.get(edge.toId);
      return {
        id: edge.toId,
        name: target?.name ?? edge.toId,
        kind: target?.kind ?? "unknown",
        edge_kind: edge.kind,
        file: edge.file,
        line: edge.line,
      };
    })
    .sort(
      (a, b) => a.id.localeCompare(b.id) || a.edge_kind.localeCompare(b.edge_kind)
    );
}
