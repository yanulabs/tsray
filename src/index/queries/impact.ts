import type {
  ImpactAnalysis,
  ImpactSymbol,
  IndexSnapshot,
  SymbolRecord,
} from "../types.js";
import { graphOf, isTestPath } from "./graph-index.js";

function toImpactSymbol(symbol: SymbolRecord): ImpactSymbol {
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    isTest: symbol.isTest,
  };
}

function bySymbol(a: ImpactSymbol, b: ImpactSymbol): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}

export function getImpactAnalysis(
  snapshot: IndexSnapshot,
  targetId: string,
  maxDepth = 4
): ImpactAnalysis {
  const graph = graphOf(snapshot);
  const depthLimit = Number.isFinite(maxDepth)
    ? Math.min(Math.max(maxDepth, 1), 12)
    : 4;
  const target = snapshot.symbols.get(targetId) ?? null;
  const direct = (graph.incoming.get(targetId) ?? []).filter(
    (edge) => edge.kind !== "imports" && edge.kind !== "re_exports"
  );

  const visited = new Set<string>([targetId]);
  const queue: Array<{ id: string; depth: number }> = [
    { id: targetId, depth: 0 },
  ];
  const impactedComponents = new Map<string, ImpactSymbol>();
  const impactedHooks = new Map<string, ImpactSymbol>();
  const impactedCallers = new Map<string, ImpactSymbol>();
  const impactedFiles = new Set<string>();
  const impactedModules = new Set<string>();
  const impactedTests = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= depthLimit) continue;
    for (const edge of graph.incoming.get(current.id) ?? []) {
      if (edge.kind === "imports" || edge.kind === "re_exports") continue;
      const source = snapshot.symbols.get(edge.fromId);
      if (!source) {
        if (isTestPath(edge.file)) impactedTests.add(edge.file);
        impactedFiles.add(edge.file);
        const moduleName = snapshot.files.get(edge.file)?.module;
        if (moduleName) impactedModules.add(moduleName);
        continue;
      }
      if (visited.has(source.id)) continue;
      visited.add(source.id);
      impactedFiles.add(source.file);
      impactedModules.add(source.module);
      if (source.isTest) {
        impactedTests.add(source.file);
      } else if (source.kind === "component") {
        impactedComponents.set(source.id, toImpactSymbol(source));
      } else if (source.kind === "hook") {
        impactedHooks.set(source.id, toImpactSymbol(source));
      } else {
        impactedCallers.set(source.id, toImpactSymbol(source));
      }
      queue.push({ id: source.id, depth: current.depth + 1 });
    }
  }

  const transitiveCount =
    impactedComponents.size +
    impactedHooks.size +
    impactedCallers.size +
    impactedTests.size;
  const risk =
    transitiveCount >= 30
      ? "critical"
      : transitiveCount >= 10
        ? "high"
        : transitiveCount >= 3
          ? "medium"
          : "low";
  const testFiles = [...impactedTests].sort();

  return {
    target,
    risk,
    directReferencesCount: direct.length,
    directReferences: direct,
    impactedComponents: [...impactedComponents.values()].sort(bySymbol),
    impactedHooks: [...impactedHooks.values()].sort(bySymbol),
    impactedCallers: [...impactedCallers.values()].sort(bySymbol),
    impactedFiles: [...impactedFiles].sort(),
    impactedModules: [...impactedModules].sort(),
    impactedTestFiles: testFiles,
    transitiveCount,
    suggestedCommands: [
      ...(testFiles.length > 0 ? [`npm test -- ${testFiles.join(" ")}`] : []),
      "npm run typecheck",
      "npm run build",
    ],
  };
}
