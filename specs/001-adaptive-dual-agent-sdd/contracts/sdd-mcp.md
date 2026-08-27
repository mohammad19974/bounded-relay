# SDD MCP Contract

## Route

`codex_worker_sdd_route` accepts a bounded task graph and optional soft
`neutralCodexShareBps`. It returns a fingerprinted `sdd-routing-v2` plan with
`sdd-task-fit-v1` scores, exact decision stages, reasons, deviations, and safe
waves. Eligibility and stronger fit precede the neutral share. It performs no
model call or write.

## Review

`codex_worker_sdd_review` accepts a strict or draft review request, exact
artifact paths, frozen host review evidence, and normal optional Codex job
configuration. It queues a fresh read-only Codex job. The existing
status/result/cancel tools own lifecycle. A terminal result contains validated
structured review evidence and gate readiness metadata.

## Compatibility

All pre-existing non-SDD v0.1 tool inputs and outputs remain valid. The SDD
tools are new, separately named under `codex_worker_sdd_*`, and their prerelease
contracts are versioned by schema and routing-policy identifiers.
