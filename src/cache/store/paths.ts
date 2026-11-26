import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../index/hasher.js";
import type { DbPaths, DbRemovalPlan, PruneResult } from "./types.js";

export function getCacheRoot(): string {
  if (process.env.TSRAY_CACHE_DIR) return path.resolve(process.env.TSRAY_CACHE_DIR);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "tsray");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "tsray");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tsray");
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "project"
  );
}

export function resolveDbPaths(canonicalRoot: string, projectId: string, overrideDb?: string): DbPaths {
  if (overrideDb) {
    const resolved = overrideDb === ":memory:" ? overrideDb : path.resolve(overrideDb);
    return { workingPath: resolved, summaryPath: resolved, singleMode: true };
  }
  const cacheRoot = getCacheRoot();
  const workingPath = path.join(
    cacheRoot,
    "worktrees",
    `${slugify(path.basename(canonicalRoot))}-${sha256(canonicalRoot).slice(0, 12)}.db`
  );
  const summaryPath = path.join(
    cacheRoot,
    "summaries",
    `${slugify(projectId)}-${sha256(projectId).slice(0, 12)}.db`
  );
  return { workingPath, summaryPath, singleMode: false };
}

function sidecarPaths(file: string): string[] {
  return [file, `${file}-wal`, `${file}-shm`];
}

export function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function planDatabaseRemoval(
  canonicalRoot: string,
  projectId: string,
  options: { overrideDb?: string; summaries?: boolean; all?: boolean } = {}
): DbRemovalPlan {
  const resolved = resolveDbPaths(canonicalRoot, projectId, options.overrideDb);
  const targets = new Set<string>();
  if (resolved.singleMode) {
    for (const file of sidecarPaths(resolved.workingPath)) targets.add(file);
  } else {
    if (!options.summaries || options.all) {
      for (const file of sidecarPaths(resolved.workingPath)) targets.add(file);
    }
    if (options.summaries || options.all) {
      for (const file of sidecarPaths(resolved.summaryPath)) targets.add(file);
    }
  }
  const existing = [...targets]
    .filter((file) => file !== ":memory:" && fs.existsSync(file))
    .map((file) => ({ path: file, bytes: fileSize(file) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    paths: [...targets].filter((file) => file !== ":memory:").sort(),
    existing,
    totalBytes: existing.reduce((total, item) => total + item.bytes, 0),
  };
}

function isSqliteFile(file: string): boolean {
  try {
    if (fs.statSync(file).size === 0) return true;
    const header = Buffer.alloc(16);
    const descriptor = fs.openSync(file, "r");
    try {
      fs.readSync(descriptor, header, 0, 16, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    return header.toString("utf8") === "SQLite format 3\u0000";
  } catch {
    return false;
  }
}

export function removeDatabases(
  plan: DbRemovalPlan,
  options: { force?: boolean; dryRun?: boolean } = {}
): { removed: string[]; skipped: Array<{ path: string; reason: string }>; dryRun: boolean } {
  if (options.dryRun) return { removed: [], skipped: [], dryRun: true };
  const removed: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const item of plan.existing) {
    let probe: DatabaseSync | null = null;
    try {
      if (item.path.endsWith("-wal") || item.path.endsWith("-shm")) {
        fs.rmSync(item.path, { force: true });
        removed.push(item.path);
        continue;
      }
      if (!isSqliteFile(item.path)) {
        skipped.push({ path: item.path, reason: "not a SQLite database" });
        continue;
      }
      probe = new DatabaseSync(item.path);
      probe.exec("PRAGMA busy_timeout = 250;");
      probe.exec("BEGIN EXCLUSIVE;");
      probe.exec("ROLLBACK;");
      probe.close();
      probe = null;
      fs.rmSync(item.path, { force: true });
      removed.push(item.path);
    } catch (error) {
      probe?.close();
      if (options.force) {
        try {
          fs.rmSync(item.path, { force: true });
          removed.push(item.path);
          continue;
        } catch (forcedError) {
          skipped.push({ path: item.path, reason: String(forcedError) });
          continue;
        }
      }
      skipped.push({
        path: item.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed, skipped, dryRun: false };
}

export function pruneWorktreeDatabases(options: { dryRun?: boolean } = {}): PruneResult {
  const directory = path.join(getCacheRoot(), "worktrees");
  const result: PruneResult = { scanned: 0, removed: [], skipped: [], roots: [] };
  if (!fs.existsSync(directory)) return result;

  for (const entry of fs.readdirSync(directory)) {
    if (!entry.endsWith(".db")) continue;
    const file = path.join(directory, entry);
    result.scanned++;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file);
      const row = db
        .prepare("SELECT value FROM working_meta WHERE key = 'canonical_root'")
        .get() as { value: string } | undefined;
      const canonicalRoot = row?.value ?? null;
      result.roots.push({ path: file, canonicalRoot });
      if (!canonicalRoot || fs.existsSync(canonicalRoot)) {
        db.close();
        db = null;
        continue;
      }
      db.close();
      db = null;
      if (!options.dryRun) {
        for (const sidecar of sidecarPaths(file)) fs.rmSync(sidecar, { force: true });
      }
      result.removed.push(file);
    } catch (error) {
      db?.close();
      result.skipped.push({
        path: file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
