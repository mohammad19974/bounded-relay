# Data Model: Adaptive Dual-Agent SDD

## Task Graph

A bounded set of tasks with stable IDs, integer effort points, risk, authority,
kind, dependencies, write scopes, hard lane eligibility, and an optional
preferred lane.

## Routing Plan

A deterministic fingerprint, routing and fit policy versions, normalized tasks,
per-task lane-fit scores and decision stages, a soft fit-neutral share,
deviations, and dependency/write-safe execution waves.

## Approved Task Manifest

A canonical versioned projection of every standard Spec Kit task line at the
committed routing revision: source artifact digest, ordered task IDs and status,
pending IDs, and a manifest digest. Router input, router output, workflow
assignments, execution results, and proof revalidation must cover the same
pending set exactly once.

## Revision Seal and Git Comparison

The strictness mode, canonical repository root, full Git revision, clean state,
policy digest, ordered tracked artifact paths with byte size and SHA-256, an
optional base revision, ordered changed paths, binary diff SHA-256, and a seal
digest.

## Review Evidence

Reviewer lane, host model-source attestation or observed Codex metadata,
revision seal, verdict, bounded findings/checks/residual risks, timestamps, and
evidence digest.

## Dual Review Gate

The current seal, host evidence, Codex evidence, approval state, and explicit
blocking reasons.

## Wave Execution

The routing digest and revision, active wave, canonical task results, completed
waves, and ordered checkpoints. Each checkpoint binds one optional writer, its
baseline and completed revisions, changed paths, binary diff digest, result
digest, and check-receipt digest.

## Check Receipt

A redacted coordinator attestation containing a named check profile,
command-argument digest, working-directory identifier, zero exit status, output
digests, and timestamps. It is not a signed CI or supply-chain attestation.

## Proof Pack

A digest-only index over approved plan, routing, completed execution,
implementation review, convergence review, check receipts, and final repository
revision. Verification reruns the authoritative validators rather than trusting
copied verdict fields.

## Handoff Context

A run-local proof digest, bundle fingerprint, final revision, and exact marker
for a bounded Markdown draft. Verification reruns the proof in a clean detached
clone, checks the draft and repository delta, and atomically publishes the
canonical handoff. Exact published bytes are a valid idempotent retry state.

## State Transitions

```text
draft artifacts -> strict plan seal -> host evidence frozen -> Codex review running
-> detached sealed clone -> dual plan gate approved -> deterministic routing
-> dependency-safe waves -> clean committed checkpoints -> implementation dual review
-> no-delta convergence audit -> final dual review -> proof assemble -> proof verify
-> proof-bound handoff draft -> verified atomic handoff publication
-> artifact/policy/revision drift -> stale -> abort and start a fresh run
```
