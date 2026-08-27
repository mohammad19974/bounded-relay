# ADR 0005: Sanitized live job activity

- Status: Accepted
- Date: 2026-08-27

## Context

A Codex job can run long enough that an unchanged `running` status looks frozen.
Raw Codex JSONL payloads are not a safe public status surface: they can contain
command text, tool arguments, paths, provider-specific fields, or future data
that this server has not threat-modeled. A guessed percentage or ETA would look
precise while having no reliable completion signal.

Repeated short polling also wastes MCP calls and model context when no state has
changed.

## Decision

BoundedRelay exposes live progress through the existing `codex_worker_status`
tool rather than adding a second status API.

- Each recognized runtime event maps to a fixed `JobActivity` enum and a
  server-owned human-readable label.
- Every unknown event type maps to `working` and exposes only the identifier
  `unknown`; unsafe session identifiers are omitted.
- Public progress includes event, command, and message counters; last normalized
  event type; update time; elapsed time; and time since the last update.
- Queued jobs include their current one-based queue position.
- Every material snapshot update increments `revision`.
- `afterRevision` lets callers return immediately for stale revisions or wait up
  to the bounded `waitMs` for a newer revision.
- The status API does not expose raw event payloads, command text, tool
  arguments, private chain-of-thought, a completion percentage, or an ETA.

## Consequences

Claude Code can explain observable progress without pretending to know when a
job will finish. Revision-aware long-polling reduces unchanged status traffic.
The enum is a compatibility surface, so adding or renaming activities requires
schema, documentation, fixture, and contract-test updates.

Activity labels describe event categories, not semantic proof. For example,
`reasoning` means a reasoning event was observed; it does not expose or
summarize the model's hidden reasoning.

## Alternatives considered

- Expose raw JSONL events: rejected because the payload is provider-shaped and
  may leak data outside the intended public contract.
- Add a numeric percentage: rejected because Codex does not provide a reliable
  total-work denominator.
- Add a separate event-stream MCP tool: deferred until a standard transport and
  explicit retention/redaction design justify the extra surface.
- Poll on a fixed timer without revisions: retained only for compatibility;
  revision-aware long-polling is the recommended caller behavior.

## Superseding condition

Revisit this decision if the supported Codex interface provides a stable,
documented, privacy-reviewed progress contract or MCP offers a standard task
subscription primitive that preserves the same policy boundary.
