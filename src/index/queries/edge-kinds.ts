export const REFERENCE_EDGE_KINDS = new Set([
  "calls",
  "renders",
  "wraps",
  "uses_hook",
  "provides_context",
  "consumes_context",
  "implements",
  "references",
]);

export const REACT_EDGE_KINDS = new Set([
  "renders",
  "wraps",
  "uses_hook",
  "provides_context",
  "consumes_context",
]);

export const CALL_EDGE_KINDS = new Set(["calls", "renders", "uses_hook", "wraps"]);
