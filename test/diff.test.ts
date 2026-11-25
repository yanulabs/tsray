import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { diffMarkdown, prepareBaseWorktree, runArchitecturalDiff } from "../src/cli/diff.js";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

function git(repo: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "tsray test",
      GIT_AUTHOR_EMAIL: "tsray@example.com",
      GIT_COMMITTER_NAME: "tsray test",
      GIT_COMMITTER_EMAIL: "tsray@example.com",
    },
  });
}

function write(repo: string, relative: string, content: string): void {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("architectural diff", () => {
  it("does not mirror head-only workspace packages into the base worktree", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-link-test-"));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-link-worktree-"));
    cleanup.push(repo, worktree);
    write(repo, "package.json", JSON.stringify({ name: "link-test", private: true }));
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    fs.rmdirSync(worktree);
    git(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);

    write(repo, "packages/head-only/package.json", JSON.stringify({ name: "head-only" }));
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
    fs.symlinkSync(path.join("..", "packages", "head-only"), path.join(repo, "node_modules", "head-only"), "dir");
    try {
      prepareBaseWorktree(
        fs.realpathSync(repo),
        fs.realpathSync(worktree),
        fs.realpathSync(worktree)
      );
      expect(fs.existsSync(path.join(worktree, "node_modules", "head-only"))).toBe(false);
      expect(fs.existsSync(path.join(repo, "packages", "head-only"))).toBe(true);
    } finally {
      git(repo, ["worktree", "remove", "--force", worktree]);
    }
  });

  it("removes the temporary worktree when base preparation fails", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-cleanup-test-"));
    cleanup.push(repo);
    write(repo, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    write(repo, "src/index.ts", "export const value = 1;\n");
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    write(repo, "package.json", JSON.stringify({ name: "cleanup-test", private: true }));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "head"]);

    const previousSeed = process.env.TSRAY_DIFF_SEED;
    try {
      process.env.TSRAY_DIFF_SEED = "0";
      expect(() => runArchitecturalDiff(repo, "HEAD~1", [], { parallel: false })).toThrow(
        "base worktree target is missing workspace metadata"
      );
    } finally {
      if (previousSeed === undefined) delete process.env.TSRAY_DIFF_SEED;
      else process.env.TSRAY_DIFF_SEED = previousSeed;
    }
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).match(/^worktree /gm)).toHaveLength(1);
  });

  it("discovers and warm-seeds all projects across an initialized submodule worktree", () => {
    const moduleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-module-"));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-workspace-"));
    cleanup.push(moduleRepo, repo);
    write(moduleRepo, "package.json", JSON.stringify({ name: "@test/module", version: "1.0.0", types: "./src/index.ts" }));
    write(moduleRepo, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src"] }));
    write(moduleRepo, "src/index.ts", "export function moduleValue(): number { return 1 }\n");
    git(moduleRepo, ["init", "-q"]);
    git(moduleRepo, ["add", "-A"]);
    git(moduleRepo, ["commit", "-q", "-m", "module"]);

    write(repo, "package.json", JSON.stringify({ name: "diff-workspace", private: true }));
    write(repo, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    write(repo, "tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./packages/local" }, { path: "./packages/module" }] }));
    write(repo, "packages/local/package.json", JSON.stringify({ name: "@test/local", version: "1.0.0", dependencies: { "@test/module": "workspace:*" } }));
    write(repo, "packages/local/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, baseUrl: ".", paths: { "@test/module": ["../module/src/index.ts"] } }, include: ["src"], references: [{ path: "../module" }] }));
    write(repo, "packages/local/src/index.ts", "import { moduleValue } from '@test/module';\nexport function localValue(): number { return moduleValue() }\n");
    git(repo, ["init", "-q"]);
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", moduleRepo, "packages/module"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
    write(repo, "packages/local/src/index.ts", "import { moduleValue } from '@test/module';\nexport function localValue(): number { return moduleValue() + 1 }\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "head"]);

    const database = path.join(repo, "cache.db");
    const indexer = new TsReactIndexer(repo, { workspace: true, parallel: false });
    const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: database });
    indexer.setProjectCache(store);
    try {
      store.syncWorking(indexer.buildIndex({ fullDiagnostics: true }));
    } finally {
      store.close();
    }
    const before = fs.readFileSync(database);
    const previousDb = process.env.TSRAY_DB;
    const previousSeed = process.env.TSRAY_DIFF_SEED;
    try {
      process.env.TSRAY_DB = database;
      process.env.TSRAY_DIFF_SEED = "0";
      const cold = runArchitecturalDiff(repo, "HEAD~1", [], { workspace: true, parallel: false });
      process.env.TSRAY_DIFF_SEED = "1";
      const seeded = runArchitecturalDiff(repo, "HEAD~1", [], { workspace: true, parallel: false });
      expect(JSON.stringify(seeded)).toBe(JSON.stringify(cold));
      expect(seeded.base.projects).toBe(2);
      expect(seeded.base.graph_digest).toEqual(expect.any(String));
      expect(seeded.indexMetrics?.base.projects_cached).toBe(1);
      expect(seeded.indexMetrics?.base.projects_rebuilt).toBe(1);
      expect(fs.readFileSync(database)).toEqual(before);
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).match(/^worktree /gm)).toHaveLength(1);
    } finally {
      if (previousDb === undefined) delete process.env.TSRAY_DB;
      else process.env.TSRAY_DB = previousDb;
      if (previousSeed === undefined) delete process.env.TSRAY_DIFF_SEED;
      else process.env.TSRAY_DIFF_SEED = previousSeed;
    }
  }, 120_000);

  it("warm-seeds the base worktree without changing deterministic diff output", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-seed-test-"));
    cleanup.push(repo);
    fs.cpSync(fixture, repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const database = path.join(repo, "cache.db");
    const indexer = new TsReactIndexer(repo, { parallel: false });
    const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: database });
    indexer.setProjectCache(store);
    try {
      store.syncWorking(indexer.buildIndex({ fullDiagnostics: true }));
    } finally {
      store.close();
    }
    const before = fs.readFileSync(database);

    const previousDb = process.env.TSRAY_DB;
    const previousSeed = process.env.TSRAY_DIFF_SEED;
    try {
      process.env.TSRAY_DB = database;
      process.env.TSRAY_DIFF_SEED = "0";
      const cold = runArchitecturalDiff(repo, "HEAD", [], { parallel: false });
      process.env.TSRAY_DIFF_SEED = "1";
      const seeded = runArchitecturalDiff(repo, "HEAD", [], { parallel: false });
      expect(JSON.stringify(seeded)).toBe(JSON.stringify(cold));
      expect(seeded.base.projects).toBe(1);
      expect(seeded.indexMetrics?.base.projects_cached).toBe(1);
      expect(seeded.indexMetrics?.base.projects_rebuilt).toBe(0);
      expect(fs.readFileSync(database)).toEqual(before);
      expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).match(/^worktree /gm)).toHaveLength(1);
    } finally {
      if (previousDb === undefined) delete process.env.TSRAY_DB;
      else process.env.TSRAY_DB = previousDb;
      if (previousSeed === undefined) delete process.env.TSRAY_DIFF_SEED;
      else process.env.TSRAY_DIFF_SEED = previousSeed;
    }
  }, 120_000);

  it("detects breaking API changes, new dead code, and gated regressions", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-diff-test-"));
    cleanup.push(repo);
    fs.cpSync(fixture, repo, { recursive: true });
    git(repo, ["init", "-q"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);

    const buttonPath = path.join(repo, "src/components/Button.tsx");
    fs.writeFileSync(
      buttonPath,
      fs
        .readFileSync(buttonPath, "utf8")
        .replace("label: string;", "label: string | number;")
        .replace("export function Button({ label }: ButtonProps)", "export function Button({ label }: ButtonProps, extra?: string)")
        .replace("return <button>{label}</button>;", "return <button>{`${label}${extra ?? \"\"}`}</button>;")
    );
    const utilsPath = path.join(repo, "src/utils.ts");
    fs.appendFileSync(utilsPath, "\nfunction newOrphan() {\n  return 42;\n}\n");

    const result = runArchitecturalDiff(repo, "HEAD", ["breaking_api", "dead_code"]);
    expect(result.base_ref).toBe("HEAD");
    expect(result.breaking_api.some((item) => item.name === "Button" && item.reason === "signature_changed")).toBe(true);
    expect(
      result.breaking_api.some((item) => item.name === "ButtonProps" && item.reason === "signature_changed")
    ).toBe(true);
    expect(result.new_dead_code.some((item) => item.name === "newOrphan")).toBe(true);
    expect(result.failed_gates).toContain("breaking_api");
    expect(result.failed_gates).toContain("dead_code");
    expect(result.base_prod_errors).toBe(0);
    expect(result.head_prod_errors).toBe(0);

    const markdown = diffMarkdown(result);
    expect(markdown).toContain("## Breaking API Changes");
    expect(markdown).toContain("## New Dead Code");
  }, 120_000);
});
