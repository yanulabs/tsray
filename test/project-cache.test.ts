import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";
import { getDeadCode, getHotspots } from "../src/index/queries.js";
import { stableStringify } from "../src/index/hasher.js";
import type { IndexSnapshot } from "../src/index/types.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-project-cache-"));
  cleanup.push(root);
  write(root, "package.json", JSON.stringify({ name: "cache-fixture", private: true }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  write(root, "tsconfig.json", JSON.stringify({
    files: [],
    references: [
      { path: "./apps/app" },
      { path: "./packages/leaf" },
      { path: "./packages/shared" },
      { path: "./packages/other" },
    ],
  }));
  write(root, "packages/shared/package.json", JSON.stringify({
    name: "@test/shared",
    version: "1.0.0",
    types: "./src/index.ts",
    exports: { ".": "./src/index.ts" },
  }));
  write(root, "packages/shared/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src"],
  }));
  write(root, "packages/shared/src/index.ts", "export interface SharedProps { value: string }\nexport function shared(): number { return 1 }\n");
  write(root, "packages/leaf/package.json", JSON.stringify({
    name: "@test/leaf",
    version: "1.0.0",
    dependencies: { "@test/shared": "workspace:*" },
    types: "./src/index.ts",
  }));
  write(root, "packages/leaf/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src"],
    references: [{ path: "../shared" }],
  }));
  write(root, "packages/leaf/src/index.ts", "import { shared } from '@test/shared';\nexport function leaf(): number { return shared() + 1 }\n");
  write(root, "packages/other/package.json", JSON.stringify({ name: "@test/other", version: "1.0.0" }));
  write(root, "packages/other/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src"],
  }));
  write(root, "packages/other/src/index.ts", "export function other(): number { return 3 }\n");
  write(root, "apps/app/package.json", JSON.stringify({
    name: "@test/app",
    version: "1.0.0",
    dependencies: { "@test/leaf": "workspace:*", "external-lib": "^1.0.0" },
    devDependencies: { typescript: "~5.9.0" },
  }));
  write(root, "apps/app/tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
    include: ["src"],
    references: [{ path: "../../packages/leaf" }],
  }));
  write(root, "apps/app/src/index.ts", "import { leaf } from '@test/leaf';\nexport function app(): number { return leaf() + 1 }\n");
  write(root, "pnpm-lock.yaml", `lockfileVersion: '9.0'
importers:
  .: {}
  apps/app:
    dependencies:
      '@test/leaf':
        specifier: workspace:*
        version: link:../../packages/leaf
      external-lib:
        specifier: ^1.0.0
        version: 1.2.0
    devDependencies:
      typescript:
        specifier: ~5.9.0
        version: 5.9.3
  packages/leaf:
    dependencies:
      '@test/shared':
        specifier: workspace:*
        version: link:../shared
  packages/shared: {}
  packages/other: {}
packages:
  external-lib@1.2.0:
    resolution: { integrity: sha512-external }
  typescript@5.9.3:
    resolution: { integrity: sha512-typescript }
snapshots:
  external-lib@1.2.0:
    dependencies:
      transitive-lib: 2.0.0
  transitive-lib@2.0.0: {}
  typescript@5.9.3: {}
`);
  return root;
}

function run(root: string): IndexSnapshot {
  const indexer = new TsReactIndexer(root, { workspace: true, parallel: false });
  const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: path.join(root, "cache.db") });
  indexer.setProjectCache(store);
  try {
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    store.syncWorking(snapshot);
    return snapshot;
  } finally {
    store.close();
  }
}

function digest(snapshot: IndexSnapshot): string {
  const payload = {
    symbols: [...snapshot.symbols.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: snapshot.edges.slice().sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    files: [...snapshot.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    fileImports: snapshot.fileImports.slice().sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    cycles: snapshot.moduleCycles,
    hotspots: getHotspots(snapshot, 1000),
    deadCode: getDeadCode(snapshot, true),
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

describe("per-project persistent cache", () => {
  it("skips every non-empty project on a full warm run with an identical graph", () => {
    const root = fixture();
    const cold = run(root);
    const warm = run(root);

    expect(cold.projectMetrics).toMatchObject({
      projects_total: 4,
      projects_cached: 0,
      projects_rebuilt: 4,
      projects_empty: 1,
      workers_spawned: 0,
    });
    expect(warm.projectMetrics).toMatchObject({
      projects_total: 4,
      projects_cached: 4,
      projects_rebuilt: 0,
      projects_empty: 1,
      workers_spawned: 0,
      diagnostics_cached: 4,
    });
    expect(digest(warm)).toBe(digest(cold));
  });

  it("keeps cached file stats immutable across same-process rebuilds", () => {
    const root = fixture();
    const indexer = new TsReactIndexer(root, { workspace: true, parallel: false });
    const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: path.join(root, "cache.db") });
    indexer.setProjectCache(store);
    try {
      const cold = indexer.buildIndex({ fullDiagnostics: true });
      const warm = indexer.buildIndex({ fullDiagnostics: true });
      const repeated = indexer.buildIndex({ fullDiagnostics: true });
      expect(warm.files).toEqual(cold.files);
      expect(repeated.files).toEqual(cold.files);
      expect(repeated.projectMetrics).toMatchObject({ projects_cached: 4, projects_rebuilt: 0 });
    } finally {
      store.close();
    }
  });

  it("does not cascade an implementation-only edit", () => {
    const root = fixture();
    run(root);
    write(root, "packages/shared/src/index.ts", "export interface SharedProps { value: string }\nexport function shared(): number { return 2 }\n");
    const snapshot = run(root);

    expect(snapshot.projectMetrics).toMatchObject({
      projects_total: 4,
      projects_cached: 3,
      projects_rebuilt: 1,
      projects_empty: 1,
      workers_spawned: 0,
    });
  });

  it("cascades an exported signature edit to downstream projects", () => {
    const root = fixture();
    run(root);
    write(root, "packages/shared/src/index.ts", "export interface SharedProps { value: number }\nexport function shared(): number { return 1 }\n");
    const snapshot = run(root);

    expect(snapshot.projectMetrics).toMatchObject({
      projects_total: 4,
      projects_cached: 2,
      projects_rebuilt: 2,
      projects_empty: 1,
      workers_spawned: 0,
    });
  });

  it("does not propagate a local package devDependency to consumers", () => {
    const root = fixture();
    run(root);
    const manifestPath = path.join(root, "packages/leaf/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.devDependencies = { ...manifest.devDependencies, vitest: "^3.0.0" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const snapshot = run(root);
    expect(snapshot.projectMetrics).toMatchObject({ projects_cached: 3, projects_rebuilt: 1 });
  });

  it("uses canonical project keys for symlinked tsconfigs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-project-symlink-"));
    cleanup.push(root);
    write(root, "package.json", JSON.stringify({ name: "symlink-fixture" }));
    write(root, "tsconfig.json", JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true },
      include: ["src"],
    }));
    write(root, "src/index.ts", "export const value = 1;\n");
    fs.symlinkSync("tsconfig.json", path.join(root, "alias.json"));

    const runLinked = () => {
      const indexer = new TsReactIndexer(root, { tsconfig: "alias.json", parallel: false });
      const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: path.join(root, "cache.db") });
      indexer.setProjectCache(store);
      try {
        expect(indexer.getProjectConfigs()[0]?.path).toBe("tsconfig.json");
        return indexer.buildIndex({ fullDiagnostics: true });
      } finally {
        store.close();
      }
    };
    runLinked();
    expect(runLinked().projectMetrics).toMatchObject({ projects_total: 1, projects_cached: 1, projects_rebuilt: 0 });
  });

  it("scopes devDependency and unrelated lockfile edits to the owning project", () => {
    const root = fixture();
    run(root);
    const manifestPath = path.join(root, "apps/app/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.devDependencies["new-dev-tool"] = "^1.0.0";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const dependencyEdit = run(root);
    expect(dependencyEdit.projectMetrics).toMatchObject({ projects_cached: 3, projects_rebuilt: 1 });

    const lockPath = path.join(root, "pnpm-lock.yaml");
    fs.appendFileSync(lockPath, "\n  unrelated-package@9.0.0:\n    resolution: { integrity: sha512-unrelated }\n");
    const unrelatedEdit = run(root);
    expect(unrelatedEdit.projectMetrics).toMatchObject({ projects_cached: 4, projects_rebuilt: 0 });
  });
});
