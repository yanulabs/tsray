import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";

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
});
