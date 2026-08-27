# Independent Review of a Frozen Plan

This recipe gives Claude Code a Codex review tied to one exact plan revision.
The worker records the Git revision and Codex result; it does not
cryptographically attest that Claude performed a separate review.

## Preconditions

- Claude Code has reviewed the plan independently before reading Codex's
  conclusions.
- The worker is connected in analyze-only mode; proposals are unnecessary.

## Review modes

- **Strict:** commit the plan and every referenced artifact, require
  `codex_worker_workspace` to return `clean: true`, and record the full
  `revision` as both the reviewed HEAD and artifact revision. Any HEAD or
  reviewed-artifact change invalidates both reviews.
- **Draft:** a dirty workspace is allowed for early feedback, but the findings
  are unpinned and advisory. They do not satisfy a frozen-plan gate or authorize
  implementation.

## Coordinator prompt

```text
Perform a two-viewpoint plan review without editing files.

1. Resolve the workspace and state whether this is a strict or draft review.
   For strict review, stop unless clean is true and record the exact revision as both the reviewed
   HEAD and artifact revision.
2. Read and review docs/plan.md yourself. Freeze your findings before invoking Codex.
3. Submit a codex_worker_analyze job asking Codex to review docs/plan.md against the requirements
   and current source at that revision.
4. Poll with bounded waits and the last revision as afterRevision until terminal, then retrieve
   the result.
5. In strict mode, resolve the workspace again and reject the evidence unless clean remains true
   and the exact revision is unchanged.
6. Compare the two reviews by requirement, evidence, severity, and next action.
7. If Git HEAD or any reviewed artifact changes, mark both reviews stale and restart the review
   cycle.
```

## What the worker proves

- the canonical repository and Git revision used by the Codex job;
- the worker policy and job lifecycle it observed;
- Codex's final message and reported usage when available.

## What it does not prove

- that Claude's review was independent or complete;
- that either reviewer is correct;
- that a plan file did not change outside the pinned Git history if the job
  intentionally analyzes a dirty worktree;
- readiness to implement.

For a strict frozen-plan gate, the recorded `clean: true` snapshot, reviewed
HEAD, and artifact revision must describe the same committed state. After any
change, obtain two new reviews.
