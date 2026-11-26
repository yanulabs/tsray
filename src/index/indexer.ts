import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  computeGraphHashes,
  findDirectedCycles,
  sha256,
} from "./hasher.js";
import { indexProject } from "./indexer/project-indexer.js";
import { canonicalPath } from "./indexer/symbol-utils.js";
import { ProjectCacheHasher } from "./indexer/cache-hasher.js";
import { createLanguageService } from "./indexer/language-service.js";
import { loadProjects } from "./indexer/project-loader.js";
import {
  indexProjectsInParallel,
  workerScriptExists,
} from "./indexer/parallel-runner.js";
import type {
  DiagnosticCacheEntry,
  IndexAccumulator,
  IndexerBootstrap,
  IndexerOptions,
  ParsedProject,
  SerializedProjectIndex,
} from "./indexer/types.js";
export type * from "./indexer/types.js";
import { WorkspaceDependencyIndex } from "./dependencies.js";
import type {
  AnalysisProjectConfig,
  IndexSnapshot,
  ProjectCacheEntry,
  ProjectCacheProvider,
  ProjectConfigInfo,
  ProjectIndexDetail,
  ProjectIndexMetrics,
} from "./types.js";
import {
  isExcluded,
  isSourceFile,
  loadConfig,
  readPackageEntrypoints,
  resolveProject,
  toPosix,
} from "../util/paths.js";

const DEPENDENCY_CACHE_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

export class TsReactIndexer {
  readonly root: string;
  readonly projectId: string;
  readonly tsconfigPath: string;
  readonly tsconfigPaths: string[];
  readonly workspace: boolean;
  readonly allowErrors: boolean;
  private readonly parallel: boolean;
  config: ReturnType<typeof resolveProject>["config"];
  readonly typescriptVersion = ts.version;

  private parsedProjects: ParsedProject[] = [];
  private activeProjects: ParsedProject[] = [];
  private readonly documentRegistry = ts.createDocumentRegistry();
  private fileList: string[] = [];
  private fileSet = new Set<string>();
  private readonly fileVersions = new Map<string, number>();
  private readonly scriptSnapshots = new Map<
    string,
    { version: string; snapshot: ts.IScriptSnapshot }
  >();
  private readonly dirtyFiles = new Set<string>();
  private readonly diagnosticsCache = new Map<string, DiagnosticCacheEntry>();
  private lastHealthySnapshot: IndexSnapshot | null = null;
  private lastSnapshot: IndexSnapshot | null = null;
  private revision = 0;
  private packageEntrypoints: string[] = [];
  private projectCache: ProjectCacheProvider | null = null;
  private projectEntryCache = new Map<string, ProjectCacheEntry>();
  private dependencyIndex: WorkspaceDependencyIndex | null = null;
  private readonly sourceHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; hash: string }>();
  private readonly cacheHasher: ProjectCacheHasher;

  constructor(targetPath: string, options: IndexerOptions = {}, bootstrap?: IndexerBootstrap) {
    if (bootstrap) {
      this.root = bootstrap.root;
      this.projectId = bootstrap.projectId;
      this.tsconfigPath = bootstrap.tsconfigPath;
      this.tsconfigPaths = bootstrap.tsconfigPaths;
      this.workspace = bootstrap.workspace;
      this.allowErrors = options.allowErrors ?? true;
      this.parallel = options.parallel ?? false;
      this.config = bootstrap.config;
      this.parsedProjects = bootstrap.projects;
      this.activeProjects = bootstrap.projects.filter((project) => project.ownedFiles.length > 0);
      this.fileList = [...bootstrap.fileList];
      this.fileSet = new Set(this.fileList);
      for (const [file, version] of bootstrap.fileVersions) this.fileVersions.set(file, version);
      this.packageEntrypoints = [...bootstrap.packageEntrypoints];
      this.cacheHasher = new ProjectCacheHasher(
        this.root,
        this.sourceHashCache
      );
      return;
    }

    const resolved = resolveProject(targetPath, options);
    this.root = resolved.root;
    this.projectId = resolved.projectId;
    this.tsconfigPath = resolved.primaryTsconfigPath;
    this.tsconfigPaths = resolved.tsconfigPaths;
    this.workspace = resolved.workspace;
    this.allowErrors = options.allowErrors ?? resolved.workspace;
    this.parallel = options.parallel ?? true;
    this.config = resolved.config;
    this.projectCache = options.projectCache ?? null;
    this.cacheHasher = new ProjectCacheHasher(
      this.root,
      this.sourceHashCache
    );

    this.loadProjects();
    this.packageEntrypoints = this.collectPackageEntrypoints();
    if (options.fullDiagnostics) this.dirtyFiles.clear();
  }

  /** @internal Rehydrate a worker without repeating workspace discovery. */
  static fromBootstrap(bootstrap: IndexerBootstrap): TsReactIndexer {
    return new TsReactIndexer(
      bootstrap.root,
      { allowErrors: true, parallel: false },
      bootstrap
    );
  }

  /** Attach persistent project outputs after the SQLite store has been resolved. */
  setProjectCache(provider: ProjectCacheProvider): void {
    this.projectCache = provider;
    this.projectEntryCache.clear();
  }

  /** @deprecated Use setProjectCache. Kept for internal API compatibility. */
  setDiagnosticCache(provider: ProjectCacheProvider): void {
    this.setProjectCache(provider);
  }

  /** Monotonic revision used by auxiliary analyses to invalidate caches. */
  get analysisRevision(): number {
    return this.revision;
  }

  /**
   * Project metadata for auxiliary analyses (CSS, runtime checks) that need a
   * type-checked program without rebuilding or mutating the semantic index.
   */
  getAnalysisProjects(): AnalysisProjectConfig[] {
    return this.activeProjects.map((project) => ({
      tsconfigPath: project.path,
      compilerOptions: { ...project.options },
      rootNames: [...project.programFiles],
      ownedFiles: [...project.ownedFiles],
    }));
  }

  /** @internal Capture one project/version epoch for worker threads. */
  getBootstrap(): IndexerBootstrap {
    return {
      root: this.root,
      projectId: this.projectId,
      tsconfigPath: this.tsconfigPath,
      tsconfigPaths: this.tsconfigPaths,
      workspace: this.workspace,
      config: this.config,
      projects: this.activeProjects,
      packageEntrypoints: this.packageEntrypoints,
      fileList: this.fileList,
      fileVersions: [...this.fileVersions],
    };
  }

  private loadProjects(): void {
    const loaded = loadProjects(
      this.root,
      this.config,
      this.tsconfigPaths,
      this.fileVersions
    );
    this.parsedProjects = loaded.parsedProjects;
    this.activeProjects = loaded.activeProjects;
    this.fileList = loaded.fileList;
    this.fileSet = new Set(loaded.fileList);
    this.fileVersions.clear();
    for (const [file, version] of loaded.fileVersions) {
      this.fileVersions.set(file, version);
    }
    for (const file of loaded.removedFiles) {
      this.scriptSnapshots.delete(file);
      this.diagnosticsCache.delete(file);
    }
  }

  private collectPackageEntrypoints(): string[] {
    const patterns = new Set(readPackageEntrypoints(this.root));
    const directories = new Set(this.parsedProjects.map((project) => path.dirname(project.path)));
    for (const directory of directories) {
      for (const pattern of readPackageEntrypoints(directory)) {
        const relative = toPosix(path.relative(this.root, path.join(directory, pattern)));
        if (!relative.startsWith("..")) patterns.add(relative);
      }
    }
    return [...patterns];
  }


  private createLanguageService(project: ParsedProject): ts.LanguageService {
    return createLanguageService(project, {
      root: this.root,
      fileVersions: this.fileVersions,
      scriptSnapshots: this.scriptSnapshots,
      documentRegistry: this.documentRegistry,
    });
  }

  /** @internal Restrict a worker to the projects assigned by the parent process. */
  restrictToProjects(configPaths: string[]): void {
    const allowed = new Set(configPaths);
    this.activeProjects = this.activeProjects.filter((project) => allowed.has(project.path));
  }

  /** @internal Index one assigned project and return a structured-clone-safe result. */
  buildProjectIndex(configPath: string, fullDiagnostics: boolean): SerializedProjectIndex {
    const project = this.activeProjects.find((candidate) => candidate.path === configPath);
    if (!project) throw new Error(`Project is not assigned to this worker: ${configPath}`);
    const accumulator = this.indexProjectLocal(project, fullDiagnostics);
    return {
      projectPath: project.path,
      symbols: [...accumulator.symbols],
      edges: accumulator.edges,
      fileImports: accumulator.fileImports,
      files: [...accumulator.files],
      warnings: accumulator.warnings,
      prodErrors: accumulator.prodErrors,
      modules: [...accumulator.modules],
    };
  }

  getLastHealthySnapshot(): IndexSnapshot | null {
    return this.lastHealthySnapshot;
  }

  getLastSnapshot(): IndexSnapshot | null {
    return this.lastSnapshot;
  }

  getProjectConfigs(): ProjectConfigInfo[] {
    return this.parsedProjects.map((project) => ({
      path: toPosix(path.relative(this.root, project.path)),
      fileCount: project.fileNames.length,
      references: project.references.map((reference) => toPosix(path.relative(this.root, reference))),
    }));
  }

  notifyFilesChanged(changedFiles: string[], reloadConfig = false): void {
    if (changedFiles.length > 0) this.revision++;
    if (reloadConfig) {
      this.config = loadConfig(this.root);
      this.dependencyIndex = null;
      this.loadProjects();
      this.packageEntrypoints = this.collectPackageEntrypoints();
      this.diagnosticsCache.clear();
      this.sourceHashCache.clear();
      for (const file of this.fileList) {
        this.fileVersions.set(file, (this.fileVersions.get(file) ?? 0) + 1);
        this.dirtyFiles.add(file);
      }
      return;
    }

    let membershipChanged = false;
    for (const changed of changedFiles) {
      if (DEPENDENCY_CACHE_FILES.has(path.basename(changed))) this.dependencyIndex = null;
      const absolute = canonicalPath(changed);
      if (fs.existsSync(absolute) && isSourceFile(absolute)) {
        const relative = toPosix(path.relative(this.root, absolute));
        if (!relative.startsWith("..") && isExcluded(relative, this.config)) continue;
        if (!this.fileSet.has(absolute)) membershipChanged = true;
        this.fileVersions.set(absolute, (this.fileVersions.get(absolute) ?? 0) + 1);
        this.scriptSnapshots.delete(absolute);
        this.dirtyFiles.add(absolute);
        this.diagnosticsCache.delete(absolute);
        this.sourceHashCache.delete(absolute);
      } else if (!fs.existsSync(absolute)) {
        if (this.fileSet.has(absolute)) membershipChanged = true;
        this.fileVersions.delete(absolute);
        this.scriptSnapshots.delete(absolute);
        this.dirtyFiles.add(absolute);
        this.diagnosticsCache.delete(absolute);
        this.sourceHashCache.delete(absolute);
      }
    }

    if (membershipChanged) {
      this.dependencyIndex = null;
      this.loadProjects();
      this.packageEntrypoints = this.collectPackageEntrypoints();
    }

    // Type errors can surface in direct importers after a dependency changes.
    if (this.lastSnapshot) {
      for (const edge of this.lastSnapshot.fileImports) {
        const from = path.resolve(this.root, edge.fromFile);
        const to = path.resolve(this.root, edge.toFile);
        if (this.dirtyFiles.has(to) && !this.dirtyFiles.has(from)) {
          this.fileVersions.set(from, (this.fileVersions.get(from) ?? 0) + 1);
          this.scriptSnapshots.delete(from);
          this.dirtyFiles.add(from);
          this.diagnosticsCache.delete(from);
        }
      }
    }
  }

  buildIndex(options: IndexerOptions = {}): IndexSnapshot {
    this.revision++;
    const started = performance.now();
    const fullDiagnostics = options.fullDiagnostics ?? this.dirtyFiles.size === 0;
    const accumulator = this.createAccumulator();
    const { entries, metrics, details } = this.resolveProjectEntries(fullDiagnostics);

    for (const project of this.activeProjects) {
      const entry = entries.get(project.path);
      if (!entry) throw new Error(`Project was not resolved: ${project.path}`);
      this.mergeProjectEntry(accumulator, entry);
    }
    this.dirtyFiles.clear();

    const { symbols, edges, fileImports, files, modules: moduleSet, warnings, prodErrors } = accumulator;
    const validEdges = edges.filter((edge) => symbols.has(edge.toId));
    edges.length = 0;
    edges.push(...validEdges);

    // Count exports once after every project has contributed its symbols.
    for (const symbol of symbols.values()) {
      const fileRecord = files.get(symbol.file);
      if (fileRecord && symbol.exported) fileRecord.exports++;
    }

    // Strong React/call edges take precedence over weak identifier references.
    const strongLocations = new Set(
      edges
        .filter((edge) => edge.kind !== "references")
        .map((edge) => `${edge.fromId}|${edge.toId}|${edge.file}:${edge.line}`)
    );
    const dedupedEdges = edges.filter(
      (edge) =>
        edge.kind !== "references" ||
        !strongLocations.has(`${edge.fromId}|${edge.toId}|${edge.file}:${edge.line}`)
    );
    edges.length = 0;
    edges.push(...dedupedEdges);

    for (const edge of edges) {
      const target = symbols.get(edge.toId);
      if (!target) continue;
      if (edge.kind === "calls" && target.kind === "hook") edge.kind = "uses_hook";
      if (edge.kind === "renders" && target.kind === "context") edge.kind = "provides_context";
    }

    // Semantic hash chain.
    computeGraphHashes(symbols, edges);

    // Module cycles from production file imports.
    const moduleEdges: Array<[string, string]> = [];
    for (const edge of fileImports) {
      if (edge.isTest) continue;
      // `import type` is erased at runtime and cannot create a runtime module
      // cycle. It still appears in the dependency graph for navigation.
      if (edge.typeOnly) continue;
      if (edge.fromModule !== edge.toModule) moduleEdges.push([edge.fromModule, edge.toModule]);
    }
    const moduleCycles = findDirectedCycles(moduleSet, moduleEdges);

    const snapshot: IndexSnapshot = {
      root: this.root,
      projectId: this.projectId,
      tsconfigPath: toPosix(path.relative(this.root, this.tsconfigPath)),
      tsconfigPaths: this.tsconfigPaths.map((config) => toPosix(path.relative(this.root, config))),
      projectConfigs: this.getProjectConfigs(),
      typescriptVersion: ts.version,
      indexedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      symbols,
      edges,
      files,
      fileImports,
      moduleCycles,
      warnings,
      prodErrors,
      filesCount: files.size,
      modules: [...moduleSet].sort(),
      diagnosticsCached: metrics.diagnostics_cached,
      projectMetrics: metrics,
      projectDetails: details,
      graphDigest: this.cacheHasher.computeSnapshotDigest(
        symbols,
        edges,
        files,
        fileImports,
        moduleCycles,
        moduleSet
      ),
    };

    this.lastSnapshot = snapshot;
    if (prodErrors.length === 0) this.lastHealthySnapshot = snapshot;
    return snapshot;
  }

  private resolveProjectEntries(fullDiagnostics: boolean): {
    entries: Map<string, ProjectCacheEntry>;
    metrics: ProjectIndexMetrics;
    details: ProjectIndexDetail[];
  } {
    const metrics: ProjectIndexMetrics = {
      projects_total: this.activeProjects.length,
      projects_cached: 0,
      projects_rebuilt: 0,
      projects_empty: this.parsedProjects.length - this.activeProjects.length,
      workers_spawned: 0,
      diagnostics_cached: 0,
    };
    const entries = new Map<string, ProjectCacheEntry>();
    const details: ProjectIndexDetail[] = this.parsedProjects
      .filter((project) => project.ownedFiles.length === 0)
      .map((project) => ({
        project: this.cacheHasher.projectCacheKey(project.path),
        status: "empty",
        files: 0,
        diagnostics_cached: 0,
        project_sig_hash: null,
      }));
    if (!this.projectCache) {
      const results = this.runProjects(this.activeProjects, fullDiagnostics);
      metrics.workers_spawned = results.workersSpawned;
      metrics.projects_rebuilt = this.activeProjects.length;
      for (const project of this.activeProjects) {
        const result = results.results.get(project.path) ?? this.indexProjectLocal(project, fullDiagnostics);
        const entry = this.cacheHasher.createProjectCacheEntry(project.path, "", result);
        entries.set(project.path, entry);
        details.push({
          project: this.cacheHasher.projectCacheKey(project.path),
          status: "rebuilt",
          files: result.symbols instanceof Map
            ? (result as IndexAccumulator).files.size
            : (result as SerializedProjectIndex).files.length,
          diagnostics_cached: 0,
          project_sig_hash: entry.projectSigHash,
        });
      }
      return { entries, metrics, details };
    }

    const dependencies = this.dependencyIndex ??= new WorkspaceDependencyIndex(
      this.root,
      this.parsedProjects.map((project) => project.path)
    );
    const projectDependencies = this.buildProjectDependencies(dependencies);
    const order = this.topologicalProjectOrder(projectDependencies);
    const sourceHashes = new Map<string, Array<[string, string]>>();
    for (const project of this.activeProjects) {
      sourceHashes.set(project.path, project.ownedFiles.map((file) => [this.cacheHasher.cacheFilePath(file), this.cacheHasher.hashSourceFile(file)]));
    }

    const emptySigHash = sha256("tsray-empty-project:v1");
    const signatures = new Map<string, string>();
    for (const project of this.parsedProjects) {
      if (project.ownedFiles.length === 0) signatures.set(project.path, emptySigHash);
    }
    const pending = new Set(this.activeProjects.map((project) => project.path));
    const writes: ProjectCacheEntry[] = [];

    while (pending.size > 0) {
      const ready: Array<{ project: ParsedProject; inputHash: string }> = [];
      let resolvedThisPass = false;
      for (const project of order) {
        if (!pending.has(project.path)) continue;
        const upstream = [...(projectDependencies.get(project.path) ?? [])].sort();
        if (!upstream.every((dependency) => signatures.has(dependency))) continue;
        const inputHash = this.cacheHasher.computeProjectInputHash(project, dependencies, upstream, signatures, sourceHashes);
        let hit = this.projectEntryCache.get(project.path);
        if (!hit || hit.inputHash !== inputHash) {
          hit = this.projectCache.readProjects([this.cacheHasher.projectCacheKey(project.path)]).get(
            this.cacheHasher.projectCacheKey(project.path)
          );
        }
        if (hit && hit.inputHash === inputHash) {
          entries.set(project.path, hit);
          signatures.set(project.path, hit.projectSigHash);
          pending.delete(project.path);
          metrics.projects_cached++;
          metrics.diagnostics_cached += hit.files.length;
          details.push({
            project: this.cacheHasher.projectCacheKey(project.path),
            status: "cached",
            files: hit.files.length,
            diagnostics_cached: hit.files.length,
            project_sig_hash: hit.projectSigHash,
          });
          resolvedThisPass = true;
        } else {
          ready.push({ project, inputHash });
        }
      }

      if (ready.length === 0) {
        if (resolvedThisPass) continue;
        const project = order.find((candidate) => pending.has(candidate.path));
        if (!project) break;
        const upstream = [...(projectDependencies.get(project.path) ?? [])].sort();
        ready.push({
          project,
          inputHash: this.cacheHasher.computeProjectInputHash(project, dependencies, upstream, signatures, sourceHashes),
        });
      }

      metrics.projects_rebuilt += ready.length;
      const results = this.runProjects(ready.map((item) => item.project), fullDiagnostics);
      metrics.workers_spawned += results.workersSpawned;
      for (const item of ready) {
        const result = results.results.get(item.project.path) ?? this.indexProjectLocal(item.project, fullDiagnostics);
        const entry = this.cacheHasher.createProjectCacheEntry(item.project.path, item.inputHash, result);
        entries.set(item.project.path, entry);
        signatures.set(item.project.path, entry.projectSigHash);
        pending.delete(item.project.path);
        writes.push(entry);
        details.push({
          project: this.cacheHasher.projectCacheKey(item.project.path),
          status: "rebuilt",
          files: entry.files.length,
          diagnostics_cached: 0,
          project_sig_hash: entry.projectSigHash,
        });
      }
    }

    this.projectCache.writeProjects(writes);
    this.projectEntryCache = new Map(entries);
    details.sort((a, b) => a.project.localeCompare(b.project));
    return { entries, metrics, details };
  }

  private buildProjectDependencies(dependencies: WorkspaceDependencyIndex): Map<string, Set<string>> {
    const active = new Set(this.activeProjects.map((project) => project.path));
    const projectsByDirectory = new Map<string, string[]>();
    for (const project of this.activeProjects) {
      const directory = path.dirname(project.path);
      const list = projectsByDirectory.get(directory) ?? [];
      list.push(project.path);
      projectsByDirectory.set(directory, list);
    }
    const result = new Map<string, Set<string>>();
    for (const project of this.activeProjects) {
      const upstream = new Set<string>();
      for (const reference of project.references) {
        if (active.has(reference)) upstream.add(reference);
      }
      for (const local of dependencies.localDependencies(project.path)) {
        for (const dependency of projectsByDirectory.get(local.directory) ?? []) {
          if (dependency !== project.path) upstream.add(dependency);
        }
      }
      result.set(project.path, upstream);
    }
    return result;
  }

  private topologicalProjectOrder(dependencies: Map<string, Set<string>>): ParsedProject[] {
    const byPath = new Map(this.activeProjects.map((project) => [project.path, project]));
    const state = new Map<string, "visiting" | "done">();
    const order: ParsedProject[] = [];
    const visit = (projectPath: string): void => {
      if (state.get(projectPath) === "done" || state.get(projectPath) === "visiting") return;
      state.set(projectPath, "visiting");
      for (const dependency of [...(dependencies.get(projectPath) ?? [])].sort()) visit(dependency);
      state.set(projectPath, "done");
      const project = byPath.get(projectPath);
      if (project) order.push(project);
    };
    for (const projectPath of [...byPath.keys()].sort()) visit(projectPath);
    return order;
  }

  private runProjects(
    projects: ParsedProject[],
    fullDiagnostics: boolean
  ): { results: Map<string, SerializedProjectIndex>; workersSpawned: number } {
    if (projects.length > 0 && this.parallel && workerScriptExists()) {
      return indexProjectsInParallel(
        projects,
        fullDiagnostics,
        this.getBootstrap()
      );
    }
    const results = new Map<string, SerializedProjectIndex>();
    for (const project of projects) {
      const accumulator = this.indexProjectLocal(project, fullDiagnostics);
      results.set(project.path, {
        projectPath: project.path,
        symbols: [...accumulator.symbols],
        edges: accumulator.edges,
        fileImports: accumulator.fileImports,
        files: [...accumulator.files],
        warnings: accumulator.warnings,
        prodErrors: accumulator.prodErrors,
        modules: [...accumulator.modules],
      });
    }
    return { results, workersSpawned: 0 };
  }

  private createAccumulator(): IndexAccumulator {
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

  private indexProjectLocal(project: ParsedProject, fullDiagnostics: boolean): IndexAccumulator {
    const accumulator = this.createAccumulator();
    const languageService = this.createLanguageService(project);
    try {
      const program = languageService.getProgram();
      if (!program) throw new Error(`TypeScript LanguageService returned no program for ${project.path}`);
      indexProject(
        {
          root: this.root,
          config: this.config,
          packageEntrypoints: this.packageEntrypoints,
          fileVersions: this.fileVersions,
          diagnosticsCache: this.diagnosticsCache,
        },
        project,
        program,
        program.getTypeChecker(),
        accumulator,
        fullDiagnostics
      );
    } finally {
      languageService.dispose();
    }
    return accumulator;
  }

  private mergeProject(target: IndexAccumulator, source: IndexAccumulator): void {
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

  private mergeProjectEntry(target: IndexAccumulator, source: ProjectCacheEntry): void {
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

}
