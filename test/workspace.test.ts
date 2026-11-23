import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { findImplementations, getDeadCode } from "../src/index/queries.js";

const workspace = fileURLToPath(new URL("./fixtures/workspace", import.meta.url));

describe("workspace and project references", () => {
  it("loads referenced tsconfigs into one semantic graph", () => {
    const indexer = new TsReactIndexer(workspace, { workspace: true });
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });

    expect(snapshot.projectId).toBe("fixture-workspace");
    expect(indexer.workspace).toBe(true);
    expect(snapshot.prodErrors).toEqual([]);
    expect(snapshot.tsconfigPaths).toContain("packages/app/tsconfig.json");
    expect(snapshot.tsconfigPaths).toContain("packages/ui/tsconfig.json");
    expect(snapshot.tsconfigPaths).toContain("tsconfig.json");
    expect(snapshot.modules.sort()).toEqual(["packages/app", "packages/ui"]);

    const app = [...snapshot.symbols.values()].find((symbol) => symbol.name === "App");
    const button = [...snapshot.symbols.values()].find((symbol) => symbol.name === "Button");
    expect(app?.kind).toBe("component");
    expect(button?.kind).toBe("component");
    expect(
      snapshot.edges.some(
        (edge) => edge.fromId === app?.id && edge.toId === button?.id && edge.kind === "renders"
      )
    ).toBe(true);
    expect(
      snapshot.fileImports.some(
        (edge) =>
          edge.fromFile === "packages/app/src/App.tsx" &&
          edge.toFile === "packages/ui/src/index.ts" &&
          edge.specifier === "@fixture/ui"
      )
    ).toBe(true);
    expect(snapshot.files.get("packages/ui/src/index.ts")?.isEntrypoint).toBe(true);
  });

  it("handles lazy, forwardRef, classes, and interface contracts", () => {
    const indexer = new TsReactIndexer(workspace, { workspace: true });
    const snapshot = indexer.buildIndex({ fullDiagnostics: true });
    const byName = (name: string) =>
      [...snapshot.symbols.values()].find((symbol) => symbol.name === name);

    const lazyPanel = byName("LazyPanel");
    const panel = byName("Panel");
    expect(lazyPanel?.kind).toBe("component");
    expect(panel?.kind).toBe("component");
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.fromId === lazyPanel?.id && edge.toId === panel?.id && edge.kind === "wraps"
      )
    ).toBe(true);

    const fancyButton = byName("FancyButton");
    expect(fancyButton?.kind).toBe("component");
    expect(fancyButton?.propsType).toContain("ButtonProps");

    const repository = [...snapshot.symbols.values()].find((symbol) => symbol.name === "Repository")!;
    const implementations = findImplementations(snapshot, repository.id);
    expect(implementations[0]?.implementations.some((item) => item.name === "MemoryRepository")).toBe(true);

    const serializable = [...snapshot.symbols.values()].find((symbol) => symbol.name === "Serializable")!;
    const structural = findImplementations(snapshot, serializable.id);
    expect(
      structural[0]?.implementations.some((item) => item.name === "Snapshot" && item.via === "structural")
    ).toBe(true);

    const hidden = byName("hidden");
    expect(hidden?.kind).toBe("method");
    expect(hidden?.exported).toBe(false);
    expect(getDeadCode(snapshot, false).some((symbol) => symbol.name === "hidden")).toBe(false);
  });
});
