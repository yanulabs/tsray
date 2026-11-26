# Contributing

## Setup

Use the Node.js version in `.nvmrc`, then install from the committed lockfile:

```sh
npm ci
npm run build
```

Report UI work additionally requires:

```sh
npm --prefix web ci
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

## Integration tooling

The MCP/skill installer is covered by `test/integration.test.ts`. It uses temporary homes
and config files only; never point tests at a real client configuration.

Safe manual checks:

```sh
node dist/cli/index.js install-mcp \
  --config /tmp/tsray-mcp.json --format opencode --dry-run --yes

node dist/cli/index.js install-skill \
  --dir /tmp/tsray-skills --dry-run --yes

npm run pack:check
```

OpenCode configuration reloads automatically. Other clients may require a restart.

## Commits

Use focused, atomic commits with conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`,
`chore:`). Keep generated report artifacts in their own commit when practical.

## Pull requests

- Search existing issues and pull requests before opening a new one.
- Describe the problem, the approach, and any user-facing or MCP API changes.
- Add or update tests for observable behavior. Avoid snapshots when an explicit assertion is
  clearer.
- Run `npm run verify`, `npm run build`, and `npm run pack:check` before requesting review.
- For report UI changes, run `npm --prefix web ci` and `npm run build:web`, then commit both
  `web/dist/report.html` and `src/render/report-template.generated.ts`.
- Update `README.md`, `docs/ARCHITECTURE.md`, and `CHANGELOG.md` when behavior or public APIs
  change.
- Never include credentials, personal access tokens, private source data, or machine-specific
  paths in commits, fixtures, or logs.

Maintainers may request changes before merging. Reviews should focus on correctness, semantic
TypeScript behavior, compatibility, security, and maintainability.

## Security and conduct

Do not disclose suspected vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md) for
private reporting. All contributors are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Releases (maintainers)

1. Update the version in `package.json`, `web/package.json`, `src/version.ts`, both lockfiles, and
   `CHANGELOG.md`.
2. Run `npm ci` in the root and `web/` directories, then run `npm run build:web` and commit both
   generated report artifacts.
3. Run `npm run verify` and `npm run pack:check`.
4. Create and push a matching `vX.Y.Z` tag on a commit reachable from `main`. The release workflow
   validates the tag, rechecks dependencies and generated artifacts, and publishes to npm.

npm provenance is enabled automatically only when the GitHub repository is public. Publishing a
public npm package does not change the repository's visibility.
