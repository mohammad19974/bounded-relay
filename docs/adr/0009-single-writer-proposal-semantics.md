# ADR 0009: Single-Writer Proposal Semantics

- Status: Accepted
- Date: 2026-08-27

## Context

Parallel AI writers can race on overlapping files, invalidate review seals, and
produce patches that are individually valid but impossible to integrate safely.
BoundedRelay already limits Codex writes to a disposable clone.

## Decision

The routing plan schedules dependency-respecting waves and allows no more than
one write task in a wave. Codex write work continues to use the established
revision-pinned isolated proposal path. Proposals targeting the same repository
remain serialized by a repository lease, and BoundedRelay never applies them.

The host coordinator may perform its assigned write task in the source checkout,
but it must respect the same wave and write-scope contract. Host-side lease
compliance is cooperative because BoundedRelay does not control the Claude Code
process. After any accepted write, affected strict review seals are stale and
the workflow must review the new state.

Codex CLI `ultra` may use Codex-managed internal read-only subagents inside one
invocation. The parent invocation remains the only Codex writer, and no lane may
recursively invoke Claude or another BoundedRelay worker.

## Consequences

The design trades maximum write parallelism for deterministic integration and
auditable ownership. Read-only work may still share a wave. External programs
that ignore the workflow remain outside this enforcement boundary.
