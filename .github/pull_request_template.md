## Summary

<!-- State the user-visible outcome and why it belongs in this project. -->

## Security and compatibility impact

<!-- Address paths, subprocesses, sandbox, environment, credentials, persistence, MCP contract, and supported runtimes. -->

- [ ] No authority boundary changes
- [ ] Boundary change documented in `docs/security-model.md` and an ADR
- [ ] Public tool/config/schema change documented and added to `CHANGELOG.md`

## Verification

<!-- List exact commands and results. Never include credentials or private source/output. -->

```text
npm run check
```

## Checklist

- [ ] Tests reproduce the issue or prove the new behavior.
- [ ] Negative and cleanup paths are covered where relevant.
- [ ] Analyze remains read-only by default.
- [ ] Proposal mode remains isolated and never applies its patch.
- [ ] Examples contain no personal paths, secrets, or unpublished-package
      claims.
- [ ] I reviewed the packed artifact when package contents changed.
