# ADR 0002: Local stdio with in-memory job handles

**Status:** Accepted  
**Date:** 2026-08-27

## Context

Claude Code can launch local MCP servers over stdio. A Codex job may take longer
than one useful MCP round trip, and users need to see whether work is queued,
active, silent, terminal, or cancelled.

A daemon or database could keep jobs across client restarts, but it would add
authentication, ownership, migration, cleanup, privacy, and crash-recovery
requirements before the basic policy contract is proven.

## Decision

- Support stdio only in v0.1.
- `codex_worker_analyze` and the optional `codex_worker_propose` return a UUID
  and initial snapshot immediately.
- Keep the queue, job records, final messages, proposal artifacts, and
  idempotency map in process memory.
- Expose status, bounded long-poll, result, cancellation, and bounded history
  listing.
- Cancel active subprocesses on graceful server shutdown.
- State clearly that jobs do not survive server exit and no audit ledger exists.

## Consequences

- Installation is local and has no listening network port.
- Claude Code can inspect real progress without one long blocking tool call.
- Restarting the MCP server loses job IDs and results.
- A crash may leave proposal operational state on disk even though jobs are not
  recoverable.
- Multiple server processes have separate queues; only proposal leases
  coordinate across processes sharing one state directory.

## Alternatives rejected

- **One blocking run tool:** simpler implementation but reproduces the opaque
  “frozen” experience.
- **Detached child without an owner:** risks orphaned jobs and ambiguous result
  ownership.
- **Persistent local daemon:** valuable later, but requires a separate security
  and lifecycle design.
- **Remote HTTP server:** unnecessary exposure for a local single-user worker.

## Revisit when

Real usage demonstrates a need for jobs to survive Claude Code restarts and the
project can specify authentication, durable ownership, migrations, retention,
crash recovery, and secure local IPC.
