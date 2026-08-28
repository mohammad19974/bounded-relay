---
description:
  "Freeze Claude host findings before an independent BoundedRelay Codex plan
  review"
---

# BoundedRelay Dual Plan Review

Run the requested phase from `$ARGUMENTS`. This command may update only the
run-local `plan-review.json` named by the workflow run ID. It never edits the
plan, source, Git state, or an external system.

## `phase=claude`

1. Read the pending evidence, its `revision.seal`, and every exact path in
   `revision.artifacts`. This is `spec.md` and `plan.md`, plus the configured
   `project_profile` when present.
2. Review requirement coverage, architecture, security, compatibility,
   ownership, rollback, and verification yourself. Do not call BoundedRelay or
   read Codex output during this phase.
3. Preserve every engine-owned field. Set `state` to `claude-frozen`, add one
   completed `claudeReview`, and leave `codexReview` and `reconciliation` null.
   The following verifier stamps the engine-owned context-bound `reviewId`;
   preserve that exact value when submitting `hostReview` to BoundedRelay.
4. Set `modelSource` to `host-selected` and `model` to null unless Claude Code
   exposes a trustworthy current model identifier. Never choose or claim Opus,
   Sonnet, or another Claude model here.
5. Replace the evidence atomically through a same-directory temporary regular
   file and rename.

## `phase=codex`

Proceed only after the engine has verified `claude-frozen` evidence.

1. Re-read the evidence without changing the Claude review.
2. Call `codex_worker_workspace`; strict review stops unless the tree is clean
   and its full revision equals `revision.head`.
3. Submit exactly one `codex_worker_sdd_review` with `phase: plan`,
   `mode: strict`, every exact sealed artifact path (including a configured
   project profile), `expectedRevision`, and the already-frozen host evidence.
   Do not use `codex_worker_analyze` as a strict-gate substitute. Do not include
   Claude findings in `focus` or any Codex prompt; BoundedRelay accepts host
   evidence for the gate but keeps it out of the Codex reviewer prompt. Omit
   `model` to use server policy unless an allowlisted profile is explicitly
   required.
4. Poll `codex_worker_status` with bounded waits and `afterRevision`, then
   retrieve the result once.
5. Re-resolve the workspace. Reject the result if HEAD or the reviewed artifacts
   changed.
6. Persist the returned strict seal, host evidence digest, structured Codex
   evidence, and gate. A result satisfies this phase only when `gate.passed` is
   true and `gate.status` is `ready` for the same seal. Add the real job ID and
   reconcile by evidence, not agreement.
7. Any High or Critical finding is blocking regardless of a model's stated
   verdict. Resolve it on a new revision and run both reviews again; never
   disposition it inside the frozen evidence.
8. Atomically replace the evidence. Never expose raw reasoning, prompts,
   credentials, or event data.

Requested phase and workflow metadata:

```text
$ARGUMENTS
```
