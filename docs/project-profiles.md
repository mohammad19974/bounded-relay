# Portable Project Policy Profiles

Project profiles adapt deterministic routing and delivery evidence to a
repository without installing executable extensions or weakening BoundedRelay's
server boundary. A profile is reviewed JSON data: it can describe capability
fit, narrower write scopes, required check definitions, and exact Codex policy.
It cannot run a command, select a Claude model, grant access, or apply a patch.

Use a profile when the generic task-kind policy is not specific enough for a
repository. Omit it when the established v0.1 router is sufficient; the
no-profile `routeSddTasks` result and fingerprint contract remain unchanged.

## The authority intersection

Profiles supply restrictions and routing evidence, not authority:

```text
server policy
  intersection trusted operator configuration
  intersection approved project profile
  intersection bounded request
  = effective execution policy
```

For example, a profile can request a Codex model, but the MCP server refuses it
unless that exact model is in `CCW_ALLOWED_MODELS`. A profile can allow writes
under `src/`, but a task limited to `src/parser/` stays limited to
`src/parser/`. Neither value can enable proposal mode, add an allowed root,
forward an environment variable, or relax a protected path.

## Quick start

Build BoundedRelay, then write the built-in starter profile to standard output:

```bash
npm run build
node dist/cli.js profile template > project-profile.json
```

Review the file as security-relevant project configuration. Edit identifiers,
capabilities, task policies, write restrictions, check definitions, and Codex
policy for the repository, then validate it without making a provider call:

```bash
node dist/cli.js profile validate < project-profile.json
```

The generated template gives both lanes equal starter scores, defines no checks,
and allows no write roots. It can route read-only work, while write tasks fail
closed until you add explicit reviewed roots. Check definitions and receipts
become mandatory only for check IDs selected by `requiredChecks`. The template
also cannot route critical work until an explicit critical Codex policy is added
and server-allowlisted.

Validation reads JSON from standard input and prints normalized public metadata
to standard output. It does not execute check definitions, read the target
repository, contact a provider, or modify a file.

A generic checked-in example is available at
[`examples/profiles/starter.json`](../examples/profiles/starter.json). Treat it
as a contract example, not a recommended capability score or delivery command
for every project.

For the TypeScript API, keep the profile path explicit:

```js
import { routeProfiledSddTasks } from "boundedrelay";

const plan = routeProfiledSddTasks({
  projectProfile,
  tasks,
});
```

MCP callers pass the same `projectProfile` object to `codex_worker_sdd_route`.
The resulting profiled plan uses schema version `2`, routing policy
`sdd-routing-v3`, and fit policy `sdd-capability-fit-v1`. See the
[tool reference](tool-reference.md) and public
[JSON Schemas](../schemas/README.md) for the exact wire contract.

## Contract map

The strict schema rejects unknown fields. Its main sections are:

| Section           | Purpose                                                                                                    | Security property                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Identity          | `profileId` and `profileVersion` identify reviewed profile content.                                        | Safe bounded strings only; identity fields are not authentication.                       |
| Lane capabilities | `laneCapabilities` declares bounded scores for the two fixed lanes.                                        | Scores affect only deterministic fit and cannot add a lane or override hard eligibility. |
| Task policies     | `taskPolicies` maps task kinds to weighted capabilities and minimums.                                      | A lane missing a required minimum is ineligible for that task.                           |
| Check profiles    | `checkProfiles` binds a safe ID to canonical bounded `argv` and repository-relative `cwd` data.            | Routing and validation digest this data but never execute it.                            |
| Required checks   | `requiredChecks` selects check IDs through `always`, `byKind`, `byRisk`, and `byAuthority`.                | The union is attached to matching write evidence; unknown or duplicate IDs fail.         |
| Codex policy      | `codexPolicy` resolves `default`, `byKind`, and `byRisk` model/reasoning values for Codex work and review. | The server-owned model allowlist remains authoritative; no Claude model is selectable.   |
| Write policy      | `writePolicy.allowedRoots` and `additionalDeniedRoots` bound repository-relative write scopes.             | Both lists only narrow task scopes and runtime policy.                                   |

All arrays, maps, strings, scores, and paths are bounded by the public schema.
Paths use `/`-separated repository-relative form. Absolute paths, traversal,
backslashes, `.git` segments, and duplicate entries fail closed. An
`additionalDeniedRoots` entry may intentionally sit below an allowed root; a
write task whose scope overlaps that denied root fails during routing.

## Capability fit and hard eligibility

The profiled router keeps two fixed lanes: `codex` and `claude-host`. The latter
means the current Claude Code session and whatever host model the user selected;
the profile does not know or choose that model.

For each task, routing proceeds from constraints to tie-breakers:

1. validate the graph, task authority, scopes, and hard `eligibleLanes`;
2. eliminate a lane that misses any profile capability minimum;
3. compare the versioned weighted capability fit of the remaining lanes;
4. apply an eligible task preference only where the fit policy permits it;
5. use neutral effort/task-count balance and canonical identifiers only for
   otherwise equivalent assignments.

Capability scores are project-owned policy inputs. They are not measurements of
model intelligence, latency, token use, price, or code quality. Change them only
through review and expect the profile and route fingerprints to change.

A task kind must have a matching `taskPolicies` entry. A referenced capability
that is omitted from one lane receives score `0` for that lane; missing policy,
unknown capability, or no lane meeting every minimum fails closed.

`requiredChecks.byRisk` and `codexPolicy.byRisk` do not silently bias lane
capability. They select explicit verification and Codex policy requirements.
Critical profiled work requires an explicit critical-risk Codex policy even when
the implementation task belongs to `claude-host`, because the independent Codex
review must still be bounded.

## Write restrictions

A write task already declares `writeScopes`. The profile intersects those scopes
with `writePolicy`:

- `allowedRoots` are an upper bound, never an expansion;
- `additionalDeniedRoots` reject an overlapping task scope, including ancestor
  or descendant overlap; and
- the runtime's protected files, proposal enablement, allowed roots, revision
  pin, and changed-path validation still apply.

Profile validation and routing do not touch a repository. Actual Codex writes,
when separately enabled, still occur only in a disposable proposal clone. The
Claude Code host remains responsible for its own source edits and for honoring
the routed wave; the optional Spec Kit pack verifies the checkpoint afterward.

## Check definitions and command digests

A check profile is a declaration used to match delivery evidence. It contains a
safe profile ID plus bounded argument-vector and working-directory data. It is
not an automatically executed hook:

- sizes, control characters, the argument count, and the repository-relative
  working directory are validated, but executable-looking or URL-like arguments
  are still inert data rather than proof that a described command is safe;
- profile template, validation, normalization, fingerprinting, and routing never
  execute the declared arguments; and
- the coordinator must review the definition before separately running an
  equivalent command with its own authority.

Never store a credential, token, or other secret in `argv`. Normalization and
fingerprinting are not a secret scrubber, and profile content may be committed
or copied into workflow evidence.

Canonical `argv` and `cwd` data produce a command digest. A matching write task
lists its required check profile IDs and digests in the profiled route. The
optional workflow accepts a checkpoint only when successful, redacted,
tree-bound receipts cover every required ID and exact digest. A digest proves
content equality, not that the command was safe, that it actually ran, or that
its result was correct; coordinator-attested receipts are not signed CI
attestations.

## Codex-only model policy

`codexPolicy` can supply a default and task-kind or risk-specific
model/reasoning rules. Resolution is deterministic:

1. matching risk rule;
2. matching task-kind rule;
3. default rule.

The default or an ordinary kind/risk rule may use `null` for both values to keep
the server/runtime defaults. It cannot contain a Claude model. A non-null model
is usable through MCP only when the server operator has included it in
`CCW_ALLOWED_MODELS`; structural validation alone does not establish model
availability or account access. A `critical` risk rule must explicitly provide
both model and reasoning effort, and missing or unavailable critical policy
fails instead of silently downgrading.

The resolved policy is routing evidence. Execution and strict review still
exact-match the routed values and use the normal server/runtime checks.

## Fingerprints are content addresses

Normalization sorts unordered values, applies defaults, and rejects ambiguous
input. Semantically equivalent profiles therefore receive the same lowercase
SHA-256 profile fingerprint. A profiled plan binds the normalized profile,
resolved Codex policies, required check descriptors, executor roles, and route
to its own plan fingerprint.

These fingerprints answer “are these bytes and policy decisions the same?” They
do not answer “who approved this?”, “is this safe?”, or “was this produced by a
trusted machine?” Use code review, repository permissions, and an external
signing system when provenance or identity is required.

## Portability checklist

Before adopting one profile across repositories:

1. review every field and compare it with the server's allowed roots, proposal,
   model, environment, and resource policy;
2. replace generic capability scores with reviewed project policy, without
   treating them as model benchmarks;
3. keep allowed write scopes narrow and explicitly protect release, credential,
   deployment, and generated-code areas where appropriate;
4. review every check definition locally before running it, and never accept a
   profile from an untrusted repository as authorization to execute commands;
5. validate the profile and store the normalized fingerprint with the review;
6. route a credential-free fixture and inspect assignments, required checks,
   resolved Codex policy, waves, and fingerprints; and
7. re-review after any profile change. Old evidence does not approve new
   content.

## Credential-free conformance

From a source checkout, run:

```bash
npm run build
npm run eval:routing
```

The deterministic corpus imports the built package and checks named policy
invariants such as canonical equivalence, no-profile compatibility, hard
eligibility, capability minimums, write restriction refusal, profile binding,
dependency order, and single-writer waves. It needs no Claude or Codex
credential and makes no provider request.

Passing the corpus means those routing-policy assertions held for the shipped
implementation and fixture set. It does not benchmark models or establish better
code, lower cost, token savings, or production correctness.

The trust and compatibility rationale is recorded in
[ADR 0010](adr/0010-portable-intersection-only-project-profiles.md).
