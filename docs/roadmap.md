# Roadmap

This roadmap communicates direction, not dates or commitments. An item is
implemented only when it is present in source, tested, documented, and listed in
`CHANGELOG.md`.

## v0.1 scope

- local stdio MCP transport;
- capabilities and workspace inspection;
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
- no direct write or apply path.

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
- evaluate an optional Claude Code plugin wrapper only if it adds installation
  value without confusing this project with OpenAI's official plugin.

## Explicit non-goals

- replacing or impersonating `openai/codex-plugin-cc`;
- Codex calling Claude or recursive agent delegation;
- automatically applying, committing, pushing, or deploying a proposal;
- generic shell or terminal access over MCP;
- automatic “best model” routing without reproducible evals;
- hard-coded provider pricing or guaranteed token savings;
- remote multi-user service in the local worker package;
- claiming that model output is safe because its filesystem boundaries passed
  validation.

Proposals for these boundaries must begin with a documented user need and
threat-model review, not an implementation patch.
