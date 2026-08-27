# ADR 0006: Ship an Optional Spec Kit SDD Pack

- Status: Accepted
- Date: 2026-08-27

## Context

BoundedRelay already provides a narrow Claude Code to Codex execution boundary.
Larger features also need durable specification, planning, routing, review, and
handoff artifacts. Requiring Spec Kit in the worker runtime would couple a safe
local MCP primitive to one project workflow and would make existing users adopt
files they may not want.

## Decision

The repository uses Spec Kit for its own material changes and publishes a
generic integration pack under `integrations/spec-kit/`. The pack is included in
release artifacts, but it is not loaded by the MCP server and is not a runtime
dependency.

The integration owns run-local evidence separately from versioned governance:

- specifications and approved plans remain normal project artifacts;
- routing, delegation, and review evidence belongs to a disposable run
  directory;
- a separate verifier must validate evidence before a later gate advances;
- consumer repositories may omit or remove the pack without changing the
  established v0.1 MCP behavior.

## Consequences

Users gain a complete delivery workflow without weakening the worker boundary.
The pack must remain provider-neutral on the host side and must not assume a
particular frontend framework, monorepo tool, or Claude model. Runtime and pack
compatibility must be tested independently.
