# Repository Operating Rules

These rules apply to human and AI contributors working in this repository.

## Product boundary

BoundedRelay is a local stdio MCP server that delegates bounded jobs from Claude
Code to the supported `codex exec --json` interface. It also provides optional,
additive SDD primitives for deterministic task routing and content-addressed
dual review.

Version 0.1 keeps two established Codex execution modes:

- `analyze`: read-only execution in the validated source Git repository;
- `proposal`: opt-in execution in a disposable clean local clone, returning a
  validated binary patch that is never applied by this project.

The SDD router separately names two assignment lanes: `codex` and `claude-host`.
The latter is the current Claude Code session using its host-selected model. The
worker must never launch Claude or choose a Claude model.

Do not add direct source-worktree writes, automatic patch application, remote
mutation, credential storage, model-quality claims, persistent jobs, or an audit
ledger without an explicit design change and matching documentation.

## Before changing code

1. Read `README.md`, `docs/architecture.md`, and `docs/security-model.md`.
2. Inspect the current source, tests, package scripts, and working tree.
3. Keep public documentation aligned with the actual implementation.
4. Preserve the one-way topology: Claude Code → MCP worker → Codex CLI.

## Implementation invariants

- Never interpolate task text into a shell command.
- Spawn executables with argument arrays and `shell: false`.
- Keep MCP stdout protocol-only; diagnostics belong on stderr.
- Keep analysis read-only by default.
- Proposal mode remains disabled unless `CCW_ENABLE_PROPOSALS=true`.
- Proposal work occurs only in the isolated clone and requires a clean,
  revision-pinned source.
- Validate paths, Git refs, patch size, changed-file count, and symlink
  boundaries before returning a proposal.
- Never apply, commit, push, publish, deploy, or modify a remote system.
- Never log or commit authentication material, prompts, job output, or local
  runtime state.
- Unknown Codex JSONL events must not crash a valid run merely because Codex
  added a new event type.

## Quality gates

Run the narrowest relevant test while iterating, then run:

```bash
npm run check
```

Review the diff and run `git diff --check` when working in a Git checkout. Tests
must use fake executables and deterministic fixtures; CI must not require
provider credentials or a paid model call.

## Documentation and release discipline

- Claims must distinguish implemented, planned, and unsupported behavior.
- Do not add fake badges, placeholder maintainers, unpublished install claims,
  or benchmark claims without reproducible evidence.
- Keep examples free of secrets, personal paths, usernames, and private
  repository data.
- Do not commit, tag, publish, or create a release unless the user explicitly
  authorizes it.
- This source repository uses `.specify/` as its own shared governance source of
  truth and ships an original optional integration under `integrations/`. Spec
  Kit is not an MCP runtime dependency, and consumer repositories must use their
  own initialized governance rather than copying this repository's `.specify/`
  directory.
- Architecture decisions live under `docs/adr/`. Keep the distributable
  integration, public docs, schemas, tests, and `.specify/` governance aligned.
