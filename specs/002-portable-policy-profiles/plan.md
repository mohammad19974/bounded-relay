# Implementation Plan: Portable Policy Profiles

**Date**: 2026-08-28 | **Spec**: [spec.md](spec.md)

## Summary

Add a separate strict profiled-routing path beside the pure legacy SDD router.
Profiles are inline data, never executable plugins. They are normalized and
fingerprinted before they can supply capability fit, narrow write scopes,
resolve Codex policy, or declare required check-receipt profiles. The existing
no-profile path remains byte-for-byte compatible.

## Architecture

```text
server policy
  intersection trusted operator configuration
  intersection approved project profile
  intersection bounded request
  = effective execution policy
```

The project profile is authoritative only for routing evidence and additional
restrictions. Server configuration remains the upper security boundary.

### Modules

- `src/sdd/routing/project-profile.ts`: strict validation, normalization,
  matching, model-policy resolution, and fingerprinting.
- `src/sdd/routing/profiled-router.ts`: a distinct v3 capability router, write
  policy checks, required-check projections, and fingerprint binding.
- `src/sdd/routing/executor-descriptors.ts`: fixed host, relay, and worker roles
  without selecting adapters or a Claude model.
- `src/mcp/` and `src/cli.ts`: aligned Zod/CLI surfaces and server allowlist
  enforcement.
- `schemas/sdd/v1/`: public profile and additive route contracts.
- `integrations/spec-kit/`: authoritative recomputation plus required receipt
  and model-policy enforcement.
- `scripts/` and `benchmarks/`: deterministic no-provider conformance corpus.
- `examples/profiles/`: safe non-executable starter profiles.

## Compatibility Strategy

When `projectProfile` is absent:

- `sdd-routing-v2` and `sdd-task-fit-v1` remain unchanged;
- no profile, required-check, or resolved-model fields are emitted;
- the existing plan fingerprint payload remains unchanged.

When `projectProfile` is present, dispatch uses schema v2, `sdd-routing-v3`, and
`sdd-capability-fit-v1`. Existing clients that do not opt in continue to use the
established contract.

## Security Decisions

1. Profile files are data only. A check may declare bounded argv/cwd data for a
   receipt digest, but BoundedRelay and the packaged validators never execute
   it. The coordinator must review and approve a command separately. Dynamic
   modules, environment maps, hooks, and provider credentials are not accepted.
2. Write policies are intersection-only and cannot weaken the runtime's own
   path/proposal restrictions.
3. MCP model requests are checked against the server-owned allowlist before a
   profiled route is returned.
4. Critical profiled work requires an exact Codex policy. No fallback is
   invented.
5. A profiled plan resolves one fingerprint-bound cross-review policy from the
   highest routed task risk, with risk, review-kind, then default precedence.
   This avoids deferring a mixed-policy conflict until global review.
6. Verification profiles bind their canonical argv/cwd digest to existing
   redacted, successful, tree-specific receipts; the coordinator remains
   responsible for reviewing and executing any command. Routing rejects more
   than 256 required writer receipts, and execution independently rejects a
   cumulative total above 256 after optional receipts are included.
7. Profile fingerprints are content addresses, not signatures or identity
   attestations.

## Verification

1. Unit tests for validation, canonicalization, selectors, fit, write scopes,
   model precedence, and no-profile compatibility.
2. MCP and CLI contract tests for template, validation, allowlist refusal, and
   profiled route output.
3. Workflow fixture tests for authoritative profile replay and required check
   receipt enforcement.
4. Credential-free routing conformance evaluation with deterministic generated
   cases and named invariant totals.
5. Full `npm run check`, package installation smoke, `git diff --check`, and an
   independent read-only review.

## Rollback

The feature is additive. Omitting `profile` restores the established route and
workflow path. Removing the profile module, optional schema properties,
examples, and conformance command requires no data migration because the runtime
stores no durable profile or job state.
