# Feature Specification: Portable Policy Profiles

**Status**: Complete — verified locally  
**Date**: 2026-08-28

## Objective

Make BoundedRelay adaptable to different repositories without weakening its
one-way Claude Code to Codex boundary. A project can supply a small, versioned
policy profile that declares lane capabilities, narrows write scopes, binds
required verification profiles, and requests an exact Codex model policy. Every
effective profile is normalized, content-addressed, explainable, and bound into
routing and workflow evidence.

The feature also adds a credential-free conformance evaluation so public claims
can point to reproducible policy checks rather than model-quality estimates.

## User Stories

### US1 - Adopt BoundedRelay in any repository

As a maintainer, I can start from a documented profile template, validate it
without credentials, and use it for a TypeScript, Python, Rust, mobile, backend,
or mixed repository without changing BoundedRelay source.

### US2 - Route by declared project capability

As a coordinator, I can route through reviewed project capabilities. The profile
declares scored lane capabilities and per-kind weighted minimums. The router
remains deterministic, keeps hard eligibility first, and explains the selected
lane and effective profile fingerprint.

### US3 - Enforce repository-specific delivery gates

As a reviewer, I can require named check profiles for matching write tasks. The
Spec Kit execution validator rejects a checkpoint when its tree-bound receipts
do not cover every required profile or match its canonical command definition.

### US4 - Keep model selection explicit and bounded

As an operator, I can request a Codex model/reasoning policy by task kind or
risk. Risk rules take deterministic precedence over kind and default rules. The
actual Codex job still fails unless the server allowlists the requested model.
The profile never selects, launches, or verifies the Claude host model.

### US5 - Prove compatibility and invariants

As a package consumer, omitting a profile produces the same normalized tasks,
assignments, fit policy, and fingerprint as the existing v0.1 router. I can run
a local conformance corpus that makes no provider call and reports pass/fail for
determinism, fit preservation, hard eligibility, dependency order, profile
binding, write policy, and single-writer waves.

## Functional Requirements

- **FR-001**: Profiles MUST use a strict schema with a version, safe ID, safe
  revision, bounded text, and no unknown fields.
- **FR-002**: Profile normalization MUST be canonical and MUST publish a
  lowercase SHA-256 policy fingerprint.
- **FR-003**: A profile MUST declare bounded lane capabilities and per-task-kind
  weighted capability requirements. A lane that misses any minimum MUST be
  ineligible for that task.
- **FR-004**: A profile MUST NOT redefine the neutral share. The route input's
  `neutralCodexShareBps` MUST remain the single bounded source for neutral
  balancing.
- **FR-005**: Profile fit MUST NOT override task hard eligibility.
- **FR-006**: Profile write policy MAY declare allowed and protected repository
  scopes. It MUST only narrow a routed task's declared write scopes.
- **FR-007**: Absolute, traversal, backslash, `.git`, duplicate, internally
  overlapping, or otherwise unsafe profile paths MUST fail closed. An allowed
  root MAY overlap a denied root because that cross-list intersection narrows
  authority.
- **FR-008**: Verification requirements MUST be named safe check-profile IDs,
  apply only to write tasks, and match by task-kind and risk policy.
- **FR-008A**: A check profile MAY contain only bounded argv data and a safe
  repository-relative cwd. Its canonical digest MUST bind matching receipts;
  validation or routing MUST never execute it.
- **FR-009**: Every routed write assignment MUST list its canonical required
  check profiles when a profile requires them.
- **FR-010**: Spec Kit execution MUST reject a writer checkpoint unless its
  successful tree-bound receipts cover every routed required check profile.
- **FR-010A**: Spec Kit execution MUST accept at most 256 receipts across all
  writer results, including optional profile-defined receipts, and MUST reject
  the active wave before checkpoint creation when it would add receipt 257.
- **FR-011**: A profile MAY declare Codex policies for default, task kind, and
  risk. Resolution order MUST be risk, then kind, then default.
- **FR-012**: A policy rule MUST use a bounded Codex model or null and a valid
  reasoning effort or null. A both-null default explicitly means the server's
  Codex defaults. It MUST NOT name or configure a Claude model.
- **FR-013**: Critical profiled tasks MUST have an explicit critical-risk Codex
  policy and MUST fail rather than silently downgrade it.
- **FR-014**: The MCP server MUST reject a non-null profiled Codex model that is
  not in the server-owned model allowlist.
- **FR-015**: A profiled route MUST use a distinct schema and policy version and
  MUST bind the normalized profile, task policies, executor descriptors,
  required checks, and one plan-level cross-review policy into its fingerprint.
  That review policy MUST resolve once from the highest routed task risk using
  risk, then review-kind, then default precedence.
- **FR-016**: The packaged workflow MUST recompute the authoritative route and
  exact-match all profiled projections before execution.
- **FR-017**: Profiles MUST NOT expand allowed roots, proposal authority,
  protected server paths, environment forwarding, timeouts, or any other server
  policy.
- **FR-018**: Profiles MUST NOT execute declared argv, load JavaScript, access
  the network, or read a repository merely by being validated.
- **FR-019**: The CLI MUST provide profile template and validation operations
  through stdin/stdout without modifying a consumer repository.
- **FR-020**: Public JSON Schema, TypeScript exports, MCP Zod input, examples,
  Spec Kit schemas, and documentation MUST describe the same contract.
- **FR-021**: The no-profile `routeSddTasks` path MUST preserve existing v0.1
  behavior and its content fingerprint for identical input. A separate
  `routeProfiledSddTasks` path MUST own the new contract.
- **FR-022**: CI MUST run a deterministic, credential-free conformance corpus
  and package smoke without a paid model call.
- **FR-023**: Conformance output MUST describe routing-policy enforcement only;
  it MUST NOT claim measured model intelligence, cost savings, latency, or code
  quality.
- **FR-024**: Examples MUST contain no personal path, credential, provider
  token, or executable command supplied by an untrusted profile.
- **FR-025**: The implementation MUST remain one-way: Claude Code host to
  BoundedRelay to local Codex CLI, with caller-owned integration.

## Edge Cases

- A profile changes key order but is semantically identical.
- A weighted capability fit ties both lanes.
- A task declares one lane while the profile favors the other.
- A protected scope is an ancestor or descendant of a task write scope.
- A gate applies to one risk but not another task of the same kind.
- A critical task is routed to the host and therefore needs the explicit Codex
  policy for its independent reviewer.
- A mixed-risk plan resolves one global cross-review policy before execution so
  implementation review cannot fail late because task policies disagree.
- A profile requests a structurally valid model that the server does not
  allowlist.
- A workflow route created without a profile is replayed after this feature.
- A writer has successful receipts, but none uses the required receipt profile.
- Optional profile-defined receipts would push the cumulative writer total from
  256 to 257 after earlier waves were accepted.

## Success Criteria

- **SC-001**: A canonical profile and a key-reordered equivalent produce the
  same fingerprint and route result.
- **SC-002**: The conformance corpus passes all declared invariants on Node
  22.13+ and Node 24 across the supported CI matrix.
- **SC-003**: Existing no-profile routing tests and integration fixtures remain
  green against a committed golden route without updating its fingerprint.
- **SC-004**: Mutation tests demonstrate that removing profile binding,
  required-receipt enforcement, fit precedence, or protected-scope rejection
  causes a named test to fail.
- **SC-005**: A new user can copy a template, validate it, route an example, and
  understand the server-policy intersection from packaged documentation.

## Non-Goals

- Automatic model benchmarking or self-learning routing.
- Choosing or launching a Claude model.
- Arbitrary repository hooks, commands, or JavaScript plugins.
- Automatic patch application, commit, merge, push, publish, or deploy.
- Persistent jobs, remote orchestration, or a multi-provider swarm.
- Numeric code-quality or cost-improvement claims.
