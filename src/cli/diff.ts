import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TsReactIndexer } from "../index/indexer.js";
import type { IndexerOptions } from "../index/indexer.js";
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
  duration_ms: number;
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

export function runArchitecturalDiff(
  repoPath: string,
  baseRef: string,
  failOnGates: string[],
  indexerOptions: IndexerOptions = {}
): DiffResult {
  const started = Date.now();
  const headIndexer = new TsReactIndexer(repoPath, indexerOptions);
  const headSnapshot = headIndexer.buildIndex({ fullDiagnostics: true });

  const gitTop = git(headIndexer.root, ["rev-parse", "--show-toplevel"]);
  const headSha = git(gitTop, ["rev-parse", "HEAD"]);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-"));
  fs.rmdirSync(temporary);
  let added = false;
  try {
    git(gitTop, ["worktree", "add", "--detach", temporary, baseRef]);
    added = true;

    const mainModules = path.join(gitTop, "node_modules");
    const temporaryModules = path.join(temporary, "node_modules");
    if (fs.existsSync(mainModules) && !fs.existsSync(temporaryModules)) {
      try {
        fs.symlinkSync(mainModules, temporaryModules, process.platform === "win32" ? "junction" : "dir");
      } catch {
        // Base indexing can still work for projects without external types.
      }
    }

    const relative = toPosix(path.relative(gitTop, headIndexer.root));
    const baseTarget = path.join(temporary, relative);
    const baseIndexer = new TsReactIndexer(baseTarget, indexerOptions);
    const baseSnapshot = baseIndexer.buildIndex({ fullDiagnostics: true });

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

    return {
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
      duration_ms: Date.now() - started,
    };
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
  if (result.new_cycles.length === 0 && result.new_dead_code.length === 0) {
    lines.push("", "No new architectural regressions detected.");
  }
  return `${lines.join("\n")}\n`;
}
