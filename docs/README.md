# Documentation

Start with the product boundary in the root [README](../README.md). These pages
describe the implemented `0.1.0` development contract; the source and tests
remain authoritative when a document drifts.

## Operate the worker

- [Getting started](getting-started.md) — complete source installation, Claude
  Code registration, first run, upgrades, and removal.
- [Configuration](configuration.md) — startup policy, limits, model allowlist,
  environment, and state directory.
- [MCP tool reference](tool-reference.md) — exact tool names, inputs, results,
  lifecycle, and errors.
- [Compatibility](compatibility.md) — Node.js, Claude Code, Codex CLI, Git,
  operating-system, and JSONL requirements.
- [Troubleshooting](troubleshooting.md) — connection, policy, queue, runtime,
  and proposal failures.
- [Examples](../examples/README.md) — local Claude Code configuration, policy
  profiles, and sanitized outputs.

## Understand the boundary

- [Architecture](architecture.md) — components, execution flow, state, and
  extension boundaries.
- [Security model](security-model.md) — trust assumptions, enforced controls,
  data handling, and limitations.
- [Relationship to the official Codex plugin](comparison-with-codex-plugin-cc.md)
  — why the official integration remains the default and where this worker is
  intentionally different.
- [Architecture decisions](adr/README.md) — accepted decisions and their
  consequences.

## Apply and extend

- [Recipes](recipes/README.md) — read-only review, independent plan review, and
  bounded proposal coordination.
- [Optional Spec Kit integration](integrations/spec-kit.md) — add three bounded
  Codex review gates to a consumer project's spec-driven workflow without making
  Spec Kit a worker dependency.
- [Development](development.md) — repository layout, tests, quality gates, and
  release preparation.
- [Roadmap](roadmap.md) — implemented scope, candidates, and explicit non-goals.
- [JSON Schemas](../schemas/README.md) — machine-readable public contract
  references.
- [Brand assets](assets/README.md) — generated cover, compact mark, prompts, and
  intended usage.

This project does not vendor Spec Kit and has no remote service, persistent job
store, or release publishing automation in v0.1.
