import { describe, expect, it } from "vitest";
import {
  applyJsonBudget,
  compactSymbol,
  jsonToolResult,
  paginate,
  textToolResult,
  truncateLog,
  truncateText,
} from "../src/tools/response.js";
import type { SymbolRecord } from "../src/index/types.js";

function symbol(overrides: Partial<SymbolRecord> = {}): SymbolRecord {
  return {
    id: "sym:src/App.tsx#App",
    name: "App",
    kind: "component",
    module: "root",
    file: "src/App.tsx",
    line: 1,
    endLine: 10,
    loc: 10,
    members: 0,
    parentId: null,
    exported: true,
    defaultExport: false,
    isTest: false,
    isGenerated: false,
    isEntrypoint: true,
    directive: null,
    complexity: 2,
    propsType: null,
    signature: "(): Element",
    doc: "",
    sigHash: "sig",
    selfHash: "self",
    depHash: "dep",
    contentHash: "content",
    eligible: true,
    sourcePreview: "export function App() { return <main />; }",
    ...overrides,
  };
}

describe("agent response controls", () => {
  it("paginates with stable totals and cursors", () => {
    const first = paginate(["a", "b", "c"], 0, 2);
    expect(first).toEqual({
      items: ["a", "b"],
      total: 3,
      offset: 0,
      limit: 2,
      next_offset: 2,
      truncated: true,
    });
    expect(paginate(["a", "b", "c"], 2, 2)).toMatchObject({
      items: ["c"],
      next_offset: null,
      truncated: false,
    });
    expect(paginate(["a", "b", "c"], 10, 2)).toMatchObject({
      items: [],
      offset: 10,
      next_offset: null,
      truncated: false,
    });
  });

  it("keeps compact symbols useful without source or heavyweight metadata", () => {
    const compact = compactSymbol(symbol({ signature: "x".repeat(500) }), "synced");
    expect(compact).toMatchObject({
      id: "sym:src/App.tsx#App",
      kind: "component",
      sync_state: "synced",
      signature_truncated: true,
      content_hash: "content",
    });
    expect(compact).not.toHaveProperty("source_preview");
    expect(compact).not.toHaveProperty("doc");
    expect(compact).not.toHaveProperty("self_hash");
  });

  it("truncates text within the exact character budget", () => {
    const result = truncateText("abcdefghij", 8);
    expect(result.text.length).toBeLessThanOrEqual(8);
    expect(result).toMatchObject({ truncated: true, originalChars: 10 });
    expect(truncateText("short", 8)).toEqual({ text: "short", truncated: false, originalChars: 5 });
    expect(truncateText("abcdef", 0)).toEqual({ text: "", truncated: true, originalChars: 6 });
  });

  it("keeps both ends of command output", () => {
    const result = truncateLog(`HEAD${"x".repeat(1000)}TAIL`, 100);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text.startsWith("HEAD")).toBe(true);
    expect(result.text.endsWith("TAIL")).toBe(true);
    expect(result).toMatchObject({ truncated: true, originalChars: 1008 });
  });

  it("budgets JSON by trimming arrays and long strings with explicit metadata", () => {
    const value = {
      items: Array.from({ length: 100 }, (_, index) => ({ id: index, text: "x".repeat(500) })),
      label: "y".repeat(2000),
    };
    const result = applyJsonBudget(value, 1500);
    const serialized = JSON.stringify(result.value, null, 2);
    expect(result.truncated).toBe(true);
    expect(serialized.length).toBeLessThanOrEqual(1500);
    expect(result.value).toMatchObject({
      _response: { truncated: true, original_chars: expect.any(Number), max_chars: 1500 },
    });
    expect(value.items).toHaveLength(100);
  });

  it("uses a bounded preview when many small fields cannot be trimmed enough", () => {
    const value = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, "x".repeat(30)])
    );
    const result = applyJsonBudget(value, 1000);
    const serialized = JSON.stringify(result.value, null, 2);
    expect(serialized.length).toBeLessThanOrEqual(1000);
    expect(result.value).toHaveProperty("preview");
  });

  it("keeps pagination cursors aligned when a hard budget trims the current page", () => {
    const value = {
      total: 20,
      offset: 0,
      limit: 20,
      next_offset: null,
      truncated: false,
      symbols: Array.from({ length: 20 }, (_, index) => ({
        id: `sym:${index}`,
        text: "x".repeat(300),
      })),
    };
    const result = applyJsonBudget(value, 1800);
    const budgeted = result.value as typeof value;
    expect(budgeted.symbols.length).toBeLessThan(20);
    expect(budgeted.total).toBe(20);
    expect(budgeted.next_offset).toBe(budgeted.symbols.length);
    expect(budgeted.truncated).toBe(true);
    expect(JSON.stringify(result.value, null, 2).length).toBeLessThanOrEqual(1800);
  });

  it("keeps nested dependency cursors aligned with returned items", () => {
    const value = {
      items: [
        {
          returned: 1,
          truncated: false,
          dependencies: {
            total: 12,
            offset: 4,
            limit: 8,
            next_offset: null,
            truncated: false,
            items: Array.from({ length: 8 }, (_, index) => ({
              id: `dep:${index}`,
              text: "x".repeat(300),
            })),
          },
        },
      ],
    };
    const result = applyJsonBudget(value, 1800);
    const budgeted = result.value as typeof value;
    const dependencies = budgeted.items[0]!.dependencies;
    expect(dependencies.items.length).toBeLessThan(8);
    expect(dependencies.next_offset).toBe(4 + dependencies.items.length);
    expect(dependencies.truncated).toBe(true);
    expect(JSON.stringify(result.value, null, 2).length).toBeLessThanOrEqual(1800);
  });

  it("keeps grouped and symbol-explanation cursors aligned after budget trimming", () => {
    const grouped = applyJsonBudget(
      {
        total: 12,
        offset: 0,
        limit: 12,
        next_offset: null,
        truncated: false,
        groups: {
          root: Array.from({ length: 8 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
          tools: Array.from({ length: 4 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
        },
      },
      1800
    ).value as Record<string, unknown>;
    const groups = grouped.groups as Record<string, unknown[]>;
    const returned = Object.values(groups).reduce((total, items) => total + items.length, 0);
    expect(grouped.next_offset).toBe(returned);
    expect(grouped.truncated).toBe(true);

    const explanation = applyJsonBudget(
      {
        total_file_imports: 10,
        offset: 2,
        limit: 8,
        next_offset: null,
        file_imports: Array.from({ length: 8 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
        total_symbol_edges: 10,
        symbol_offset: 2,
        symbol_limit: 8,
        next_symbol_offset: null,
        symbol_edges: Array.from({ length: 8 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
        symbol_edges_truncated: false,
        total_symbols: 10,
        symbols_truncated: false,
        symbols: Array.from({ length: 8 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
      },
      1800
    ).value as Record<string, unknown>;
    const symbols = explanation.symbols as unknown[];
    const symbolEdges = explanation.symbol_edges as unknown[];
    const fileImports = explanation.file_imports as unknown[];
    expect(explanation.next_symbol_offset).toBe(2 + Math.min(symbols.length, symbolEdges.length));
    expect(explanation.next_offset).toBe(2 + fileImports.length);
    expect(explanation.symbols_truncated).toBe(true);
    expect(explanation.symbol_edges_truncated).toBe(true);
  });

  it("keeps React context and hook cursors aligned after budget trimming", () => {
    const result = applyJsonBudget(
      {
        total_contexts: 8,
        context_offset: 0,
        context_limit: 8,
        next_context_offset: null,
        contexts_truncated: false,
        contexts: Array.from({ length: 8 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
        total_hooks: 6,
        hook_offset: 2,
        hook_limit: 4,
        next_hook_offset: null,
        hooks_truncated: false,
        hooks: Array.from({ length: 4 }, (_, index) => ({ id: index, text: "x".repeat(300) })),
        truncated: false,
      },
      1800
    ).value as Record<string, unknown>;
    const contexts = result.contexts as unknown[];
    const hooks = result.hooks as unknown[];
    expect(result.next_context_offset).toBe(contexts.length);
    expect(result.next_hook_offset).toBe(2 + hooks.length);
    expect(result.contexts_truncated).toBe(true);
    expect(result.hooks_truncated).toBe(true);
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(1800);
  });

  it("returns MCP text content that respects JSON and text budgets", () => {
    const json = jsonToolResult({ values: Array.from({ length: 100 }, () => "x".repeat(100)) }, 1000);
    expect(json.content[0]).toMatchObject({ type: "text" });
    expect((json.content[0] as { text: string }).text.length).toBeLessThanOrEqual(1000);

    const text = textToolResult("a".repeat(5000), 1000);
    expect((text.content[0] as { text: string }).text.length).toBeLessThanOrEqual(1000);
  });
});
