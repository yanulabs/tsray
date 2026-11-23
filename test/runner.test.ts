import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/util/paths.js";
import { detectLintRunner, detectTestRunner, detectTypecheckRunner, runCommand } from "../src/tools/runner.js";

const fixture = fileURLToPath(new URL("./fixtures/react-app", import.meta.url));
const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryPackage(packageJson: Record<string, unknown>): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-runner-"));
  cleanup.push(directory);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(packageJson));
  return directory;
}

describe("tool runner detection", () => {
  it("reports unavailable runners without crashing", () => {
    const config = loadConfig(fixture);
    expect(detectTestRunner(fixture, config).available).toBe(false);
    expect(detectLintRunner(fixture, config).available).toBe(false);
    expect(detectTypecheckRunner(fixture, config).available).toBe(false);
  });

  it("detects package scripts and adds a safe vitest run flag", () => {
    const root = temporaryPackage({
      scripts: { test: "vitest", typecheck: "tsc --noEmit", lint: "eslint ." },
      devDependencies: { vitest: "^5.0.0" },
    });
    const config = loadConfig(root);
    expect(detectTestRunner(root, config).command).toBe("npm run test -- --run");
    expect(detectTestRunner(root, config).source).toBe("package.json#scripts.test");
    expect(detectTypecheckRunner(root, config).command).toBe("npm run typecheck");
    expect(detectLintRunner(root, config).command).toBe("npm run lint");
  });

  it("honors explicit tsray.json runner commands", () => {
    const root = temporaryPackage({});
    fs.writeFileSync(
      path.join(root, "tsray.json"),
      JSON.stringify({ runner: { test: "node --test", typecheck: "tsc -p tsconfig.json", lint: "biome check ." } })
    );
    const config = loadConfig(root);
    expect(detectTestRunner(root, config).command).toBe("node --test");
    expect(detectTypecheckRunner(root, config).command).toBe("tsc -p tsconfig.json");
    expect(detectLintRunner(root, config).command).toBe("biome check .");
  });

  it("captures command output and exit codes", async () => {
    const success = await runCommand(process.cwd(), 'node -e "console.log(\'ok\')"');
    expect(success.exit_code).toBe(0);
    expect(success.stdout.trim()).toBe("ok");
    expect(success.timed_out).toBe(false);

    const failure = await runCommand(process.cwd(), 'node -e "process.exit(3)"');
    expect(failure.exit_code).toBe(3);
  });
});
