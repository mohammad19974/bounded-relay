# Optional Spec Kit integration

BoundedRelay does not require Spec Kit. This guide adds Spec Kit to a **consumer
repository** and uses BoundedRelay as an independent Codex reviewer at the
points where a second model has the most leverage.

This division keeps ownership clear:

- Spec Kit owns durable `spec.md`, `plan.md`, and `tasks.md` artifacts in the
  consumer repository.
- Claude Code owns orchestration and final integration decisions.
- BoundedRelay gives Codex bounded read-only review jobs and observable status.
- Neither Codex nor BoundedRelay silently approves or edits Spec Kit artifacts.

## When it is worth using

Use Spec Kit for a feature with meaningful ambiguity, architecture decisions,
multiple dependent tasks, security or compatibility constraints, or more than
one implementation phase. For a tiny typo or one-line fix, the artifact cost is
usually unnecessary.

Spec Kit is not vendored into BoundedRelay itself because it would add a second
governance system and installation dependency to a deliberately small runtime.

## Install a pinned Spec Kit release

The commands below pin the official `v1.0.1` release, which was the latest
release when this guide was verified on 2026-08-27. Check the
[official releases](https://github.com/github/spec-kit/releases/latest) before
adopting or upgrading it.

Install [uv](https://docs.astral.sh/uv/) first, then:

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.0.1
specify --version
```

For an existing non-empty consumer repository, first create a reviewable Git
baseline. Then run from its root:

```bash
specify init --here --force --integration claude
```

`--force` permits initialization in a non-empty directory and may replace files
at conflicting managed paths. Review the generated diff before proceeding. The
official
[existing-project guide](https://github.com/github/spec-kit/blob/main/docs/guides/existing-projects.md)
explains this brownfield workflow.

## Recommended three-gate review workflow

The full path is:

```text
/speckit.constitution → /speckit.specify → /speckit.clarify → /speckit.plan
                                                        ↓
                                                Codex plan review
                                                        ↓
/speckit.checklist → /speckit.tasks → /speckit.analyze
                                                        ↓
                                             Codex artifact review
                                                        ↓
/speckit.implement → project checks → Claude diff review
                                                        ↓
                                        Codex implementation review
                                                        ↓
                 /speckit.converge → project verification → project handoff
```

This guide initializes Spec Kit's Claude integration, so it uses the official
slash commands installed there, including `/speckit.plan`, `/speckit.tasks`,
`/speckit.analyze`, `/speckit.implement`, and `/speckit.converge`. Verification
and handoff are delivery steps owned by the consumer repository; this guide does
not present those two steps as Spec Kit commands.

## Choose the review mode before each gate

Use one explicit mode and record it with the review evidence:

- **Strict review:** commit every artifact and code surface being reviewed, call
  `codex_worker_workspace`, require `clean: true`, and record its full
  `revision` as both the reviewed HEAD and artifact revision. If HEAD or any
  reviewed artifact changes, invalidate the review and run that gate again.
  After the Codex result returns, resolve the workspace again and accept the
  evidence only if `clean` remains `true` and `revision` is unchanged. For Gate
  3, also record the approved pre-implementation revision so the committed
  implementation range is reviewable.
- **Draft review:** uncommitted artifacts or a dirty workspace may be inspected
  for early feedback. Record the review as unpinned and advisory. It cannot
  approve implementation, release, or any gate that requires frozen evidence.

In strict mode, stop before submission when `clean` is not `true`. The fact that
an artifact path has the same name is not enough; its committed revision must
match the revision recorded for the review. BoundedRelay does not lock the
consumer repository during an analysis job, so the coordinator must keep the
reviewed checkout unchanged for the duration of a strict gate.

### Gate 1: plan review

After `/speckit.plan`, select strict or draft mode and ask Claude to submit a
read-only Codex analysis:

```text
Use bounded-relay for an independent plan review. First resolve the workspace. In strict mode,
stop unless clean is true and record the returned revision as the reviewed HEAD and artifact
revision. Read the active feature's spec.md and plan.md, plus only the repository rules and
architecture files they reference. Check requirement coverage, security boundaries, ownership,
compatibility, test strategy, and unnecessary complexity. Return severity-ranked findings with
exact artifact locations. Do not edit files.
```

Claude should resolve the workspace, submit the job, and poll
`codex_worker_status` with the last observed `revision` as `afterRevision`.
Claude then decides which findings are valid and updates the owning Spec Kit
artifact before tasks are generated.

### Gate 2: cross-artifact review

After `/speckit.tasks` and the built-in read-only `/speckit.analyze` pass, apply
the selected review mode again:

```text
Ask bounded-relay to review spec.md, plan.md, and tasks.md as one contract.
Identify missing requirements, conflicting decisions, unowned work, unsafe parallel tasks,
and verification gaps. Do not implement or modify artifacts.
```

This is intentionally independent of the first review. Do not paste the first
model's conclusion into the prompt as an assumed truth.

### Gate 3: implementation review

After `/speckit.implement` and the consumer repository's own checks pass, apply
the selected review mode again:

```text
Use bounded-relay for a read-only implementation review against spec.md, plan.md, and tasks.md.
In strict mode, inspect the committed diff from the recorded approved pre-implementation revision
to the reviewed HEAD. In draft mode, inspect the current working-tree diff. Inspect relevant tests
and report correctness, security, regression, contract, and missing-verification findings. Do not
edit, apply, commit, push, or deploy anything.
```

Claude owns the final decision, repairs, `/speckit.converge`, project
verification, and handoff. This three-gate pattern adds independent review
coverage only when the scopes are explicit and findings are reconciled against
repository evidence.

## Token and latency discipline

- Delegate bounded questions, not the entire project history.
- Point Codex to exact artifact paths and relevant architecture files.
- Use `afterRevision` with a bounded `waitMs` instead of repeatedly requesting
  unchanged status.
- Retrieve the final result once. Do not ask both models to regenerate the same
  implementation without a concrete comparison goal.
- Use a smaller/faster allowlisted model for narrow checks only when evaluated
  evidence shows it is adequate; do not auto-route by marketing labels.

## Proposal mode with Spec Kit

Read-only review is the recommended default. If proposal mode is enabled, scope
`writePaths` to implementation and test directories. Keep Spec Kit artifacts out
of the proposal scope unless the task explicitly authorizes updating them. The
returned patch remains an artifact for review; BoundedRelay does not apply it.

## What this integration does not guarantee

- Agreement between models is not proof of correctness.
- Disagreement is not automatically a defect.
- More model calls do not guarantee better code or lower total tokens.
- Spec Kit artifacts can still encode incorrect assumptions.
- Repository tests, security review, and human accountability remain required.

For the official sequence and quality gates, read Spec Kit's
[Agentic SDD reference](https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md).
