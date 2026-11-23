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

describe("healthy snapshot fallback", () => {
  it("keeps the last healthy snapshot while production errors exist", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-healthy-"));
    cleanup.push(temporary);
    fs.cpSync(fixture, temporary, { recursive: true });

    const indexer = new TsReactIndexer(temporary);
    const store = new DualCacheStore(indexer.root, indexer.projectId, { overrideDb: ":memory:" });
    const controller = new IndexController(indexer, store);
    try {
      const healthy = await controller.rebuild({ fullDiagnostics: true });
      const healthyAt = healthy.indexedAt;

      const appPath = path.join(temporary, "src/App.tsx");
      const original = fs.readFileSync(appPath, "utf8");
      fs.writeFileSync(appPath, original.replace("const theme = useTheme();", "const theme: number = useTheme();"));
      indexer.notifyFilesChanged([appPath]);
      const fallback = await controller.rebuild({ fullDiagnostics: true });

      expect(fallback.indexedAt).toBe(healthyAt);
      expect(fallback.prodErrors).toEqual([]);
      expect(indexer.getLastSnapshot()?.prodErrors.length).toBeGreaterThan(0);
      expect(controller.status().prod_errors).toBeGreaterThan(0);
      expect(controller.status().served_prod_errors).toBe(0);
      expect(controller.status().index_state).toBe("error");

      fs.writeFileSync(appPath, original);
      indexer.notifyFilesChanged([appPath]);
      const recovered = await controller.rebuild({ fullDiagnostics: true });
      expect(recovered.prodErrors).toEqual([]);
      expect(recovered.indexedAt).not.toBe(healthyAt);
    } finally {
      await controller.stop();
      store.close();
    }
  }, 60_000);
});
