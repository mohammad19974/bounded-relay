# Tasks: Portable Policy Profiles

## Phase 1 - Governance and contract

- [x] T001 Approve the feature spec, plan, data contract, and compatibility
      boundary.
- [x] T002 Add an ADR for non-executable, intersection-only project profiles.
- [x] T003 Update shared context and constitution with profile invariants.

## Phase 2 - Profile core

- [x] T004 Add strict profile types, normalization, fingerprinting, and template
      generation under `src/sdd/routing/`.
- [x] T005 Add canonical verification selectors, write-scope restrictions, and
      Codex policy resolution.
- [x] T006 Add focused profile unit and mutation-sensitive tests.

## Phase 3 - Profiled routing

- [x] T007 Add a separate profiled router while preserving no-profile route
      output and fingerprints.
- [x] T008 Bind capability fit, executor descriptors, required check profiles,
      resolved Codex policy, and profile evidence into v3 profiled plans.
- [x] T009 Add routing tests for precedence, hard eligibility, critical policy,
      scope restrictions, and canonical equivalence.

## Phase 4 - Public surfaces

- [x] T010 Add `profile template` and `profile validate` CLI operations.
- [x] T011 Add the strict optional profile to MCP Zod input and enforce the
      server-owned model allowlist.
- [x] T012 Export profile APIs and align route/profile JSON Schemas.
- [x] T013 Add CLI, MCP, schema, and installed-package contract tests.

## Phase 5 - Workflow enforcement

- [x] T014 Extend Spec Kit routing evidence with optional profiled projections
      and authoritative replay.
- [x] T015 Require writer receipts to cover every routed check profile.
- [x] T016 Bind profiled Codex policy to implementer/reviewer assignments and
      keep the legacy critical policy for no-profile runs.
- [x] T017 Add credential-free workflow fixtures for valid and tampered profiled
      runs.

## Phase 6 - Evals, examples, and docs

- [x] T018 Add safe starter profiles and a complete project-profile guide.
- [x] T019 Add a deterministic routing conformance corpus and npm command.
- [x] T020 Update README comparison tables with reproducible enforcement
      evidence and explicit non-benchmark limits.
- [x] T021 Update architecture, security, configuration, tool reference,
      ecosystem comparison, roadmap, changelog, and docs index.

## Phase 7 - Delivery

- [x] T022 Run focused tests, then the full release gate and package smoke.
- [x] T023 Run independent security/compatibility review and repair accepted
      findings.
- [x] T024 Re-run convergence, refresh context/handoff, and inspect the complete
      diff with `git diff --check`.
