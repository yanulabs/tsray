# Contributing

## Setup

```sh
npm install
npm run build
```

Report UI work additionally requires:

```sh
npm --prefix web install
npm run build:web
```

`npm run build:web` writes `web/dist/report.html` and regenerates
`src/render/report-template.generated.ts`. Commit both when the UI changes.

## Checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run typecheck` covers both `src/` (production build config) and `test/` (test config).
The fixture at `test/fixtures/react-app` is intentionally excluded from lint/typecheck; it is
a controlled TypeScript project with a local JSX shim.

## Design rules

- The TypeScript Compiler API is the source of truth. Do not add syntax-only heuristics where
  a checked symbol, type, or resolved module is available.
- Unwrap aliases (`checker.getAliasedSymbol`) for every import/reference. A React graph that
  stops at `index.ts` is considered a bug.
- Canonical IDs must remain line-independent.
- Never write summary data to working tables and never span a transaction across both SQLite
  databases.
- MCP stdio owns stdout. Use stderr for logs and banners.
- Keep report payloads JSON-serializable and snake_case for parity with goray.
- Test observable behavior, not implementation details.

## Commits

Use focused, atomic commits with conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`,
`chore:`). Keep generated report artifacts in their own commit when practical.
