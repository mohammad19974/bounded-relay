# ADR 0010: Portable, Intersection-Only Project Profiles

- Status: Accepted
- Date: 2026-08-28

## Context

The built-in task-kind fit policy is intentionally generic. Repositories differ
in their delivery checks, protected paths, lane capabilities, and approved Codex
policies, but making those differences executable plugins would create a new
command-execution and supply-chain boundary. Letting a project profile replace
server policy would also allow repository data to grant itself more authority
than the operator intended.

The existing `routeSddTasks` contract and fingerprints are already public. An
additive profile feature must not silently change that no-profile behavior.

## Decision

Project profiles are strict, versioned, non-executable data. A caller opts in by
passing `projectProfile` to the separate `routeProfiledSddTasks` API. Profiled
plans use schema version `2`, routing policy `sdd-routing-v3`, and fit policy
`sdd-capability-fit-v1`. Omitting a profile continues to use `routeSddTasks` and
the unchanged v0.1 route and fingerprint contract.

The effective boundary is always an intersection:

```text
server policy
  intersection trusted operator configuration
  intersection approved project profile
  intersection bounded request
  = effective execution policy
```

A profile may:

- declare bounded lane capability scores and per-task-kind weighted minimums;
- further restrict repository-relative write scopes and identify protected
  scopes;
- name required check profiles and define their canonical bounded `argv` and
  repository-relative `cwd` data for receipt matching;
- resolve Codex-only model and reasoning policies using risk, then task kind,
  then default precedence; and
- set bounded routing preferences described by the public schema.

A profile may not expand allowed roots, proposal authority, runtime write
access, protected server paths, environment forwarding, resource limits, or the
server-owned Codex model allowlist. Hard task eligibility is evaluated before
profile capability fit. Write policy can only narrow the scopes already declared
by a task.

Check definitions are evidence descriptors, not hooks. Their bounded `argv`
entries are inert reviewed data, not a structural claim that a described command
is safe. Validation, routing, and fingerprinting never execute `argv`, invoke a
shell, load code, read a repository, or access the network. The caller-owned
coordinator separately reviews and runs any check, then supplies a redacted,
successful, tree-bound receipt whose profile ID and canonical command digest
must match.

Model policy applies only to Codex work and independent Codex review. A profile
cannot select, launch, or attest the Claude Code host model. A non-null Codex
model must also be allowed by server configuration. Critical profiled work
requires an explicit critical-risk Codex policy and fails closed if it is
missing or unavailable; no fallback is invented.

Profiles are normalized before use. Their lowercase SHA-256 fingerprint binds
canonical content into profiled routing and workflow evidence. It is a content
address only: it does not authenticate an author, establish trust, or act as a
digital signature.

## Consequences

The same reviewed profile can be carried between repositories and machines
without installing executable extension code. Semantically equivalent profiles
produce the same content fingerprint and deterministic route. Profiled output
can explain capability fit, effective write restrictions, required checks, and
resolved Codex policy while remaining bounded by server configuration.

Operators must still review a profile before trusting its routing preferences or
running any described checks. A structurally valid profile is not an endorsement
of its contents. Profile changes intentionally produce different profile and
route fingerprints and invalidate evidence tied to the old content.

Maintaining a separate profiled route contract adds API and schema surface, but
it avoids a breaking reinterpretation of legacy no-profile routes.

## Alternatives considered

- **Executable repository plugins or automatic hooks:** rejected because
  validation would become code execution and inherit repository-controlled
  authority. Bounded `argv` data remains inert until a coordinator separately
  reviews and chooses to run it.
- **Let profiles replace server configuration:** rejected because project data
  could widen roots, models, credentials, or write authority.
- **Add profile fields directly to `routeSddTasks`:** rejected because an
  accidental default or fingerprint-payload change could break existing
  consumers.
- **Treat the profile fingerprint as an approval signature:** rejected because a
  digest proves content equality, not provenance, identity, or authorization.

## Supersession condition

Replace this decision only if a new, threat-modeled trust system can preserve
the no-profile compatibility contract and prove that any expanded extension
mechanism cannot execute unreviewed project-controlled code or widen the
server-owned boundary.
