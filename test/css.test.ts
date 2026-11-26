import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TsReactIndexer } from "../src/index/indexer.js";
import { DualCacheStore } from "../src/cache/store.js";
import { IndexController } from "../src/index/watch.js";
import { registerMcpTools } from "../src/tools/tools.js";
import { analyzeCss } from "../src/css/analyzer.js";
import { resolveCascade, resolveCssImpact } from "../src/css/queries.js";
import { CssAnalysisService } from "../src/css/service.js";
import { specificityOfSelectorText } from "../src/css/selectors.js";

const fixture = fileURLToPath(new URL("./fixtures/css-app", import.meta.url));

function analyze(
  extraCssFiles: string[] = [],
  options: { includeGenerated?: boolean; auditGlobalClasses?: boolean } = {}
) {
  const indexer = new TsReactIndexer(fixture);
  return analyzeCss({
    root: indexer.root,
    projects: indexer.getAnalysisProjects(),
    extraCssFiles,
    ...options,
  });
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

describe("CSS analysis", () => {
  it("indexes imported CSS Modules, global styles, path aliases, and bindings", () => {
    const analysis = analyze();

    expect(analysis.files).toContain("src/global.css");
    expect(analysis.files).toContain("src/Button.module.css");
    expect(analysis.files).toContain("src/styles/Panel.module.css");

    expect(analysis.skippedPreprocessors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tsFile: "src/Button.tsx",
          specifier: "./legacy.scss",
          resolvedFile: "src/legacy.scss",
        }),
      ])
    );

    expect(analysis.skippedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "src/dist/generated.css",
          reason: "generated",
        }),
      ])
    );
    // Tailwind files are partially analyzed: plain rules and @theme tokens are
    // still useful, while generated utilities require compiled CSS.
    expect(analysis.tailwindFiles).toContain("src/tailwind.css");
    expect(analysis.files).toContain("src/tailwind.css");
    expect(analysis.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "--color-brand",
          selector: "@theme",
          isDefinition: true,
        }),
      ])
    );
    expect(analysis.files).not.toContain("src/dist/generated.css");

    expect(analysis.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tsFile: "src/Button.tsx",
          className: "root",
          targetCssFile: expect.stringContaining("Button.module.css"),
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "panelTitle",
          targetCssFile: expect.stringContaining("Panel.module.css"),
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "secondary",
          targetCssFile: expect.stringContaining("Button.module.css"),
          resolutionKind: "type-resolved",
        }),
      ])
    );

    expect(analysis.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          className: "toggle",
          targetCssFile: null,
          resolutionKind: "static",
        }),
      ])
    );

    // Template literal + computed object key preserve the module target.
    expect(analysis.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          className: "toggled",
          targetCssFile: expect.stringContaining("Button.module.css"),
          resolutionKind: "static",
        }),
        // Local variables that produce className values are resolved too.
        expect.objectContaining({
          className: "alpha",
          targetCssFile: expect.stringContaining("Dynamic.module.css"),
          resolutionKind: "static",
        }),
        // Partial-token interpolation retains its known prefix, not a bogus
        // 'prefix-' class and not a fully unknown '*'.
        expect.objectContaining({
          className: "prefix-*",
          targetCssFile: expect.stringContaining("Dynamic.module.css"),
          resolutionKind: "dynamic-unresolved",
        }),
        // String-literal unions in templates become concrete class names.
        expect.objectContaining({
          className: "badge-new",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "badge-hot",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "tone-*",
          targetCssFile: null,
          resolutionKind: "dynamic-unresolved",
        }),
        expect.objectContaining({
          className: "trimmed",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "array-class",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "dark-mode",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "light-mode",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "label-class",
          targetCssFile: null,
          resolutionKind: "static",
        }),
        expect.objectContaining({
          className: "slot-class",
          targetCssFile: null,
          resolutionKind: "static",
        }),
      ])
    );
    expect(
      analysis.bindings.some(
        (binding) =>
          binding.resolutionKind !== "dynamic-unresolved" &&
          binding.className.startsWith("prefix-")
      )
    ).toBe(false);
  });

  it("reports missing and unused CSS Module classes without camelCase false positives", () => {
    const analysis = analyze();
    const diagnostics = analysis.diagnostics;
    const codes = diagnostics.map((item) => item.code);

    expect(codes).toContain("MISSING_CSS_MODULE_CLASS");
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_CSS_MODULE_CLASS",
          file: "src/Button.tsx",
          symbol: "absent",
        }),
        expect.objectContaining({
          code: "UNUSED_CSS_MODULE_CLASS",
          file: "src/Button.module.css",
          symbol: ".unused",
        }),
      ])
    );

    expect(diagnostics.some((item) => item.symbol.includes("iconButton"))).toBe(false);
    expect(
      diagnostics.some(
        (item) => item.code === "MISSING_CSS_MODULE_CLASS" && item.symbol === "iconButton"
      )
    ).toBe(false);
    expect(
      diagnostics.some(
        (item) => item.code === "UNUSED_CSS_MODULE_CLASS" && item.symbol === ".icon-button"
      )
    ).toBe(false);
    expect(
      diagnostics.some(
        (item) => item.code === "UNUSED_CSS_MODULE_CLASS" && item.symbol === ".composedBase"
      )
    ).toBe(false);
  });

  it("detects values, variables, cycles, inert declarations, and duplicates", () => {
    const analysis = analyze(["extra/problem.css", "extra/specificity.css"]);
    const byCode = (code: string) => analysis.diagnostics.filter((item) => item.code === code);

    expect(byCode("UNDEFINED_CSS_VAR")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "--missing", file: "extra/problem.css" }),
      ])
    );
    expect(byCode("CYCLIC_CSS_VAR").length).toBeGreaterThan(0);
    expect(byCode("INERT_DECLARATION")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: ".broken", message: expect.stringContaining("'width'") }),
      ])
    );
    expect(byCode("DUPLICATE_PROPERTY")).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: ".duplicate" })])
    );
    expect(
      byCode("DUPLICATE_PROPERTY").some((item) => item.symbol === ".fallback")
    ).toBe(false);
    expect(byCode("CSS_SYNTAX_OR_VALUE_ERROR")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: ".invalid",
          message: expect.stringContaining("'color'"),
        }),
      ])
    );
    expect(
      byCode("CSS_SYNTAX_OR_VALUE_ERROR").some((item) => item.symbol === ".modern")
    ).toBe(false);

    // Selector lists are expanded, so specificity is computed per selector
    // rather than only for the first item in the list.
    const first = analysis.rules.find((rule) => rule.selector === ".first");
    const second = analysis.rules.find((rule) => rule.selector === "#second");
    expect(first?.specificity).toEqual({ id: 0, class: 1, type: 0 });
    expect(second?.specificity).toEqual({ id: 1, class: 0, type: 0 });
  });

  it("does not treat keyframe stops as selectors and resolves nesting", () => {
    const analysis = analyze();
    expect(analysis.rules.some((rule) => rule.selector === "0%")).toBe(false);
    expect(analysis.rules.some((rule) => rule.selector === "100%")).toBe(false);
    expect(analysis.rules.some((rule) => rule.selector === ".card")).toBe(true);
    expect(analysis.rules.some((rule) => rule.selector === ".root:focus-visible")).toBe(true);
  });

  it("tracks :global() classes separately from local module classes", () => {
    const analysis = analyze();
    const rule = analysis.rules.find(
      (candidate) => candidate.selector === ":global(.external) .root"
    );
    expect(rule).toBeDefined();
    expect(rule?.classes).toEqual(
      expect.arrayContaining([
        { name: "external", isGlobal: true },
        { name: "root", isGlobal: false },
      ])
    );
  });

  it("computes specificity for selector lists, functional pseudo-classes, and nesting", () => {
    expect(specificityOfSelectorText(".a.b")).toEqual({ id: 0, class: 2, type: 0 });
    expect(specificityOfSelectorText("#header .a")).toEqual({ id: 1, class: 1, type: 0 });
    expect(specificityOfSelectorText("div::before")).toEqual({ id: 0, class: 0, type: 2 });
    expect(specificityOfSelectorText(":where(#x, .y)")).toEqual({ id: 0, class: 0, type: 0 });
    expect(specificityOfSelectorText(":is(.a, #b)")).toEqual({ id: 1, class: 0, type: 0 });
    expect(specificityOfSelectorText(":nth-child(2n of .a)")).toEqual({
      id: 0,
      class: 2,
      type: 0,
    });
  });

  it("resolves cascade layers with !important reversal and unlayered precedence", () => {
    const analysis = analyze();

    const normal = resolveCascade(analysis, ".winner");
    expect(normal.color?.every((entry) => entry.selector === ".winner")).toBe(true);
    expect(normal.color?.at(-1)?.value).toBe("blue");
    expect(normal.color?.at(-1)?.layer).toBeNull();

    const important = resolveCascade(analysis, ".winner-important");
    expect(important.color?.at(-1)?.value).toBe("red");
    expect(important.color?.at(-1)?.important).toBe(true);
    expect(important.color?.at(-1)?.layer).toBe("base");

    // Only the selector subject participates: `.subject .child` styles the
    // child, and `.subject::before` styles a pseudo-element.
    const subject = resolveCascade(analysis, ".subject");
    expect(subject.color?.every((entry) => entry.selector === ".subject")).toBe(true);
    expect(subject.color?.at(-1)?.value).toBe("black");
    expect(subject.content).toBeUndefined();

    const pseudo = resolveCascade(analysis, ".subject::before");
    expect(pseudo.content?.at(-1)?.value).toBe('"subject-marker"');
  });

  it("processes @import dependencies before the importing stylesheet", () => {
    const analysis = analyze(["extra/importer.css"]);
    expect(analysis.files).toEqual(
      expect.arrayContaining(["extra/importer.css", "extra/imported.css"])
    );
    expect(analysis.files.indexOf("extra/imported.css")).toBeLessThan(
      analysis.files.indexOf("extra/importer.css")
    );

    const cascade = resolveCascade(analysis, ".import-winner");
    expect(cascade.color?.at(-1)?.value).toBe("red");
  });

  it("allows explicit compiled CSS while skipping it by default", () => {
    const analysis = analyze(["src/dist/generated.css"]);
    expect(analysis.files).toContain("src/dist/generated.css");
  });

  it("can opt into generated CSS and global class auditing", () => {
    const withGenerated = analyze([], { includeGenerated: true });
    expect(withGenerated.files).toContain("src/dist/generated.css");

    const audited = analyze([], { auditGlobalClasses: true });
    const unused = audited.diagnostics.filter(
      (diagnostic) => diagnostic.code === "POSSIBLY_UNUSED_GLOBAL_CLASS"
    );
    expect(unused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: ".unused-global" }),
      ])
    );
    expect(unused.some((diagnostic) => diagnostic.symbol === ".used-global")).toBe(
      false
    );
    // `tone-*` is a partially dynamic template, so `.tone-warm` is potentially used.
    expect(unused.some((diagnostic) => diagnostic.symbol === ".tone-warm")).toBe(
      false
    );
    expect(unused.some((diagnostic) => diagnostic.symbol === ".label-class")).toBe(
      false
    );
    expect(unused.some((diagnostic) => diagnostic.symbol === ".slot-class")).toBe(
      false
    );
    expect(unused.some((diagnostic) => diagnostic.symbol === ".sm:hidden")).toBe(
      false
    );
    expect(resolveCssImpact(audited, ".sm:hidden").rules?.length).toBeGreaterThan(0);
  });

  it("reports custom-property definitions and consumers", () => {
    const analysis = analyze();
    const impact = resolveCssImpact(analysis, "--brand");
    expect(impact.kind).toBe("custom-property");
    expect(impact.definitions?.length).toBeGreaterThan(0);
    expect(impact.consumers?.length).toBeGreaterThan(0);
  });

  it("caches analysis until the indexer revision changes", () => {
    const indexer = new TsReactIndexer(fixture);
    const service = new CssAnalysisService(indexer);

    const first = service.analyze();
    expect(service.analyze()).toBe(first);

    indexer.notifyFilesChanged([path.join(indexer.root, "src/global.css")]);
    const second = service.analyze();
    expect(second).not.toBe(first);
  });
});

describe("CSS MCP tools", () => {
  it("registers and serves diagnostics, impact, and cascade", async () => {
    const indexer = new TsReactIndexer(fixture);
    const store = new DualCacheStore(indexer.root, indexer.projectId, {
      overrideDb: ":memory:",
    });
    const controller = new IndexController(indexer, store);
    const server = new McpServer({ name: "tsray-css-test", version: "0.0.0" });
    registerMcpTools(server, controller, store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "css-test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("css_diagnostics");
      expect(names).toContain("css_impact");
      expect(names).toContain("css_cascade");
      expect(names).toContain("css_runtime_check");

      const diagnostics = await client.callTool({
        name: "css_diagnostics",
        arguments: { extra_css_files: ["extra/problem.css"] },
      });
      const diagnosticsPayload = JSON.parse(textOf(diagnostics)) as {
        ok: boolean;
        error_count: number;
        diagnostics: Array<{ code: string }>;
      };
      expect(diagnosticsPayload.ok).toBe(false);
      expect(diagnosticsPayload.error_count).toBeGreaterThan(0);
      expect(diagnosticsPayload.diagnostics.map((item) => item.code)).toContain(
        "UNDEFINED_CSS_VAR"
      );

      const audit = await client.callTool({
        name: "css_diagnostics",
        arguments: { audit_global_classes: true },
      });
      const auditPayload = JSON.parse(textOf(audit)) as {
        possibly_unused_global_classes: number;
      };
      expect(auditPayload.possibly_unused_global_classes).toBeGreaterThan(0);

      const impact = await client.callTool({
        name: "css_impact",
        arguments: { symbol: "--brand" },
      });
      const impactPayload = JSON.parse(textOf(impact)) as {
        kind: string;
        definitions: unknown[];
      };
      expect(impactPayload.kind).toBe("custom-property");
      expect(impactPayload.definitions.length).toBeGreaterThan(0);

      const cascade = await client.callTool({
        name: "css_cascade",
        arguments: { selector_query: ".winner-important" },
      });
      const cascadePayload = JSON.parse(textOf(cascade)) as {
        properties: Record<string, Array<{ value: string; winner: boolean }>>;
      };
      const winner = cascadePayload.properties.color?.find((entry) => entry.winner);
      expect(winner?.value).toBe("red");
    } finally {
      await server.close();
      await client.close();
      await controller.stop();
      store.close();
    }
  }, 60_000);
});
