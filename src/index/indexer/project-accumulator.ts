import type { ProjectCacheEntry } from "../types.js";
import type { IndexAccumulator } from "./types.js";

export function createAccumulator(): IndexAccumulator {
    return {
      symbols: new Map(),
      edges: [],
      fileImports: [],
      files: new Map(),
      warnings: [],
      prodErrors: [],
      modules: new Set(),
      declarationIds: new Map(),
      pendingWraps: [],
      seenFileImports: new Set(),
      seenEdges: new Set(),
      symbolBody: new Map(),
    };
  }


export function mergeProject(target: IndexAccumulator, source: IndexAccumulator): void {
    for (const [id, symbol] of source.symbols) {
      const existing = target.symbols.get(id);
      if (!existing) {
        target.symbols.set(id, symbol);
        continue;
      }
      existing.exported ||= symbol.exported;
      existing.defaultExport ||= symbol.defaultExport;
      existing.isEntrypoint ||= symbol.isEntrypoint;
    }
    for (const edge of source.edges) {
      const key = `${edge.fromId}|${edge.toId}|${edge.kind}|${edge.file}:${edge.line}|${edge.via ?? ""}`;
      if (target.seenEdges.has(key)) continue;
      target.seenEdges.add(key);
      target.edges.push(edge);
    }
    for (const edge of source.fileImports) {
      const key = `${edge.fromFile}|${edge.toFile}|${edge.line}|${edge.typeOnly ? "type" : "value"}`;
      if (target.seenFileImports.has(key)) continue;
      target.seenFileImports.add(key);
      target.fileImports.push(edge);
    }
    for (const [file, record] of source.files) {
      if (!target.files.has(file)) target.files.set(file, record);
    }
    target.warnings.push(...source.warnings);
    target.prodErrors.push(...source.prodErrors);
    for (const module of source.modules) target.modules.add(module);
  }

export function mergeProjectEntry(target: IndexAccumulator, source: ProjectCacheEntry): void {
    for (const symbol of source.symbols) {
      const existing = target.symbols.get(symbol.id);
      if (!existing) {
        target.symbols.set(symbol.id, symbol);
        continue;
      }
      existing.exported ||= symbol.exported;
      existing.defaultExport ||= symbol.defaultExport;
      existing.isEntrypoint ||= symbol.isEntrypoint;
    }
    for (const edge of source.edges) {
      const key = `${edge.fromId}|${edge.toId}|${edge.kind}|${edge.file}:${edge.line}|${edge.via ?? ""}`;
      if (target.seenEdges.has(key)) continue;
      target.seenEdges.add(key);
      target.edges.push(edge);
    }
    for (const edge of source.fileImports) {
      const key = `${edge.fromFile}|${edge.toFile}|${edge.line}|${edge.typeOnly ? "type" : "value"}`;
      if (target.seenFileImports.has(key)) continue;
      target.seenFileImports.add(key);
      target.fileImports.push(edge);
    }
    for (const file of source.files) {
      if (!target.files.has(file.path)) target.files.set(file.path, { ...file });
    }
    target.warnings.push(...source.warnings);
    target.prodErrors.push(...source.prodErrors);
    for (const module of source.modules) target.modules.add(module);
  }
