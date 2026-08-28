# BoundedRelay Adaptive SDD pack

This optional integration adds a fail-closed Spec Kit workflow for consumer
repositories that use Claude Code as coordinator and BoundedRelay as the local
Codex boundary. It is packaged with BoundedRelay but is not required by the MCP
runtime.

Routing is **adaptive and quality-first**, not a forced provider split. Hard
eligibility runs first, followed by a versioned task-kind fit policy. The
default 5,000-basis-point Codex share applies only to tasks still neutral after
fit and an eligible preferred-lane tie-break. A true 50/50 odd neutral tie gives
the extra task to Codex. A fit-specialized workload may correctly route 100% to
one lane. No share predicts tokens, cost, latency, or quality.

## What is enforced

1. The Claude host review is written and frozen before Codex starts. Its
   findings are never copied into the Codex reviewer prompt.
2. Strict gates call `codex_worker_sdd_review`, not generic analysis. The same
   clean Git revision and artifact digests must produce a current strict seal,
   and only `passed: true` / `status: ready` continues.
3. Task routing calls `codex_worker_sdd_route`; a manifest from the exact
   committed `tasks.md` requires every pending standard task ID exactly once.
   The approved plan-review revision must be its ancestor, `spec.md` and
   `plan.md` must be unchanged, and the full strict evidence is revalidated.
4. Verified routing creates `execution.json`. A bounded Spec Kit `do-while`
   executes the exact dependency waves in order, with at most one writer and a
   verified direct-child non-merge checkpoint commit between writer waves.
5. Every Codex write assignment is a bounded, revision-pinned proposal.
   BoundedRelay never integrates it into the source. The coordinator remains
   responsible for review and authorized integration.
6. High and Critical findings always block strict approval. Implementation and
   convergence each receive a fresh two-provider review.
7. Run evidence is bounded JSON, written by same-directory temporary file plus
   atomic rename. Validators reject unsafe IDs and paths, symlinks, non-regular
   files, oversized files, stale seals, missing assignments, invalid
   fingerprints, and incomplete gates.
8. Convergence audits but never implements. New pending tasks stop the current
   chain and require a fresh route; a no-change audit receives a no-delta
   review.
9. A final digest-only proof pack reruns the authoritative route, strict review
   validation, historical wave checks, and convergence freshness before binding
   the accepted evidence.
10. Handoff is drafted run-locally, proof-checked again in an isolated clone,
    and atomically published to the canonical path with idempotent retries.
11. An optional project profile is a tracked, bounded, regular non-symlink JSON
    file. Its exact bytes join plan, routing, implementation, convergence, and
    proof seals; a one-byte change invalidates the chain. Profile write policy
    can only narrow task leases, and the profile path itself is protected from
    every writer.

## Prerequisites

- Node.js supported by the installed BoundedRelay release.
- `boundedrelay` available on `PATH`, a working Codex CLI login, and the
  consumer repository inside `CCW_ALLOWED_ROOTS`.
- BoundedRelay configured to expose the SDD tools. Proposal mode is required
  only for routed Codex write tasks and remains opt-in.
- Spec Kit `>=1.0.1` initialized in the consumer repository with its Claude
  integration.
- Git. Strict reviews require the artifacts and implementation under review to
  be committed and the worktree clean. The workflow never creates those
  checkpoint commits.

Run `boundedrelay doctor` before installing the pack. Resolve the consumer
checkout with `codex_worker_workspace` and fix reported blockers rather than
widening policy blindly.

## Install from a checked-out BoundedRelay release

Run these commands from a consumer repository already initialized with Spec
Kit's Claude integration:

```bash
INTEGRATION_ROOT="$(boundedrelay sdd path)"
boundedrelay sdd validate
specify extension add "$INTEGRATION_ROOT/spec-kit/extension" --dev
specify workflow add "$INTEGRATION_ROOT/spec-kit/workflow" --dev
specify extension list
specify extension info boundedrelay-sdd
specify workflow list
specify workflow info boundedrelay-adaptive-sdd
```

`boundedrelay sdd validate` checks the packaged manifests and required assets
before Spec Kit registers them. The `--dev` operations reference these local
source directories, so the workflow keeps access to its companion scripts and
schemas.

Keep the integration files together: workflow shell steps locate `scripts/` and
`schemas/` relative to the installed workflow directory. Review the generated
consumer-repository diff before accepting it. Do not copy this repository's own
`.specify` directory into a consumer project.

For a local Claude Code session, use the official development loading path:

```bash
claude --plugin-dir "$INTEGRATION_ROOT/claude-code-plugin"
```

Inside Claude Code, run `/boundedrelay:setup`; use `/reload-plugins` after local
plugin edits. Persistent `claude plugin install` requires a published Claude
marketplace entry, which this source checkout does not pretend to provide. The
plugin's `.mcp.json` runs `boundedrelay serve` and intentionally contains no
Claude model field. If you already define a BoundedRelay MCP server, keep one
canonical server definition rather than launching duplicates.

Add this consumer-repository ignore rule before starting a workflow:

```gitignore
.specify/workflows/runs/
```

Run-local evidence may contain repository paths, findings, and job IDs. Do not
commit or publish it.

## Run it

Start the installed workflow with:

```bash
specify workflow run boundedrelay-adaptive-sdd \
  -i spec="Build the approved feature" \
  -i scope="packages/example" \
  -i feature_directory="specs/001-example" \
  -i codex_share=50 \
  -i project_profile=".boundedrelay/project-profile.json"
```

The inputs are:

- `spec`: the feature request;
- `scope`: the exact repository/package authority boundary;
- `feature_directory`: a safe repository-relative directory containing
  `spec.md`, `plan.md`, and later `tasks.md`;
- `codex_share`: the soft Codex share for fit-neutral effort, an integer percent
  with default `50`; it is not a quota;
- `project_profile`: optional safe repository-relative path to a committed
  BoundedRelay project-profile JSON file. Omit it to retain the legacy
  `sdd-routing-v2` behavior.

Create a starting profile with `boundedrelay profile template`, review and
restrict its allowed roots/checks/model policy for the consumer repository, then
validate the exact file with `boundedrelay profile validate`. The workflow uses
the authoritative schema-v2 router and records the normalized fingerprint,
executor, capability, required-check, and Codex-policy projections. Check `argv`
values are inert configuration: no integration script evaluates or executes
them. The host coordinator owns any reviewed command execution and must submit
digest-only receipts for the exact checkpoint tree.

At strict checkpoint gates, run the relevant repository checks and create or
explicitly authorize a normal review commit. Reject the gate if the worktree is
dirty. Approval prompts are human control points; they do not make invalid
evidence valid.

Every human rejection aborts the current run. Correct the artifact, code, route,
or checkpoint and start a fresh workflow run. Do not reuse the rejected run's
routing, execution, review, or proof evidence.

Spec Kit shell steps are not capability-sandboxed. This workflow keeps
unconstrained inputs out of shell `run` strings and passes only the
engine-generated, script-validated run ID. Review the workflow before executing
it; BoundedRelay's sandbox applies to Codex children, not arbitrary Spec Kit
shell commands.

Evidence is written under:

```text
.specify/workflows/runs/<run-id>/
  handoff-draft.md
  evidence/
    plan-review.json
    routing.json
    execution.json
    implementation-review.json
    convergence-review.json
    proof-pack.json
    handoff-context.json
  patches/
    <codex-writer-task-id>.patch
```

The scripts expose preparation and verification operations; the execution
validator additionally verifies an active wave, complete execution, or
historical checkpoints. Provider calls happen in Claude Code, not in the
scripts, so fixtures and CI can test the pack without credentials or paid calls.

Before routing, the engine parses standard checkbox IDs (`T###` or longer) from
the committed `tasks.md`, sorts them canonically, and seals their completion
state in a manifest. Assignments must cover every incomplete ID exactly once;
missing, duplicate, completed, or invented IDs fail. The plan-review commit must
be an ancestor of this checkpoint, with unchanged `spec.md` and `plan.md`, and
its complete strict provider evidence is revalidated rather than trusted by
verdict alone.

Every verified route enters the same execution path, including a best-fit route
whose implementation tasks all use one lane. Within a wave, dependencies must
already be complete in earlier waves; ready read-only tasks run in canonical
task-ID order before the single possible writer. A writer requires redacted
coordinator-attested check receipts containing command/output digests, a zero
exit code, and `testedTree`. Each receipt must name the exact checkpoint tree.
These records are not signed CI attestations, include no raw output, and do not
independently prove command execution.

For a Codex writer, the exact proposal patch bytes are persisted only under the
ignored run-local `patches/<task-id>.patch` with owner-only permissions. The
validator recomputes the digest, applies the bytes to a disposable Git index at
the active baseline, and requires the resulting tree to equal the checkpoint
tree. The source worktree is not the validation target. The checkpoint must be
exactly one non-merge commit whose sole parent is the active baseline. Claude
Code or the human coordinator integrates; BoundedRelay never integrates into the
source, commits, merges, pushes, publishes, or deploys a patch.

Every Codex execution result records `model` and `reasoningEffort`, including
`null` for independently routed defaults; both must exactly match its routed
model policy. A no-profile legacy critical route keeps the allowlisted
`gpt-5.6-sol` / `ultra` requirement.

With a project profile, each Codex implementation or Claude-task Codex
cross-review is bound to the exact routed profile model and reasoning effort.
Writer results must cover every routed required-check ID with a successful
tree-bound receipt whose profile ID, cwd, and command digest match the sealed
definition. A task may require at most 64 receipts, while this optional Spec Kit
workflow rejects more than 256 required writer receipts across the whole route
before execution. Execution separately caps all recorded writer receipts at 256
across the run, including optional profile-defined receipts, and refuses the
wave that would record receipt 257 before it creates a checkpoint. Receipts for
undefined profile checks are rejected. The integration never launches the
profile's command arguments itself.

Implementation review is bound to verified execution and compares the routing
base revision with final `HEAD`; more than 256 changed paths is rejected.
Convergence is fail-closed and has no direct implementation step. If its audit
adds pending tasks or changes reviewed state, the run stops and those tasks need
a fresh route and wave execution. Only no new work proceeds to a no-delta review
at the approved implementation revision. Each dual review moves through
`pending` to `claude-frozen` to `complete`, and the Codex stage cannot alter or
see the frozen host findings. High and Critical findings always block approval.
For implementation and convergence, the frozen host review ID binds the
run/phase, nonce, sealed revision, source-evidence digest, check digest, and
prepared Codex review policy. Convergence receipts must name its sealed Git
tree.

Proof-pack assembly and immediate verification rerun the authoritative route,
statically exact-match every routing projection, revalidate strict dual-review
checks and historical waves, exact-match the execution-to-implementation and
implementation-to-convergence source chains, and recompute current convergence
freshness. The proof pack is a digest index, not an append-only audit ledger or
a claim that the result is correct.

Claude then writes only the run-local `handoff-draft.md`. The verifier rechecks
the proof at the final revision inside an isolated Git clone, validates the
draft's exact binding marker, and atomically publishes
`.specify/agents/HANDOFF.md`. Retrying the same verified draft is idempotent;
the mechanism is not a signature or durable audit ledger.

## Model policy

Claude Code chooses its own host model. The plugin and workflow never select
Opus, Sonnet, or any other Claude model. Codex models come only from the
server-owned allowlist; omitting a model uses the server default. A critical
no-profile route requires an explicitly allowlisted `gpt-5.6-sol` with `ultra`
reasoning on its Codex execution or review lane. A project profile instead must
declare an explicit non-null model and effort in `codexPolicy.byRisk.critical`;
the authoritative router binds that exact policy and the plan-level
`crossReviewPolicy`, and the server allowlist still decides availability. The
other provider remains an independent reviewer. If the required policy is
unavailable, stop and report the blocker; never downgrade silently.

## Recovery and removal

- If a validator reports stale evidence, do not edit the seal. Recreate the
  clean checkpoint and start a fresh corrected run so Claude then Codex review
  the new evidence in that order.
- If the MCP server restarts, its jobs disappear. Submit a fresh idempotent
  review or proposal in a fresh workflow run; do not manufacture missing
  terminal evidence.
- If routing changes, start a fresh run and regenerate both `routing.json` and
  `execution.json`; their digest binding prevents replay.
- If convergence adds tasks, preserve them and start a fresh routed run; never
  implement them or continue the old evidence chain.
- If handoff verification fails, correct the run-local draft or stale proof and
  retry. The canonical handoff is not replaced until verification succeeds.
- To remove the integration, uninstall the workflow, extension, and Claude
  plugin through their respective managers, then delete ignored run evidence.
  BoundedRelay itself continues to work.

This pack improves separation of duties and evidence quality; it does not prove
either model is correct, turn local receipts/model metadata into signed
attestations, prove who authored a checkpoint tree, replace repository
tests/security review, or remove human accountability.

## License and attribution

The integration files are original BoundedRelay material covered by this
repository's MIT license. They do not vendor Spec Kit or Claude Code source,
templates, logos, or generated agent files. “Spec Kit”, “Claude Code”, and
“Codex” identify compatible external products; their use here does not imply
endorsement. Install those products separately under their own terms.
