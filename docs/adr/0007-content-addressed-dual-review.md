# ADR 0007: Content-Addressed Independent Dual Review

- Status: Accepted
- Date: 2026-08-27

## Context

Two positive review messages are not a trustworthy gate if they inspected
different revisions, if the second reviewer saw the first review, or if either
approval can be replayed after an artifact changes.

## Decision

A strict review is bound to a revision seal containing the exact Git revision,
clean-state fingerprint, canonical artifact paths, sizes, and SHA-256 digests.
Host evidence is frozen before Codex starts. Its digest is part of the review
request, but its findings are excluded from the Codex prompt so that the second
review remains independent.

The gate approves only when both structured evidence records:

1. validate against their schemas;
2. approve the same current seal and review policy;
3. were produced in the required host-then-fresh-Codex order; and
4. remain current after the Codex process finishes.

Missing, malformed, fenced, truncated, stale, or mismatched evidence fails
closed. A draft review is explicitly advisory and can never approve a delivery
gate.

## Consequences

Changing one reviewed byte invalidates approval and requires another review. The
workflow stores more metadata, but it can prove exactly what both systems
reviewed without storing chain-of-thought or provider credentials.
