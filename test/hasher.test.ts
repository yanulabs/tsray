import { describe, expect, it } from "vitest";
import {
  computeGraphHashes,
  findDirectedCycles,
  sha256,
  stableStringify,
} from "../src/index/hasher.js";
import type { EdgeRecord, SymbolRecord } from "../src/index/types.js";

function symbol(id: string, selfHash: string): SymbolRecord {
  return {
    id,
    name: id,
    kind: "function",
    module: "root",
    file: `${id}.ts`,
    line: 1,
    endLine: 2,
    loc: 2,
    members: 0,
    parentId: null,
    exported: false,
    defaultExport: false,
    isTest: false,
    isGenerated: false,
    isEntrypoint: false,
    directive: null,
    complexity: 1,
    propsType: null,
    signature: "() => void",
    doc: "",
    sigHash: "",
    selfHash,
    depHash: "",
    contentHash: "",
    eligible: true,
    sourcePreview: "",
  };
}

function edge(fromId: string, toId: string): EdgeRecord {
  return { fromId, toId, kind: "calls", file: `${fromId}.ts`, line: 1 };
}

describe("semantic hashes", () => {
  it("makes callers depend on callees", () => {
    const a = symbol("a", "self-a");
    const b = symbol("b", "self-b");
    const symbols = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    computeGraphHashes(symbols, [edge("a", "b")]);
    const firstA = a.contentHash;
    const firstB = b.contentHash;

    b.selfHash = "self-b2";
    computeGraphHashes(symbols, [edge("a", "b")]);
    expect(b.contentHash).not.toBe(firstB);
    expect(a.contentHash).not.toBe(firstA);
    expect(a.depHash).not.toBe(sha256("dep:v1:"));
  });

  it("terminates on cycles and gives every member the same dependency digest", () => {
    const a = symbol("a", "self-a");
    const b = symbol("b", "self-b");
    const symbols = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    computeGraphHashes(symbols, [edge("a", "b"), edge("b", "a")]);
    expect(a.depHash).toBe(b.depHash);
    expect(a.contentHash).toBe(sha256(`content:v1:${a.selfHash}:${a.depHash}`));
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("finds directed cycles and sorts them stably", () => {
    const cycles = findDirectedCycles(
      ["c", "b", "a", "d"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["d", "a"],
      ]
    );
    expect(cycles).toEqual([["a", "b", "c"]]);
  });
});

describe("stable stringify", () => {
  it("sorts object keys recursively", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}'
    );
  });
});
