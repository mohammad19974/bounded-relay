# Contributing

Thank you for helping improve BoundedRelay. This project treats its subprocess,
path, and proposal boundaries as security-sensitive code.

## Before opening an issue

- Search existing issues.
- Confirm the behavior on a currently supported Node.js and Codex CLI
  combination.
- Remove repository names, prompts, credentials, absolute personal paths, and
  proprietary output.
- Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.

## Development setup

```bash
npm ci
npm run build
npm test
```

Node.js `^22.13.0 || ^24.0.0` is required. See
[Development](docs/development.md) for the complete workflow.

## Pull requests

Keep a pull request focused on one coherent change. Include:

- the problem and intended behavior;
- the security or compatibility impact;
- tests that fail before the change and pass afterward;
- documentation updates for any public contract change;
- exact verification commands and results.

Run the full local gate before requesting review:

```bash
npm run check
```

Do not include generated credentials, Codex rollout files, real job output,
runtime state, or fixtures copied from private repositories.

## Tests

- Unit tests cover pure validation, state transitions, event parsing, and
  limits.
- Integration tests use a fake Codex executable and temporary Git repositories.
- Contract tests exercise MCP tool inputs and structured results.
- CI must not authenticate to Claude or Codex and must not make a paid model
  call.

Security-related code should include negative tests for traversal, symlink
boundaries, shell metacharacters, dirty worktrees, revision drift, output
limits, cancellation, and cleanup.

## Documentation

Use factual language. Avoid claims such as “best model,” “zero risk,”
“guaranteed token savings,” or “production ready” unless the repository contains
reproducible evidence for the precise claim.

Examples must use explicit placeholders and explain how to replace them. Do not
commit `@latest` in a shared MCP configuration.

## Commit and release policy

Use Conventional Commit style when proposing a commit message. Maintainers own
versioning and releases. A merged pull request does not imply an npm release,
and contributors must not add a publishing workflow without an approved release
design.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
