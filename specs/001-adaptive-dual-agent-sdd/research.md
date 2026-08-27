# Research: Adaptive Dual-Agent SDD

## Codex maximum-quality profile

- **Decision**: Support `gpt-5.6-sol` and the Codex CLI-specific `ultra`
  reasoning value only through explicit allowlisted configuration.
- **Rationale**: The local Codex 0.149.1 catalog advertises `ultra` as maximum
  reasoning with automatic task delegation, while the public API model
  documentation exposes `max`. BoundedRelay invokes the CLI, so the CLI contract
  is relevant, but entitlement is still account-dependent.
- **Alternative**: Hard-code Sol/ultra. Rejected because installations and
  accounts differ.

## Claude model identity

- **Decision**: Use `claude-host` and `host-selected`; never set or infer a
  Claude model.
- **Rationale**: Current Claude Code supports a user-selected model alias.
  BoundedRelay is an MCP worker and cannot truthfully attest which host model
  produced external evidence.
- **Alternative**: Require Opus. Rejected by the requested behavior and one-way
  boundary.

## Distribution

- **Decision**: Ship an optional Claude Code plugin and Spec Kit integration
  pack.
- **Rationale**: Claude Code plugins officially bundle skills and MCP
  configuration, while Spec Kit provides durable feature artifacts and workflow
  gates. Neither needs to become a core runtime dependency.
- **Alternative**: Documentation-only recipe. Rejected because it cannot fail
  closed.

## Adaptive routing objective

- **Decision**: Fix hard-eligible and stronger versioned-fit tasks first. Use an
  eligible soft preference only for an exact base-fit tie, then optimize a
  configurable share over the remaining fit-neutral effort and task count.
- **Rationale**: A forced 50/50 quota can knowingly choose a weaker lane.
  Estimated effort still helps divide genuinely neutral work, while BoundedRelay
  observes no comparable Claude token or cost telemetry and cannot claim
  provider-price balance.
- **Alternative**: Optimize balance before fit. Rejected because a
  presentation-friendly split is not worth reducing task suitability.

## Strict review workspace

- **Decision**: Execute strict Codex review in a disposable detached clone
  pinned to the revision seal, without an origin or active Git hooks, while
  final freshness remains source-bound.
- **Rationale**: A seal check alone does not prevent source bytes from changing
  during a long review. Isolation gives Codex a stable snapshot; final source
  revalidation prevents replay.
