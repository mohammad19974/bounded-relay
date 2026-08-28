# BoundedRelay Handoff

**State**: verified locally — publication and external CI remain user-owned

## Objective

Publish-ready implementation of Portable Policy Profiles at
`specs/002-portable-policy-profiles` without changing the established one-way
Claude Code host -> BoundedRelay MCP -> local Codex CLI topology or the legacy
v0.1 routing fingerprint.

## Active artifacts

- `specs/002-portable-policy-profiles/spec.md`
- `specs/002-portable-policy-profiles/plan.md`
- `specs/002-portable-policy-profiles/tasks.md`
- `docs/project-profiles.md`
- `docs/adr/0010-portable-intersection-only-project-profiles.md`
- `.specify/memory/constitution.md`
- `.specify/agents/context.json`

## Completed state

- T001-T024 are complete. The feature adds strict non-executable project
  profiles, canonical fingerprints, deterministic capability routing, narrower
  write policy, required check bindings, explicit Codex-only model policy, and a
  plan-level cross-review policy.
- The legacy no-profile path remains `sdd-routing-v2` / `sdd-task-fit-v1`; the
  opt-in profile path is `sdd-routing-v3` / `sdd-capability-fit-v1`.
- Profiles never choose or launch a Claude model, execute declared argv, expand
  server authority, apply patches, commit, merge, push, publish, or deploy.
- Spec Kit replays the authoritative route, validates tree-bound receipts,
  rejects more than 256 required writer receipts before execution, and rejects
  any active wave that would raise all recorded writer receipts above 256 after
  optional receipts are included.
- Doctor capability detection uses bounded raw probe text internally and exposes
  only separately redacted diagnostics, including when a forwarded environment
  value equals a required Codex flag.
- CI defines Node 22.13 and 24 checks across Linux, macOS, and Windows, plus an
  installed-package contract and platform-specific npm shim verification.
- Independent final review found no remaining Critical, High, or Medium release
  blocker after all accepted findings were repaired.

## Verification performed on 2026-08-28

- Exact `npm run check` passed on Node 22.19: format, ESLint, TypeScript, 326
  tests across 22 files, coverage, build, 16/16 credential-free routing
  conformance cases, and installed-package smoke.
- Coverage passed at 92.29% statements, 89.23% branches, 97.2% functions, and
  92.21% lines.
- The real `boundedrelay@0.1.0` tarball contained 267 files, installed into an
  empty consumer, exposed nine MCP tools, completed a compatible handshake, and
  made no model call.
- Node 24.19 independently passed TypeScript, all 326 tests, and build.
- Strict Ajv schema compilation, JSON parsing, focused 256/257 receipt tests,
  doctor redaction/capability regression, and independent read-only review
  passed. Run repository-wide `git diff --check` once more after any handoff
  edit.

## Verification boundary

- Local tests use fake provider fixtures and credential-free MCP handshakes. No
  live Claude Code -> Codex provider call was made, so local evidence does not
  attest account authentication, model availability, provider quality, token
  savings, or cost savings.
- Linux and Windows behavior is represented by the committed GitHub Actions
  matrix and cross-platform regressions, but those hosted runners cannot execute
  until the working tree is committed and pushed.
- The feature remains uncommitted in a deliberately dirty worktree. Preserve all
  changes and inspect `git status --short` before integration.

## Next executable steps

1. Inspect the copied destination diff and confirm repository identity.
2. Commit and push only with explicit user authorization.
3. Require the complete GitHub Actions matrix to pass on Linux, macOS, and
   Windows before tagging or publishing the npm package.
4. Run a live Claude Code host acceptance test with an authenticated local Codex
   CLI; report it separately from credential-free policy conformance.

## Recovery notes

- A failed gate does not authorize bypassing policy or rewriting evidence. Fix
  the owning artifact and rerun the affected gate.
- Do not commit, push, publish, deploy, or install globally without separate
  user authorization.
- Do not report numeric quality, speed, token, or savings improvements without a
  reproducible pinned benchmark and disclosed environment.
