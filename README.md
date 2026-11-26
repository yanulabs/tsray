# tsray

Semantic TypeScript/React indexer, MCP stdio server, and offline architecture reporter.

## Project resources

- [Architecture guide](docs/ARCHITECTURE.md)
- [Contributing guide](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

`tsray` loads a TypeScript project with `ts.LanguageService` + `ts.TypeChecker`, builds a
line-independent semantic graph of symbols and React edges, caches content-addressed
summaries in SQLite, and exposes the result over MCP, Markdown, DOT, Mermaid, JSON, and a
single-file React report.

It is the TypeScript counterpart of [goray](https://github.com/yanulabs/goray), which does
the same for Go. The important difference is that `tsray` never guesses from syntax: every
call, render, context, reference, interface implementation, and barrel re-export is resolved
through the TypeScript compiler.

## Why the TypeScript Compiler API

SWC, Babel, Biome, and Tree-sitter produce syntax trees only. They cannot answer questions
such as "which component renders this one through a barrel file", "which type structurally
implements this interface", or "which hook does this component call through a path alias".
`ts.LanguageService` keeps an incremental program with per-file `ScriptVersion` values and
`ts.TypeChecker` provides declaration merging, overload resolution, alias unwrapping with
`getAliasedSymbol`, and structural assignability with `isTypeAssignableTo`.

## Requirements

- Node.js **>= 22.13** (uses the built-in `node:sqlite` module; no native addon)
- npm 10+ (or pnpm/bun for development)
- A project with `tsconfig.json` (project references and pnpm/npm workspaces are supported)

Node 22 prints an `ExperimentalWarning` for `node:sqlite`; it is harmless. Set
`NODE_NO_WARNINGS=1` if you need completely quiet stderr.

## Install and build

```sh
npm install
npm run build

node dist/cli/index.js version
node dist/cli/index.js index .

# Optional: expose the built CLI as `tsray`
npm link
tsray version
```

The report UI is committed as a single-file Vite artifact and embedded into the runtime as
gzip+base64, so `npm run build` never requires the web toolchain. To rebuild the UI:

```sh
npm run build:web   # web/ Vite build + src/render/report-template.generated.ts
```

## Quick start

```sh
# Build the index once and sync the working database
tsray index /path/to/react-app

# Offline interactive report (one HTML file, no external assets)
tsray export html /path/to/react-app -o report.html --open

# Markdown, Graphviz, Mermaid, or JSON
tsray export md /path/to/react-app -o ARCHITECTURE.md
tsray export dot /path/to/react-app --scope module -o modules.dot
tsray export mermaid /path/to/react-app --scope file --root src/App.tsx
tsray export json /path/to/react-app -o architecture.json

# Live server: MCP stdio + report UI
tsray serve /path/to/react-app

# CI architecture gate against a git ref
tsray diff main /path/to/react-app --fail-on cycles,breaking_api,untested_hotspots
```

`[path]` defaults to `.` and is resolved upward to the nearest `tsconfig.json`. A file path
inside the project works too. Use `--workspace` to force the nearest workspace root, or
`--tsconfig <path>` to select a specific project.

## CLI

```text
tsray <command> [path] [options]

Commands:
  serve [path]                       Run the MCP stdio server and live report UI
  index [path]                       Build and sync the semantic index once
  export <html|md|dot|mermaid|json> [path]
  diff [base-ref] [path]             Compare the working tree against a git ref
  db <path|info|rm|prune> [path]
  install-mcp [targets]               Register the MCP server with supported clients
  uninstall-mcp [targets]             Remove MCP registrations
  mcp-status [targets]                Inspect MCP registrations
  install-skill [targets]             Install the bundled agent skill
  uninstall-skill [targets]           Remove installed skills
  skill-status [targets]              Inspect skill installations
  version
  help
```

### `serve`

```sh
tsray serve [path] [--db <path>] [--host <addr>] [--port <n>] \
  [--port-range <n>] [--strict-port] [--port-file <path>] \
  [--open] [--no-watch] [--log-level off|error|info]
```

- `--db <path>` — single-database override; env `TSRAY_DB`; `:memory:` is supported.
- `--host` — bind address (default `127.0.0.1`). Binding beyond loopback prints a warning.
  Loopback requests validate `Host` and `Origin` headers against DNS rebinding. The report API has
  no authentication; keep it on loopback unless you trust the network.
- `--port` — preferred report port (default `4321`; env `TSRAY_PORT`; `0` = OS-assigned).
- `--port-range` — fallback window after the preferred port (default `100`).
- `--strict-port` — fail instead of moving when the preferred port is busy.
- `--port-file` — write `{ "url": ..., "pid": ... }` to a file and remove it on shutdown.
- `--open` — open the report in the default browser.
- `--no-watch` — disable chokidar file watching.
- `--log-level` — stderr verbosity (default `info`; env `TSRAY_LOG_LEVEL`).

`stdout` is reserved for MCP JSON-RPC 2.0. All diagnostics, banners, and the
`TSRAY_REPORT_URL=` line go to **stderr**.

The server exposes:

| Route | Purpose |
| --- | --- |
| `GET /` | Live single-file report UI |
| `GET /api/report` | Full report payload (JSON) |
| `GET /api/symbol?id=<symbol-id>` | Source, references, component tree, impact for one symbol |
| `GET /api/health` | Server and index status |

The UI polls every 5 seconds, preserving the active view, filters, selection, and zoom.

When production TypeScript errors appear in a single-project index, `tsray` keeps serving the
last healthy report snapshot. Workspace indexes are resilient by default: unrelated package
errors are reported but do not prevent the semantic graph from updating. Pass
`--allow-errors` or set `TSRAY_ALLOW_ERRORS=true` to opt into the same behavior for a single
project. `project_info.index_state` reports the latest attempt (`ready`, `indexing`, or
`error`), with `prod_errors` / `current_prod_errors` for the current tree and
`served_prod_errors` for the snapshot being served.

### `index`

Builds the index exactly once and syncs `working_symbols`, `working_edges`, and
`working_files` to SQLite. It does not start the watcher, MCP, or HTTP server.

Single-project production TypeScript errors exit `1` and do **not** overwrite the last healthy
working snapshot. Workspace indexes update by default and report diagnostics without
blocking; use `--allow-errors` for the same behavior in a single project. Errors confined to
test/story files become warnings and exit `0`. Use `--json` for machine-readable output.

Full multi-project indexes use worker threads only for projects that miss the persistent cache.
The default worker count is `clamp(1, 8, floor((availableMemoryGB - 1.5) / 2))`, including
Linux cgroup limits and macOS/Windows headroom. `TSRAY_WORKERS` remains an explicit override.

Each non-empty project persists its symbols, edges, imports, module stats, diagnostics, input
fingerprint, and exported-API signature hash in the working SQLite database. Cache keys include
source content hashes, resolved compiler options, the TypeScript version, scoped package/lockfile
dependencies, and upstream project signature hashes. Unchanged projects are hydrated without
creating a TypeScript program. Implementation-only edits rebuild only the edited project;
exported API changes cascade to affected dependents. Solution/aggregator configs with no owned
files are reported as `projects_empty`. Use `tsray db rm <path>` to force a cold rebuild.

JSON output and `project_info` expose `projects_total`, `projects_cached`, `projects_rebuilt`,
`projects_empty`, `workers_spawned`, and `diagnostics_cached`. The default `project_info` payload
is a bounded summary with five one-line diagnostic samples per severity; pass `verbose: true`
for paginated project/config details, storage metadata, and bounded diagnostic objects.
`project_filter`, `limit`, and `offset` control the verbose project page.

### `export`

| Format | Output |
| --- | --- |
| `html` | Self-contained offline report (CSS/JS/data inlined) |
| `md` | Architecture report with modules, cycles, hotspots, dead code, interfaces |
| `dot` | Graphviz module/file/symbol graph |
| `mermaid` | Mermaid `flowchart` |
| `json` | Full report payload |

Graph flags: `--scope module|file|symbol`, `--root <id>` (required for symbol scope),
`--depth <n>`. `--open` opens the generated HTML (writing to `$TMPDIR` when `-o` is absent).

### `diff`

Indexes the working tree and a temporary detached git worktree of `base-ref` (default
`HEAD`), then reports deterministic architectural deltas:

- new and resolved module cycles;
- removed or signature-changed exported symbols (breaking API);
- added exports;
- new and resolved dead code;
- new untested production symbols with cyclomatic complexity >= 10;
- file/symbol/edge/module counters.

```sh
tsray diff main --fail-on cycles,breaking_api,dead_code,untested_hotspots
tsray diff origin/main . --format md
```

Gates exit `1`; a missing repository or unresolvable ref exits `2`. Temporary worktrees are
always removed.

The base worktree initializes and checks out gitlinked submodules at `base-ref`, mirrors same-commit
generated outputs and nested `node_modules` from the main checkout, and refuses to continue if
tracked tsconfig discovery is incomplete. Only run architectural diffs against repositories and
submodules you trust. It read-only warm-seeds from the main checkout's working
SQLite cache. Project fingerprints use repo-relative paths and containing submodule revisions, so
identical projects across worktrees share cache entries without reusing changed-submodule results;
the main checkout database is never modified. JSON includes explicit `base`/`head` project, file,
symbol, edge, and graph-digest summaries. Set `TSRAY_DIFF_SEED=0` to force a cold diff, or `TSRAY_DIFF_PROFILE=1`
to emit detailed base/head cache and discovery metrics to stderr.

### `db`

```sh
tsray db path [path] [--summaries]
tsray db info [path]
tsray db rm [path] [--summaries] [--all] [--dry-run] [--force]
tsray db prune [--dry-run]
```

- `path` prints the resolved working DB path without creating it; `--summaries` prints the
  shared summary DB path.
- `info` prints counts, paths, and index metadata.
- `rm` removes the current checkout's working DB by default. `--summaries` targets only the
  shared summary DB, `--all` targets both. Sidecar `-wal`/`-shm` files are included.
- `prune` removes worktree databases whose persisted `canonical_root` no longer exists.

## Install and MCP client integration

### Install the CLI

```sh
npm install
npm run build
make install          # npm link; exposes `tsray` on PATH
tsray version
```

After a release is published on npm:

```sh
npm install --global @yanulabs/tsray
```

For a regular global install from a local checkout instead of a development link:

```sh
npm install --global /absolute/path/to/tsray
```

The npm package includes the compiled CLI, the embedded report template, and the agent
skill. `make install-mcp` and `npm run install:mcp` use the current Node executable plus the
compiled CLI path by default.

### Automated MCP registration

```sh
make install-mcp                                   # interactive target picker
make install-mcp MCP_TARGET=opencode                # one client
make install-mcp MCP_TARGET=opencode,cursor         # several clients
make install-mcp MCP_TARGET=detected                # detected clients only
make install-mcp MCP_TARGET=all                     # every supported client
make install-mcp MCP_SCOPE=project                  # project-local configs
make install-mcp MCP_ARGS='serve /absolute/repo'    # pin a repository
make install-mcp MCP_CONFIG=/tmp/mcp.json           # explicit config file
```

Equivalent npm scripts:

```sh
npm run install:mcp -- opencode cursor
npm run mcp:status -- opencode
npm run uninstall:mcp -- opencode
```

Or call the CLI directly:

```sh
tsray install-mcp opencode,cursor
tsray install-mcp --scope project --target opencode
tsray mcp-status --target detected
tsray uninstall-mcp --target installed
```

Supported targets:

| Target | Global config | Project config | Entry format |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` | `./opencode.json` | `mcp.servers.<name>` |
| `claude` | `~/.claude.json` | `./.mcp.json` | `mcpServers.<name>` |
| `codex` | `~/.codex/config.toml` | `./.codex/config.toml` | `[mcp_servers.<name>]` |
| `cursor` | `~/.cursor/mcp.json` | `./.cursor/mcp.json` | `mcpServers.<name>` |
| `gemini` | `~/.gemini/settings.json` | `./.gemini/settings.json` | `mcpServers.<name>` |
| `antigravity` | `~/.gemini/config/mcp_config.json` | `./.agents/mcp_config.json` | `mcpServers.<name>` |
| `agents` | `~/.agents/mcp.json` | `./.agents/mcp.json` | `mcpServers.<name>` |

Target selection accepts numbers, names, comma/space-separated lists, `detected`,
`installed`, `all`, or an explicit config path. In a non-interactive shell, installation
defaults to OpenCode; uninstallation defaults to already-installed targets.

Important variables:

| Variable | Purpose |
| --- | --- |
| `MCP_NAME` | Server key (default `tsray`) |
| `MCP_SCOPE` | `global` or `project` |
| `MCP_TARGET` | Target selection |
| `MCP_ARGS` | Server arguments (default `serve`) |
| `MCP_CONFIG` / `MCP_FORMAT` | Explicit config path and format |
| `MCP_CWD` | Fixed server working directory |
| `MCP_BIN` | Executable override (for example a compiled Bun binary) |
| `OPENCODE_CONFIG` | OpenCode config path override |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | Client-specific home overrides |

The installer edits JSON atomically, preserves existing file permissions, follows symlinked
config files, and refuses JSONC files rather than risking corruption. For OpenCode JSONC,
use the client's own command:

```sh
opencode mcp add tsray --global -- node /absolute/path/to/tsray/dist/cli/index.js serve
```

OpenCode V2 reloads MCP configuration automatically; verify with `opencode mcp list`.
Other clients may need a restart. Antigravity spawns stdio servers with `cwd /`, so the
installer uses `serve ${workspaceFolder}` unless explicit arguments or `MCP_CWD` are
provided.

The generated OpenCode entry is:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "tsray": {
        "type": "local",
        "command": [
          "node",
          "/absolute/path/to/tsray/dist/cli/index.js",
          "serve"
        ]
      }
    }
  }
}
```

The server resolves the active workspace automatically. Pin a repository by appending its
path to `MCP_ARGS` or the command.

### Agent skill

The package ships `.opencode/skills/tsray/SKILL.md` with tool-routing, canonical-ID, and
summary-workflow guidance.

```sh
make install-skill                         # interactive target picker
make install-skill SKILL_TARGET=opencode
make install-skill SKILL_TARGET=opencode,claude,agents
make install-skill SKILL_SCOPE=project
make install-skill SKILL_DIR=/path/to/skills SKILL_MODE=link
make uninstall-skill SKILL_TARGET=installed
```

Equivalent commands:

```sh
npm run install:skill -- opencode
npm run skill:status -- opencode
npm run uninstall:skill -- opencode
```

Supported skill targets are OpenCode, Claude Code, Codex, Cursor, Gemini CLI, and the shared
`~/.agents` directory. OpenCode also discovers the Claude and Agents compatibility paths.

### Install or remove everything

```sh
make install-all       # CLI + skill + MCP registration
make uninstall-all     # MCP registration + skill + CLI
```

### Equivalent per-client commands

```sh
# Claude Code
claude mcp add --scope user tsray -- node /absolute/path/to/tsray/dist/cli/index.js serve

# Cursor / generic JSON clients
# {
#   "mcpServers": {
#     "tsray": {
#       "command": "node",
#       "args": ["/absolute/path/to/tsray/dist/cli/index.js", "serve"]
#     }
#   }
# }
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `project_info` | Compact readiness, graph digest, counts, cache metrics, paths, and diagnostic samples; `verbose: true` for full metadata |
| `get_codebase_map` | Module scorecard, cross-module edges, cycles, hotspots (`md`, `json`, `dot`, `mermaid`) |
| `get_module_overview` | Module files, dependencies, hotspots, test reachability (`md`, `json`) |
| `get_dependency_graph` | Module/file BFS with fan-in/fan-out ranking (`json`, `dot`, `mermaid`) |
| `explain_dependency` | Exact imports and symbol edges behind a module-to-module dependency |
| `lookup_symbol` | Canonical ID, name, file, or fuzzy lookup with summary metadata |
| `get_api_surface` | Paginated exported API with module/kind filters |
| `get_references` | Type-checked references with enclosing caller and `file:line` |
| `get_call_graph` | BFS callers/callees with typed edges |
| `get_component_tree` | React renders, wrapper HOCs, hooks, context providers/consumers |
| `find_implementations` | Interface-to-class/type implementation matrix, including structural matches |
| `get_impact_analysis` | Kind-aware blast radius: components, hooks, callers, tests, modules, commands |
| `get_dead_code` | Unreachable symbols after entrypoint/test/generated exemptions |
| `get_hotspots` | Complexity × fan-in × untested risk ranking |
| `get_function_body` | Source body, LOC, and complexity |
| `list_stale_summaries` | Eligible symbols missing or stale in the summary cache |
| `get_summary_context` | Source, schema, hashes, staleness, previous summary, dependencies |
| `upsert_summaries` | Validate and store structured summaries with optimistic hash checks |
| `get_summary_coverage` | Coverage totals and breakdowns by kind/module |
| `run_tests` | Run the project's test runner (package script, vitest, or jest) |
| `run_typecheck` | Run `tsc --noEmit` or the configured typecheck script |
| `run_lint` | Run the configured linter, eslint, or biome |
| `css_diagnostics` | Static CSS/CSS Modules analysis: syntax and value errors, custom-property cycles, inert declarations, duplicates, missing/unused module classes, and opt-in global-class audit |
| `css_impact` | Definitions, consumers, rules, and components impacted by a custom property, class, or ID |
| `css_cascade` | Cascade Level 5 resolution for a selector's subject across `!important`, `@layer`, specificity, and source order |
| `css_runtime_check` | Optional Playwright layout invariants (overflow, clipping, collapsed or obscured controls) |
| `reindex` | Force a full synchronous rebuild and working DB sync |

Symbol arguments accept `symbol_id` (canonical ID or exact name) or the camelCase
`symbolId` alias. JSON results use snake_case fields for parity with `goray`.

CSS analysis is on demand and does not change the TypeScript snapshot. It parses imported
`.css` files with `css-tree`, validates them with `lightningcss` plus the css-tree property
grammar, and uses the owning project's TypeChecker to resolve CSS Module imports, string
aliases, template literals, conditional classes, and computed class keys. `.scss`, `.sass`,
`.less`, and `.styl` sources are reported as skipped; analyze their compiled CSS instead.
Automatically discovered CSS under `node_modules`, `dist`/`build`/`out`, and generated
directories is also skipped by default; list a compiled output explicitly in
`extra_css_files` when it is the only available stylesheet. Tailwind files are listed separately in `css_diagnostics.tailwind_files`; their plain
rules and `@theme` tokens are analyzed, while generated utilities require compiled CSS or
`css_runtime_check`. CSS-in-JS projects should also use compiled CSS or the runtime check. That tool is lazy-loaded and requires the optional `playwright` peer
dependency plus a Chromium browser (`npx playwright install chromium`).

Stylesheet order follows the TypeScript import graph from root modules, so `@layer`
statements keep the order in which the application evaluates its CSS imports.

`css_diagnostics` accepts `include_generated: true` to analyze compiled/dist CSS and
`audit_global_classes: true` to report plain CSS classes that have no statically resolved
`className` binding. The global audit understands `clsx`/`cn`-style helpers, template-literal
prefixes, `classList.add/remove/toggle`, `setAttribute("class", ...)`, and DOM `className`
assignments, but remains a warning-level heuristic because runtime code can apply arbitrary
classes.

### Agent response controls

MCP tools default to compact, bounded responses so an agent can inspect a large repository
without spending most of its context window on repetitive metadata.

| Control | Behavior |
| --- | --- |
| `compact` | Defaults to `true` on symbol-heavy tools. Set `false` for full symbol metadata. |
| `limit` / `offset` | Paginate symbol, file, edge, and audit results. |
| `next_offset` | Cursor for the next page, or `null` when the collection is exhausted. |
| `max_nodes` / `max_edges` | Bound graph payloads; use `node_offset` / `edge_offset` to continue. |
| `max_chars` | Hard JSON/text response budget, from 1,000 to 200,000 characters. |
| `include_source` | Source is opt-in for `lookup_symbol`; summary context includes it by default. |
| `source_chars` | Bound source previews or function bodies independently of `max_chars`. |
| `output_chars` | Per-stream command output budget for test/typecheck/lint tools. |

Collection tools return `total`, `offset`, `limit`, `next_offset`, and `truncated` alongside
their results. For example, `lookup_symbol` returns:

```json
{
  "total": 3,
  "offset": 0,
  "limit": 10,
  "next_offset": null,
  "symbols": [{ "id": "sym:src/App.tsx#App", "name": "App", "kind": "component" }]
}
```

If `max_chars` is reached, tsray first trims the largest collections and long strings, then
falls back to a preview. Truncated JSON includes `_response.truncated`,
`_response.original_chars`, `_response.max_chars`, and, when available,
`_response.truncated_paths`. When a structured response is retained, pagination totals remain
authoritative; the final preview fallback can omit them.

Command tools retain both the beginning and end of stdout/stderr, because test and type
errors often appear at the end. They also return `stdout_original_chars`,
`stderr_original_chars`, and an overall `truncated` flag.

Source is never included accidentally in compact symbol, reference, graph, or impact
results. Request it explicitly with `lookup_symbol(include_source: true)`,
`get_function_body`, or `get_summary_context`.

### Canonical IDs

```text
sym:src/components/Button.tsx#Button
sym:src/components/Button.tsx:ButtonWidget#render
file:src/components/Button.tsx
```

IDs are line-independent, so summaries survive line shifts, file moves within the same
path, and branch switches. Class methods include the class container.

## React-aware analysis

The indexer extracts more than a JavaScript call graph:

| Edge | Source | Example |
| --- | --- | --- |
| `renders` | JSX opening/self-closing tags, `React.createElement` | `<Button />` |
| `wraps` | `React.memo`, `forwardRef`, `lazy` | `const Memo = memo(Button)` |
| `uses_hook` | calls to symbols named `use*` | `useTheme()` |
| `provides_context` | `<Ctx.Provider>`, React 19 `<Ctx>` | `<ThemeContext>` |
| `consumes_context` | `useContext(Ctx)`, `use(Ctx)`, `<Ctx.Consumer>` | `useContext(ThemeContext)` |
| `calls` | checked call expressions | `formatPrice()` |
| `implements` | class heritage plus `isTypeAssignableTo` | `class Store implements Repository` |
| `references` | checked identifier and type references | `type Props = ButtonProps` |
| `imports` / `re_exports` | import and barrel declarations | `export { Button } from "./Button"` |

### Barrel files and path aliases

Every reference and import is unwrapped with `checker.getAliasedSymbol`. A component
imported from `src/components/index.ts` has an edge directly to its declaration in
`Button.tsx`, not to the barrel. This keeps fan-in, cycles, blast radius, and dead-code
analysis accurate in React codebases where most imports pass through `index.ts`.

Barrel re-exports are still recorded as `re_exports` edges for dependency explanations, but
they are not usage edges for dead-code reachability.

### Entrypoints

Dead code is computed as reachability from explicit roots, not raw in-degree. Default roots
include:

- `src/main.*`, `src/index.*`, `src/entry-client.*`, `src/entry-server.*`, `src/App.*`;
- Next.js `app/**/{page,layout,loading,error,not-found,template,default,route,middleware}.*`;
- `pages/**`, `src/pages/**`, Remix/TanStack `routes/**`, `app/routes/**`;
- `*.stories.*`, `*.config.*`, `scripts/**`, and `package.json#exports/main/module/bin`;
- tests, story files, symbols marked exported/entrypoint, and any symbol in an entrypoint
  file.

Add project-specific patterns in `tsray.json`:

```json
{
  "entrypoints": ["src/features/**/register.ts"],
  "exclude": ["**/legacy/**"]
}
```

### Logical modules

Grouping mirrors the `goray` convention without forcing Go's `cmd/`/`internal/` layout:

| Path | Module |
| --- | --- |
| `packages/ui/src/Button.tsx` | `packages/ui` |
| `apps/web/src/App.tsx` | `apps/web` |
| `src/features/billing/invoice.ts` | `features/billing` |
| `src/app/dashboard/page.tsx` | `app/dashboard` |
| `src/components/Button.tsx` | `components` |
| `vite.config.ts` | `root` |

## Storage and caching

Two SQLite databases live outside the repository:

```text
<cache>/worktrees/<dir-slug>-<sha256(canonicalRoot)[:12]>.db
<cache>/summaries/<project-slug>-<sha256(projectId)[:12]>.db
```

The cache root is `~/Library/Caches/tsray` on macOS, `%LOCALAPPDATA%\tsray` on Windows, and
`$XDG_CACHE_HOME/tsray` (or `~/.cache/tsray`) elsewhere. Override with `TSRAY_CACHE_DIR`.

- **Working DB** — checkout-local: symbols, edges, files, metadata. Safe to delete; rebuilt
  by `tsray index`.
- **Summary DB** — content-addressed and shareable across worktrees/branches: validated
  summaries, symbol history, LRU timestamps.

`--db`/`TSRAY_DB` switches to single-database mode. Both databases use WAL, a 5-second busy
timeout, and separate transactions; no transaction spans both files.

### Semantic hashes

```text
sig_hash     = sha256("sig:v1:" + type-checked signature)
self_hash    = sha256("self:v1:" + directive + ":" + sig_hash + ":" + normalized body)
dep_hash     = sha256("dep:v1:" + sorted external dependency content hashes + SCC digest)
content_hash = sha256("content:v1:" + self_hash + ":" + dep_hash)
```

Strongly connected components are collapsed with Tarjan's algorithm, so recursive component
trees and circular imports terminate with stable hashes. A caller's `content_hash` changes
when a dependency changes; a symbol's `self_hash` changes only when its own normalized body
or signature changes.

### Staleness

| State | Meaning |
| --- | --- |
| `synced` | Exact `(content_hash, prompt_version)` hit |
| `soft_stale` | The code is unchanged but dependencies changed; previous summary is reusable |
| `hard_stale` | The symbol itself changed; previous summary is a baseline only |
| `missing` | Never summarized |
| `not_eligible` | Test/generated symbol or out of scope |

Test and story symbols, and generated files, are indexed for navigation but are never
summary-eligible or included in production hotspots.

### Summary schema

Clients generate summaries; `tsray` validates and caches them. It never calls an LLM.

Functions, hooks, components, and methods:

```json
{
  "intent": "Why this exists and its architectural role.",
  "side_effects": ["none"],
  "invariants": ["Label is rendered as-is"],
  "concurrency": "Optional notes, max 800 chars"
}
```

Types, interfaces, classes, contexts, enums, and variables:

```json
{
  "intent": "Architectural responsibility.",
  "key_invariants": ["Single provider per tree"],
  "boundaries": ["client-only"]
}
```

Valid side effects: `none`, `db_read`, `db_write`, `network_io`, `fs_io`, `exec`, `env_read`,
`mutates_props`, `mutates_module_state`, `dom_mutation`, `storage_io`, `timer`,
`subscription`, `throws`, `renders_children`, `uses_context`. `none` must be the only entry.

`upsert_summaries` requires the `content_hash` (or both `self_hash` and `dep_hash`) returned
by `get_summary_context`. A mismatch returns `hash_mismatch`; re-fetch context and retry.

## Report UI

The offline report is a React 19 + Tailwind 4 + Vite single-file build:

- **Graph** — goray-style ELK layered/orthogonal module graph with compact monospace nodes,
  module color stripes, edge highlighting, transitive reduction, filters, pan/zoom, and fit-to-view.
- **Hotspots** — sortable risk table with test-reachability and complexity filters.
- **Modules** — module cards with health, entrypoints, dependencies, and coverage.
- **Contracts** — interface implementation matrix.
- **Explorer** — module/kind-filtered symbol browser.
- **Inspector** — kind/export/entry/dead badges, hashes, relationships, cached summary,
  blast radius and source when connected to `tsray serve`.
- `Cmd+K` / `Ctrl+K` command palette.

Static exports work from `file://`; live mode polls `/api/report` every 5 seconds.

## Configuration

`tsray.json` (or `tsray.config.json`) at the project root:

```json
{
  "projectId": "acme-web",
  "entrypoints": ["src/features/**/register.ts"],
  "exclude": ["**/legacy/**"],
  "summaries": { "promptVersion": "v1" },
  "runner": {
    "test": "npm run test -- --run",
    "typecheck": "npm run typecheck",
    "lint": "npm run lint"
  }
}
```

`runner.*` takes precedence over package scripts. Otherwise `run_tests` detects a `test`
script containing vitest/jest, then local vitest/jest; `run_typecheck` uses
`typecheck`/`type-check`, then local `tsc --noEmit`; `run_lint` uses a `lint` script, then biome
or eslint configs.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `TSRAY_DB` | Single database override |
| `TSRAY_CACHE_DIR` | Cache root override |
| `TSRAY_PROMPT_VERSION` | Summary prompt version (default `v1`) |
| `TSRAY_PORT`, `TSRAY_PORT_RANGE`, `TSRAY_HOST` | Server bind settings |
| `TSRAY_STRICT_PORT` | `true` to require the preferred port |
| `TSRAY_PORT_FILE` | Port file path |
| `TSRAY_ALLOW_ERRORS` | `true` updates workspace indexes even when production diagnostics exist |
| `TSRAY_WORKERS` | Full multi-project index worker count; `1` disables worker parallelism |
| `TSRAY_LOG_LEVEL` | `off`, `error`, `info` |
| `TSRAY_REPORT_URL` | Written to stderr by `serve` so a dev proxy can follow a moved port |
| `TSRAY_DEV_API` | Vite dev proxy target (web development only) |
| `TSRAY_DEBUG` | Print stack traces from CLI failures |

## Development

```sh
npm run typecheck   # src + tests
npm run lint
npm test
npm run build
npm run build:web   # requires web/node_modules
```

The fixture project in `test/fixtures/react-app` exercises barrels, aliases, hooks,
contexts, wrappers, entrypoints, and incremental rebuilds. `test/watch.test.ts` drives a real
chokidar watcher.

### Bun single binary (optional)

```sh
npm run build:bin    # bun build ./src/cli/index.ts --compile --outfile ./bin/tsray
```

Bun must support the `node:sqlite` compatibility module. If your Bun build does not, adapt
`src/cache/store.ts` to `bun:sqlite` (`import { Database }` and `new Database(path)` instead
of `DatabaseSync`; the `prepare`/`run`/`get`/`all`/`exec` calls used here are equivalent).
The report template is embedded, so the binary needs no runtime web files.

## Layout

```text
src/
  cli/        command routing, git worktree diff, MCP/skill integration
  integration/ atomic JSON/TOML client config editing, detection, skill install
  index/      indexer/ (orchestration, project pass, cache hashing, symbol utils), queries/ (graph, modules, symbols, audit, impact), watcher
  css/        analysis/ (AST walker, rule builder), tsx/ (imports, expressions), cascade, diagnostics, runtime checks
  cache/      store/ (working DB, summary DB, schemas, paths, read-only cache)
  render/     exporters/ (payload, Markdown, graph, JSON, HTML), embedded template
  mcp/        stdio server + local HTTP report server
  tools/      composition root, domain/ tool modules, shared/ argument/result/projection helpers, runner detection
  cli/        command dispatch, commands/ handlers, diff/ worktree and rendering
  util/       paths, globs, source utilities
web/          React 19 + Tailwind 4 report UI (Vite single-file build)
test/         vitest suites and the React fixture
scripts/      report embedding and executable post-build step
```

## Limitations

- Workspace tsconfigs are indexed as separate LanguageService programs with their own compiler
  options, module resolution, React type identities, and path aliases. Duplicate file ownership
  is assigned to the broadest applicable config; cross-project symbol edges use stable IDs.
- When a single package references sibling source projects, those files are used for type
  resolution but only files under the resolved project root are indexed. Use `--workspace`
  to index the whole graph.
- Structural interface matching is project-local and intentionally broader than nominal
  `implements` checks; review `via: "structural"` edges when they appear noisy.
- Sources are indexed, not bundled. Runtime-only dynamic imports and non-literal module
  specifiers are not resolved.
- CSS analysis covers standard CSS and CSS Modules. Preprocessors are skipped, and Tailwind or
  CSS-in-JS source files are not statically modeled; use compiled CSS or the Playwright runtime
  check for those projects. Media queries and state selectors are reported, but cascade
  resolution assumes their conditions match.
- The indexer does not execute analyzed project code. Optional MCP command tools execute package
  scripts or configured commands and must only be used with trusted repositories.

## Community and support

See [SUPPORT.md](SUPPORT.md) for support channels and [CONTRIBUTING.md](CONTRIBUTING.md) for
development and review expectations. Participation is governed by the
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md); do not open
a public issue for a security problem.

## License

MIT. See [LICENSE](LICENSE). Bundled report dependencies retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the included texts in `licenses/`.
