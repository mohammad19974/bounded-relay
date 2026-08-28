# Roadmap

This roadmap communicates direction, not dates or commitments. An item is
implemented only when it is present in source, tested, documented, and listed in
`CHANGELOG.md`.

## v0.1 scope

- local stdio MCP transport;
- capabilities and workspace inspection;
- deterministic `sdd-routing-v2` quality-first task routing with neutral share
  metadata, fingerprints, explanations, and single-writer waves;
- optional strict portable project profiles through the separate
  `sdd-routing-v3` path, with capability minimums, intersection-only write
  policy, required check digests, Codex-only model policy, and unchanged
  no-profile routing;
- credential-free deterministic routing conformance fixtures that report policy
  invariants without provider, quality, speed, token, or cost claims;
- content-addressed strict/draft SDD review with frozen host evidence, fresh
  structured Codex review, and fail-closed freshness gates;
- in-memory asynchronous job queue;
- read-only analysis by default;
- real Codex JSONL event counters and sanitized live activity;
- queue position, activity/update timing, revision-aware bounded status wait,
  result, cancellation, and job listing;
- sanitized child environment and explicit allowed roots;
- server-owned optional model allowlist;
- disabled-by-default isolated patch proposals;
- clean revision pinning, cross-process proposal lease,
  protected-path/ref/symlink/size validation;
- binary patch metadata with explicit patch-body retrieval;
- optional packaged Spec Kit workflow/extension and Claude Code plugin, with
  local path discovery and structural validation;
- mechanically verified Spec Kit `execution.json` ledgers with exact dependency
  waves, at most one writer, direct-child non-merge checkpoint commits,
  disposable-index patch-to-tree verification, routed Codex model/effort
  matching, and redacted tree-bound check receipts;
- committed standard `tasks.md` manifests with exact pending-ID route coverage,
  plus descendant routing checkpoints that retain an unchanged, fully
  revalidated ancestor plan review;
- implementation review over the routing-base-to-final-HEAD comparison (bounded
  to 256 changed paths), followed by convergence review chained from the
  approved implementation revision;
- fail-closed High/Critical review findings and convergence audits that never
  implement directly: new tasks require a fresh routed run, while no new work
  proceeds to a no-delta review;
- run-local digest-only SDD proof packs that rerun authoritative routing, strict
  routing projections, strict evidence checks, historical wave validation, exact
  execution/review source chains, and convergence freshness before binding
  evidence fingerprints, review job IDs, checkpoint/check digests, and accepted
  proposal digests;
- run-local handoff drafting with proof revalidation in an isolated clone,
  atomic canonical publication, and idempotent verification retries;
- no direct source-worktree write or patch-integration path.

## Candidates after real-world evaluation

### Contract hardening

- publish compatibility fixtures for supported Codex CLI lines;
- stabilize JSON schemas and error codes;
- add conformance tests against packed releases;
- improve cancellation and process-tree evidence across supported operating
  systems.

### Observability without false audit claims

- optional user-controlled event export with explicit redaction and retention;
- structured result summaries that keep large patches out of model context;
- optional client-side activity presentation without expanding the server's
  privacy surface.

Any durable event store requires a new privacy design. It must not be called an
audit ledger unless integrity, retention, access, and verification properties
are implemented and tested.

### Lifecycle durability

- evaluate a local daemon or a standard MCP asynchronous-task primitive;
- define crash recovery and job ownership;
- define upgrade behavior for in-flight jobs.

Persistence is not a small extension to the current process-lifetime model.

### Distribution

- publish a signed/provenance-backed npm package after the name and ownership
  are confirmed;
- provide a version-pinned Claude Code project example;
- evaluate a Claude Code marketplace distribution only after live host
  validation and identity/ownership are confirmed.

## Explicit non-goals

- replacing or impersonating `openai/codex-plugin-cc`;
- Codex calling Claude, nested BoundedRelay workers, or cross-provider
  recursion; bounded Codex-internal read-only subagents remain limited to the
  documented `ultra` invocation policy;
- automatically applying, committing, pushing, or deploying a proposal;
- generic shell or terminal access over MCP;
- automatic “best model” routing without reproducible evals;
- hard-coded provider pricing or guaranteed token savings;
- remote multi-user service in the local worker package;
- claiming that model output is safe because its filesystem boundaries passed
  validation.

Proposals for these boundaries must begin with a documented user need and
threat-model review, not an implementation patch.
