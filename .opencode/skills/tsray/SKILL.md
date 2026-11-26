---
name: tsray
description: Deterministic TypeScript/React semantic code intelligence via the TypeScript Compiler API. Use for TypeScript/React codebase navigation, architecture overview, symbol lookup, references, callers, React render/component/context graphs, interface implementations, change impact, untested complexity hotspots, dead code, test/typecheck/lint execution, and structured summary caching. Prefer these tools for known TypeScript symbols and React structures when the tsray MCP server is connected.
---

# tsray

In OpenCode, tools are named `tsray_<tool>` directly or live under `tools.tsray.*` in Code
Mode.

## Tool routing

1. **Prefer `tsray` for a known TypeScript identifier** (component, hook, context, function,
   method, class, interface, type, enum, variable). Vector search is probabilistic and can miss
   type aliases, barrel re-exports, and interface implementations; `tsray` is compiler-exact
   (`ts.LanguageService` + `ts.TypeChecker`).
2. **Use `get_codebase_map` or `get_module_overview` for project architecture.** The tool catalog
   below is the authoritative list of available tools.
3. **Use full-text search for non-TypeScript files** (SQL, YAML, Dockerfiles, Markdown, configs,
   Go, Rust) and conceptual discovery when no symbol name is known. Switch to `tsray` as soon as
   a TypeScript identifier is available.
4. **Use `rg` or direct file reads for literal strings, comments, error text, JSX copy, and exact
   lines immediately before editing.**
5. Respect explicit user instructions about tool selection; these defaults are not a prohibition
   on other search methods.

Examples:

- To inspect a component tree, use `lookup_symbol(query="Button")` followed by
  `get_component_tree(symbol_id=...)`.
- To find consumers of a context, use
  `get_references(symbol_id="sym:src/theme.tsx#ThemeContext")` and `get_impact_analysis(symbol_id=...)`.
- To explain a barrel dependency, use `explain_dependency(from="components", to="root")` and
  `get_dependency_graph`.

## Connection check

1. Call `project_info` (batch it with `get_codebase_map` for initial orientation).
2. If tools are missing, ask the user to register the stdio server:

   ```sh
   npm run build
   node dist/cli/index.js install-mcp --target opencode --yes
   node dist/cli/index.js install-skill --target opencode --yes
   opencode mcp list
   ```

   For Claude Code or another client, select the appropriate target or use:

   ```sh
   claude mcp add --scope user tsray -- node /absolute/path/to/tsray/dist/cli/index.js serve
   ```

3. Check `index_state`:
   - `ready`: use the snapshot.
   - `indexing`: retry shortly; the server may serve the last healthy snapshot.
   - `error`: inspect `current_prod_errors` for the latest working-tree errors and
     `prod_errors` for the snapshot being served. Production TypeScript errors keep the last
     healthy snapshot on disk; test-only errors are warnings.

`project_info` also reports tsconfig paths, workspace mode, TypeScript version, DB paths,
summary prompt version, and diagnostics. The default payload is compact. Use `verbose: true`
(or `compact: false`) for paginated project/config details; `project_filter`, `limit`, and
`offset` control the page. Verbose responses are capped at 12,000 characters and return
`tool_count` rather than the registered tool-name list.

## Tool catalog

| Tool | Parameters |
|---|---|
| `project_info` | `compact` (default true), `verbose`, `project_filter`, `limit` (default 20), `offset`, `max_chars`. Readiness, counts, DB paths, diagnostics; verbose mode paginates projects. |
| `get_codebase_map` | `format` (`md` default, `json`, `dot`, `mermaid`), `top_modules` (`0` = all), `offset`, `edge_limit`, `edge_offset`, `sort_by`, `detail`, `summary_only`, `max_chars`. |
| `get_module_overview` | `module` (required), `format`, `file_limit`, `file_offset`, `dependency_limit`, `dependency_offset`, `compact`, `max_chars`. |
| `get_dependency_graph` | `format`, `scope`, `root`, `depth`, `direction`, `max_nodes`, `node_offset`, `max_edges`, `edge_offset`, `rank_limit`, `max_chars`. |
| `explain_dependency` | `from`, `to`, `include_tests`, `limit`, `offset`, `symbol_limit`, `symbol_offset`, `max_chars`. |
| `lookup_symbol` | `query`, `limit`, `offset`, `compact`, `include_source` (default false), `source_chars`, `max_chars`. Returns a paginated `symbols` envelope. |
| `get_api_surface` | `module`, `kind`, `limit` (`0` = all remaining), `offset`, `compact`, `max_chars`. |
| `get_references` | `symbol_id` (or `symbolId`), `include_imports`, `limit`, `offset`, `compact`, `max_chars`. |
| `get_call_graph` | `symbol_id`, `depth`, `direction`, `max_nodes`, `node_offset`, `max_edges`, `edge_offset`, `max_chars`. |
| `get_component_tree` | `symbol_id`, `depth`, `direction`, `max_nodes`, `node_offset`, `max_edges`, `edge_offset`, `context_limit`, `context_offset`, `hook_limit`, `hook_offset`, `compact`, `max_chars`. |
| `find_implementations` | `symbol_id` optional, `limit`, `offset`, `implementation_limit`, `implementation_offset`, `max_chars`. |
| `get_impact_analysis` | `symbol_id`, `max_depth`, `direct_limit`, `direct_offset`, `impact_limit`, `impact_offset`, `compact`, `max_chars`. |
| `get_dead_code` | `include_exported`, `module`, `kind`, `group_by`, `limit`, `offset`, `max_chars`. |
| `get_hotspots` | `limit`, `offset`, `module`, `untested_only`, `min_complexity`, `sort_by`, `max_chars`. |
| `get_function_body` | `symbol_id`, `source_chars`, `compact`, `max_chars`. Source is explicit. |
| `list_stale_summaries` | `limit`, `offset`, `module`, `kind`, `max_chars`. Returns a paginated `symbols` envelope. |
| `get_summary_context` | `symbol_ids` (batched, max 25) or `symbol_id`, `include_source`, `source_chars`, `dependency_limit`, `dependency_offset`, `compact`, `max_chars`. Returns `{ total, returned, truncated, items }`. |
| `upsert_summaries` | `entries` array: `symbol_id`, `summary`, `expected_content_hash` (or self+dep hashes), `model_id`; `max_chars`. |
| `get_summary_coverage` | `module`, `compact` (default true), `max_chars`. |
| `run_tests` | `timeout_seconds`, `output_chars`, `max_chars`. |
| `run_typecheck` | `timeout_seconds`, `output_chars`, `max_chars`. |
| `run_lint` | `timeout_seconds`, `output_chars`, `max_chars`. |
| `reindex` | `full_diagnostics` (default true), `max_chars`. |

JSON fields are snake_case. Symbol arguments accept either `symbol_id` or `symbolId`.

## Response efficiency

- Start with compact defaults and small limits. Follow `next_offset` only when another page
  is actually needed.
- Every tool accepts `max_chars` (1,000–200,000). Truncated JSON contains
  `_response.truncated`, `_response.original_chars`, and `_response.max_chars`.
- Graph tools use `max_nodes` / `max_edges` plus `node_offset` / `edge_offset`.
- Source is opt-in for `lookup_symbol`; use `get_function_body` or
  `get_summary_context` when source is genuinely required. Bound it with `source_chars`.
- `run_tests`, `run_typecheck`, and `run_lint` keep the head and tail of each output stream;
  bound each stream with `output_chars`.
- Do not request `compact: false` unless the omitted metadata is needed.

## Canonical IDs

```text
sym:src/components/Button.tsx#Button
sym:src/components/Button.tsx:Widget#render
file:src/components/Button.tsx
```

IDs are line-independent. Use `lookup_symbol` when you do not know the canonical ID.

## Navigation & audit

- Architecture: `get_codebase_map`, `get_module_overview`, `get_dependency_graph`,
  `explain_dependency`.
- Find code: `lookup_symbol`.
- Understand calls: `get_references`, `get_call_graph`, `get_function_body`.
- React structure: `get_component_tree` (renders, HOC wrappers, hooks, providers/consumers).
- Contracts: `find_implementations` (nominal plus structural matches; check `via`).
- Change risk: `get_impact_analysis` before editing an exported symbol or context.
- Complexity gaps: `get_hotspots` with `untested_only: true`.
- Unused code: `get_dead_code`. Framework route files are exempted automatically.
- Public API: `get_api_surface`.

Before refactoring a symbol, run `lookup_symbol` -> `get_impact_analysis` (plus
`find_implementations` for interfaces/contracts) before reading or editing files.

## Summary workflow

The server never generates prose. The client generates summaries.

1. List candidates:
   ```json
   {"kind":"component","limit":25}
   ```
   via `list_stale_summaries`.
2. Fetch context:
   ```json
   {"symbol_ids":["sym:src/App.tsx#App"],"include_source":true}
   ```
   Responses return `{ total, returned, truncated, items }`. Each item includes the exact
   schema, hashes, staleness, previous summary, bounded source, and a paginated `dependencies`
   object (`items`, `total`, `offset`, `limit`, `next_offset`).
3. Build the summary using the returned schema. Do not add fields.
   Callable (component, hook, function, method):
   ```json
   {
     "intent": "Why this exists and its architectural role.",
     "side_effects": ["none"],
     "invariants": ["Label is rendered as-is"]
   }
   ```
   Type-like (interface, type, class, context, enum, variable):
   ```json
   {
     "intent": "Architectural responsibility.",
     "key_invariants": ["Single provider per tree"],
     "boundaries": ["client-only"]
   }
   ```
4. Upsert with hashes:
   ```json
   {
     "entries": [{
       "symbol_id": "sym:src/App.tsx#App",
       "summary": {"intent": "...", "side_effects": ["renders_children"], "invariants": []},
       "expected_content_hash": "...",
       "model_id": "your-model-id"
     }]
   }
   ```
5. Handle statuses:
   - `updated`: stored.
   - `hash_mismatch`: source or dependencies changed; re-fetch context.
   - `validation_error`: fix the schema.
   - `not_eligible`: test/story/generated symbols cannot be summarized.
   - `not_found`: symbol disappeared after a rebuild.
6. Check `get_summary_coverage` after batches.

## Staleness rules

- `synced`: exact content hash hit.
- `soft_stale`: code unchanged, dependencies changed; previous summary is reusable.
- `hard_stale`: the symbol changed; previous summary is only a baseline.
- `missing`: never summarized.
- `not_eligible`: do not summarize.

## Practical rules

- Do not edit source files to store summaries.
- Do not invent canonical IDs.
- Prefer `tsray` over shell tools for TypeScript/React structure; use shell tools for
  formatting, running arbitrary commands, and non-code files.
- Use `run_tests`, `run_typecheck`, and `run_lint` when available; they respect the project's
  package manager and scripts. These tools execute code and must only be used with trusted
  repositories and configurations.
- Prefer automatic incremental rebuilds. Call `reindex` after a branch switch or dependency
  upgrade.
- Generate the offline report with:
  ```sh
  tsray export html /path/to/project -o report.html
  ```
- CI gate:
  ```sh
  tsray diff main /path/to/project --fail-on cycles,breaking_api,untested_hotspots
  ```
