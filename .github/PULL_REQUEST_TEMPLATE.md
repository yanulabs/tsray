## Summary

Describe the change and the problem it solves.

## Test plan

List the commands you ran and any manual checks. If a check does not apply, explain why.

```sh
npm run verify
npm run build
npm run pack:check
```

For report UI changes, also run:

```sh
npm --prefix web ci
npm run build:web
```

## Checklist

- [ ] I searched existing issues and pull requests for related work.
- [ ] The change is focused and includes tests for observable behavior where practical.
- [ ] `npm run verify` and `npm run build` pass.
- [ ] Generated report artifacts are refreshed when the report UI or its build changes.
- [ ] Documentation and `CHANGELOG.md` are updated when appropriate.
- [ ] No credentials, private paths, or sensitive source data are included.
- [ ] I have read `CONTRIBUTING.md` and agree to follow `CODE_OF_CONDUCT.md`.
