import type { Report, ReportModule, ReportSymbol } from "../types/report";

export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const value = candidate.toLowerCase();
  if (value === q) return 1000;
  if (value.startsWith(q)) return 850 - Math.min(100, value.length - q.length);
  const index = value.indexOf(q);
  if (index >= 0) return 700 - Math.min(200, index);
  let cursor = 0;
  let gaps = 0;
  for (const char of q) {
    const found = value.indexOf(char, cursor);
    if (found < 0) return 0;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 400 - gaps);
}

export interface SymbolHit {
  symbol: ReportSymbol;
  score: number;
}

export function searchSymbols(report: Report, query: string, limit = 60): SymbolHit[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return report.symbols
      .filter((symbol) => !symbol.is_test)
      .slice(0, limit)
      .map((symbol) => ({ symbol, score: 0 }));
  }
  const hits: SymbolHit[] = [];
  for (const symbol of report.symbols) {
    const score = Math.max(
      fuzzyScore(trimmed, symbol.name) + 40,
      fuzzyScore(trimmed, symbol.id),
      fuzzyScore(trimmed, symbol.module),
      fuzzyScore(trimmed, symbol.file)
    );
    if (score > 0) hits.push({ symbol, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name)).slice(0, limit);
}

export interface ModuleHit {
  module: ReportModule;
  score: number;
}

export function searchModules(report: Report, query: string, limit = 20): ModuleHit[] {
  const trimmed = query.trim();
  if (!trimmed) return report.modules.slice(0, limit).map((module) => ({ module, score: 0 }));
  const hits: ModuleHit[] = [];
  for (const module of report.modules) {
    const score = Math.max(
      fuzzyScore(trimmed, module.name),
      fuzzyScore(trimmed, String(module.components)),
      fuzzyScore(trimmed, String(module.symbols))
    );
    if (score > 0) hits.push({ module, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.module.name.localeCompare(b.module.name)).slice(0, limit);
}
