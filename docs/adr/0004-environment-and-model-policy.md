# ADR 0004: Environment and model overrides are server-owned allowlists

**Status:** Accepted  
**Date:** 2026-08-27

## Context

An MCP server inherits Claude Code's process environment. Forwarding it
wholesale to Codex would make unrelated credentials and local configuration
visible to model-invoked repository commands. Allowing arbitrary model
identifiers would also let untrusted tool input bypass operator policy and make
behavior less reproducible.

## Decision

- Construct the child environment from a small operational allowlist.
- Forward known provider-token variables only with `CCW_FORWARD_AUTH_ENV=true`.
- Forward other variables only when their names appear in `CCW_FORWARD_ENV`.
- Never expose environment values through CLI config, capabilities, tool errors,
  or logs.
- Invoke Codex with `--strict-config`, `--ignore-user-config`, and
  `--ignore-rules`; the last flag disables user/project execpolicy `.rules`
  files for this subprocess.
- Omit model by default; accept an explicit model only when the server owner
  lists it in `CCW_ALLOWED_MODELS`.
- Treat reasoning effort as an explicit bounded enum and let Codex reject
  unsupported combinations.

## Consequences

- Normal saved Codex login remains available through `HOME` and `CODEX_HOME`.
- Environments relying on token variables must deliberately widen the boundary.
- Proxy, certificate, or tool-specific variables may require explicit
  forwarding.
- User Codex configuration does not silently change worker jobs.
- The project does not maintain a model catalog or claim an optimal route.

## Alternatives rejected

- **Inherit all environment variables:** convenient but exposes secrets
  unnecessarily.
- **Block all auth variables permanently:** prevents legitimate non-interactive
  deployments.
- **Accept any caller-provided model:** transfers server policy to untrusted
  input.
- **Hard-code current model tiers:** becomes stale and implies unsupported
  quality claims.

## Revisit when

Codex introduces a stronger scoped credential mechanism or a stable
configuration contract that can be safely composed without inheriting unrelated
user policy.
