# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project intends to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) after its public
contracts are validated.

## [Unreleased]

### Added

- Server-owned `CCW_DEFAULT_MODEL` and `CCW_DEFAULT_REASONING_EFFORT` applied
  when a job omits `model` or `reasoningEffort`. The default model must appear
  in `CCW_ALLOWED_MODELS` and configuration fails closed otherwise (ADR 0004
  amendment).
- Partial-result salvage: a job that fails on timeout, output limit, protocol
  error, or all-commands-failed still returns the last complete agent message,
  marked with `finalMessagePartial`, a server-owned `notice`, and
  `partialResultAvailable` on the snapshot. SDD reviews are excluded.
- Numeric failure `diagnostics` (stop reason, exit code, event and command
  counters, byte counts, elapsed time) on runtime failures, sanitized to
  server-derived numbers and fixed enums only.
- `sessionPersisted` snapshot marker and a `resumeHint` on results whose Codex
  session is recorded and resumable.
- Separate `CCW_MAX_STDERR_BYTES` budget (default 10 MB) so stderr log noise no
  longer consumes the stdout JSONL budget.
- Wire-safe final messages: `codex_worker_result` truncates an oversized
  `finalMessage` (marking it partial) instead of refusing the whole frame, so a
  large completed result can never become permanently unreadable over MCP.
- Guardrails on the new defaults: `CCW_DEFAULT_REASONING_EFFORT=ultra` fails
  configuration closed (ultra stays a per-job opt-in), and `sessionPersisted`
  appears only after a recorded session id was actually observed.
- Work preservation on every terminal path: a completed Codex answer survives a
  failing proposal finalization, workspace cleanup, or lease release; a cancel
  that lands after the runtime finished returns the real result instead of an
  empty cancellation; the chunk that trips the stdout budget is still parsed so
  the answer it carries is not discarded; and terminal-history eviction now
  orders by completion time so a long job's result is readable before it can be
  evicted.
- `codex_worker_propose` now forwards `resumeSessionId` and `persistSession`, so
  a proposal can continue the analyze thread that planned it and record its own
  thread for a repair round. Both fields were previously accepted by the schema
  and silently dropped.
- The request fingerprint includes `resumeSessionId` and `persistSession`, so
  two continuations of different threads cannot collide on one idempotency key.
- Structured SDD reviews get a JSON-only output instruction instead of the prose
  thoroughness contract, which could otherwise corrupt their schema-constrained
  decision.
- The final-message wire budget accounts for an attached patch, so a
  policy-valid proposal result is never refused whole; bootstrap failures name
  their exit status or timeout.
- Policy observability: `config`, `doctor`, and `codex_worker_capabilities` now
  surface the server-owned defaults (`defaultModel`, `defaultReasoningEffort`),
  the stderr budget, and whether a proposal bootstrap is configured, so the
  effective delegation policy is verifiable without reading source. `doctor`
  and capabilities also report a `buildId` — the running module's build
  fingerprint, which the frozen package version cannot provide — and warn when
  a configured bootstrap command cannot be resolved on `PATH`.
- Bootstrap robustness: its output is discarded rather than buffered, so a
  verbose but successful install is no longer turned into a proposal failure;
  a cancel aborts a running bootstrap instead of waiting out the whole window
  while the repository lease is held.
- A JSONL consumer's own typed error is reported as itself instead of being
  relabelled as a non-JSON stdout line.
- Operator-declared proposal-clone bootstrap (`CCW_PROPOSAL_BOOTSTRAP` +
  `CCW_PROPOSAL_BOOTSTRAP_TIMEOUT_MS`, ADR 0003 amendment): a server-owned argv,
  run once per fresh clone without a shell, can install dependencies so Codex
  verifies its patch with the project's own typecheck/lint/tests before
  returning it. The proposal prompt tells Codex whether dependencies are ready;
  failures fail preparation closed and bootstrap output is never surfaced.
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
- A separate `routeProfiledSddTasks` / `sdd-routing-v3` path for strict portable
  project profiles: deterministic capability fit, intersection-only write
  restrictions, required check definitions and command digests, Codex-only model
  policy, and content-addressed evidence without changing no-profile routes.
- A safe generic project-profile template, stdin/stdout validation, public
  schema and documentation, plus a deterministic credential-free routing
  conformance corpus that reports policy invariants rather than model quality,
  speed, token, or cost results.
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
  effort to routed policy. Legacy no-profile critical host work retains the
  `gpt-5.6-sol` / `ultra` review rule; profiled work uses its explicit,
  allowlisted critical and plan-level cross-review policies.
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

- `CCW_MAX_OUTPUT_BYTES` now bounds stdout only and its default rose from 1 MB
  to 5 MB.
- Timeout failures now report `resultTruncated: true`.
- Analysis jobs execute with `--cd` at the validated repository root; the
  requested cwd becomes a prompt focus hint.
- The worker prompt now demands a complete, evidence-backed final result and
  points Codex at repository conventions (AGENTS.md/CLAUDE.md/README) instead of
  requesting a concise result.
- The supported Node contract is now explicit (`^22.13.0 || ^24.0.0`), and CI
  exercises the real installed tarball on both lines across Ubuntu, macOS, and
  Windows.
- Source and Git-dependency installs build through `prepare`; package checks now
  clean-install and exercise the shipped CLI, ESM entrypoint, npm shim,
  integration pack, and credential-free MCP surface.
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
- Runtime completion now evaluates nested Codex command status and exit codes:
  an outer zero exit and optimistic final message cannot make an all-failed
  command set successful, and specialized SDD reviews require a successful
  inspection command.
- `codex_worker_result` now marks failed/cancelled jobs and completed SDD
  reviews with non-passing gates as MCP errors while preserving their structured
  result payloads.
- The Spec Kit workflow now executes sealed required writer checks in an
  explicit shell-free, time/output-bounded step and derives their receipts from
  captured process results instead of trusting prefilled success evidence.

### Security

- Windows startup now uses file URLs for ESM imports, rejects cross-drive path
  containment, preserves only required case-normalized runtime environment keys,
  resolves trusted native launchers without a shell, enables long Git paths, and
  avoids PATH lookup for `taskkill.exe`.
- Proposal mode is disabled by default and never applies its returned patch to
  the source worktree.
- Direct token environment forwarding is disabled by default.
- Raw Codex event payloads and unrecognized event identifiers are excluded from
  live status; unsafe session identifiers are omitted.

## 0.1.0 - Unreleased development version

The package manifest reserves this version for the first public development
release. It has not been published to npm or announced as stable.
