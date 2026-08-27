# Implementation Plan: Adaptive Dual-Agent SDD

**Date**: 2026-08-27 | **Spec**: [spec.md](spec.md)

## Summary

Add first-class optional SDD primitives to the existing TypeScript package: a
pure deterministic router, dependency-ordered single-writer execution,
content-addressed Git comparison seals, structured independent Codex review
jobs, fail-closed dual-review gates, check receipts, a revalidated proof pack,
and a distributable Spec Kit/Claude Code integration pack. Preserve the one-way
Claude-to-BoundedRelay-to-Codex topology and every v0.1 tool.

## Technical Context

- TypeScript 6, Node.js 22.13+, ESM, strict exact optional types.
- Existing MCP SDK, Zod, Vitest, V8 coverage, ESLint, Prettier, and Git/Codex
  subprocess adapters.
- No new runtime or development dependency.
- Process-lifetime job/evidence state; run-local Spec Kit evidence is machine
  state.
- CI uses fake Codex executables and temporary Git repositories only.

## Constitution Check

| Gate                 | Status | Evidence                                                                 |
| -------------------- | ------ | ------------------------------------------------------------------------ |
| Code-enforced policy | Pass   | Shared strict validators and independent workflow verification scripts.  |
| One-way topology     | Pass   | Only `claude-host` is represented; no Claude executable or API is added. |
| Bounded writes       | Pass   | Existing isolated proposal lane remains the only Codex write path.       |
| Fresh dual review    | Pass   | Same revision seal and ordered host/Codex evidence are mandatory.        |
| Explainable routing  | Pass   | Versioned deterministic policy with stable reason codes.                 |
| Compatibility        | Pass   | Existing MCP tools and schemas remain additive.                          |

## Architecture Decisions

1. Keep BoundedRelay a single package; add focused `src/sdd` modules instead of
   a monorepo.
2. Keep routing pure and deterministic. Model marketing claims never enter the
   optimizer.
3. Route with `sdd-routing-v2`: hard eligibility, `sdd-task-fit-v1`, an eligible
   preferred lane on an exact fit tie, then a soft neutral effort/count share,
   true odd neutral Codex tie-break, and lexical stability. A balance target
   never lowers task fit.
4. Treat Claude as `claude-host`; any model label is host-declared metadata
   only.
5. Run specialized review through the existing JobManager lifecycle, but use a
   distinct structured review contract and output schema. Generic analysis
   cannot satisfy a strict review gate.
6. Content-address artifacts and policy. Strict evidence is invalid after any
   relevant change.
7. Ship Spec Kit and Claude Code integrations under `integrations/`; they remain
   optional runtime assets and are included in the npm package.
8. Support Codex CLI `ultra` as an explicit profile value advertised by the
   installed CLI catalog. `max` remains the safest maximum for single-writer
   proposals; no profile silently downgrades.
9. Execute assignments by dependency-safe waves with at most one writer. Each
   wave ends at a clean committed Git checkpoint whose exact binary diff and
   changed paths match the writer lease.
10. Persist Codex proposal bytes only under ignored run-local state and bind
    them to the result by SHA-256. Record redacted check receipts rather than
    raw command output or environment values.
11. Freeze host evidence before every independent Codex review. Implementation
    and convergence use explicit Git base-to-head comparisons so code findings
    are both complete and bounded.
12. Treat proof packs as verifiable indexes, not trusted summaries: assembly and
    verification rerun authoritative routing, strict review, historical
    execution, and final freshness checks.

## Source Scope

```text
src/sdd/                         routing, seals, evidence, gates
src/core/                        additive job/result metadata
src/runtime/                     structured Codex review and Git comparison runtime
src/mcp/                         new SDD tools
src/config/                      bounded SDD configuration
src/security/                    artifact and prompt boundaries
schemas/sdd/v1/                  public SDD JSON contracts
integrations/spec-kit/           optional workflow, evidence, wave, check, and proof pack
integrations/claude-code-plugin/ optional distributable host plugin
tests/                           unit, contract, workflow, and package tests
docs/                            setup, architecture, security, reference
```

## Public API Additions

- `codex_worker_sdd_route`: synchronous read-only deterministic task routing.
- `codex_worker_sdd_review`: asynchronous read-only review job tied to a
  revision seal.
- Existing status/result/cancel/list tools manage the review lifecycle.
- Review results add a structured `review` artifact; existing result fields
  remain compatible.

Separate freeze/gate operations are provided by exported library primitives and
the Spec Kit pack. Keeping them out of the first MCP surface avoids mutable
server-side workflow state and replay-prone plan IDs while still enforcing the
consumer workflow in run-local validators.

## Security and Failure Semantics

- Artifact resolution rejects absolute paths, traversal, duplicate paths,
  symlinks, non-files, oversized files, and paths outside the repository.
- Strict preparation requires clean HEAD and creates a detached origin-free,
  hooks-disabled clone at that exact revision; clone bytes and source freshness
  are checked before execution, and finalization rechecks source HEAD,
  cleanliness, and digests.
- Host findings are hashed and stored with the request but omitted from Codex
  prompts.
- Structured Codex output is parsed strictly; Markdown fences and malformed JSON
  fail.
- A review job may complete while its gate verdict is not approved; workflow
  verification blocks.
- No raw host review, task prompt, or lease token appears in live status.
- Human rejection aborts the run. It never silently repeats a provider call or
  reuses stale review evidence.
- Host-side write isolation is cooperative during editing; the next wave is
  blocked unless the resulting clean committed diff exactly matches the routed
  writer lease.

## Verification Plan

1. Focused routing, seal/gate, JobManager, runtime, MCP, and integration-pack
   tests.
2. Schema and example validation.
3. `npm run check` including coverage and package dry run.
4. Real local `boundedrelay doctor`, MCP fake-client smoke, and no-provider Spec
   Kit fixtures for route recomputation, ordered execution, review freezing,
   checks, and proof revalidation.
5. `git diff --check`, independent read-only review, convergence audit, and
   handoff refresh.

## Rollback

The change is additive. Disable or omit the optional integration pack and
continue using v0.1 tools. Removing new SDD tools/modules restores the prior
surface without data migration because no durable server state or remote
resource is created.
