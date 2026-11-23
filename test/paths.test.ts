import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isEntrypointFile, loadConfig, readPackageEntrypoints, resolveProject } from "../src/util/paths.js";

const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

describe("project metadata", () => {
  it("maps package exports from dist back to src entrypoints", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-entry-"));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "entry-fixture",
        main: "./dist/index.js",
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
        bin: { cli: "./dist/cli.js" },
      })
    );

    const patterns = readPackageEntrypoints(root);
    expect(patterns.some((pattern) => pattern.startsWith("src/index."))).toBe(true);
    expect(patterns.some((pattern) => pattern.startsWith("src/cli."))).toBe(true);
    expect(isEntrypointFile("src/index.ts", loadConfig(root), patterns)).toBe(true);
  });

  it("resolves a workspace root without a root tsconfig", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-workspace-"));
    cleanup.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "workspace-fixture", workspaces: ["packages/*"] })
    );
    fs.mkdirSync(path.join(root, "packages", "web", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "web", "src", "main.ts"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(root, "packages", "web", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] })
    );

    const project = resolveProject(root, { workspace: true });
    expect(project.root).toBe(fs.realpathSync(root));
    expect(project.projectId).toBe("workspace-fixture");
    expect(project.workspace).toBe(true);
    expect(
      project.tsconfigPaths.some((file) => file.endsWith(path.join("packages", "web", "tsconfig.json")))
    ).toBe(true);
  });
});
