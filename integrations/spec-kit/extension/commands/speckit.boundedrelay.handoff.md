---
description: "Write an exact provider-aware continuation handoff"
---

# Refresh the Consumer Handoff

After all review and convergence gates pass, write the proposed handoff only to
the run-local `handoff-draft.md` named by `evidence/handoff-context.json`. Do
not edit `.specify/agents/HANDOFF.md` directly. The following verifier
revalidates the complete proof chain and atomically publishes the draft to that
canonical path only after every binding check passes.

Record objective, scope, active artifacts, frozen revision, routing target and
actual effort split, Claude-host and Codex task ownership, accepted patches,
changed files, checks and outcomes, review evidence paths, blockers, next exact
action, and rollback notes. Distinguish estimated effort from observed Codex
usage; do not invent Claude token use, cost savings, percentages complete, or
model identity. Never store prompts, raw output, credentials, private payloads,
or chain-of-thought.

Read the run-local `evidence/handoff-context.json` named in `$ARGUMENTS` and
place its exact `marker` once, unchanged, on the standalone final line of the
draft. Replace any older `boundedrelay-handoff-v1` marker in that draft. The
following verifier rejects a missing, duplicated, stale, or manually
reconstructed proof binding.

This command does not commit, push, publish, deploy, or modify an external
system.

```text
$ARGUMENTS
```
