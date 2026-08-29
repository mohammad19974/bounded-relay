# Tasks: Adaptive Dual-Agent SDD

## Phase 1: Governance and Design

- [x] T001 Create the feature specification and checklist in
      `specs/001-adaptive-dual-agent-sdd/`.
- [x] T002 Record architecture, research, data model, MCP contract, and
      verification quickstart.
- [x] T003 Add shared project constitution and active context under `.specify/`.

## Phase 2: Deterministic Routing

- [x] T004 Implement canonical task contracts and fingerprinting in
      `src/sdd/routing/`.
- [x] T005 Implement quality-first adaptive routing, a soft neutral share, and
      safe waves in `src/sdd/routing/`.
- [x] T006 Add exhaustive routing behavior tests in `tests/sdd-routing.test.ts`.

## Phase 3: Revision and Review Gates

- [x] T007 Implement safe revision seals, tracked artifact hashing, and Git
      comparison binding in `src/sdd/review/` and `src/runtime/`.
- [x] T008 Implement host/Codex evidence validation and dual gate evaluation in
      `src/sdd/review/`.
- [x] T009 Add strict stale/malformed/path/comparison review tests in
      `tests/sdd-review-gate.test.ts`.

## Phase 4: Runtime and MCP Integration

- [x] T010 Extend reasoning contracts with Codex CLI `ultra` across types and
      schemas.
- [x] T011 Add structured SDD review lifecycle to JobManager, Codex invocation,
      and result types.
- [x] T012 Register `codex_worker_sdd_route` and `codex_worker_sdd_review` in
      `src/mcp/server.ts`.
- [x] T013 Add runtime, JobManager, and MCP contract coverage for review
      freshness and routing, including detached strict-review isolation, drift,
      hooks, remotes, submodules, and cleanup.

## Phase 5: Distributable Workflow

- [x] T014 Create the generic Spec Kit extension/workflow pack in
      `integrations/spec-kit/`.
- [x] T015 Create the Claude Code plugin with no model override in
      `integrations/claude-code-plugin/`.
- [x] T016 Add credential-free workflow/manifest tests in
      `tests/integration-pack.test.ts`.
- [x] T017 Include integration assets in the npm package and add safe
      setup/validation CLI support.

## Phase 6: Enforced Orchestration Evidence

- [x] T018 Recompute and exact-match routing with the packaged deterministic CLI
      while binding it to the approved current plan.
- [x] T019 Execute every provider assignment in dependency-safe waves with one
      writer, exact leases, clean committed checkpoints, and persisted Codex
      patch bytes.
- [x] T020 Freeze plan, implementation, and convergence host reviews before
      fresh Codex review and bind code findings to exact Git comparisons.
- [x] T021 Add redacted check receipts plus proof-pack assembly and immediate
      independent revalidation of routing, reviews, execution history, and final
      freshness.
- [x] T022 Bind routing to an exact committed pending-task manifest, allow only
      ancestor plan reviews with unchanged spec/plan bytes, and run the complete
      strict plan validator before writes.
- [x] T023 Block High/Critical approvals, require no-delta convergence or a
      fresh routed run, and publish a proof-bound retry-safe handoff.

## Phase 7: Documentation and Delivery

- [x] T024 Add ADRs for SDD integration, dual evidence, routing, and writer
      semantics in `docs/adr/`.
- [x] T025 Update README, architecture, security, configuration, tool reference,
      ecosystem comparison, and roadmap.
- [x] T026 Run focused tests and the full `npm run check` gate.
- [x] T027 Run sandbox MCP/workflow smoke tests and inspect package contents.
- [x] T028 Perform an independent review, repair accepted findings, and rerun
      checks.
- [x] T029 Run convergence, update tasks/context/handoff, and inspect
      `git diff --check`.

## Phase 8: False-Success Hardening

- [x] T030 Reproduce and fail closed when Codex exits zero after every nested
      command execution failed, while preserving recovery after a later
      successful exploratory command.
- [x] T031 Require specialized SDD review to observe a successful inspection
      command and classify failed, cancelled, blocked, or stale terminal MCP
      results as errors without discarding their structured payloads.
- [ ] T032 Replace caller-authored required check success with an explicit
      shell-free workflow runner that derives receipts from sealed commands and
      rejects nonzero, missing, timed-out, or forged evidence.
- [ ] T033 Align schemas, workflow gates, security/architecture documentation,
      changelog, context, and handoff with the fail-closed behavior.
- [ ] T034 Run focused regressions, the complete `npm run check` release gate,
      independent diff review, and `git diff --check`.
