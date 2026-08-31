# Feature Specification: Adaptive Dual-Agent SDD

**Feature directory**: `specs/001-adaptive-dual-agent-sdd` **Created**:
2026-08-27 **Status**: Approved for implementation

## User Scenarios and Testing

### User Story 1 - Trust a plan reviewed by both systems (P1)

As a developer, I want Claude and Codex to review the same frozen plan
independently so that a material plan change cannot reuse stale approval.

**Independent test**: Freeze a clean plan, submit host evidence first, run a
fresh Codex review, and prove the gate passes only when both approve the same
seal. Modify one byte and prove it fails.

### User Story 2 - Divide approved work predictably (P1)

As a developer, I want approved tasks routed to the best eligible lane before
any workload-balance tie-break so that a fixed quota never reduces task fit or
assigns two writers to the same scope.

**Independent test**: Route even, odd, weighted, constrained, and
dependency-linked task graphs and obtain byte-stable assignments with explicit
balance and deviation evidence.

### User Story 3 - Run the policy as a real delivery workflow (P1)

As a team, I want Spec Kit gates to validate routing, dependency-ordered
execution, reviews, convergence, and handoff so that missing worker evidence
cannot silently advance implementation.

**Independent test**: Run the packaged fixture workflow with fake providers and
prove out-of-order dependencies, multiple writers, uncommitted changes, missing
patch bytes, failed checks, pending, malformed, stale, or rejected evidence
stops before the next gate.

### User Story 4 - Install and understand the integration (P2)

As an open-source user, I want a documented Claude Code plugin and optional Spec
Kit pack so that I can adopt the system without replacing my selected Claude
model or guessing its security limits.

**Independent test**: Validate manifests, packaged files, setup instructions,
safe defaults, and a credential-free first run from a clean fixture repository.

### User Story 5 - Fail closed on unexecuted or failed verification (P1)

As a developer, I want BoundedRelay to distinguish an optimistic final message
from successful command execution so that a failed, missing, timed-out, or
fabricated check can never be reported as a successful review or workflow run.

**Independent test**: Make Codex emit a failed `command_execution` item and a
successful outer exit/final message, then prove the job fails. Prefill a writer
result with a forged zero-exit receipt, then prove the workflow replaces it only
after executing the sealed required command and refuses nonzero, missing, and
timed-out commands without advancing the wave or proof pack.

## Functional Requirements

- **FR-001**: The system MUST represent the Claude executor only as
  `claude-host` using the model selected by Claude Code; it MUST NOT launch,
  choose, or infer a Claude model.
- **FR-002**: Routing MUST be deterministic for semantically identical input and
  MUST publish both routing-policy and task-fit-policy versions in every
  fingerprinted plan.
- **FR-003**: Routing MUST apply hard eligibility, versioned task-kind fit, an
  eligible preferred lane only on an exact fit tie, then a soft fit-neutral
  effort and task-count share. Balance MUST NOT lower the selected task fit.
  Every decision and deviation MUST include stable evidence.
- **FR-004**: The soft fit-neutral Codex share MUST default to 5,000 basis
  points. Only at a true 50/50 odd neutral tie MUST Codex receive the extra
  task.
- **FR-005**: Routing MUST validate unique task IDs, bounded effort, known
  dependencies, an acyclic graph, safe relative write scopes, and
  non-overlapping concurrent writers.
- **FR-006**: Strict review MUST require a clean working tree, full Git
  revision, bounded regular artifact files, and a deterministic content digest.
- **FR-007**: Host review evidence MUST be frozen before Codex review starts and
  MUST NOT be included in the Codex reviewer prompt.
- **FR-008**: A dual-review gate MUST pass only when host and Codex evidence
  approve the same current revision seal. Draft reviews are advisory and MUST
  NOT approve delivery.
- **FR-009**: Missing, empty, malformed, fenced, truncated, stale, mismatched,
  failed, cancelled, or unavailable required review evidence MUST fail closed.
- **FR-010**: Codex reviews MUST run fresh with read-only sandbox, never-approve
  policy, ephemeral state, and schema-validated structured output.
- **FR-011**: `gpt-5.6-sol` and Codex CLI `ultra` MAY be configured for critical
  profiles only when explicitly allowlisted. The worker MUST NOT silently
  downgrade an unavailable profile.
- **FR-012**: Codex write tasks MUST remain isolated proposals. Same-repository
  proposals MUST be serialized, and BoundedRelay MUST never apply them
  automatically.
- **FR-013**: The integration MUST preserve all existing v0.1 MCP tools and add
  SDD tools without changing their established behavior, except that documented
  false-success outcomes MUST fail closed while retaining the same structured
  diagnostic payload.
- **FR-014**: The workflow MUST record run-local structured routing, execution,
  review, check, proof-pack, and handoff evidence, validate it separately, and
  exclude it from versioned governance state.
- **FR-015**: Public output MUST distinguish observed Codex usage from
  unavailable Claude usage and MUST NOT claim that workload balance equals token
  or monetary-cost balance.
- **FR-016**: CI and package verification MUST use fake executables and MUST NOT
  require provider credentials or paid calls.
- **FR-017**: Strict Codex reviews MUST execute from a detached, origin-free,
  hooks-disabled clone pinned to the sealed revision; source and clone freshness
  MUST fail closed before execution and source freshness MUST be rechecked at
  finalization.
- **FR-018**: A route with zero Codex implementation assignments MUST still
  produce complete wave-ordered execution evidence without inventing Codex work;
  independent Codex review gates remain required.
- **FR-019**: A rejected human gate MUST abort the current run and MUST NOT
  itself trigger a provider call. Repair requires a fresh run and fresh
  evidence.
- **FR-020**: Execution MUST honor routed wave and dependency order, permit at
  most one writer in a wave, and require each writer outcome to become a clean
  committed checkpoint before a dependent wave starts.
- **FR-021**: Every writer checkpoint MUST bind the exact Git base, completed
  revision, binary diff digest, changed paths, writer lease, result digest, and
  check-receipt digest. Codex proposal patch bytes MUST be persisted run-locally
  with owner-only permissions and match their declared digest.
- **FR-022**: Routing MUST be recomputed by the packaged deterministic router
  and MUST remain bound to the approved current plan. Plan, implementation, and
  convergence host evidence MUST each be frozen before the corresponding Codex
  review.
- **FR-023**: Implementation and convergence reviews MUST include an exact Git
  comparison from the prior approved revision so findings can target any changed
  tracked path without weakening the bounded artifact contract.
- **FR-024**: Writer checks MUST produce redacted typed receipts. Proof-pack
  assembly and immediate verification MUST rerun routing, review,
  execution-history, and final-freshness validators.
- **FR-025**: Routing MUST derive a content-addressed manifest from the approved
  committed `tasks.md` and MUST exactly cover every pending canonical task ID;
  omitted, invented, duplicated, or non-canonical task projections MUST fail.
- **FR-026**: A reviewed plan revision MAY precede the tasks checkpoint only
  when it is an ancestor and the current `spec.md` and `plan.md` bytes exactly
  match the reviewed artifacts. Routing MUST revalidate the complete strict plan
  evidence before any implementation wave starts.
- **FR-027**: A High or Critical finding MUST block approval regardless of a
  provider's stated verdict. Resolution requires a new revision and two fresh
  reviews; frozen evidence MUST NOT carry a manual disposition override.
- **FR-028**: Convergence MUST NOT implement new work outside routing. If a
  convergence audit adds or discovers tasks, the current run MUST stop and the
  work MUST enter a fresh approved manifest, route, and wave-execution run.
- **FR-029**: The final handoff MUST be machine-bound to the verified proof-pack
  digest, bundle fingerprint, and final Git revision. Publication MUST occur
  only after revalidation and MUST be safe to retry after a lost response.
- **FR-030**: Runtime completion MUST consume completed Codex command status and
  exit-code evidence. When every attempted command failed, a zero outer process
  exit or optimistic final message MUST NOT produce a successful job. A strict
  SDD review MUST include at least one successful inspection command.
- **FR-031**: The optional workflow MUST execute every sealed required writer
  check through a workflow-owned, shell-free, time- and output-bounded runner.
  Required-check receipts MUST be derived from the actual captured process
  result; caller-authored, missing, nonzero, unavailable, or timed-out evidence
  MUST NOT advance execution or enter an approved proof pack.
- **FR-032**: `codex_worker_result` MUST mark failed or cancelled terminal jobs
  and completed SDD reviews with a non-passing gate as MCP errors while
  preserving their complete structured diagnostic payload. Nonterminal and
  genuinely successful results MUST remain successful retrievals.

## Edge Cases

- Only one lane is eligible for all tasks.
- Every task has a stronger fit for one provider and the valid result is 100% on
  that lane.
- The closest fit-neutral weighted split differs substantially from the
  configured soft share.
- A task count is odd but the extra task is hard-constrained to the host.
- Plan artifacts change while Codex is reviewing them.
- A valid review belongs to another seal or is replayed after policy changes.
- Proposal mode is disabled, the source is dirty, or a same-repository lease is
  active.
- The local Codex catalog does not advertise the configured model or reasoning
  profile.
- A routed dependency belongs to the same or a later wave.
- A proposal claims a patch digest whose persisted bytes differ.
- A host writer modifies a path outside its declared lease.
- A valid historical execution is checked after the source advances to
  convergence.
- `tasks.md` omits a submitted route ID, includes a pending ID omitted by the
  route, or changes after its routing checkpoint.
- Convergence discovers new implementation work after the approved execution.
- Handoff publication succeeds but the caller retries after losing the success
  response.
- Codex exits zero after one or more internal commands fail and its final
  message incorrectly claims that checks passed.
- A coordinator pre-populates structurally valid check receipts although the
  profiled command was never started, cannot be found, requires unavailable
  network access, exits nonzero, or exceeds the runner deadline.

## Assumptions

- Claude Code remains the coordinator and is already authenticated under the
  user's chosen plan.
- Spec Kit is optional for BoundedRelay runtime and is installed separately in
  consumer projects.
- Estimated effort points are planning inputs, not measured tokens or prices.
- Host-side writer lease compliance is cooperative; unrelated local programs are
  outside the worker's enforcement boundary.

## Success Criteria

- **SC-001**: Repeated routing of 100 representative task graphs produces
  identical fingerprints, assignments, and reason codes.
- **SC-002**: Strong-fit task graphs never rebalance onto a weaker lane;
  feasible neutral even graphs reach exactly 50/50 effort and true tied odd
  neutral graphs assign the extra task to Codex.
- **SC-003**: Every tested change to revision, artifact content, routing policy,
  or evidence makes a strict approval unusable before implementation continues.
- **SC-004**: The full test, type, lint, coverage, build, and package gate
  succeeds without model credentials or network calls.
- **SC-005**: A new user can identify setup, safety limits, profile
  configuration, workflow stages, and uninstall/recovery steps from the packaged
  documentation.
- **SC-006**: A credential-free fixture MUST assemble and reverify a digest-only
  proof pack after all gates pass, reject a non-approved final review, and
  verify an all-host route as valid ordered execution with no invented worker
  call.
- **SC-007**: A realistic plan-review commit followed by a distinct tasks
  checkpoint MUST route successfully only when reviewed plan artifacts are
  unchanged, and exact task-manifest coverage MUST reject one omitted or
  invented pending ID.
- **SC-008**: Convergence writes, approved High/Critical findings, tampered
  post-proof evidence, and a handoff marker mismatch MUST fail before delivery;
  retrying an already-published exact handoff MUST succeed idempotently.
- **SC-009**: Credential-free regressions MUST prove that nested command
  failure, forged receipts, missing executables, nonzero exits, and check
  timeouts cannot be surfaced as successful MCP results, completed waves, or
  approved proof packs.
