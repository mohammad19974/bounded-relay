# Independent Review of a Frozen Plan

This recipe uses the specialized SDD review path so Claude host evidence and a
fresh Codex decision are tied to one current content-addressed seal.

## Preconditions

- Claude Code reviewed the plan independently and completed its structured
  findings before invoking Codex.
- Every reviewed strict-mode artifact is committed and the worktree is clean.
- `codex_worker_workspace` returned the exact full Git revision.
- The host findings refer only to files included in `artifactPaths`.

## Coordinator prompt

```text
Perform a strict dual plan review through bounded-relay without editing files.

1. Call codex_worker_workspace. Stop unless clean=true and record the exact full revision.
2. Review the active spec.md and plan.md yourself. Produce a bounded reviewId, verdict, summary,
   and structured findings, then freeze them before starting Codex.
3. Call codex_worker_sdd_review with phase=plan, mode=strict, those exact artifactPaths,
   expectedRevision equal to the inspected revision, and the frozen hostReview.
4. Keep focus neutral. Do not copy the host summary or findings into focus or another Codex prompt.
5. Poll codex_worker_status with bounded waitMs and the last afterRevision until terminal.
6. Retrieve codex_worker_result. Continue only if review.gate.passed=true and
   review.gate.status=ready.
7. If either review requests changes, repair the owning artifacts, create a new authorized clean
   checkpoint, and repeat both reviews. Never reuse the old seal.
```

## Strict versus draft

- **Strict** requires a clean tree and full `expectedRevision`. Both approvals
  must match one current seal. It is the only mode that can return a ready gate.
- **Draft** can inspect a dirty or uncommitted plan for early feedback, but the
  returned gate remains advisory and cannot authorize implementation.

A generic `codex_worker_analyze` call cannot satisfy a strict gate even if its
prompt asks for the same review.

## What the worker enforces

- safe repository-relative regular artifacts with bounded sizes;
- exact revision, clean-state fingerprint, artifact sizes and SHA-256 digests;
- host evidence normalization and digest before Codex starts;
- exclusion of host conclusions from the Codex prompt;
- a detached origin-free clone proven to match the strict seal, followed by a
  fresh, ephemeral, read-only Codex run with approvals disabled and a JSON
  output schema;
- final freshness recheck and a fail-closed dual-review verdict.

## What remains outside the proof

- the host's declared Claude model identity and completeness of its review;
- the correctness of either reviewer's conclusions;
- writes by unrelated tools after the gate result;
- production readiness without repository checks and human accountability.

Changing one reviewed byte, HEAD, clean state, phase, or evidence record makes
the approval unusable. Recover by reviewing the new state from the beginning.
