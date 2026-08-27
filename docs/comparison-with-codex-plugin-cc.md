# Relationship to `openai/codex-plugin-cc`

OpenAI's [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
is the official place to start when the goal is to use Codex from Claude Code.
It provides Claude Code slash commands and a Codex subagent for review,
adversarial review, background work, status/result/cancellation, session
handoff, and an optional review gate.

BoundedRelay is an independent community MCP server with a narrower
policy-and-artifact focus. It does not fork, vendor, wrap, or claim
compatibility with the official plugin's internal implementation. Its overlap in
read-only review and job lifecycle is intentional but is **not** a reason to
prefer it over the official integration.

This comparison was reviewed against the public official-plugin README on
2026-08-27. Follow the official repository for its current behavior.

## Meaningful differences

| Area                            | Official plugin                                                             | BoundedRelay v0.1                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Integration surface             | Claude Code plugin commands and a subagent                                  | Seven base stdio MCP tools plus one startup-gated proposal tool, with JSON inputs and results                      |
| Codex runtime                   | Local Codex CLI and Codex app server, using the user's Codex setup          | Local `codex exec --json` with an explicit required-flag contract                                                  |
| Policy ownership                | Follow the official plugin and Codex configuration model                    | Server-owned workspace/model/environment/resource allowlists and limits                                            |
| Review and background lifecycle | Built in                                                                    | Also available; this is overlap, not differentiation                                                               |
| Proposed edits                  | Official rescue workflows can attempt fixes under their documented controls | Optional proposal runs only in a disposable clean clone and returns a validated binary patch that is never applied |
| Job durability                  | Follow the official plugin's current session behavior                       | Process-memory only; server exit loses all jobs and results                                                        |
| Distribution                    | Official Claude Code marketplace plugin                                     | Unpublished local development package in v0.1                                                                      |

The table describes public contracts, not a quality, speed, model, cost, or
security benchmark. No claim is made that either integration produces better
code or uses fewer tokens.

## Which one to use

Use the official plugin when you want the supported Claude Code experience, its
commands, review gate, session workflows, or general Codex delegation.

Evaluate this worker only when all of these are relevant:

- your coordinator needs MCP tool calls rather than plugin slash commands;
- the server owner must bound roots, explicit model overrides, forwarded
  environment names, queue size, runtime, output, and patch size;
- write-capable work must be reduced to a revision-pinned patch artifact
  generated outside the source checkout;
- process-lifetime jobs and manual patch review are acceptable.

## Using both

The integrations can coexist under distinct names, but installing both is not
required. Route each task once so Claude Code does not duplicate Codex work:

```text
Use the official Codex plugin for normal review, interactive delegation, and session workflows.
Use bounded-relay only when the task explicitly requires its MCP policy boundary or isolated patch
artifact. Never submit the same write task to both integrations concurrently.
```

The worker cannot observe or lock work launched through another integration. Its
proposal lease covers only worker processes that share its state directory.
One-writer coordination across tools remains the coordinator's responsibility.

## Branding and support

This project must not use OpenAI or Anthropic logos, describe itself as
official, imply endorsement, or redirect support requests to either vendor.
Issues about this worker belong in this repository; Codex and Claude Code
product issues belong in their vendors' official channels.
