# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project intends to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after its public
contracts are validated.

## [Unreleased]

### Added

- BoundedRelay project identity, generated README cover and repository mark,
  complete source-installation guide, and optional Spec Kit integration recipe.
- Local stdio MCP server for Claude Code.
- In-memory asynchronous queue with status, result, list, long-poll, and
  cancellation operations.
- Read-only Codex analysis through `codex exec --json`.
- Opt-in proposal mode using a clean, revision-pinned, disposable local Git
  clone.
- Changed-path, ref, patch-size, file-count, and symlink validation for
  proposals.
- Proposal results that omit the binary patch body unless explicitly requested.
- Environment allowlisting, executable resolution, workspace allowlists, bounded
  output, and configurable timeouts.
- Sanitized live activity labels, update and elapsed timing, queued position,
  and revision-aware status long-polling through `afterRevision`.
- `codex_worker_sdd_route`, a synchronous model-free adaptive router with
  `sdd-routing-v2` quality-first task-kind fit, a neutral non-quota share,
  stable reasons, a plan fingerprint, and dependency-safe single-writer waves.
- `codex_worker_sdd_review`, a structured read-only review job that freezes
  Claude host evidence, seals exact artifacts, excludes host findings from the
  Codex prompt, and returns a current dual-review gate verdict.
- Draft and strict review modes. Strict approval requires both independent
  reviewers to approve the same clean Git revision and content-addressed
  artifact seal; Codex reads a detached, origin-free clone, and stale or invalid
  evidence fails closed.
- `ultra` as an explicit Codex reasoning-effort value. Unsupported model/profile
  combinations fail; BoundedRelay does not silently downgrade them.
- Packaged optional Spec Kit workflow/extension and Claude Code plugin under
  `integrations/`, plus `boundedrelay sdd path` and `boundedrelay sdd validate`
  for local discovery and structural validation.
- Wave-ordered Spec Kit `execution.json` evidence prepared only from verified
  routing, with exact dependency order, at most one writer per wave, clean
  direct-child non-merge checkpoint commits, and historical replay validation.
- A committed standard `tasks.md` manifest whose canonical pending IDs must be
  covered exactly once by routing, with completed or invented IDs rejected. The
  reviewed plan must remain an unchanged, fully revalidated ancestor of the
  routing checkpoint.
- Redacted coordinator-attested check receipts and ignored run-local Codex patch
  files whose bytes and SHA-256 digests are revalidated before a wave advances;
  receipts bind `testedTree`, and a disposable Git index proves the persisted
  patch produces the exact checkpoint tree.
- Exact execution-time matching of each Codex result's model and reasoning
  effort to routed policy, including required `gpt-5.6-sol` / `ultra` Codex
  cross-review for critical Claude-host work.
- Context-derived frozen host review IDs binding run/phase, nonce, revision,
  source/check digests, and prepared review policy for implementation and
  convergence evidence.
- Implementation review bound to verified execution and the
  routing-base-to-final-HEAD diff, with a 256-changed-path limit, plus
  convergence review chained from the approved implementation revision.
- Fail-closed severity and convergence gates: unresolved High/Critical findings
  cannot approve, convergence never implements directly, and newly appended
  tasks require a fresh routed and wave-executed run.
- Digest-only Spec Kit proof packs that rerun authoritative routing, strict
  projection validation, strict dual-review validation, historical wave checks,
  exact execution-to-implementation-to-convergence source chains, and current
  convergence freshness before binding evidence, checkpoint, check, review-job,
  and proposal digests without storing prompts or raw model output.
- Run-local handoff drafts with final-proof revalidation in an isolated Git
  clone, exact marker binding, atomic publication to the canonical handoff, and
  idempotent verification retries.
- Shared `.specify/` governance for this source repository. It is development
  state, not an MCP runtime dependency or consumer-project template.

### Changed

- The package, executable, and MCP implementation name are now `boundedrelay`;
  the stable v0.1 MCP tools and environment variables remain `codex_worker_*`
  and `CCW_*`.
- `codex_worker_list` returns an explicit `{ "jobs": [...] }` object.
- The Codex compatibility probe now also requires `exec --output-schema` for
  schema-constrained SDD reviews.
- Public snapshots and terminal results add optional SDD review metadata and a
  validated structured review artifact without changing established v0.1 job
  fields.
- Adaptive workflows now pass every legitimate route, including a one-lane
  implementation result, through the same `execution.json` wave and checkpoint
  validators.
- Spec Kit routing evidence now requires the exact current router and fit policy
  versions and selection order rather than arbitrary non-empty labels.
- Every packaged human gate now aborts on rejection. A correction requires a
  fresh workflow run and a new evidence chain.

### Security

- Proposal mode is disabled by default and never applies its returned patch to
  the source worktree.
- Direct token environment forwarding is disabled by default.
- Raw Codex event payloads and unrecognized event identifiers are excluded from
  live status; unsafe session identifiers are omitted.

## 0.1.0 - Unreleased development version

The package manifest reserves this version for the first public development
release. It has not been published to npm or announced as stable.
