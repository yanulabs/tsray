import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { explainDependency, getModuleEdges } from "../src/index/queries.js";

const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-module-graph-"));
  cleanup.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "module-graph-fixture" }));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src"],
    })
  );
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

describe("module graph topology", () => {
  it("keeps type-only import cycles out of the runtime architecture graph", () => {
    const root = project({
      "src/features/a/index.ts":
        'import type { B } from "../b";\nexport interface A {\n  b: B;\n}\n',
      "src/features/b/index.ts":
        'import type { A } from "../a";\nexport interface B {\n  a: A;\n}\n',
    });
    const snapshot = new TsReactIndexer(root).buildIndex({ fullDiagnostics: true });

    expect(snapshot.prodErrors).toEqual([]);
    expect(snapshot.fileImports).toHaveLength(2);
    expect(snapshot.fileImports.every((edge) => edge.typeOnly)).toBe(true);
    expect(snapshot.moduleCycles).toEqual([]);
    expect(getModuleEdges(snapshot)).toEqual([]);

    const explanation = explainDependency(snapshot, "features/a", "features/b");
    expect(explanation.file_imports).toHaveLength(1);
    expect(explanation.file_imports[0]?.type_only).toBe(true);
  });

  it("keeps value-import cycles and their edge weights", () => {
    const root = project({
      "src/features/a/index.ts":
        'import { b } from "../b";\nexport function a(): number {\n  return b();\n}\n',
      "src/features/b/index.ts":
        'import { a } from "../a";\nexport function b(): number {\n  return a();\n}\n',
    });
    const snapshot = new TsReactIndexer(root).buildIndex({ fullDiagnostics: true });

    expect(snapshot.prodErrors).toEqual([]);
    expect(snapshot.moduleCycles).toEqual([["features/a", "features/b"]]);
    const edges = getModuleEdges(snapshot);
    expect(edges.map((edge) => [edge.from, edge.to]).sort()).toEqual([
      ["features/a", "features/b"],
      ["features/b", "features/a"],
    ]);
    expect(edges.every((edge) => edge.imports === 1 && edge.symbols === 1)).toBe(true);
  });
});
