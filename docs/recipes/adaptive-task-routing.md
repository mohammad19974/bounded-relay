# Adaptive Quality-First Task Routing

Use this recipe after a task graph is approved and before either lane starts
implementation. Routing is deterministic and model-free; it assigns authority
but does not execute a task.

## Coordinator prompt

```text
Route this approved task graph through codex_worker_sdd_route.

1. Translate each approved task into a stable ID, integer effortPoints, risk, authority, kind,
   dependencies, and exact writeScopes. Mark a lane ineligible only for a real capability,
   authority, or safety constraint. Treat preferredLane as soft.
2. Use neutralCodexShareBps=5000 as neutral metadata, not a quota.
3. Preserve the returned routingPolicyVersion and planFingerprint.
4. Show every assignment, wave, reason code, actual share, and deviation. Do not claim token or
   cost savings.
5. Execute waves in order. Allow multiple read-only tasks in a wave, but only the returned
   writerTaskId may write. Codex writes must use isolated revision-pinned proposals.
6. If the approved task graph changes, route it again and invalidate downstream delegation
   evidence.
```

## Policy interpretation

The router first enforces hard eligibility and validates the graph/scopes. It
then minimizes regret against versioned task-kind lane fit. An explicit
`preferredLane` applies only when both lanes have the same base fit. Only then
does the router compare neutral effort share and task-count share using the same
configured value. The odd-task Codex preference applies only at a true neutral
50/50 tie; lexical task ID is final.

Risk does not bias provider fit; `critical` activates the workflow's independent
cross-provider review/profile policy. The actual result may assign all work to
one lane when eligibility or fit calls for it. `50/50` is not forced. Effort
points are planning estimates, not tokens, price, provider quota, elapsed time,
or quality measurements.

## Lane meaning

- `claude-host` uses the current model selected in Claude Code. BoundedRelay
  neither chooses nor verifies it.
- `codex` uses the local worker and its server-owned model allowlist. A model or
  effort profile is never inferred from the share.

For critical workflow tasks, use the separate explicitly approved model policy
from the [Adaptive SDD guide](../integrations/spec-kit.md). Never silently
downgrade an unavailable profile.

## Verification checklist

- Task IDs are unique and dependencies are known and acyclic.
- Read-only tasks have no write scopes; write tasks have at least one safe
  repository-relative scope.
- `planFingerprint` belongs to the exact normalized graph being executed.
- Every writer follows its returned wave and scope.
- A changed route causes delegation evidence to be rebuilt.
