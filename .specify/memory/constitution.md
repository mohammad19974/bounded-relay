# BoundedRelay Constitution

## I. Policy Is Enforced in Code

Security, review, routing, and authority claims MUST be backed by executable
validation and tests. Prompt text and documentation are defense in depth, never
the only enforcement boundary.

## II. One-Way Provider Topology

Claude Code is the host coordinator and uses the model selected by its user.
BoundedRelay MUST NOT launch Claude, call Anthropic, choose a Claude model, or
claim to verify the host model. Cross-model work remains one-way: Claude Code
calls BoundedRelay, and BoundedRelay calls the local Codex CLI.

## III. Bounded Authority and Single-Writer Safety

Read-only review is the default. Codex writes only in a disposable proposal
clone. Every mutable task MUST declare bounded write scopes and MUST NOT overlap
another active writer. External host edits are cooperative and MUST be reported
honestly as such. Routed execution MUST honor dependency waves, permit at most
one writer per wave, and require a clean committed checkpoint whose diff matches
the writer lease before dependent work starts.

## IV. Content-Addressed Review Evidence

Strict review MUST bind every reviewer to the same clean Git revision, artifact
digest, and policy version. Codex MUST review a detached clone proven to match
that seal, while final freshness remains bound to the source checkout. Host
evidence MUST be frozen before Codex sees the task. Missing, malformed, stale,
truncated, unavailable, or non-approving evidence MUST fail a required gate
closed. Implementation and convergence review MUST bind the code delta through
an exact Git base-to-head comparison.

## V. Deterministic, Explainable Routing

Routing MUST honor hard eligibility and versioned task fit before balance. An
eligible lane preference applies only to an exact base-fit tie. The default 50
percent Codex value is a soft share for fit-neutral effort, never a provider
quota. At a true 50/50 odd neutral tie, Codex receives the extra task. Every
assignment and deviation MUST have stable reason codes and a decision stage.
Estimated effort is not a token or monetary-cost guarantee.

## VI. Observable, Honest State

Status exposes lifecycle facts, safe activity labels, revisions, fingerprints,
and evidence state. It MUST NOT expose raw prompts, command arguments, secrets,
private reasoning, fabricated progress, or unsupported quality and savings
claims. Check receipts MUST omit raw output and environment data; proof packs
MUST be independently revalidated before delivery.

## VII. Compatibility and Verification

Existing v0.1 tools remain compatible unless a separately documented breaking
release is approved. Public TypeScript, Zod, JSON Schema, documentation,
examples, and package contents MUST stay aligned. Changes require focused tests,
the full `npm run check` gate, a real diff review, and a concise handoff.
Provider credentials and paid model calls MUST NOT be required by CI.

## VIII. Portable Profiles Are Intersection-Only Data

A project profile MAY provide versioned capability evidence, verification
definitions, Codex-only model requests, and additional write restrictions. It
MUST be strict, bounded, canonical, and content-addressed. A profile MUST NOT
launch Claude, select a Claude model, execute its declared check command, load
code, or expand any server-owned root, model, environment, proposal, path, or
resource policy. Profiled routing uses a separate public schema and policy
version; the established no-profile route remains compatible.

**Version**: 1.3.0 | **Ratified**: 2026-08-27 | **Last amended**: 2026-08-28
