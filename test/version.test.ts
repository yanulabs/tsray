import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("package metadata", () => {
  it("keeps the runtime version in sync with package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version: string;
      engines?: { node?: string };
    };
    expect(VERSION).toBe(pkg.version);
    expect(pkg.engines?.node).toContain("22.13");
  });
});
