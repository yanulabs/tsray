import path from "node:path";
import type { WorkspaceDependencyIndex } from "../dependencies.js";
import type { ParsedProject } from "./types.js";

export function buildProjectDependencies(
  activeProjects: readonly ParsedProject[],
  dependencies: WorkspaceDependencyIndex
): Map<string, Set<string>> {
    const active = new Set(activeProjects.map((project) => project.path));
    const projectsByDirectory = new Map<string, string[]>();
    for (const project of activeProjects) {
      const directory = path.dirname(project.path);
      const list = projectsByDirectory.get(directory) ?? [];
      list.push(project.path);
      projectsByDirectory.set(directory, list);
    }
    const result = new Map<string, Set<string>>();
    for (const project of activeProjects) {
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

export function topologicalProjectOrder(
  activeProjects: readonly ParsedProject[],
  dependencies: Map<string, Set<string>>
): ParsedProject[] {
    const byPath = new Map(activeProjects.map((project) => [project.path, project]));
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
