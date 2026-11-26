# Changelog

## Unreleased

## 0.2.0 — 2026-11-26

### Added

- Optional CSS/CSS Modules analysis with `css_diagnostics`, `css_impact`, `css_cascade`, and
  `css_runtime_check` MCP tools. Uses `css-tree` plus `lightningcss`, resolves `baseUrl`/`paths`
  aliases, follows the TypeScript import graph for stylesheet order, and detects missing/unused
  module classes, undefined or cyclic custom properties, inert declarations, duplicates, and
  missing dependency imports. Playwright remains an optional peer dependency.
- CSS hardening: partial Tailwind analysis, generated CSS opt-in (`include_generated`), global
  dead-class audit (`audit_global_classes`), TypeChecker-resolved template classes, local
  `className` variables, helper transforms, `classList`/`setAttribute` usage, escaped class
  identifiers, and subject-aware cascade matching.

### Changed

- Split every oversized orchestration file into domain modules with stable facades:
  `tools/domains`, `index/queries`, `index/indexer`, `cache/store`, `render/exporters`,
  `cli/commands`, `cli/diff`, and `css/analysis` + `css/tsx`. Entry files such as
  `tools.ts`, `queries.ts`, `store.ts`, `exporters.ts`, and `diff.ts` are now composition or
  re-export facades; registration, parsing, projections, SQL schemas, and shared helpers are
  reusable modules.
- `version`, `--version`, and `-v` now print conventional Unix-style output
  (`tsray <version>`) instead of only the raw version number.

## 0.1.0 — 2026-11-26

Initial release.

### Added

- TypeScript Compiler API indexer with incremental `ScriptVersion` snapshots.
- React-aware edges: renders, wrapper HOCs, hooks, context providers/consumers, structural
  interface implementations, barrel re-exports, and checked references.
- Canonical, line-independent symbol IDs and SCC-safe semantic hashes.
- Dual SQLite cache (`node:sqlite`) for checkout-local working state and content-addressed
  shared summaries.
- chokidar watcher with 200 ms debounce, selective invalidation, and healthy-snapshot
  fallback.
- MCP stdio server with architecture, dependency, symbol, React, impact, dead-code, hotspot,
  and summary tools, plus test/typecheck/lint runners.
- Local report API with port fallback and `--port-file`.
- Markdown, Graphviz DOT, Mermaid, JSON, and single-file HTML exports.
- Detached-git-worktree architectural diff with CI gates.
- `db` commands for cache inspection, removal, and pruning.
- React 19 + Tailwind 4 report UI with graph, hotspots, modules, contracts, explorer,
  inspector, command palette, and live refresh.
- Goray-style ELK layered/orthogonal dependency graph with module colors, edge highlighting,
  DFS back edges, transitive reduction, hub/isolated filters, and fit-to-view controls.
- Multi-client MCP install/uninstall/status commands for OpenCode, Claude Code, Codex,
  Cursor, Gemini CLI, Antigravity, and Agents, with atomic JSON/TOML editing.
- Skill install/uninstall/status commands and Makefile/npm integration targets.
- Community health files: code of conduct, support guide, security policy, issue templates, and
  pull request template.
- npm package metadata, changelog/security files, and complete bundled-dependency license texts.
- Standalone HTML reports embed the project and bundled-dependency licenses plus the elkjs
  source-availability statement.
- Automated dependency updates and dependency audits in CI.
- Cross-platform package-build checks for macOS and Windows.
- Visibility-aware npm release workflow with provenance for public repositories and a packaged
  agent skill.

### Changed

- CI tests the minimum supported Node.js version, verifies generated report HTML and embedded
  content, pins third-party actions by commit, and applies workflow timeouts and concurrency
  limits.
- Releases validate the Git tag against `package.json`, require the tagged commit to be on
  `main`, and rebuild and verify report artifacts.
- npm packing builds the CLI automatically, verifies the published manifest, and ships
  self-contained source maps.

### Security

- Local report HTTP requests validate `Host` and `Origin`, reject unsupported methods, and
  return generic server errors without leaking stack traces.

### Fixed

- Resolve TypeScript project references that point directly to config files as well as directories,
  so standard solution-style Vite projects are indexed instead of appearing empty.
