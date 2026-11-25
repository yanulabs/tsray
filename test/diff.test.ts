import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { diffMarkdown, runArchitecturalDiff } from "../src/cli/diff.js";
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

describe("architectural diff", () => {
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
