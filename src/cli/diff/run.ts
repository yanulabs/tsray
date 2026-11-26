import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TsReactIndexer } from "../../index/indexer.js";
import type { IndexerOptions } from "../../index/indexer.js";
import { ReadOnlyProjectCacheStore, resolveDbPaths } from "../../cache/store.js";
import { getDeadCode, getHotspots } from "../../index/queries.js";
import { toPosix } from "../../util/paths.js";
import { byFile } from "./compare.js";
import { cycleKey, git } from "./git.js";
import { metricsOf, summaryOf } from "./snapshot.js";
import type { DiffResult } from "./types.js";
import {
  assertTrackedConfigsDiscovered,
  prepareBaseWorktree,
} from "./worktree.js";

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
