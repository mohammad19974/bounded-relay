# Adaptive Spec Kit and Claude Code integration

BoundedRelay ships an optional Adaptive SDD integration for consumer
repositories. It combines Spec Kit artifacts, Claude Code coordination,
quality-first task routing, content-addressed dual review, isolated Codex
proposals, convergence, and an exact handoff.

Spec Kit is not an MCP runtime dependency. This BoundedRelay source repository
uses its own `.specify/` governance, but consumers must initialize and own their
own Spec Kit workspace. Never copy this repository's `.specify/` directory into
another project.

## What is packaged

`integrations/spec-kit/` contains:

- the `boundedrelay-sdd` Spec Kit extension and its five coordinator commands;
- the `boundedrelay-adaptive-sdd` workflow;
- bounded JSON evidence schemas;
- separate prepare/verify scripts for plan review, routing, wave-ordered
  execution, implementation review, convergence review, and final proof-pack
  assembly.

`integrations/claude-code-plugin/` contains a Claude Code plugin manifest, an
MCP declaration that runs `boundedrelay serve`, and setup/Adaptive SDD skills.

These assets are original BoundedRelay material. They do not vendor Spec Kit or
Claude Code source. Nothing activates or installs them when the MCP server
starts.

## Prerequisites

- a built BoundedRelay checkout; the package is not published to npm yet;
- Node.js supported by the checked-out package;
- Git and a working local Codex CLI login;
- a consumer repository inside `CCW_ALLOWED_ROOTS`;
- Spec Kit `>=1.0.1` initialized with its Claude integration;
- Claude Code for the optional host plugin and coordinator commands;
- `CCW_ENABLE_PROPOSALS=true` only when a routed Codex task requires writes.

Strict gates also require an explicitly authorized committed checkpoint and a
clean worktree. The workflow never creates commits itself.

## 1. Build and expose the local worker

From the BoundedRelay checkout:

```bash
npm ci
npm run check
npm link

boundedrelay doctor
boundedrelay sdd validate
INTEGRATION_ROOT="$(boundedrelay sdd path)"
```

`sdd validate` checks required regular files and parses packaged JSON manifests.
It does not modify a consumer repository, invoke Spec Kit, call either provider,
or validate the plugin with Claude Code.

`npm link` makes the local `boundedrelay` executable available to the optional
plugin's `.mcp.json`. If you use only the direct absolute-path MCP registration
from the [getting-started guide](../getting-started.md), a global link is not
required.

## 2. Initialize the consumer Spec Kit workspace

Install Spec Kit using its official instructions and verify the version:

```bash
specify --version
```

For a reviewed existing repository, create an appropriate Git baseline, then
initialize from its root:

```bash
specify init --here --force --integration claude
```

`--force` can replace conflicting managed files in a non-empty repository.
Inspect the resulting diff before accepting it. See Spec Kit's
[existing-project guide](https://github.com/github/spec-kit/blob/main/docs/guides/existing-projects.md).

Add run-local evidence to the consumer repository's `.gitignore`:

```gitignore
.specify/workflows/runs/
```

That evidence can contain paths, findings, digests, and job IDs. Do not commit
or publish it.

## 3. Add the local extension and workflow

Run these commands from the initialized consumer repository while
`INTEGRATION_ROOT` still points to the checked-out BoundedRelay pack:

```bash
specify extension add "$INTEGRATION_ROOT/spec-kit/extension" --dev
specify workflow add "$INTEGRATION_ROOT/spec-kit/workflow" --dev

specify extension list
specify extension info boundedrelay-sdd
specify workflow list
specify workflow info boundedrelay-adaptive-sdd
```

`--dev` references the local source directories. Keep the checkout at that path
while using the integration. The authoritative syntax is covered by Spec Kit's
[extension reference](https://github.com/github/spec-kit/blob/main/docs/reference/extensions.md)
and
[workflow reference](https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md).

## 4. Validate and load the optional Claude Code plugin

The plugin intentionally contains no Claude model field. It keeps whatever model
the user selected in Claude Code.

On a machine with Claude Code installed:

```bash
claude plugin validate "$INTEGRATION_ROOT/claude-code-plugin"
claude --plugin-dir "$INTEGRATION_ROOT/claude-code-plugin"
```

The first command is host-side validation; the second loads the local plugin for
that Claude Code session. Follow Claude Code's
[plugin documentation](https://code.claude.com/docs/en/plugins) for persistent
distribution options.

The plugin already declares the BoundedRelay MCP server. If the same Claude Code
session has a direct `bounded-relay` registration, keep one canonical definition
instead of launching duplicate server processes with separate queues and
process-memory histories.

Automated BoundedRelay tests intentionally do not require Claude Code or paid
provider calls. Therefore `npm run check` and `boundedrelay sdd validate` do not
prove that a particular Claude Code installation accepted the plugin. Direct MCP
registration remains a supported alternative.

## 5. Run the workflow

Start it with explicit feature and authority inputs:

```bash
specify workflow run boundedrelay-adaptive-sdd \
  -i spec="Implement the approved feature contract" \
  -i scope="apps/api and packages/contracts" \
  -i feature_directory="specs/001-example" \
  -i codex_share=50
```

The workflow follows this sequence:

```text
specify -> clarify -> approve spec -> plan -> clean checkpoint
  -> freeze Claude plan review -> fresh strict Codex plan review -> approve gate
  -> checklist -> tasks -> analyze -> approve task graph
  -> commit standard tasks.md manifest -> adaptive route every pending ID exactly once
  -> verify and approve assignments -> prepare execution.json
  -> do-while dependency waves: read-only tasks -> one writer -> checks
     -> human inspection -> one direct-child non-merge commit -> verify tree
  -> compare routing base to final HEAD -> strict dual implementation review
  -> fail-closed convergence audit: no direct implementation
     -> if new tasks: stop and start a fresh routed run
     -> if no new work: no-delta strict dual convergence review
  -> final convergence freshness check -> revalidated digest-only proof pack
  -> run-local handoff draft -> isolated proof recheck -> atomic canonical handoff
```

Human gates authorize continuation but cannot make invalid evidence valid. The
prepare/verify scripts do not call a provider. Claude Code performs provider
calls through the packaged commands and BoundedRelay tools, then the scripts
validate the bounded evidence separately.

Every packaged gate uses `on_reject: abort`. A rejection terminates the current
evidence chain: correct the artifacts, code, task graph, or route, then start a
fresh workflow run. Reusing rejected routing, execution, review, or proof
evidence is not a recovery path.

Spec Kit's official workflow reference warns that shell steps run with the
user's privileges and have no capability sandbox. This pack keeps unconstrained
workflow inputs out of every shell `run` field: shell steps receive only the
engine-generated run ID, which each script validates again. Review the installed
workflow before running it; BoundedRelay constrains its own Codex subprocesses,
not arbitrary third-party Spec Kit shell steps.

## Routing contract

Routing starts from a content-addressed manifest parsed from the exact committed
`tasks.md` at the routing revision. Every checkbox task must use a standard
`T###` identifier (three or more digits); IDs must be unique, and only
incomplete IDs enter `pendingTaskIds`. The normalized route must cover those
pending IDs in canonical order exactly once. Missing, duplicate, completed, or
invented assignments fail verification.

The task checkpoint may descend from the approved plan review, but the reviewed
revision must remain its Git ancestor and the committed `spec.md` and `plan.md`
bytes must be unchanged. Routing revalidates the entire historical strict plan
review—including both frozen provider records, their projections, provenance,
ordering, seal, and reconciliation—rather than trusting only its verdict or
digest.

The workflow calls `codex_worker_sdd_route`. Its default `codex_share=50` maps
to `neutralCodexShareBps=5000`. It is neutral metadata, not a quota. The router
first selects the lanes that best fit the tasks; it consults the share only
after fit and an applicable exact-fit preference tie.

Candidates are compared in this order:

1. hard eligibility and validated safety, dependency, authority, and scope
   constraints;
2. minimum regret against versioned task-kind lane fit;
3. explicit `preferredLane`, only for an exact base-fit tie;
4. smallest estimated-effort deviation from the neutral Codex share;
5. smallest task-count deviation from that same share;
6. at a true neutral 50/50 odd tie, the extra task goes to Codex;
7. lexical task-ID tie-break.

The result records normalized tasks, assignments, safe waves, reason codes,
balance/deviation metrics, a policy version, and a SHA-256 plan fingerprint.
Each wave has at most one writer. Multiple ready read-only tasks may share a
wave.

Risk does not bias lane fit. A critical task instead activates the
cross-provider review and explicit Codex profile policy described below. The
actual share may be anywhere from 0% to 100% when eligibility or task fit
requires it. `effortPoints` are planning estimates. The route is not a claim or
guarantee about tokens, monetary cost, latency, provider quota, quality, or
resource savings.

An all-host or all-Codex best-fit implementation route is valid. Every verified
route still becomes `execution.json` and passes through the same wave,
checkpoint, implementation-review, convergence-review, and proof-pack
validators. Codex remains the independent reviewer at the required strict gates
even when it owns no implementation task.

Each Codex execution result records `model` and `reasoningEffort`, including
`null` for a routed server default. Wave validation exact-matches both fields to
the assignment's routed model policy; a syntactically valid but different
profile is rejected.

## Model contract

`claude-host` means the current Claude Code session. BoundedRelay never launches
Claude, calls Anthropic, chooses Opus/Sonnet, or infers a model from task type.
A host model label is optional host-declared metadata, not a verified identity.

Codex model overrides remain server-owned and explicit. Omit `model` to use the
worker's Codex default, or list exact allowed values in `CCW_ALLOWED_MODELS`.
The packaged critical-task evidence policy requires an independent reviewer from
the other provider and one Codex lane configured as:

```json
{
  "source": "server-allowlisted",
  "model": "gpt-5.6-sol",
  "reasoningEffort": "ultra"
}
```

This profile must be explicitly allowlisted and available to the local Codex
CLI/account. If it is unavailable or rejected, stop and report the blocker. The
workflow does not downgrade the model or effort and does not replace the user's
Claude model. In particular, a critical task assigned to `claude-host` forces
the Codex implementation/convergence cross-review policy to this `gpt-5.6-sol` /
`ultra` profile.

## Strict dual-review contract

Plan, implementation, and convergence checkpoints use `codex_worker_sdd_review`,
never generic analysis. The enforced sequence is:

1. Create an authorized commit containing every artifact/code surface under
   review and require a clean worktree.
2. Claude Code reviews independently and freezes its structured evidence.
3. Submit exact artifact paths, full `expectedRevision`, and frozen `hostReview`
   to `codex_worker_sdd_review`.
4. BoundedRelay seals the revision, workspace fingerprint, artifact sizes, and
   SHA-256 digests before starting Codex.
5. BoundedRelay hashes host evidence but excludes its summary and findings from
   the Codex prompt and `focus`.
6. BoundedRelay creates a detached origin-free clone proven to match the strict
   seal; Codex runs there fresh, ephemeral, read-only, approval-free, and
   constrained by the packaged output schema.
7. Finalization rechecks the workspace and artifacts. Continue only when
   `review.gate.passed` is `true` and `review.gate.status` is `ready`.

Each evidence document advances through `pending` to `claude-frozen` to
`complete`. The verifier accepts each transition separately; the host cannot
write Codex evidence early, and the Codex stage cannot replace frozen host
evidence. For implementation and convergence, the derived frozen host review ID
binds the run and phase, nonce, sealed revision, source-evidence digest, check
digest, and prepared Codex review policy. The plan-review ID binds the
applicable run, phase, nonce, and revision context.

Any reviewed byte, Git revision, clean state, policy, phase, or evidence
mismatch makes approval unusable. Missing, empty, malformed, fenced, truncated,
unavailable, cancelled, stale, or non-approving evidence fails closed. A
completed review job can still have a blocked or stale gate.

An unresolved `high` or `critical` finding always invalidates an approving
provider record and blocks the strict gate, even if a model labels its own
verdict approved. Fix the underlying artifact on a new revision and start a
fresh review chain; findings cannot be waived by editing frozen evidence.

Draft `codex_worker_sdd_review` calls are useful for early feedback on a dirty
checkout, but draft evidence is advisory and never passes a gate. A normal
`codex_worker_analyze` call cannot satisfy a strict gate under any mode.

## Routed execution and one-writer safety

After `routing.mjs verify` accepts `routing.json`, `execution.mjs prepare`
requires a clean worktree at the exact approved routing revision and creates
`execution.json`. Spec Kit then runs a bounded `do-while` over the router's
canonical contiguous waves. Execution follows these enforced rules:

1. A task may start only after every dependency has a result in an earlier wave,
   and the dependency completion timestamp must precede the task start.
2. Read-only tasks in the active wave run first in canonical task-ID order. They
   record bounded verification statements and no write evidence.
3. The active wave may have at most one writer. A Claude-host writer uses only
   its routed lease. A Codex writer calls `codex_worker_propose` against the
   active baseline and routed write paths.
4. Claude Code or the human coordinator inspects and integrates a Codex patch as
   the sole writer. BoundedRelay returns the proposal artifact but never
   integrates it into the source, commits, merges, pushes, publishes, or deploys
   it.
5. The exact returned Codex patch bytes are persisted only at the ignored
   run-local `patches/<task-id>.patch` with owner-only permissions. The
   validator recomputes its SHA-256 digest, applies the bytes to a disposable
   Git index loaded from the active baseline, and requires the produced tree to
   equal the checkpoint commit's tree. This validation application never writes
   the source worktree.
6. Every writer records typed host-executed check receipts: a safe profile and
   label, hashes of the exact command and its stdout/stderr, relative working
   directory, zero exit code, timestamps, and `testedTree`. Writer receipts must
   name the exact checkpoint tree. Raw output, environment values, credentials,
   and tokens are excluded. These are redacted coordinator-attested digest
   records, not signed CI attestations, and they do not independently prove
   command execution.
7. The human gate inspects the wave. If it wrote code, the human authorizes one
   non-merge commit whose sole parent is the active baseline; a read-only wave
   keeps the baseline revision unchanged. Wave verification requires a clean
   worktree, an exact committed diff and tree matching the writer's changed
   paths and lease, and result/check digests. The next wave's baseline is that
   completed revision.

The complete validator replays dependency order and every historical checkpoint
before implementation review. Paused workflow execution is resumable: the
command recognizes already-recorded complete results for the active wave instead
of repeating provider work.

Codex CLI `ultra` may coordinate internal read-only Codex subagents inside one
invocation. They inherit the same root, sandbox, and authority; the parent
invocation remains the only Codex proposal writer. Cross-provider recursion and
nested BoundedRelay workers remain prohibited.

## Run evidence

Evidence is written under the ignored consumer path:

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

Writers use same-directory temporary files and atomic rename. Validators reject
unsafe IDs/paths, symlinks, non-regular or oversized files, missing assignments,
stale revisions, mismatched fingerprints, invalid critical profiles, incomplete
or out-of-order waves, patch-byte digest mismatches, invalid check receipts, and
failed gates. Run evidence is operational state, not a durable or cryptographic
audit ledger.

Implementation review seals the full diff from the approved routing base
revision to final `HEAD`. A review scope above 256 changed paths is rejected and
must be split. Convergence is fail-closed and cannot implement remaining work in
the same run. If its audit appends tasks or otherwise changes the reviewed
state, verification stops and the new pending IDs require a fresh approved route
and wave execution. Only a no-change result proceeds: convergence review is then
a no-delta audit whose head and comparison base both equal the approved
implementation-review revision. Every convergence check receipt must name that
exact sealed Git tree.

`proof-pack.json` is assembled only after four independent revalidation paths
pass: static routing validation reruns the authoritative `sdd route` command and
exact-matches its complete projected assignments, policies, totals, and
deviations; all plan, implementation, and convergence strict evidence remains
approved and content-addressed; `execution.mjs verify-history` replays every
historical wave and checkpoint without requiring `HEAD` to move backward; and
the convergence comparison is recomputed against the current clean repository
state. The pack also exact-matches execution's digest, final revision, and
copied check receipts into implementation review, then the implementation-review
digest and revision into convergence review.

Only after those checks does the pack index policy versions, route fingerprint,
routing totals, evidence-file digests, revision seals, accepted Codex job IDs,
proposal patch digests, checkpoint digests, and check-receipt digests under one
bundle fingerprint.

The proof pack excludes patch bytes, prompts, raw provider output, credentials,
findings text, and chain-of-thought. It detects changed evidence bytes; it does
not prove semantic correctness, survive deletion, or provide append-only ledger
guarantees.

After delivery approval, Claude writes the continuation only to the run-local
`handoff-draft.md` and includes the exact marker prepared in
`handoff-context.json`. Verification clones the final Git revision without local
hardlinks, copies only that run evidence into the clone, and reruns proof
verification in isolation. It then checks the current revision and marker and
atomically replaces `.specify/agents/HANDOFF.md`. Re-running verification with
the same valid draft leaves the same canonical bytes, so retry is idempotent.
Atomic publication prevents a partial canonical file; it is not a signature,
durable ledger, or protection against later unrelated writes.

## Recovery

| Failure                                   | Safe recovery                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Human gate rejected                       | The run is aborted. Correct the owning artifact/code and start a fresh run; do not copy its route, execution ledger, reviews, or proof pack into the replacement.  |
| Review is `stale`                         | Do not edit the seal. Create a new authorized clean checkpoint and start a fresh corrected run with new Claude-then-Codex evidence.                                |
| Gate is `blocked`                         | Resolve reported findings or invalid evidence, update the owning artifacts, and start a fresh run so both reviewers inspect the corrected revision.                |
| Convergence adds pending tasks            | Preserve the new `tasks.md`, stop the stale chain, and start a fresh approved plan/routing/execution run. Never implement the new work inside the old run.         |
| Handoff verification fails                | Keep the run-local draft for diagnosis, restore the proof/revision binding, and retry verification. The canonical handoff is published only after all checks pass. |
| Wave verification fails                   | Keep the failed run for diagnosis. Restore a clean, correctly scoped committed checkpoint through normal project recovery, then start a fresh route and execution. |
| Writer checkpoint has extra/merge commits | Do not rewrite evidence in place. Start a fresh run from an approved baseline and create exactly one direct-child non-merge writer commit.                         |
| Patch tree or `testedTree` mismatches     | Treat the evidence as invalid. Reintegrate and rerun checks from the correct baseline in a fresh run; never replace only the recorded digest or tree ID.           |
| MCP server restarted                      | In-memory jobs are gone. Confirm no proposal process remains, then start fresh jobs in a fresh run; do not manufacture missing terminal evidence.                  |
| Routing changed                           | Start a fresh run and regenerate `routing.json` and `execution.json`; their digests prevent replay of the old execution chain.                                     |
| `LEASE_CONFLICT`                          | Wait for or cancel the owning proposal. Never delete a lock while a worker may still run.                                                                          |
| Critical Sol-ultra profile unavailable    | Stop, verify allowlist/CLI/account support, or explicitly redesign and reapprove the task policy. Never silently downgrade.                                        |
| Claude plugin fails validation            | Use direct MCP registration, inspect the plugin path and host version, and rerun `claude plugin validate`.                                                         |

## Removal

Inspect the exact removal commands supported by the installed Spec Kit version:

```bash
specify extension --help
specify workflow --help
```

Remove `boundedrelay-sdd` and `boundedrelay-adaptive-sdd` through those
managers, stop loading the local Claude plugin, and delete ignored run evidence
only after confirming it is no longer needed. If the global source link was
used:

```bash
npm unlink --global boundedrelay
```

Removing the optional integration does not change established MCP tools or
delete a consumer repository. Removing the MCP registration also does not delete
the BoundedRelay checkout.

## Claims and responsibility

- Agreement between two models is not proof of correctness.
- More calls do not guarantee better code, fewer tokens, lower cost, or faster
  delivery.
- Routing metadata does not measure provider usage. Codex usage is reported only
  when observed; Claude usage remains unavailable unless the host supplies it.
- Exact manifest coverage checks recorded standard task IDs, not whether the
  task graph is semantically complete or correctly decomposed.
- High/Critical blocking applies to findings present in the structured review;
  no verifier can prove a reviewer did not omit a defect.
- Patch-to-tree equality proves that the persisted bytes reconstruct the
  checkpoint tree from the baseline. It does not prove correctness, authorship,
  or commit-message/metadata equivalence.
- Check receipts and recorded model/effort fields are bounded local evidence,
  not signed CI or provider attestations.
- Isolated proof revalidation and atomic handoff publication are local integrity
  controls, not a signature or protection against later unrelated modification.
- Repository tests, domain review, security review, and human accountability
  remain required.
- BoundedRelay does not commit, apply, push, publish, deploy, or mutate a remote
  system.

For the broader method, read Spec Kit's
[Agentic SDD reference](https://github.com/github/spec-kit/blob/main/docs/reference/agentic-sdd.md).
