import { describe, expect, it } from "vitest";
import { DEFAULT_ENTRYPOINTS, globToRegExp, matchesAny } from "../src/util/glob.js";
import { deriveModuleName } from "../src/util/paths.js";

describe("glob matching", () => {
  it("matches nested app route entrypoints", () => {
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "app/dashboard/settings/page.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "src/app/(marketing)/layout.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "src/main.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "src/components/Button.tsx")).toBe(false);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "src/components/Button.stories.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "middleware.ts")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "app/profile/index.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "app/profile/_layout.tsx")).toBe(true);
    expect(matchesAny(DEFAULT_ENTRYPOINTS, "src/app/dashboard/route.ts")).toBe(true);
  });

  it("supports braces, globstar, and question marks", () => {
    expect(globToRegExp("src/**/{a,b}.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/**/{a,b}.ts").test("src/x/y/c.ts")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
  });
});

describe("module grouping", () => {
  it("groups features, app routes, packages, and root files", () => {
    expect(deriveModuleName("src/features/billing/invoice.ts")).toBe("features/billing");
    expect(deriveModuleName("src/app/dashboard/page.tsx")).toBe("app/dashboard");
    expect(deriveModuleName("packages/ui/src/Button.tsx")).toBe("packages/ui");
    expect(deriveModuleName("src/components/Button.tsx")).toBe("components");
    expect(deriveModuleName("vite.config.ts")).toBe("root");
  });
});
