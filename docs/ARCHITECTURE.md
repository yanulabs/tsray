# Architecture

`tsray` is a semantic indexer plus four consumers of the same snapshot: MCP tools, the
offline report, CLI exports, and the architectural diff. This document describes the data
flow and the deliberate differences from the Go implementation (`goray`).

## Data flow

```text
tsconfig.json / project references / workspace
                │
                ▼
     ts.LanguageService (incremental ScriptVersion map)
                │
                ▼
        ts.Program + ts.TypeChecker
                │
     ┌──────────┼───────────────┐
     ▼          ▼               ▼
 symbols      edges       diagnostics
 React/TS      calls/renders  prod vs test
     │          │
     └────┬─────┘
          ▼
   semantic hash chain (SCC-safe)
          │
          ├── worktree SQLite snapshot
          ├── summary SQLite cache (content-addressed)
          ├── MCP tools
          ├── Markdown / DOT / Mermaid / JSON
          └── single-file React report
```

The index snapshot is treated as immutable after `buildIndex()` returns. Derived query
indexes (incoming/outgoing adjacency, fan-in, test reachability, module rollups) are cached
in a `WeakMap` keyed by the snapshot, so MCP calls reuse them until the snapshot changes.

CSS analysis is a separate on-demand layer. It asks the indexer for project compiler options
and builds a short-lived `ts.Program` to extract CSS Module imports and `className` bindings,
then parses imported `.css` files with `css-tree`. It never mutates the TypeScript snapshot or
the working SQLite database. The service caches one result keyed by the indexer revision and
the requested `extra_css_files`; watched `.css` files bump that revision even when the
TypeScript graph digest is unchanged. Build outputs (`dist`, `build`, `generated`, and
`node_modules`) are skipped by default and can be analyzed explicitly through
`extra_css_files` or `include_generated: true`. Tailwind files contribute their plain CSS
rules and `@theme` tokens; generated utilities require compiled CSS or the Playwright runtime
check. The opt-in global-class audit uses static `className`, helper, template-prefix, and DOM
`classList` signals and reports warnings rather than hard failures.

## Source modules

| Module | Responsibility |
| --- | --- |
| `src/util/paths.ts` | tsconfig/workspace discovery, project metadata, module grouping, package entrypoints |
| `src/util/glob.ts` | Entrypoint/test/exclude glob matching, built-in framework patterns |
| `src/util/source.ts` | Directives, cyclomatic complexity, JSDoc, JSX detection, exports |
| `src/index/types.ts` | Domain model, canonical ID shapes, auxiliary analysis project metadata |
| `src/css/` | On-demand CSS/CSS Modules AST, TypeScript className bindings, cascade, diagnostics, optional Playwright runtime checks |
| `src/index/hasher.ts` | Normalized AST printing, direct hashes, iterative SCC decomposition |
| `src/index/indexer.ts` | Index orchestration facade; project loading, cache/worker coordination, incremental invalidation |
| `src/index/indexer/` | Project symbol/edge pass, cache hashing, symbol classification, shared types |
| `src/index/queries.ts` | Query facade re-exporting graph/module/symbol/audit/impact domains |
| `src/index/queries/` | Graph index, modules, symbols, call/component graphs, implementations, audit, impact |
| `src/index/watch.ts` | chokidar debounce, selective invalidation, last-healthy snapshot |
| `src/cache/summary.ts` | Zod validation of client-generated summaries |
| `src/cache/store.ts` | Cache facade re-exporting working/summary stores, paths, schemas |
| `src/cache/store/` | Dual SQLite store, working/summary databases, staleness, coverage, read-only cache, prune/remove |
| `src/render/exporters.ts` | Export facade re-exporting payload, Markdown, graph, JSON, and HTML modules |
| `src/render/exporters/` | Report payload and Markdown/DOT/Mermaid/HTML/JSON output |
| `src/mcp/server.ts` | MCP stdio transport, HTTP API, port fallback, live HTML |
| `src/tools/tools.ts` | MCP composition root; wires domain modules to one server |
| `src/tools/domains/` | Project, architecture, symbol, React, audit, summary, command, CSS, and maintenance tool domains |
| `src/tools/shared/` | Registration context, schemas, argument parsing, result helpers, symbol resolution, and shared projections |
| `src/tools/response.ts` | Bounded JSON/text response budgets and pagination helpers |
| `src/tools/runner.ts` | package-manager/script/test/lint/typecheck detection |
| `src/cli/index.ts` | CLI parsing and command dispatch |
| `src/cli/commands/` | serve/index/export/diff/db/integration command handlers |
| `src/cli/diff.ts` | Diff facade re-exporting worktree snapshot, execution, and Markdown rendering |
| `src/cli/diff/` | Detached worktree preparation, snapshot comparison, and CI gates |
| `src/cli/integration.ts` | MCP/skill target selection and command orchestration |
| `src/integration/config.ts` | Atomic JSON/TOML MCP config editing and validation |
| `src/integration/clients.ts` | Client config paths, format inference, and detection |
| `src/integration/skills.ts` | Skill copy/link/status/removal |
| `web/` | React 19 report UI, built into `web/dist/report.html` |

## Mapping from goray

| `goray` (Go) | `tsray` (TypeScript) |
| --- | --- |
| `go/packages` + `go/types` | `ts.LanguageService` + `ts.TypeChecker` |
| `go.mod` / `go.work` | `tsconfig.json` / `references` / workspace roots |
| Build tags | Per-project tsconfig + export conditions |
| `types.Implements` | `TypeChecker.isTypeAssignableTo` (structural) |
| Pure-Go SQLite | `node:sqlite` `DatabaseSync` |
| `fsnotify` | chokidar + 200 ms debounce + versioned snapshots |
| `internal/mcp` JSON-RPC | `@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport` |
| `go:embed` report | gzip+base64 embedded Vite single-file template |
| `go test` / `golangci-lint` | Detected package scripts, vitest/jest, tsc, eslint/biome |
| `make install-mcp` + Python helper | TypeScript integration CLI + Makefile/npm wrappers |

## TypeScript project loading

`resolveProject()` finds the nearest `tsconfig.json` or workspace root. `TsReactIndexer`
then:

1. Reads every relevant tsconfig with `ts.readConfigFile` and
   `ts.parseJsonConfigFileContent`.
2. Follows project references recursively and discovers workspace package configs.
3. Assigns each source file to the broadest applicable project root and creates a separate
   `LanguageService` for each owned project. Project references and workspace metadata remain
   available for cross-package type resolution.
4. Deduplicates source files, excludes `node_modules`, declaration files, and build output.
5. Uses custom LanguageService hosts that cache `ScriptSnapshot`s by per-file version. Full
   multi-project indexes may distribute uncached projects across worker threads.

`notifyFilesChanged()` canonicalizes paths (important for `/var` vs `/private/var` on macOS),
bumps versions, adds or removes files from the program, invalidates snapshots, and marks
direct importers for incremental diagnostics.

### Incremental diagnostics

The CLI/export/reindex paths request `fullDiagnostics: true`. Watch rebuilds use cached
diagnostics for unchanged files and only ask the program for syntactic/semantic diagnostics
on changed files and their direct importers. Option and global diagnostics are always
recomputed.

### Healthy snapshots

A snapshot with production TypeScript errors is returned to callers for inspection but is
never written over a healthy working database. Test/story diagnostics are warnings.
`IndexController.status()` separates the latest attempt (`prod_errors`, `warnings`,
`index_state`) from the snapshot being served (`served_indexed_at`, `served_prod_errors`), so
MCP clients can report a broken working tree while still querying the last good graph.

## Symbol extraction

Top-level declarations become symbols:

- functions and arrow/function-expression variables (classified as component, hook, or
  function);
- React wrappers (`memo`, `forwardRef`, `lazy`) with an unwrapped inner symbol and a `wraps`
  edge;
- `createContext` variables;
- classes (React class components when they extend `Component`/`PureComponent`) and methods;
- interfaces, type aliases, enums, and exported variables.

Anonymous default exports use the Pascal-cased file name (`page.tsx` → `Page`), which keeps
Next.js route components addressable. Export assignments and export specifiers are resolved
after the declaration pass, so `export default App` and `export { Button as default }` point
at the canonical declaration.

### Canonical IDs

```text
sym:<repo-relative-file>#<name>
sym:<repo-relative-file>:<Class>#<method>
file:<repo-relative-file>
```

Line numbers are payload metadata only, never identity.

### Hashing

`normalizeNodeText` uses the TypeScript printer with comments removed, then collapses
whitespace. The hash chain is:

```text
sig_hash     = sha256("sig:v1:" + signature)
self_hash    = sha256("self:v1:" + directive + ":" + sig_hash + ":" + body)
dep_hash     = sha256("dep:v1:" + SCC digest + sorted dependency content hashes)
content_hash = sha256("content:v1:" + self_hash + ":" + dep_hash)
```

Tarjan's SCC decomposition is implemented iteratively to avoid stack overflows on large
graphs. Components are emitted dependency-first. Every member of a cycle shares the SCC's
canonical digest, which makes recursive React trees and circular imports stable.

## React graph extraction

A plain call graph is insufficient for React. The visitor emits:

- `renders` — uppercase JSX tags, property-access tags, `React.createElement`;
- `wraps` — `memo`/`forwardRef`/`lazy` targets, including `lazy(() => import(...))`;
- `uses_hook` — resolved calls whose target kind is `hook`;
- `provides_context` — `<Ctx.Provider>` and React 19 `<Ctx>`;
- `consumes_context` — `useContext`, `use`, and `<Ctx.Consumer>`;
- `implements` — class heritage plus `checker.isTypeAssignableTo` over interfaces ×
  class/type candidates;
- `references` — checked identifier/type references not already described by a stronger edge;
- `imports` — file node → target declaration, useful for module explanations;
- `re_exports` — barrel re-export declarations.

When a file node is the caller (module top-level code), the edge source is
`file:<relative-path>`. Upward queries simply start from a symbol.

Weak `references` edges are dropped when a stronger edge exists for the same source, target,
file, and line. This avoids double-counting a hook call as both `uses_hook` and `references`.

### Barrel unwrapping

`resolveSymbolTarget()` calls `checker.getAliasedSymbol()` before consulting the
declaration→canonical-ID map. Imports and references therefore resolve through:

- barrel `index.ts` re-exports;
- `export * from`;
- `export { X as default }`;
- path aliases and workspace package names.

The dependency graph never collapses onto the barrel file.

### Structural implementations

`TypeChecker.isTypeAssignableTo(candidate, iface)` is evaluated for every interface against
class/type-alias candidates. Matches are recorded with `via: "structural"`; explicit
`implements`/`extends` clauses are recorded separately. Generic or unresolved pairs that
throw are skipped.

## Dead code

Dead code is reachability, not raw in-degree:

1. Roots: entrypoint files/symbols, tests and stories, exported symbols (unless
   `include_exported`), and symbols in entrypoint files.
2. Traverse all edges except `imports` and `re_exports`.
3. Report eligible symbols never reached.

This avoids false positives from unused barrels and from internal helpers called by live
exported code. Framework route files are roots via the entrypoint pattern set.

## Hotspots and impact

- Hotspots: `complexity × (1 + log2(1 + fan_in)) × (testReachable ? 1 : 1.8)`.
- Test reachability: BFS from test symbols and test-file edges over non-import edges.
- Impact: reverse BFS over non-import edges, grouped into components, hooks, callers, test
  files, and modules; risk thresholds are low/medium/high/critical.

## Module graph and cycles

`fileImports` is produced by `ts.resolveModuleName` for static imports, re-exports, and
literal dynamic imports. The production module graph is topology-defined by runtime value
imports: test-file imports and erased `import type` edges are excluded, while type-only
import sites remain available through file-level dependency queries and
`explain_dependency`. Cross-module symbol edges add weight to an existing value-import edge
but never invent a new runtime dependency. Cycles are SCCs of size > 1.

The report UI uses the same ELK layered/orthogonal layout conventions as goray: compact
monospace nodes, module color stripes, rounded orthogonal routes, haloed edges, DFS
back-edge highlighting, transitive reduction, hub/isolated filters, module filtering,
direction switching, and fit-to-view controls.

## SQLite model

### Working database

```text
working_meta      key/value: root, project, tsconfigs, timestamps, counts, cycles
working_symbols   canonical symbol row + hashes + provenance
working_edges     from_id, to_id, kind, file, line, via
working_files     module, LOC, test/generated/entrypoint flags, exports/imports
```

WAL + `synchronous=NORMAL`, 5 s busy timeout. `syncWorking()` replaces the snapshot in one
transaction.

### Summary database

```text
summary_cache    (content_hash, prompt_version) → validated summary + hashes + LRU
symbol_history   symbol_id → last content/self/dep hashes
summary_meta
```

Summaries are content-addressed, so branches and worktrees share them automatically. Reads
of soft/hard stale symbols return the previous summary plus a reason rather than silently
pretending it is current.

`upsertSummaries()` validates schema by symbol kind, checks the expected content/self/dep
hashes, and writes the cache + history in a single summary-database transaction. Working
tables are never written during summary upserts.

## Report embedding

`web/report.html` is a Vite entry containing:

```html
<script id="tsray-data" type="application/json" data-tsray-live="__TSRAY_LIVE__">__TSRAY_REPORT_DATA__</script>
```

`vite-plugin-singlefile` inlines the JS and CSS. `scripts/embed-report.mjs` gzips the result
and writes `src/render/report-template.generated.ts` as base64 chunks. At runtime,
`exportHtml()` decompresses the template once and replaces the data-script body with a
JSON payload whose `<` characters are escaped as `\u003c`. Static exports set the live flag
to `false`; the server sets it to `true`, and the UI polls `/api/report`.

`web/dist/report.html` is committed to mirror `goray`'s embedded artifact and to make the
build inspectable. `npm run build:web` refreshes both the HTML and the generated TS module.

## MCP client integration

`tsray install-mcp`, `uninstall-mcp`, and `mcp-status` share one TypeScript integration
layer. Supported clients are OpenCode, Claude Code, Codex, Cursor, Gemini CLI, Antigravity,
and the shared Agents directory.

The integration layer:

- resolves global/project config paths, including `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`,
  `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`;
- detects installed clients from config directories, executables, and known application
  paths;
- accepts numbered/name/comma/space target selections plus `detected`, `installed`, `all`,
  and explicit config paths;
- edits OpenCode V2 `mcp.servers` and removes legacy duplicate entries;
- edits `mcpServers` JSON for Claude/Cursor/Gemini/Antigravity/Agents;
- preserves unrelated Codex TOML while replacing only the selected `mcp_servers.<name>`
  block, then validates the result with `smol-toml`;
- writes atomically, preserves existing permissions, defaults new config files to `0600`,
  follows symlinks, and refuses JSONC rather than risking corruption;
- uses `serve ${workspaceFolder}` for Antigravity's `/` working-directory behavior;
- installs/removes the bundled skill as a copy or symlink without deleting its source.

The Makefile and npm scripts are thin wrappers around these CLI commands. OpenCode reloads
MCP configuration automatically; other clients are told to restart.

## MCP and HTTP lifecycle

`startServe()`:

1. starts the initial full index in the background;
2. starts the watcher unless `--no-watch`;
3. starts the HTTP server with port fallback;
4. connects the MCP `McpServer` to `StdioServerTransport`;
5. prints the banner and `TSRAY_REPORT_URL=` to stderr;
6. handles SIGINT/SIGTERM by closing the watcher, MCP transport, HTTP server, store, and port
   file.

`stdout` is never used for logs. Tool handlers call `controller.getSnapshot()`, which either
returns the current healthy snapshot or waits briefly for a rebuild.

## Diff

`runArchitecturalDiff()`:

1. indexes the working tree;
2. finds the git top level and base SHA;
3. creates a detached temporary worktree;
4. initializes gitlinked submodules at the base ref, mirrors same-commit generated outputs and
   nested `node_modules`, and symlinks the main checkout's `node_modules` when available;
5. indexes the same relative subdirectory in the base worktree;
6. compares cycles, exported symbols/signatures, dead code, and untested hotspots;
7. returns JSON (or Markdown) and sets exit code `1` when a configured gate fails.

Temporary worktrees are removed in `finally`.

## Testing strategy

- `hasher`: dependency propagation, cycles, stable serialization.
- `indexer`: fixture classification, barrel unwrapping, React edges, entrypoints, incremental
  updates, new-file discovery.
- `cache`: staleness transitions, schema validation, hash conflicts, coverage, persistence,
  prune/remove.
- `render`: payload shape, all formats, HTML injection escaping.
- `mcp`: client/server round trip, errors, summary upsert through MCP.
- `watch`: real chokidar debounce and rebuild.
- `diff`: temporary git repository and gated regressions.
- `runner`: package script detection and command execution.
