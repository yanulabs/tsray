import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";
import { IndexController } from "../src/index/watch.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for condition");
}

describe("watcher", () => {
  it("rebuilds after a debounced source change", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-watch-"));
    cleanup.push(temporary);
    fs.cpSync(fixture, temporary, { recursive: true });

    const indexer = new TsReactIndexer(temporary);
    const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: ":memory:" });
    const controller = new IndexController(indexer, store);
    try {
      const initial = await controller.rebuild({ fullDiagnostics: true });
      const initialApp = [...initial.symbols.values()].find((symbol) => symbol.name === "App")!;
      const initialIndexedAt = initial.indexedAt;

      controller.startWatch();
      await new Promise((resolve) => setTimeout(resolve, 600));

      const appPath = path.join(temporary, "src/App.tsx");
      fs.writeFileSync(
        appPath,
        fs.readFileSync(appPath, "utf8").replace("label={theme.name}", 'label={`${theme.name} changed`}')
      );

      await waitFor(() => {
        const current = controller.indexer.getLastSnapshot();
        return Boolean(current && current.indexedAt !== initialIndexedAt);
      }, 20_000);

      const updated = await controller.getSnapshot();
      const updatedApp = [...updated.symbols.values()].find((symbol) => symbol.name === "App")!;
      expect(updatedApp.selfHash).not.toBe(initialApp.selfHash);
    } finally {
      await controller.stop();
      store.close();
    }
  }, 40_000);
});
