import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { sha256, stableStringify } from "../hasher.js";
import { toPosix } from "../../util/paths.js";
import type {
  EdgeRecord,
  FileImportEdge,
  FileRecord,
  ProjectCacheEntry,
  SymbolRecord,
} from "../types.js";
import type {
  IndexAccumulator,
  ParsedProject,
  SerializedProjectIndex,
} from "./types.js";
import type { WorkspaceDependencyIndex } from "../dependencies.js";

type SourceHashCache = Map<
  string,
  { size: number; mtimeMs: number; ctimeMs: number; hash: string }
>;

export class ProjectCacheHasher {
  constructor(
    private readonly root: string,
    private readonly sourceHashCache: SourceHashCache
  ) {}

  computeProjectInputHash(
    project: ParsedProject,
    dependencies: WorkspaceDependencyIndex,
    upstream: string[],
    signatures: Map<string, string>,
    sourceHashes: Map<string, Array<[string, string]>>
  ): string {
    return sha256(stableStringify({
      cacheVersion: 5,
      projectPath: this.projectCacheKey(project.path),
      files: sourceHashes.get(project.path) ?? [],
      compilerOptions: this.normalizeCacheValue(project.options),
      typescriptVersion: ts.version,
      dependencyFingerprint: dependencies.fingerprint(project.path),
      projectRevision: dependencies.projectRevision(project.path),
      upstream: upstream.map((path) => [
        this.projectCacheKey(path),
        signatures.get(path) ?? "",
        dependencies.projectRevision(path),
      ]),
    }));
  }

  hashSourceFile(file: string): string {
    try {
      const stat = fs.statSync(file);
      const cached = this.sourceHashCache.get(file);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) {
        return cached.hash;
      }
      const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      this.sourceHashCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash });
      return hash;
    } catch {
      return sha256(`missing:${this.cacheFilePath(file)}`);
    }
  }

  cacheFilePath(file: string): string {
    const relative = toPosix(path.relative(this.root, file));
    return relative.startsWith("..") ? file : relative;
  }

  projectCacheKey(projectPath: string): string {
    return this.cacheFilePath(projectPath);
  }

  normalizeCacheValue(value: unknown): unknown {
    if (typeof value === "string") {
      return value === this.root || value.startsWith(`${this.root}${path.sep}`)
        ? toPosix(path.relative(this.root, value))
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.normalizeCacheValue(item));
    if (value && typeof value === "object") {
      const normalized: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) normalized[key] = this.normalizeCacheValue(item);
      return normalized;
    }
    return value;
  }

  computeProjectSigHash(symbols: Iterable<SymbolRecord>): string {
    const api = [...symbols]
      .filter((symbol) => symbol.exported && !symbol.isTest)
      .map((symbol) => ({
        id: symbol.id,
        kind: symbol.kind,
        sigHash: symbol.sigHash,
        defaultExport: symbol.defaultExport,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return sha256(stableStringify(api));
  }

  createProjectCacheEntry(
    projectPath: string,
    inputHash: string,
    result: SerializedProjectIndex | IndexAccumulator
  ): ProjectCacheEntry {
    if (result.symbols instanceof Map) {
      const accumulator = result as IndexAccumulator;
      return {
        cacheVersion: 5,
        projectPath: this.projectCacheKey(projectPath),
        inputHash,
        projectSigHash: this.computeProjectSigHash(accumulator.symbols.values()),
        outputHash: this.computeProjectOutputHash(result),
        symbols: [...accumulator.symbols.values()],
        edges: accumulator.edges,
        fileImports: accumulator.fileImports,
        files: [...accumulator.files.values()],
        warnings: accumulator.warnings,
        prodErrors: accumulator.prodErrors,
        modules: [...accumulator.modules],
      };
    }
    const serialized = result as SerializedProjectIndex;
    const symbols = new Map(serialized.symbols);
    return {
      cacheVersion: 5,
      projectPath: this.projectCacheKey(projectPath),
      inputHash,
      projectSigHash: this.computeProjectSigHash(symbols.values()),
      outputHash: this.computeProjectOutputHash(result),
      symbols: [...symbols.values()],
      edges: serialized.edges,
      fileImports: serialized.fileImports,
      files: serialized.files.map(([, file]) => file),
      warnings: serialized.warnings,
      prodErrors: serialized.prodErrors,
      modules: serialized.modules,
    };
  }


  computeProjectOutputHash(result: SerializedProjectIndex | IndexAccumulator): string {
    const sort = <T>(items: T[], key: (item: T) => string): T[] =>
      items.slice().sort((a, b) => key(a).localeCompare(key(b)));
    if (result.symbols instanceof Map) {
      const accumulator = result as IndexAccumulator;
      return sha256(JSON.stringify({
        symbols: sort([...accumulator.symbols.values()], (symbol) => symbol.id),
        edges: sort(accumulator.edges, (edge) => stableStringify(edge)),
        fileImports: sort(accumulator.fileImports, (edge) => stableStringify(edge)),
        files: sort([...accumulator.files.values()], (file) => file.path),
        modules: sort([...accumulator.modules], (module) => module),
      }));
    }
    const serialized = result as SerializedProjectIndex;
    return sha256(JSON.stringify({
      symbols: sort(serialized.symbols.map(([, symbol]) => symbol), (symbol) => symbol.id),
      edges: sort(serialized.edges, (edge) => stableStringify(edge)),
      fileImports: sort(serialized.fileImports, (edge) => stableStringify(edge)),
      files: sort(serialized.files.map(([, file]) => file), (file) => file.path),
      modules: sort(serialized.modules, (module) => module),
    }));
  }

  computeSnapshotDigest(
    symbols: Map<string, SymbolRecord>,
    edges: EdgeRecord[],
    files: Map<string, FileRecord>,
    fileImports: FileImportEdge[],
    cycles: string[][],
    modules: Set<string>
  ): string {
    const hash = createHash("sha256");
    const add = (label: string, value: unknown): void => {
      hash.update(label);
      hash.update("\0");
      hash.update(JSON.stringify(value));
      hash.update("\n");
    };
    const canonical = <T>(items: T[], key: (item: T) => string): T[] =>
      items
        .map((item, index) => ({ item, index, key: key(item) }))
        .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index)
        .map((entry) => entry.item);
    add("symbols", canonical([...symbols.values()], (symbol) => symbol.id));
    add("edges", canonical(edges, (edge) => stableStringify(edge)));
    add("files", canonical([...files.values()], (file) => file.path));
    add("imports", canonical(fileImports, (edge) => stableStringify(edge)));
    add("cycles", canonical(cycles, (cycle) => stableStringify(cycle)));
    add("modules", [...modules].sort());
    return hash.digest("hex");
  }

}
