# Security Policy

## Supported versions

Security fixes are provided for the latest released `0.1.x` version. Older versions should be
upgraded before reporting an issue.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/yanulabs/tsray/security/advisories/new)
to report a suspected vulnerability. **Do not open a public issue for a security problem.**

Include as much of the following as you can:

- the affected tsray version or commit;
- the operating system, Node.js version, and MCP client involved;
- the impact and any prerequisites;
- concrete reproduction steps or a minimal proof of concept;
- relevant logs with credentials, tokens, and private source data removed.

We will acknowledge reports on a best-effort basis, investigate, and coordinate disclosure with the
reporter. Please give us reasonable time to address an issue before sharing details publicly.

## Security boundaries

- `tsray serve` binds to `127.0.0.1` by default. Loopback requests validate `Host` and `Origin`
  headers to prevent DNS-rebinding access, and the API accepts only `GET`/`HEAD`. It still has no
  authentication; do not expose it to an untrusted network.
- Reports and indexes can contain proprietary source code and diagnostic paths. Store and share
  them with the same care as the source code itself.
- MCP command tools can run a project's test, typecheck, or lint scripts. Only connect tsray to a
  repository and configuration you trust.
- `tsray diff` creates and removes temporary Git worktrees. Reports that leak data across worktrees
  or fail to clean them up are in scope.
