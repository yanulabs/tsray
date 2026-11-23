import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { getDeadCode, getHotspots, getModuleSummaries, getSymbolMatches } from "../src/index/queries.js";
import type { IndexSnapshot } from "../src/index/types.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
const cleanup: string[] = [];

afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

let cached: { indexer: TsReactIndexer; snapshot: IndexSnapshot } | null = null;

function indexed(): { indexer: TsReactIndexer; snapshot: IndexSnapshot } {
  if (!cached) {
    const indexer = new TsReactIndexer(fixture);
    cached = { indexer, snapshot: indexer.buildIndex({ fullDiagnostics: true }) };
  }
  return cached;
}

function symbol(name: string) {
  const found = [...indexed().snapshot.symbols.values()].find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing symbol ${name}`);
  return found;
}

function hasEdge(from: string, to: string, kind: string): boolean {
  return indexed().snapshot.edges.some(
    (edge) => edge.fromId === from && edge.toId === to && edge.kind === kind
  );
}

describe("TypeScript/React indexer", () => {
  it("resolves the project and indexes without production errors", () => {
    const { snapshot } = indexed();
    expect(snapshot.projectId).toBe("fixture-react-app");
    expect(snapshot.tsconfigPath).toBe("tsconfig.json");
    expect(snapshot.prodErrors).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.filesCount).toBe(7);
    expect(snapshot.symbols.size).toBe(12);
    expect(snapshot.modules.sort()).toEqual(["components", "root"]);
  });

  it("classifies React components, hooks, contexts, and types", () => {
    expect(symbol("App").kind).toBe("component");
    expect(symbol("Button").kind).toBe("component");
    expect(symbol("Button").propsType).toBe("ButtonProps");
    expect(symbol("MemoButton").kind).toBe("component");
    expect(symbol("ThemeProvider").kind).toBe("component");
    expect(symbol("useTheme").kind).toBe("hook");
    expect(symbol("ThemeContext").kind).toBe("context");
    expect(symbol("ButtonProps").kind).toBe("interface");
    expect(symbol("Theme").kind).toBe("interface");
  });

  it("unwraps barrel re-exports instead of collapsing onto index.ts", () => {
    const { snapshot } = indexed();
    const barrelSymbols = [...snapshot.symbols.values()].filter(
      (candidate) => candidate.file === "src/components/index.ts"
    );
    expect(barrelSymbols).toEqual([]);

    const app = symbol("App");
    const button = symbol("Button");
    expect(hasEdge(app.id, button.id, "renders")).toBe(true);
    expect(
      snapshot.edges.some(
        (edge) => edge.fromId === "file:src/App.tsx" && edge.toId === button.id && edge.kind === "imports"
      )
    ).toBe(true);
    expect(snapshot.fileImports.some((edge) => edge.fromFile === "src/App.tsx" && edge.toFile === "src/components/index.ts")).toBe(
      true
    );
  });

  it("extracts React render, hook, context, and wrapper edges", () => {
    const app = symbol("App");
    const button = symbol("Button");
    const memoButton = symbol("MemoButton");
    const themeProvider = symbol("ThemeProvider");
    const themeContext = symbol("ThemeContext");
    const useTheme = symbol("useTheme");

    expect(hasEdge(app.id, button.id, "renders")).toBe(true);
    expect(hasEdge(app.id, themeProvider.id, "renders")).toBe(true);
    expect(hasEdge(app.id, useTheme.id, "uses_hook")).toBe(true);
    expect(hasEdge(themeProvider.id, themeContext.id, "provides_context")).toBe(true);
    expect(hasEdge(useTheme.id, themeContext.id, "consumes_context")).toBe(true);
    expect(hasEdge(memoButton.id, button.id, "wraps")).toBe(true);
  });

  it("marks framework entrypoints and avoids false-positive dead code", () => {
    const { snapshot } = indexed();
    expect(symbol("App").isEntrypoint).toBe(true);
    expect(symbol("Button").isEntrypoint).toBe(false);
    expect(getDeadCode(snapshot, false)).toEqual([]);
    const allDead = getDeadCode(snapshot, true).map((candidate) => candidate.name);
    expect(allDead).toContain("localHelper");
    expect(allDead).toContain("deadRoot");
    expect(allDead).toContain("add");
  });

  it("computes module summaries and hotspots", () => {
    const { snapshot } = indexed();
    const modules = getModuleSummaries(snapshot);
    const root = modules.find((module) => module.name === "root");
    const components = modules.find((module) => module.name === "components");
    expect(root?.components).toBe(2);
    expect(components?.components).toBe(2);
    expect(components?.fanIn).toBe(1);
    expect(getHotspots(snapshot, 5)).toHaveLength(5);
    expect(getSymbolMatches(snapshot, "Button").map((candidate) => candidate.name)).toContain("Button");
  });

  it("rebuilds incrementally after a file change and indexes new files", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-incremental-"));
    cleanup.push(temporary);
    fs.cpSync(fixture, temporary, { recursive: true });

    const indexer = new TsReactIndexer(temporary);
    const before = indexer.buildIndex({ fullDiagnostics: true });
    const beforeApp = [...before.symbols.values()].find((candidate) => candidate.name === "App")!;

    const appPath = path.join(temporary, "src/App.tsx");
    fs.writeFileSync(
      appPath,
      fs.readFileSync(appPath, "utf8").replace("label={theme.name}", 'label={`${theme.name}!`}')
    );
    const extraPath = path.join(temporary, "src/Extra.tsx");
    fs.writeFileSync(extraPath, "export function Extra() {\n  return <div>extra</div>;\n}\n");

    indexer.notifyFilesChanged([appPath, extraPath]);
    const after = indexer.buildIndex({ fullDiagnostics: false });
    const afterApp = [...after.symbols.values()].find((candidate) => candidate.name === "App")!;
    const extra = [...after.symbols.values()].find((candidate) => candidate.name === "Extra");

    expect(after.prodErrors).toEqual([]);
    expect(afterApp.selfHash).not.toBe(beforeApp.selfHash);
    expect(extra?.kind).toBe("component");

    // Add a real cross-module cycle and verify that the incremental program
    // reports it from resolved imports rather than syntax guesses.
    fs.mkdirSync(path.join(temporary, "src/features/a"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "src/features/b"), { recursive: true });
    const aPath = path.join(temporary, "src/features/a/index.ts");
    const bPath = path.join(temporary, "src/features/b/index.ts");
    fs.writeFileSync(aPath, 'import { b } from "../b";\nexport function a(): number {\n  return b();\n}\n');
    fs.writeFileSync(bPath, 'import { a } from "../a";\nexport function b(): number {\n  return a();\n}\n');
    indexer.notifyFilesChanged([aPath, bPath]);
    const cyclic = indexer.buildIndex({ fullDiagnostics: false });
    expect(cyclic.prodErrors).toEqual([]);
    expect(
      cyclic.moduleCycles.some(
        (cycle) => cycle.includes("features/a") && cycle.includes("features/b")
      )
    ).toBe(true);
  });
});
