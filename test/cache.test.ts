import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import {
  DualCacheStore,
  planDatabaseRemoval,
  pruneWorktreeDatabases,
  removeDatabases,
} from "../src/cache/store.js";
import type { IndexSnapshot, SymbolRecord } from "../src/index/types.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
const cleanup: string[] = [];

afterAll(() => {
  for (const item of cleanup) fs.rmSync(item, { recursive: true, force: true });
});

function build(): { snapshot: IndexSnapshot; store: DualCacheStore } {
  const indexer = new TsReactIndexer(fixture);
  const snapshot = indexer.buildIndex({ fullDiagnostics: true });
  const store = new DualCacheStore(snapshot.root, snapshot.projectId, { overrideDb: ":memory:" });
  store.syncWorking(snapshot);
  return { snapshot, store };
}

function button(snapshot: IndexSnapshot): SymbolRecord {
  const found = [...snapshot.symbols.values()].find((symbol) => symbol.name === "Button");
  if (!found) throw new Error("Button missing from fixture index");
  return found;
}

describe("dual SQLite summary cache", () => {
  it("syncs the working database and reports counts", () => {
    const { snapshot, store } = build();
    try {
      const info = store.getInfo();
      expect(info.working_symbols).toBe(snapshot.symbols.size);
      expect(info.working_edges).toBe(snapshot.edges.length);
      expect(info.working_files).toBe(snapshot.filesCount);
      expect(info.canonical_root).toBe(snapshot.root);
    } finally {
      store.close();
    }
  });

  it("moves from missing to synced and stores validated summaries", () => {
    const { snapshot, store } = build();
    try {
      const target = button(snapshot);
      expect(store.getStaleness(target)).toBe("missing");

      const invalid = store.upsertSummaries(
        [{ symbolId: target.id, expectedContentHash: target.contentHash, summary: { intent: "" } }],
        snapshot
      );
      expect(invalid.results[0]?.status).toBe("validation_error");

      const wrongHash = store.upsertSummaries(
        [{ symbolId: target.id, expectedContentHash: "nope", summary: { intent: "x", side_effects: ["none"], invariants: [] } }],
        snapshot
      );
      expect(wrongHash.results[0]?.status).toBe("hash_mismatch");

      const saved = store.upsertSummaries(
        [
          {
            symbolId: target.id,
            expectedContentHash: target.contentHash,
            summary: {
              intent: "Render a labelled button",
              side_effects: ["none"],
              invariants: ["label is visible"],
              concurrency: "none",
            },
          },
        ],
        snapshot
      );
      expect(saved.saved).toBe(1);
      expect(saved.results[0]?.status).toBe("updated");
      expect(store.getStaleness(target)).toBe("synced");
      expect(store.getSummary(target.contentHash)?.intent).toBe("Render a labelled button");
    } finally {
      store.close();
    }
  });

  it("distinguishes soft dependency staleness from hard symbol changes", () => {
    const { snapshot, store } = build();
    try {
      const target = button(snapshot);
      store.upsertSummaries(
        [
          {
            symbolId: target.id,
            expectedContentHash: target.contentHash,
            summary: { intent: "Button", side_effects: ["none"], invariants: [] },
          },
        ],
        snapshot
      );

      const dependencyChanged: SymbolRecord = {
        ...target,
        depHash: "changed-dependency-hash",
        contentHash: "changed-content-hash",
      };
      const soft = store.resolveSummary(dependencyChanged);
      expect(soft.state).toBe("soft_stale");
      expect(soft.reason).toBe("deps_changed");
      expect(soft.summary?.intent).toBe("Button");

      const symbolChanged: SymbolRecord = {
        ...dependencyChanged,
        selfHash: "changed-self-hash",
      };
      const hard = store.resolveSummary(symbolChanged);
      expect(hard.state).toBe("hard_stale");
      expect(hard.reason).toBe("self_changed");
    } finally {
      store.close();
    }
  });

  it("validates architecture summaries for non-callable kinds", () => {
    const { snapshot, store } = build();
    try {
      const contextSymbol = [...snapshot.symbols.values()].find((symbol) => symbol.kind === "context")!;
      const invalid = store.upsertSummaries(
        [
          {
            symbolId: contextSymbol.id,
            expectedContentHash: contextSymbol.contentHash,
            summary: { intent: "Theme context", side_effects: ["none"], invariants: [] },
          },
        ],
        snapshot
      );
      expect(invalid.results[0]?.status).toBe("validation_error");

      const valid = store.upsertSummaries(
        [
          {
            symbolId: contextSymbol.id,
            expectedContentHash: contextSymbol.contentHash,
            summary: { intent: "Theme context", key_invariants: ["single provider"], boundaries: ["client only"] },
          },
        ],
        snapshot
      );
      expect(valid.results[0]?.status).toBe("updated");
    } finally {
      store.close();
    }
  });

  it("reuses persistent diagnostics until the workspace epoch changes", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diagnostics-"));
    cleanup.push(temporary);
    fs.cpSync(fixture, temporary, { recursive: true });
    const database = path.join(temporary, "cache.db");
    const run = () => {
      const indexer = new TsReactIndexer(temporary, { parallel: false });
      const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: database });
      indexer.setDiagnosticCache(store);
      try {
        const snapshot = indexer.buildIndex({ fullDiagnostics: true });
        store.syncWorking(snapshot);
        return snapshot;
      } finally {
        store.close();
      }
    };

    const cold = run();
    const warm = run();
    expect(cold.diagnosticsCached).toBe(0);
    expect(warm.diagnosticsCached).toBe(warm.filesCount);
    expect(warm.prodErrors).toEqual(cold.prodErrors);
    expect(warm.warnings).toEqual(cold.warnings);
    expect(warm.symbols).toEqual(cold.symbols);
    expect(warm.edges).toEqual(cold.edges);

    const app = path.join(temporary, "src/App.tsx");
    fs.writeFileSync(
      app,
      fs.readFileSync(app, "utf8").replace("const theme = useTheme();", "const theme: number = useTheme();")
    );
    const changed = run();
    expect(changed.diagnosticsCached).toBe(0);
    expect(changed.prodErrors.length).toBeGreaterThan(0);
  });

  it("computes coverage by kind and module", () => {
    const { snapshot, store } = build();
    try {
      const target = button(snapshot);
      store.upsertSummaries(
        [
          {
            symbolId: target.id,
            expectedContentHash: target.contentHash,
            summary: { intent: "Button", side_effects: ["none"], invariants: [] },
          },
        ],
        snapshot
      );
      const coverage = store.getCoverage(snapshot);
      expect(coverage.eligible).toBeGreaterThan(0);
      expect(coverage.synced).toBe(1);
      expect(coverage.missing).toBeGreaterThan(0);
      expect(coverage.by_kind.component?.synced).toBe(1);
      expect(coverage.by_module.components?.synced).toBe(1);
      expect(coverage.percent).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("creates parent directories for an explicit database path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-cache-"));
    cleanup.push(directory);
    const db = path.join(directory, "nested", "cache", "tsray.db");
    const indexer = new TsReactIndexer(fixture);
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    const store = new DualCacheStore(snapshot.root, snapshot.projectId, { overrideDb: db });
    try {
      expect(fs.existsSync(db)).toBe(true);
      expect(store.workingPath).toBe(db);
    } finally {
      store.close();
    }
  });

  it("persists summaries in a file-backed single database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-cache-"));
    cleanup.push(directory);
    const db = path.join(directory, "cache.db");
    const indexer = new TsReactIndexer(fixture);
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    const target = button(snapshot);

    const first = new DualCacheStore(snapshot.root, snapshot.projectId, { overrideDb: db });
    first.syncWorking(snapshot);
    first.upsertSummaries(
      [
        {
          symbolId: target.id,
          expectedContentHash: target.contentHash,
          summary: { intent: "Persisted", side_effects: ["none"], invariants: [] },
        },
      ],
      snapshot
    );
    first.close();

    const second = new DualCacheStore(snapshot.root, snapshot.projectId, { overrideDb: db });
    try {
      expect(second.getInfo().cached_summaries).toBe(1);
      expect(second.getStaleness(target)).toBe("synced");
    } finally {
      second.close();
    }

    const plan = planDatabaseRemoval(snapshot.root, snapshot.projectId, { overrideDb: db });
    expect(plan.existing.length).toBeGreaterThan(0);
    const removal = removeDatabases(plan);
    expect(removal.removed.length).toBeGreaterThan(0);
    expect(fs.existsSync(db)).toBe(false);
  });

  it("prunes worktree databases whose canonical root no longer exists", () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-prune-"));
    cleanup.push(cacheRoot);
    const previous = process.env.TSRAY_CACHE_DIR;
    process.env.TSRAY_CACHE_DIR = cacheRoot;
    try {
      const worktrees = path.join(cacheRoot, "worktrees");
      fs.mkdirSync(worktrees, { recursive: true });
      const aliveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-alive-"));
      cleanup.push(aliveRoot);
      const create = (file: string, canonicalRoot: string): void => {
        const db = new DatabaseSync(file);
        db.exec("CREATE TABLE working_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
        db.prepare("INSERT INTO working_meta (key, value) VALUES (?, ?)").run("canonical_root", canonicalRoot);
        db.close();
      };
      create(path.join(worktrees, "alive.db"), aliveRoot);
      create(path.join(worktrees, "missing.db"), path.join(cacheRoot, "does-not-exist"));

      const result = pruneWorktreeDatabases({ dryRun: true });
      expect(result.scanned).toBe(2);
      expect(result.removed.some((file) => file.endsWith("missing.db"))).toBe(true);
      expect(fs.existsSync(path.join(worktrees, "missing.db"))).toBe(true);

      const applied = pruneWorktreeDatabases();
      expect(applied.removed.some((file) => file.endsWith("missing.db"))).toBe(true);
      expect(fs.existsSync(path.join(worktrees, "missing.db"))).toBe(false);
      expect(fs.existsSync(path.join(worktrees, "alive.db"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TSRAY_CACHE_DIR;
      else process.env.TSRAY_CACHE_DIR = previous;
    }
  });
});
