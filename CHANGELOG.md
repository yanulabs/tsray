# Changelog

## 0.1.0 — 2026-11-24

Initial release.

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
- npm release workflow with provenance and a packaged agent skill.
