# ADR 0001: Use supported `codex exec --json`

**Status:** Accepted  
**Date:** 2026-08-27

## Context

The worker needs non-interactive Codex execution, real lifecycle signals,
cancellation, bounded output, and a final result. Automating the interactive TUI
or parsing terminal presentation would couple the project to unstable UI
behavior and require a pseudo-terminal.

OpenAI documents `codex exec` for scripts and CI. With `--json`, stdout is a
JSONL event stream that includes thread, turn, item, error, and usage events.

## Decision

- Invoke the locally installed Codex executable with `exec --json`.
- Pass the task over stdin using `-`.
- Use explicit strict-config, sandbox, approval, working-directory, ephemeral,
  user-config, execpolicy-rule, and color flags.
- Probe global and `exec` help and refuse `serve` when a required flag is
  absent.
- Parse the stream incrementally and normalize only fields required by the
  public job contract.
- Accept unknown well-formed event types as progress events.
- Fail on malformed JSONL, failed turns, missing terminal state, or missing
  final message.
- Never scrape the TUI or implement an undocumented Codex wire protocol.

## Consequences

- The worker depends on the documented Codex CLI command and event contract.
- Compatibility can be checked with fake JSONL fixtures and `codex exec --help`.
- Task text is not visible in the process argument list.
- The worker can expose honest event counters but cannot calculate a reliable
  percent complete.
- `--ephemeral` means Codex rollout persistence and resume are intentionally
  unavailable.

## Alternatives rejected

- **Interactive PTY automation:** broader capability but fragile, hard to bound,
  and unnecessary.
- **Direct provider API integration:** would duplicate Codex harness behavior
  and introduce credential and provider-SDK ownership.
- **Parse human-readable stdout:** loses structured progress and breaks when
  presentation changes.

## Revisit when

OpenAI deprecates the required flags, publishes a more appropriate stable worker
protocol, or MCP hosts broadly support a native Codex execution integration with
equivalent policy controls.
