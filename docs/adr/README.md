# Architecture Decision Records

ADRs capture decisions that change trust, compatibility, or ownership
boundaries. They explain why the current design exists; source and tests remain
the executable truth.

| ADR                                                   | Status   | Decision                                                                      |
| ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| [0001](0001-supported-codex-exec-jsonl.md)            | Accepted | Use supported `codex exec --json`, not TUI automation or a private protocol.  |
| [0002](0002-stdio-in-memory-job-api.md)               | Accepted | Use local stdio MCP with explicit process-lifetime job handles.               |
| [0003](0003-isolated-proposal-patches.md)             | Accepted | Generate opt-in proposals in a disposable clone and never apply them.         |
| [0004](0004-environment-and-model-policy.md)          | Accepted | Make child environment and explicit model overrides server-owned allowlists.  |
| [0005](0005-sanitized-live-job-activity.md)           | Accepted | Expose revision-aware sanitized activity without raw events or fake progress. |
| [0006](0006-optional-spec-kit-sdd-pack.md)            | Accepted | Ship a generic Spec Kit pack without making it a worker runtime dependency.   |
| [0007](0007-content-addressed-dual-review.md)         | Accepted | Require independent evidence against one current content-addressed seal.      |
| [0008](0008-deterministic-effort-balanced-routing.md) | Accepted | Route by quality fit, then use a soft share only for fit-neutral work.        |
| [0009](0009-single-writer-proposal-semantics.md)      | Accepted | Preserve one writer per wave and isolated Codex proposals.                    |

New ADRs use the next number and include context, decision, consequences,
alternatives, and the condition that would supersede the decision.
