import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { computeGraphHashes, findDirectedCycles } from "./hasher.js";
import { indexProject } from "./indexer/project-indexer.js";
import { canonicalPath } from "./indexer/symbol-utils.js";
import { ProjectCacheHasher } from "./indexer/cache-hasher.js";
import {
  createAccumulator,
  mergeProjectEntry,
} from "./indexer/project-accumulator.js";
import { createLanguageService } from "./indexer/language-service.js";
import { resolveProjectEntries } from "./indexer/project-resolver.js";
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
import type { WorkspaceDependencyIndex } from "./dependencies.js";
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
    const accumulator = createAccumulator();
    const { entries, metrics, details } = this.resolveProjectEntries(fullDiagnostics);

    for (const project of this.activeProjects) {
      const entry = entries.get(project.path);
      if (!entry) throw new Error(`Project was not resolved: ${project.path}`);
      mergeProjectEntry(accumulator, entry);
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
    const resolved = resolveProjectEntries(
      {
        root: this.root,
        parsedProjects: this.parsedProjects,
        activeProjects: this.activeProjects,
        projectCache: this.projectCache,
        projectEntryCache: this.projectEntryCache,
        dependencyIndex: this.dependencyIndex,
        cacheHasher: this.cacheHasher,
        runProjects: (projects, diagnostics) =>
          this.runProjects(projects, diagnostics),
        indexProjectLocal: (project, diagnostics) =>
          this.indexProjectLocal(project, diagnostics),
      },
      fullDiagnostics
    );
    this.projectEntryCache = resolved.projectEntryCache;
    this.dependencyIndex = resolved.dependencyIndex;
    return {
      entries: resolved.entries,
      metrics: resolved.metrics,
      details: resolved.details,
    };
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


  private indexProjectLocal(project: ParsedProject, fullDiagnostics: boolean): IndexAccumulator {
    const accumulator = createAccumulator();
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

}
