import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TsReactIndexer } from "../index/indexer.js";
import type { IndexerOptions } from "../index/indexer.js";
import type { ProjectIndexMetrics } from "../index/types.js";
import { ReadOnlyProjectCacheStore, resolveDbPaths } from "../cache/store.js";
import { getDeadCode, getHotspots } from "../index/queries.js";
import { toPosix } from "../util/paths.js";

export interface DiffResult {
  base_ref: string;
  head_ref: string;
  root: string;
  gates: string[];
  failed_gates: string[];
  new_cycles: string[][];
  resolved_cycles: string[][];
  breaking_api: Array<{
    id: string;
    name: string;
    kind: string;
    file: string;
    line: number;
    reason: "removed" | "signature_changed";
  }>;
  added_exports: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  new_dead_code: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  resolved_dead_code: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  new_untested_hotspots: Array<{
    id: string;
    name: string;
    complexity: number;
    file: string;
    line: number;
    risk_score: number;
  }>;
  metrics: {
    base: Record<string, number>;
    head: Record<string, number>;
  };
  head_prod_errors: number;
  base_prod_errors: number;
  base: ProjectSummary;
  head: ProjectSummary;
  /** Non-enumerable timing/cache telemetry for programmatic benchmarks. */
  readonly indexMetrics?: { base: ProjectIndexMetrics; head: ProjectIndexMetrics };
}

export interface ProjectSummary {
  projects: number;
  projects_empty: number;
  files: number;
  symbols: number;
  edges: number;
  graph_digest: string | null;
}

export class GitDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiffError";
  }
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    throw new GitDiffError(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

function cycleKey(cycle: string[]): string {
  return cycle.join("->");
}

function metricsOf(snapshot: {
  filesCount: number;
  symbols: Map<string, unknown>;
  edges: unknown[];
  moduleCycles: unknown[];
  modules: string[];
  prodErrors: unknown[];
}): Record<string, number> {
  return {
    files: snapshot.filesCount,
    symbols: snapshot.symbols.size,
    edges: snapshot.edges.length,
    modules: snapshot.modules.length,
    cycles: snapshot.moduleCycles.length,
    prod_errors: snapshot.prodErrors.length,
  };
}

function summaryOf(snapshot: {
  filesCount: number;
  symbols: Map<string, unknown>;
  edges: unknown[];
  projectMetrics?: ProjectIndexMetrics;
  graphDigest?: string;
}): ProjectSummary {
  return {
    projects: snapshot.projectMetrics?.projects_total ?? 0,
    projects_empty: snapshot.projectMetrics?.projects_empty ?? 0,
    files: snapshot.filesCount,
    symbols: snapshot.symbols.size,
    edges: snapshot.edges.length,
    graph_digest: snapshot.graphDigest ?? null,
  };
}

function isWorkspaceSourceTarget(mainRoot: string, target: string): boolean {
  const relative = path.relative(mainRoot, target);
  return !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    relative !== "node_modules" &&
    !relative.startsWith(`node_modules${path.sep}`);
}

function containsWorkspaceLink(directory: string, mainRoot: string, depth = 0): boolean {
  if (depth > 4) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const sourcePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (isWorkspaceSourceTarget(mainRoot, fs.realpathSync(sourcePath))) return true;
      } catch {
        // Ignore broken optional links.
      }
    } else if (entry.isDirectory() && entry.name !== ".pnpm" && containsWorkspaceLink(sourcePath, mainRoot, depth + 1)) {
      return true;
    }
  }
  return false;
}

function mirrorNodeModules(
  mainRoot: string,
  worktreeRoot: string,
  source: string,
  destination: string
): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (fs.existsSync(destinationPath)) continue;
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(sourcePath);
      } catch {
        // Ignore broken optional links.
        continue;
      }
      const relative = path.relative(mainRoot, target);
      if (isWorkspaceSourceTarget(mainRoot, target)) {
        const remapped = path.join(worktreeRoot, relative);
        if (!fs.existsSync(remapped)) continue;
        target = remapped;
      }
      try {
        fs.symlinkSync(target, destinationPath);
      } catch {
        // Broken optional links do not prevent indexing tracked source files.
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name.startsWith("@") || containsWorkspaceLink(sourcePath, mainRoot)) {
        mirrorNodeModules(mainRoot, worktreeRoot, sourcePath, destinationPath);
      } else {
        try {
          fs.symlinkSync(sourcePath, destinationPath, process.platform === "win32" ? "junction" : "dir");
        } catch {
          // A recursive fallback keeps platforms without directory links working.
          mirrorNodeModules(mainRoot, worktreeRoot, sourcePath, destinationPath);
        }
      }
      continue;
    }
    try {
      fs.symlinkSync(sourcePath, destinationPath, "file");
    } catch {
      // Ignore optional node_modules metadata files.
    }
  }
}

function linkWorkspaceNodeModules(mainRoot: string, worktreeRoot: string): void {
  const pending = [mainRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const relative = path.relative(mainRoot, directory);
    const destination = path.join(worktreeRoot, relative);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const source = path.join(directory, entry.name);
      const target = path.join(destination, entry.name);
      if (entry.name === "node_modules") {
        mirrorNodeModules(mainRoot, worktreeRoot, source, target);
        continue;
      }
      if (entry.isDirectory() && fs.existsSync(target)) pending.push(source);
    }
  }
}

function assertTrackedConfigsDiscovered(worktreeRoot: string, baseTarget: string, tsconfigPaths: string[]): void {
  const discovered = new Set(tsconfigPaths);
  const missing: string[] = [];
  for (const file of git(worktreeRoot, ["ls-files"]).split("\n")) {
    if (!file || !path.basename(file).startsWith("tsconfig") || !file.endsWith(".json")) continue;
    const absolute = path.join(worktreeRoot, file);
    const relative = path.relative(baseTarget, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (!discovered.has(toPosix(relative))) missing.push(toPosix(relative));
  }
  if (missing.length > 0) {
    throw new GitDiffError(`base worktree discovery missed tracked tsconfigs: ${missing.slice(0, 5).join(", ")}`);
  }
}

/** @internal Shared by diff integration tests and diagnostics. */
function mirrorGeneratedOutputs(mainRoot: string, worktreeRoot: string): void {
  const generatedDirectories = new Set(["dist", "lib", "build", "out"]);
  const mirror = (source: string, destination: string): void => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory() && generatedDirectories.has(entry.name)) {
        if (!fs.existsSync(destinationPath)) {
          try {
            fs.symlinkSync(sourcePath, destinationPath, process.platform === "win32" ? "junction" : "dir");
          } catch {
            // Generated output is optional when directory links are unavailable.
          }
        }
      } else if (entry.isDirectory()) {
        if (fs.existsSync(destinationPath)) mirror(sourcePath, destinationPath);
      } else if (
        entry.name.startsWith("tsconfig") &&
        entry.name.endsWith(".json") &&
        !fs.existsSync(destinationPath)
      ) {
        const relative = path.relative(source, sourcePath);
        try {
          git(source, ["ls-files", "--error-unmatch", relative]);
        } catch {
          fs.copyFileSync(sourcePath, destinationPath);
        }
      }
    }
  };

  for (const line of git(mainRoot, ["submodule", "status", "--recursive"]).split("\n")) {
    const match = line.match(/^[\s+-]?([0-9a-f]+)\s+(\S+)/);
    if (!match) continue;
    const [, commit, relative] = match;
    const source = path.join(mainRoot, relative!);
    const destination = path.join(worktreeRoot, relative!);
    if (!fs.existsSync(source) || !fs.existsSync(destination)) continue;
    try {
      if (git(destination, ["rev-parse", "HEAD"]) === commit) mirror(source, destination);
    } catch {
      // Uninitialized or changed submodules are handled by submodule update.
    }
  }
}

/** @internal Shared by diff integration tests and diagnostics. */
export function prepareBaseWorktree(mainRoot: string, worktreeRoot: string, baseTarget: string): void {
  git(worktreeRoot, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--checkout"]);
  const status = git(worktreeRoot, ["submodule", "status", "--recursive"]);
  if (status.split("\n").some((line) => line.startsWith("-"))) {
    throw new GitDiffError("base worktree has uninitialized submodules; refusing a partial diff");
  }
  mirrorGeneratedOutputs(mainRoot, worktreeRoot);
  linkWorkspaceNodeModules(mainRoot, worktreeRoot);
  if (!fs.existsSync(path.join(baseTarget, "pnpm-workspace.yaml")) && !fs.existsSync(path.join(baseTarget, "package.json"))) {
    throw new GitDiffError(`base worktree target is missing workspace metadata: ${baseTarget}`);
  }
}

export function runArchitecturalDiff(
  repoPath: string,
  baseRef: string,
  failOnGates: string[],
  indexerOptions: IndexerOptions = {}
): DiffResult {
  const headIndexer = new TsReactIndexer(repoPath, indexerOptions);
  const seedPath = resolveDbPaths(headIndexer.root, headIndexer.projectId, process.env.TSRAY_DB).workingPath;
  const seed = process.env.TSRAY_DIFF_SEED !== "0" && seedPath !== ":memory:"
    ? new ReadOnlyProjectCacheStore(seedPath)
    : null;
  if (seed) headIndexer.setProjectCache(seed);
  let headSnapshot: ReturnType<TsReactIndexer["buildIndex"]>;
  try {
    headSnapshot = headIndexer.buildIndex({ fullDiagnostics: true });
  } catch (error) {
    seed?.close();
    throw error;
  }

  let gitTop: string;
  let headSha: string;
  try {
    gitTop = fs.realpathSync(git(headIndexer.root, ["rev-parse", "--show-toplevel"]));
    headSha = git(gitTop, ["rev-parse", "HEAD"]);
  } catch (error) {
    seed?.close();
    throw error;
  }

  let temporary: string;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-"));
    fs.rmdirSync(temporary);
  } catch (error) {
    seed?.close();
    throw error;
  }
  let added = false;
  try {
    git(gitTop, ["worktree", "add", "--detach", temporary, baseRef]);
    added = true;

    const relative = toPosix(path.relative(gitTop, headIndexer.root));
    const baseTarget = path.join(temporary, relative);
    prepareBaseWorktree(gitTop, temporary, baseTarget);
    const baseOptions: IndexerOptions = { ...indexerOptions };
    if (baseOptions.tsconfig && path.isAbsolute(baseOptions.tsconfig)) {
      const relativeConfig = path.relative(headIndexer.root, baseOptions.tsconfig);
      if (!relativeConfig.startsWith("..")) baseOptions.tsconfig = relativeConfig;
    }
    const baseIndexer = new TsReactIndexer(baseTarget, baseOptions);
    if (seed) baseIndexer.setProjectCache(seed);
    const baseSnapshot = baseIndexer.buildIndex({ fullDiagnostics: true });
    assertTrackedConfigsDiscovered(temporary, baseTarget, baseSnapshot.tsconfigPaths);
    if (process.env.TSRAY_DIFF_PROFILE === "1") {
      const baseMetrics = baseSnapshot.projectMetrics;
      const headMetrics = headSnapshot.projectMetrics;
      process.stderr.write(`${JSON.stringify({
        event: "tsray_diff_index",
        seed: Boolean(seed),
        base: baseMetrics,
        head: headMetrics,
        base_projects_total: baseMetrics?.projects_total ?? 0,
        base_projects_cached: baseMetrics?.projects_cached ?? 0,
        base_projects_rebuilt: baseMetrics?.projects_rebuilt ?? 0,
        base_projects_empty: baseMetrics?.projects_empty ?? 0,
        base_workers: baseMetrics?.workers_spawned ?? 0,
        base_files: baseSnapshot.filesCount,
        base_symbols: baseSnapshot.symbols.size,
        base_edges: baseSnapshot.edges.length,
        head_projects_total: headMetrics?.projects_total ?? 0,
        head_projects_cached: headMetrics?.projects_cached ?? 0,
        head_projects_rebuilt: headMetrics?.projects_rebuilt ?? 0,
        head_projects_empty: headMetrics?.projects_empty ?? 0,
        head_workers: headMetrics?.workers_spawned ?? 0,
        head_files: headSnapshot.filesCount,
        head_symbols: headSnapshot.symbols.size,
        head_edges: headSnapshot.edges.length,
      })}\n`);
    }

    const baseCycleKeys = new Set(baseSnapshot.moduleCycles.map(cycleKey));
    const headCycleKeys = new Set(headSnapshot.moduleCycles.map(cycleKey));
    const newCycles = headSnapshot.moduleCycles.filter((cycle) => !baseCycleKeys.has(cycleKey(cycle)));
    const resolvedCycles = baseSnapshot.moduleCycles.filter((cycle) => !headCycleKeys.has(cycleKey(cycle)));

    const breakingApi: DiffResult["breaking_api"] = [];
    const addedExports: DiffResult["added_exports"] = [];
    for (const [id, baseSymbol] of baseSnapshot.symbols) {
      if (!baseSymbol.exported || baseSymbol.isTest) continue;
      const headSymbol = headSnapshot.symbols.get(id);
      if (!headSymbol || !headSymbol.exported) {
        breakingApi.push({
          id,
          name: baseSymbol.name,
          kind: baseSymbol.kind,
          file: baseSymbol.file,
          line: baseSymbol.line,
          reason: "removed",
        });
      } else if (headSymbol.sigHash !== baseSymbol.sigHash) {
        breakingApi.push({
          id,
          name: baseSymbol.name,
          kind: baseSymbol.kind,
          file: headSymbol.file,
          line: headSymbol.line,
          reason: "signature_changed",
        });
      }
    }
    for (const [id, headSymbol] of headSnapshot.symbols) {
      if (!headSymbol.exported || headSymbol.isTest) continue;
      if (!baseSnapshot.symbols.get(id)?.exported) {
        addedExports.push({
          id,
          name: headSymbol.name,
          kind: headSymbol.kind,
          file: headSymbol.file,
          line: headSymbol.line,
        });
      }
    }

    const baseDead = new Set(getDeadCode(baseSnapshot, false).map((symbol) => symbol.id));
    const headDead = getDeadCode(headSnapshot, false);
    const newDeadCode = headDead
      .filter((symbol) => !baseDead.has(symbol.id))
      .map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        line: symbol.line,
      }));
    const headDeadIds = new Set(headDead.map((symbol) => symbol.id));
    const resolvedDeadCode = getDeadCode(baseSnapshot, false)
      .filter((symbol) => !headDeadIds.has(symbol.id))
      .map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        line: symbol.line,
      }));

    const baseUntested = new Set(
      getHotspots(baseSnapshot, 10000)
        .filter((hotspot) => !hotspot.testReachable && hotspot.complexity >= 10)
        .map((hotspot) => hotspot.id)
    );
    const newUntestedHotspots = getHotspots(headSnapshot, 10000)
      .filter((hotspot) => !hotspot.testReachable && hotspot.complexity >= 10 && !baseUntested.has(hotspot.id))
      .map((hotspot) => ({
        id: hotspot.id,
        name: hotspot.name,
        complexity: hotspot.complexity,
        file: hotspot.file,
        line: hotspot.line,
        risk_score: hotspot.riskScore,
      }));

    const failedGates: string[] = [];
    if (failOnGates.includes("cycles") && newCycles.length > 0) failedGates.push("cycles");
    if (failOnGates.includes("breaking_api") && breakingApi.length > 0) failedGates.push("breaking_api");
    if (failOnGates.includes("dead_code") && newDeadCode.length > 0) failedGates.push("dead_code");
    if (failOnGates.includes("untested_hotspots") && newUntestedHotspots.length > 0) {
      failedGates.push("untested_hotspots");
    }

    const result: DiffResult = {
      base_ref: baseRef,
      head_ref: headSha,
      root: headIndexer.root,
      gates: failOnGates,
      failed_gates: failedGates,
      new_cycles: newCycles,
      resolved_cycles: resolvedCycles,
      breaking_api: breakingApi.sort(byFile),
      added_exports: addedExports.sort(byFile),
      new_dead_code: newDeadCode.sort(byFile),
      resolved_dead_code: resolvedDeadCode.sort(byFile),
      new_untested_hotspots: newUntestedHotspots.sort((a, b) => b.risk_score - a.risk_score),
      metrics: {
        base: metricsOf(baseSnapshot),
        head: metricsOf(headSnapshot),
      },
      head_prod_errors: headSnapshot.prodErrors.length,
      base_prod_errors: baseSnapshot.prodErrors.length,
      base: summaryOf(baseSnapshot),
      head: summaryOf(headSnapshot),
    };
    Object.defineProperty(result, "indexMetrics", {
      value: { base: baseSnapshot.projectMetrics, head: headSnapshot.projectMetrics },
      enumerable: false,
    });
    return result;
  } finally {
    try {
      seed?.close();
    } finally {
      if (added) {
        try {
          git(gitTop, ["worktree", "remove", "--force", temporary]);
        } catch {
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
}

function byFile(
  a: { file: string; line: number },
  b: { file: string; line: number }
): number {
  return a.file.localeCompare(b.file) || a.line - b.line;
}

export function diffMarkdown(result: DiffResult): string {
  const lines = [
    `# Architectural Diff: ${result.base_ref} -> ${result.head_ref.slice(0, 12)}`,
    "",
    `- Gates: ${result.gates.length > 0 ? result.gates.join(", ") : "none"}`,
    `- Failed gates: ${result.failed_gates.length > 0 ? result.failed_gates.join(", ") : "none"}`,
    `- Production TS errors: ${result.base_prod_errors} -> ${result.head_prod_errors}`,
    "",
    "## Metrics",
    "",
    "| Metric | Base | Head |",
    "| --- | ---: | ---: |",
    ...Object.keys(result.metrics.head).map(
      (key) => `| ${key} | ${result.metrics.base[key] ?? 0} | ${result.metrics.head[key] ?? 0} |`
    ),
    "",
    `## New Cycles (${result.new_cycles.length})`,
    ...result.new_cycles.map((cycle) => `- ${cycle.join(" -> ")} -> ${cycle[0]}`),
    "",
    `## Resolved Cycles (${result.resolved_cycles.length})`,
    ...result.resolved_cycles.map((cycle) => `- ${cycle.join(" -> ")} -> ${cycle[0]}`),
    "",
    `## Breaking API Changes (${result.breaking_api.length})`,
    ...result.breaking_api.map(
      (item) => `- **${item.reason}** \`${item.name}\` (${item.kind}) at \`${item.file}:${item.line}\``
    ),
    "",
    `## Added Exports (${result.added_exports.length})`,
    ...result.added_exports.map((item) => `- \`${item.name}\` (${item.kind}) at \`${item.file}:${item.line}\``),
    "",
    `## New Dead Code (${result.new_dead_code.length})`,
    ...result.new_dead_code.map((item) => `- \`${item.name}\` at \`${item.file}:${item.line}\``),
    "",
    `## New Untested Hotspots (${result.new_untested_hotspots.length})`,
    ...result.new_untested_hotspots.map(
      (item) =>
        `- \`${item.name}\` complexity ${item.complexity}, risk ${item.risk_score} at \`${item.file}:${item.line}\``
    ),
  ];
  if (
    result.new_cycles.length === 0 &&
    result.new_dead_code.length === 0 &&
    result.breaking_api.length === 0 &&
    result.new_untested_hotspots.length === 0
  ) {
    lines.push("", "No new architectural regressions detected.");
  }
  return `${lines.join("\n")}\n`;
}
