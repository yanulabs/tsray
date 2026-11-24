import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SymbolRecord } from "../index/types.js";

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  truncated: boolean;
}

export function paginate<T>(items: readonly T[], offset = 0, limit = 50): Page<T> {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : items.length;
  const selected = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: selected,
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    next_offset: safeOffset + selected.length < items.length ? safeOffset + selected.length : null,
    truncated: safeOffset + selected.length < items.length,
  };
}

export function compactSymbol(
  symbol: SymbolRecord,
  syncState = "missing"
): Record<string, unknown> {
  const signature =
    symbol.signature.length > 300
      ? { text: `${symbol.signature.slice(0, 297)}…`, truncated: true }
      : { text: symbol.signature, truncated: false };
  return {
    id: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    module: symbol.module,
    file: symbol.file,
    line: symbol.line,
    exported: symbol.exported,
    default_export: symbol.defaultExport,
    is_entrypoint: symbol.isEntrypoint,
    is_test: symbol.isTest,
    eligible: symbol.eligible,
    sync_state: syncState,
    signature: signature.text,
    signature_truncated: signature.truncated,
    content_hash: symbol.contentHash,
  };
}

export function compactEdge(edge: {
  from?: string;
  to?: string;
  from_id?: string;
  to_id?: string;
  fromId?: string;
  toId?: string;
  kind: string;
  file: string;
  line: number;
  via?: string;
}): Record<string, unknown> {
  return {
    from: edge.from ?? edge.from_id ?? edge.fromId,
    to: edge.to ?? edge.to_id ?? edge.toId,
    kind: edge.kind,
    file: edge.file,
    line: edge.line,
    ...(edge.via ? { via: edge.via } : {}),
  };
}

export function truncateText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean; originalChars: number } {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  const budget = Math.max(0, Math.trunc(maxChars));
  if (budget === 0) return { text: "", truncated: true, originalChars: text.length };
  const suffix = `\n… [truncated; original ${text.length} characters]`;
  if (suffix.length >= budget) return { text: "…", truncated: true, originalChars: text.length };
  return {
    text: `${text.slice(0, budget - suffix.length)}${suffix}`,
    truncated: true,
    originalChars: text.length,
  };
}

/** Keep both the beginning and end of command output, where failures usually appear. */
export function truncateLog(
  text: string,
  maxChars: number
): { text: string; truncated: boolean; originalChars: number } {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  const budget = Math.max(0, Math.trunc(maxChars));
  if (budget === 0) return { text: "", truncated: true, originalChars: text.length };
  const marker = "\n… [middle truncated]…\n";
  if (marker.length >= budget) return { text: "…", truncated: true, originalChars: text.length };
  const available = budget - marker.length;
  const headChars = Math.floor(available * 0.7);
  const tailChars = available - headChars;
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`,
    truncated: true,
    originalChars: text.length,
  };
}

export function applyJsonBudget(
  value: unknown,
  maxChars: number
): { value: unknown; truncated: boolean; originalChars: number } {
  const original = JSON.stringify(value, null, 2);
  if (original === undefined) return { value: null, truncated: false, originalChars: 0 };
  if (!Number.isFinite(maxChars) || original.length <= maxChars) {
    return { value, truncated: false, originalChars: original.length };
  }

  const budget = Math.max(0, Math.trunc(maxChars));
  const cloned = JSON.parse(original) as unknown;
  const paths = new Set<string>();
  const metadata = {
    truncated: true,
    original_chars: original.length,
    max_chars: budget,
    truncated_paths: [] as string[],
  };

  const attachMetadata = (): void => {
    if (isRecord(cloned)) cloned._response = metadata;
  };
  attachMetadata();

  for (let iteration = 0; iteration < 80; iteration++) {
    const serialized = JSON.stringify(cloned, null, 2);
    if (serialized.length <= budget) {
      return { value: cloned, truncated: true, originalChars: original.length };
    }

    const arrays: Array<ArrayCandidate> = [];
    const strings: Array<{ value: string; path: string }> = [];
    collectCandidates(cloned, "", arrays, strings);

    const largestArray = arrays.sort((a, b) => b.value.length - a.value.length)[0];
    if (largestArray && largestArray.value.length > 1) {
      const remove = Math.max(1, Math.floor(largestArray.value.length / 2));
      largestArray.value.splice(largestArray.value.length - remove, remove);
      if (largestArray.parent && largestArray.key) {
        reconcileArrayPagination(
          largestArray.parent,
          largestArray.key,
          largestArray.path,
          largestArray.root
        );
      }
      addPath(paths, metadata.truncated_paths, largestArray.path);
      continue;
    }

    const longestString = strings.sort((a, b) => b.value.length - a.value.length)[0];
    if (longestString && longestString.value.length > 200) {
      const keep = Math.max(100, Math.floor(longestString.value.length / 2));
      setAtPath(cloned, longestString.path, `${longestString.value.slice(0, keep)}…`);
      addPath(paths, metadata.truncated_paths, longestString.path);
      continue;
    }

    break;
  }

  // A compact preview is the final fallback. Binary search accounts for JSON
  // escaping so the serialized response stays within the requested budget.
  const suffix = "\n… [response truncated]";
  const fallbackMetadata = {
    truncated: true,
    original_chars: original.length,
    max_chars: budget,
  };
  let low = 0;
  let high = original.length;
  let best = `${suffix}`;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const preview = `${original.slice(0, middle)}${suffix}`;
    const candidate = { _response: fallbackMetadata, preview };
    if (JSON.stringify(candidate, null, 2).length <= budget) {
      best = preview;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    value: { _response: fallbackMetadata, preview: best },
    truncated: true,
    originalChars: original.length,
  };
}

export function jsonToolResult(value: unknown, maxChars = Number.POSITIVE_INFINITY): CallToolResult {
  const budgeted = applyJsonBudget(value, maxChars);
  return { content: [{ type: "text", text: JSON.stringify(budgeted.value, null, 2) }] };
}

export function textToolResult(text: string, maxChars = Number.POSITIVE_INFINITY): CallToolResult {
  const budgeted = truncateText(text, maxChars);
  return { content: [{ type: "text", text: budgeted.text }] };
}

function addPath(paths: Set<string>, output: string[], path: string): void {
  if (paths.has(path) || output.length >= 20) return;
  paths.add(path);
  output.push(path);
}

interface ArrayCandidate {
  value: unknown[];
  path: string;
  parent?: Record<string, unknown>;
  key?: string;
  root?: Record<string, unknown>;
}

const PAGINATION_KEYS: Record<string, { offset: string; limit: string; next: string; total: string }> = {
  symbols: { offset: "offset", limit: "limit", next: "next_offset", total: "total" },
  file_imports: { offset: "offset", limit: "limit", next: "next_offset", total: "total_file_imports" },
  references: { offset: "offset", limit: "limit", next: "next_offset", total: "total" },
  interfaces: { offset: "offset", limit: "limit", next: "next_offset", total: "total" },
  hotspots: { offset: "offset", limit: "limit", next: "next_offset", total: "total" },
  modules: { offset: "offset", limit: "limit", next: "next_offset", total: "total_modules" },
  module_edges: { offset: "edge_offset", limit: "edge_limit", next: "next_edge_offset", total: "total_module_edges" },
  files: { offset: "file_offset", limit: "file_limit", next: "next_file_offset", total: "total_files" },
  dependencies: { offset: "dependency_offset", limit: "dependency_limit", next: "next_dependency_offset", total: "total_dependencies" },
  nodes: { offset: "node_offset", limit: "node_limit", next: "next_node_offset", total: "total_nodes" },
  edges: { offset: "edge_offset", limit: "edge_limit", next: "next_edge_offset", total: "page_total_edges" },
  implementations: {
    offset: "implementation_offset",
    limit: "implementation_limit",
    next: "next_implementation_offset",
    total: "total_implementations",
  },
  direct_references: {
    offset: "direct_offset",
    limit: "direct_limit",
    next: "next_direct_offset",
    total: "direct_references_count",
  },
  contexts: { offset: "context_offset", limit: "context_limit", next: "next_context_offset", total: "total_contexts" },
  hooks: { offset: "hook_offset", limit: "hook_limit", next: "next_hook_offset", total: "total_hooks" },
  items: { offset: "offset", limit: "limit", next: "next_offset", total: "total" },
};

function reconcileArrayPagination(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  root?: Record<string, unknown>
): void {
  if (path.startsWith("groups.") && root) {
    reconcileGroupedPagination(root);
    return;
  }
  if (
    (key === "symbols" || key === "symbol_edges") &&
    "symbol_offset" in parent &&
    "next_symbol_offset" in parent
  ) {
    const offsetValue = parent.symbol_offset;
    const offset = typeof offsetValue === "number" ? offsetValue : 0;
    let next: number | null = null;
    for (const [collection, totalKey, truncatedKey] of [
      ["symbols", "total_symbols", "symbols_truncated"],
      ["symbol_edges", "total_symbol_edges", "symbol_edges_truncated"],
    ] as const) {
      const totalValue = parent[totalKey];
      const total = typeof totalValue === "number" ? totalValue : undefined;
      const length = Array.isArray(parent[collection]) ? parent[collection].length : 0;
      if (total !== undefined && offset + length < total) {
        const candidate = offset + length;
        next = next === null ? candidate : Math.min(next, candidate);
      }
      if (collection === key && typeof parent[truncatedKey] === "boolean") {
        parent[truncatedKey] = true;
      }
    }
    parent.next_symbol_offset = next;
    return;
  }
  if (key === "direct_references" && typeof parent.impact_truncated === "boolean") {
    parent.impact_truncated = true;
  }
  if (key === "items" && typeof parent.returned === "number" && !("offset" in parent)) {
    parent.returned = Array.isArray(parent.items) ? parent.items.length : 0;
    parent.truncated = true;
    return;
  }
  if (key.startsWith("impacted_")) {
    reconcileImpactPagination(parent);
    return;
  }
  if (key === "contexts" && typeof parent.contexts_truncated === "boolean") {
    parent.contexts_truncated = true;
  }
  if (key === "hooks" && typeof parent.hooks_truncated === "boolean") {
    parent.hooks_truncated = true;
  }
  const layout = PAGINATION_KEYS[key];
  if (!layout || !(layout.next in parent)) return;
  const offsetValue = parent[layout.offset];
  const offset = typeof offsetValue === "number" ? offsetValue : 0;
  const totalValue = parent[layout.total];
  const total = typeof totalValue === "number" ? totalValue : undefined;
  const length = Array.isArray(parent[key]) ? parent[key].length : 0;
  if (total !== undefined) {
    parent[layout.next] = offset + length < total ? offset + length : null;
  }
  if (typeof parent.truncated === "boolean") parent.truncated = true;
}

function reconcileGroupedPagination(root: Record<string, unknown>): void {
  const groups = isRecord(root.groups) ? root.groups : {};
  const returned = Object.values(groups).reduce<number>(
    (total, group) => total + (Array.isArray(group) ? group.length : 0),
    0
  );
  const offsetValue = root.offset;
  const offset = typeof offsetValue === "number" ? offsetValue : 0;
  const totalValue = root.total;
  const total = typeof totalValue === "number" ? totalValue : returned;
  root.next_offset = offset + returned < total ? offset + returned : null;
  root.truncated = true;
}

function reconcileImpactPagination(parent: Record<string, unknown>): void {
  const offset = typeof parent.impact_offset === "number" ? parent.impact_offset : 0;
  let next: number | null = null;
  for (const key of [
    "impacted_components",
    "impacted_hooks",
    "impacted_callers",
    "impacted_files",
    "impacted_modules",
    "impacted_test_files",
  ]) {
    const totalKey = `total_${key}`;
    const total = parent[totalKey];
    const length = Array.isArray(parent[key]) ? parent[key].length : 0;
    if (typeof total !== "number" || offset + length >= total) continue;
    const candidate = offset + length;
    next = next === null ? candidate : Math.min(next, candidate);
  }
  parent.next_impact_offset = next;
  parent.impact_truncated = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectCandidates(
  value: unknown,
  path: string,
  arrays: Array<ArrayCandidate>,
  strings: Array<{ value: string; path: string }>,
  parent?: Record<string, unknown>,
  key?: string,
  root?: Record<string, unknown>
): void {
  if (Array.isArray(value)) {
    if (path !== "_response.truncated_paths") arrays.push({ value, path, parent, key, root });
    for (let index = 0; index < value.length; index++) {
      collectCandidates(value[index], `${path}[${index}]`, arrays, strings, undefined, undefined, root);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "_response") continue;
      collectCandidates(
        child,
        path ? `${path}.${childKey}` : childKey,
        arrays,
        strings,
        value,
        childKey,
        root ?? value
      );
    }
    return;
  }
  if (typeof value === "string" && path !== "_response.preview") {
    strings.push({ value, path });
  }
}

function setAtPath(root: unknown, path: string, value: string): void {
  const tokens = path.match(/[^.[\]]+/g);
  if (!tokens || tokens.length === 0) return;
  let current: unknown = root;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (Array.isArray(current)) current = current[Number(tokens[index])];
    else if (isRecord(current)) current = current[tokens[index]!];
    else return;
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(current)) current[Number(last)] = value;
  else if (isRecord(current)) current[last] = value;
}
