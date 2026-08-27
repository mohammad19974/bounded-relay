---
name: boundedrelay-adaptive-sdd
description:
  Coordinate the optional BoundedRelay Spec Kit workflow with strict independent
  reviews, deterministic effort routing, bounded proposals, convergence, and
  handoff.
user-invocable: true
---

# Adaptive dual-agent SDD

Use the packaged workflow as the source of truth. Do not improvise a second
governance system.

## Invariants

- Claude Code is the coordinator and keeps the host-selected model. Never force
  a Claude model.
- Route with `codex_worker_sdd_route`. Hard eligibility and versioned task fit
  decide first. Use the default 5,000-basis-point Codex share only for tasks
  still neutral after fit; it is not a quota or a token, price, quality, or
  elapsed-time promise. Preserve and verify the returned policy versions,
  decision stages, and plan fingerprint.
- Freeze Claude's review before starting Codex. Never place frozen Claude
  findings in the Codex prompt or `focus` field.
- Strict plan, implementation, and convergence gates use
  `codex_worker_sdd_review`; generic analysis is advisory and cannot satisfy
  them. Accept only a current strict seal and `gate.passed: true`,
  `gate.status: ready`.
- Execute the routed dependency graph in canonical waves. Start every wave from
  its verified clean committed checkpoint, finish all prior dependencies, and
  allow at most one writer. Codex write slices are revision-pinned isolated
  proposals with exact write scopes; BoundedRelay returns patches and never
  applies them. The coordinator reviews and integrates only within the user's
  existing authority.
- Keep one writer per repository at a time. Never provider-batch across waves,
  recursively delegate, silently downgrade a critical profile, auto-commit,
  push, publish, or deploy.
- Re-seal and repeat both reviews after any reviewed artifact, revision, policy,
  or implementation change. Missing, stale, malformed, or unavailable evidence
  fails closed.
- Complete every routed assignment exactly once. Zero Codex implementation
  assignments are valid when hard eligibility and task fit put all work on the
  host; record the host results without a worker call. Codex still participates
  in the independent review gates.
- Human rejection aborts the evidence chain. Start a fresh corrected run rather
  than re-prompting a stale gate or entering an unbounded provider loop.

## Execution

1. Load the consumer constitution, active spec/plan/tasks, and repository rules.
2. Follow
   `specify -> clarify -> plan -> frozen dual plan review -> checklist -> tasks -> analyze`.
3. Route the approved task graph and obtain explicit approval for assignments
   and deviations.
4. Execute each routed wave in dependency order. Record provider results and
   check receipts, then require an authorized clean Git checkpoint before the
   next wave.
5. Revalidate the complete wave ledger and its committed path leases.
6. Run frozen dual implementation review, converge, implement remaining work,
   repeat strict review, then prove the final convergence audit did not stale
   its seal.
7. Produce an exact handoff with observed job IDs, checks, findings, residual
   risk, and unavailable usage fields stated as unavailable. Do not estimate
   provider usage.

During long jobs, poll `codex_worker_status` with bounded `waitMs` and the last
`afterRevision`. Show lifecycle facts and safe activity labels; never invent
percentages or an ETA.
