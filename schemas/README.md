# JSON Schemas

These draft 2020-12 schemas document the v0.1 public data contract:

- [`tool-inputs.schema.json`](tool-inputs.schema.json)
- [`workspace-summary.schema.json`](workspace-summary.schema.json)
- [`public-job-snapshot.schema.json`](public-job-snapshot.schema.json)
- [`job-result.schema.json`](job-result.schema.json)
- [`sdd/v1/route-input.schema.json`](sdd/v1/route-input.schema.json)
- [`sdd/v1/route-plan.schema.json`](sdd/v1/route-plan.schema.json)
- [`sdd/v1/project-profile.schema.json`](sdd/v1/project-profile.schema.json)
- [`sdd/v1/profiled-route-input.schema.json`](sdd/v1/profiled-route-input.schema.json)
- [`sdd/v1/profiled-route-plan.schema.json`](sdd/v1/profiled-route-plan.schema.json)
- [`sdd/v1/review-input.schema.json`](sdd/v1/review-input.schema.json)
- [`sdd/v1/codex-review-output.schema.json`](sdd/v1/codex-review-output.schema.json)
- [`sdd/v1/review-artifact.schema.json`](sdd/v1/review-artifact.schema.json)

Runtime MCP input validation is implemented with Zod in `src/mcp/server.ts`;
source and contract tests are authoritative. Keep these schemas synchronized
whenever a public field changes.

`sdd/v1/route-input.schema.json` uses `neutralCodexShareBps`. It is neutral
non-quota metadata for the `sdd-routing-v2` policy; hard eligibility and
versioned task-kind fit take precedence. Its matching route plan has
`schemaVersion: 1` and remains the no-profile compatibility contract.

`project-profile.schema.json` describes strict, non-executable profile data.
`profiled-route-input.schema.json` requires that profile beside the established
task shape. Its result uses the distinct `profiled-route-plan.schema.json`
contract with `schemaVersion: 2`, `sdd-routing-v3`, and `sdd-capability-fit-v1`.
The plan binds profile identity/fingerprint, fixed executor descriptors,
capability evidence, required check command digests, Codex-only policy, tasks,
and waves. The `sdd/v1/` directory is the versioned public schema collection;
the `schemaVersion` inside each route result selects the legacy or additive plan
shape.

`review-artifact.schema.json` describes the validated terminal artifact,
including gate freshness. A generic analysis result is not review evidence and
cannot satisfy that schema's strict gate.

`tool-inputs.schema.json` is a definition bundle rather than a schema for an
invented MCP envelope. Validate an arguments object against the `$defs` entry
whose name exactly matches the tool, for example `#/$defs/codex_worker_analyze`.
Its numeric maxima show the v0.1 defaults where noted; runtime-discovered limits
remain authoritative because the server owner can configure them.

The schemas do not describe environment configuration. A project profile is
bounded route input and cannot broaden the environment-owned server policy. See
[Portable project profiles](../docs/project-profiles.md) and
[Configuration](../docs/configuration.md).
