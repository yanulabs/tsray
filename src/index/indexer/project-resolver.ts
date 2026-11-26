import { sha256 } from "../hasher.js";
import { WorkspaceDependencyIndex } from "../dependencies.js";
import type {
  ProjectCacheEntry,
  ProjectCacheProvider,
  ProjectIndexDetail,
  ProjectIndexMetrics,
} from "../types.js";
import type { ProjectCacheHasher } from "./cache-hasher.js";
import type {
  IndexAccumulator,
  ParsedProject,
  SerializedProjectIndex,
} from "./types.js";
import {
  buildProjectDependencies,
  topologicalProjectOrder,
} from "./project-graph.js";

export interface ProjectEntryResolverDeps {
  root: string;
  parsedProjects: ParsedProject[];
  activeProjects: ParsedProject[];
  projectCache: ProjectCacheProvider | null;
  projectEntryCache: Map<string, ProjectCacheEntry>;
  dependencyIndex: WorkspaceDependencyIndex | null;
  cacheHasher: ProjectCacheHasher;
  runProjects(
    projects: ParsedProject[],
    fullDiagnostics: boolean
  ): { results: Map<string, SerializedProjectIndex>; workersSpawned: number };
  indexProjectLocal(
    project: ParsedProject,
    fullDiagnostics: boolean
  ): IndexAccumulator;
}

export function resolveProjectEntries(
  deps: ProjectEntryResolverDeps,
  fullDiagnostics: boolean
): {
  entries: Map<string, ProjectCacheEntry>;
  metrics: ProjectIndexMetrics;
  details: ProjectIndexDetail[];
  projectEntryCache: Map<string, ProjectCacheEntry>;
  dependencyIndex: WorkspaceDependencyIndex;
} {
    const metrics: ProjectIndexMetrics = {
      projects_total: deps.activeProjects.length,
      projects_cached: 0,
      projects_rebuilt: 0,
      projects_empty: deps.parsedProjects.length - deps.activeProjects.length,
      workers_spawned: 0,
      diagnostics_cached: 0,
    };
    const entries = new Map<string, ProjectCacheEntry>();
    const details: ProjectIndexDetail[] = deps.parsedProjects
      .filter((project) => project.ownedFiles.length === 0)
      .map((project) => ({
        project: deps.cacheHasher.projectCacheKey(project.path),
        status: "empty",
        files: 0,
        diagnostics_cached: 0,
        project_sig_hash: null,
      }));
    const dependencies =
      deps.dependencyIndex ??
      new WorkspaceDependencyIndex(
        deps.root,
        deps.parsedProjects.map((project) => project.path)
      );

    if (!deps.projectCache) {
      const results = deps.runProjects(deps.activeProjects, fullDiagnostics);
      metrics.workers_spawned = results.workersSpawned;
      metrics.projects_rebuilt = deps.activeProjects.length;
      for (const project of deps.activeProjects) {
        const result = results.results.get(project.path) ?? deps.indexProjectLocal(project, fullDiagnostics);
        const entry = deps.cacheHasher.createProjectCacheEntry(project.path, "", result);
        entries.set(project.path, entry);
        details.push({
          project: deps.cacheHasher.projectCacheKey(project.path),
          status: "rebuilt",
          files: result.symbols instanceof Map
            ? (result as IndexAccumulator).files.size
            : (result as SerializedProjectIndex).files.length,
          diagnostics_cached: 0,
          project_sig_hash: entry.projectSigHash,
        });
      }
      return { entries, metrics, details, projectEntryCache: deps.projectEntryCache, dependencyIndex: dependencies };
    }

    const projectDependencies = buildProjectDependencies(deps.activeProjects, dependencies);
    const order = topologicalProjectOrder(deps.activeProjects, projectDependencies);
    const sourceHashes = new Map<string, Array<[string, string]>>();
    for (const project of deps.activeProjects) {
      sourceHashes.set(project.path, project.ownedFiles.map((file) => [deps.cacheHasher.cacheFilePath(file), deps.cacheHasher.hashSourceFile(file)]));
    }

    const emptySigHash = sha256("tsray-empty-project:v1");
    const signatures = new Map<string, string>();
    for (const project of deps.parsedProjects) {
      if (project.ownedFiles.length === 0) signatures.set(project.path, emptySigHash);
    }
    const pending = new Set(deps.activeProjects.map((project) => project.path));
    const writes: ProjectCacheEntry[] = [];

    while (pending.size > 0) {
      const ready: Array<{ project: ParsedProject; inputHash: string }> = [];
      let resolvedThisPass = false;
      for (const project of order) {
        if (!pending.has(project.path)) continue;
        const upstream = [...(projectDependencies.get(project.path) ?? [])].sort();
        if (!upstream.every((dependency) => signatures.has(dependency))) continue;
        const inputHash = deps.cacheHasher.computeProjectInputHash(project, dependencies, upstream, signatures, sourceHashes);
        let hit = deps.projectEntryCache.get(project.path);
        if (!hit || hit.inputHash !== inputHash) {
          hit = deps.projectCache.readProjects([deps.cacheHasher.projectCacheKey(project.path)]).get(
            deps.cacheHasher.projectCacheKey(project.path)
          );
        }
        if (hit && hit.inputHash === inputHash) {
          entries.set(project.path, hit);
          signatures.set(project.path, hit.projectSigHash);
          pending.delete(project.path);
          metrics.projects_cached++;
          metrics.diagnostics_cached += hit.files.length;
          details.push({
            project: deps.cacheHasher.projectCacheKey(project.path),
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
          inputHash: deps.cacheHasher.computeProjectInputHash(project, dependencies, upstream, signatures, sourceHashes),
        });
      }

      metrics.projects_rebuilt += ready.length;
      const results = deps.runProjects(ready.map((item) => item.project), fullDiagnostics);
      metrics.workers_spawned += results.workersSpawned;
      for (const item of ready) {
        const result = results.results.get(item.project.path) ?? deps.indexProjectLocal(item.project, fullDiagnostics);
        const entry = deps.cacheHasher.createProjectCacheEntry(item.project.path, item.inputHash, result);
        entries.set(item.project.path, entry);
        signatures.set(item.project.path, entry.projectSigHash);
        pending.delete(item.project.path);
        writes.push(entry);
        details.push({
          project: deps.cacheHasher.projectCacheKey(item.project.path),
          status: "rebuilt",
          files: entry.files.length,
          diagnostics_cached: 0,
          project_sig_hash: entry.projectSigHash,
        });
      }
    }

    deps.projectCache.writeProjects(writes);
    deps.projectEntryCache = new Map(entries);
    details.sort((a, b) => a.project.localeCompare(b.project));
    return { entries, metrics, details, projectEntryCache: deps.projectEntryCache, dependencyIndex: dependencies };
  }
