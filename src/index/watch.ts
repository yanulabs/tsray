import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { DualCacheStore } from "../cache/store.js";
import type { TsReactIndexer } from "./indexer.js";
import type { IndexSnapshot } from "./types.js";
import { isSourceFile } from "../util/paths.js";

const CONFIG_FILES = new Set([
  "tsconfig.json",
  "package.json",
  "pnpm-workspace.yaml",
  "tsray.json",
  "tsray.config.json",
]);

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
]);

export interface IndexControllerStatus {
  index_state: "ready" | "indexing" | "error";
  /** Timestamp of the snapshot currently served to clients. */
  indexed_at: string | null;
  served_indexed_at: string | null;
  duration_ms: number;
  /** Production errors in the latest attempted build (not the served snapshot). */
  prod_errors: number;
  warnings: number;
  served_prod_errors: number;
  files: number;
  symbols: number;
  edges: number;
  last_error: string | null;
}

export class IndexController {
  private snapshot: IndexSnapshot | null = null;
  private building: Promise<IndexSnapshot> | null = null;
  private watcher: FSWatcher | null = null;
  private pendingFiles = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private needsConfigReload = false;
  private lastError: string | null = null;
  private latestProdErrors = 0;
  private latestWarnings = 0;
  private latestAttemptAt: string | null = null;

  constructor(
    readonly indexer: TsReactIndexer,
    readonly store: DualCacheStore,
    private readonly log: (message: string) => void = () => {}
  ) {
    indexer.setProjectCache(store);
  }

  status(): IndexControllerStatus {
    const state: IndexControllerStatus["index_state"] = this.building
      ? "indexing"
      : this.lastError || (this.latestProdErrors > 0 && !this.indexer.allowErrors)
        ? "error"
        : this.snapshot
          ? "ready"
          : "indexing";
    return {
      index_state: state,
      indexed_at: this.snapshot?.indexedAt ?? this.latestAttemptAt,
      served_indexed_at: this.snapshot?.indexedAt ?? null,
      duration_ms: this.snapshot?.durationMs ?? 0,
      prod_errors: this.latestProdErrors,
      warnings: this.latestWarnings,
      served_prod_errors: this.snapshot?.prodErrors.length ?? 0,
      files: this.snapshot?.filesCount ?? 0,
      symbols: this.snapshot?.symbols.size ?? 0,
      edges: this.snapshot?.edges.length ?? 0,
      last_error: this.lastError,
    };
  }

  async rebuild(options: { fullDiagnostics?: boolean } = {}): Promise<IndexSnapshot> {
    if (this.building) return this.building;
    this.building = Promise.resolve().then(() => {
      try {
        const snapshot = this.indexer.buildIndex(options);
        const healthy = snapshot.prodErrors.length === 0 || this.indexer.allowErrors;
        this.latestProdErrors = snapshot.prodErrors.length;
        this.latestWarnings = snapshot.warnings.length;
        this.latestAttemptAt = snapshot.indexedAt;
        if (healthy) {
          this.store.syncWorking(snapshot);
          this.snapshot = snapshot;
          this.lastError = null;
          this.log(
            `[tsray] indexed ${snapshot.symbols.size} symbols / ${snapshot.edges.length} edges in ${snapshot.durationMs}ms` +
              (snapshot.prodErrors.length > 0 ? ` (${snapshot.prodErrors.length} diagnostics)` : "")
          );
        } else {
          this.log(
            `[tsray] ${snapshot.prodErrors.length} production TypeScript error(s); keeping last healthy snapshot`
          );
          if (!this.snapshot || this.snapshot.prodErrors.length > 0) this.snapshot = snapshot;
        }
        return this.snapshot ?? snapshot;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log(`[tsray] rebuild failed: ${this.lastError}`);
        if (this.snapshot) return this.snapshot;
        throw error;
      }
    });
    try {
      return await this.building;
    } finally {
      this.building = null;
    }
  }

  async getSnapshot(waitMs = 1500): Promise<IndexSnapshot> {
    if (this.building) {
      await Promise.race([this.building, delay(waitMs)]);
    }
    if (this.snapshot) return this.snapshot;
    return this.rebuild({ fullDiagnostics: true });
  }

  startWatch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.indexer.root, {
      ignoreInitial: true,
      ignored: (candidate) => {
        const segments = candidate.split(path.sep);
        return segments.some((segment) => IGNORED_SEGMENTS.has(segment));
      },
      awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
    });

    const onChange = (filePath: string): void => {
      const base = path.basename(filePath);
      const relative = path.relative(this.indexer.root, filePath);
      this.pendingFiles.add(filePath);
      if (CONFIG_FILES.has(base) || base.startsWith("tsconfig.") || base.startsWith("vite.config.")) {
        this.needsConfigReload = true;
      } else if (!isSourceFile(relative)) {
        this.pendingFiles.delete(filePath);
        return;
      }
      this.schedule();
    };

    this.watcher
      .on("add", onChange)
      .on("change", onChange)
      .on("unlink", onChange)
      .on("error", (error) => this.log(`[tsray] watcher error: ${String(error)}`));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const files = [...this.pendingFiles];
      const reload = this.needsConfigReload;
      this.pendingFiles.clear();
      this.needsConfigReload = false;
      this.timer = null;
      try {
        this.indexer.notifyFilesChanged(files, reload);
        void this.rebuild({ fullDiagnostics: reload }).catch((error) =>
          this.log(`[tsray] rebuild error: ${String(error)}`)
        );
      } catch (error) {
        this.log(`[tsray] invalidation error: ${String(error)}`);
      }
    }, 200);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
