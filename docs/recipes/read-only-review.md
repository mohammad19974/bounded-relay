# Read-only Repository Review

Use this recipe for architecture, correctness, security, test-gap, or refactor
analysis without a patch.

## Coordinator prompt

```text
Use bounded-relay for a bounded read-only review of the current Git repository.

1. Call codex_worker_workspace and show me the canonical repository and revision.
2. Submit codex_worker_analyze with the task below.
3. Poll status with bounded waits and the last revision as afterRevision; report the sanitized
   activity label and real counters if I ask for progress.
4. When terminal, retrieve the result and separate verified findings from suggestions.
5. Do not enable proposal mode, request writes, or ask another agent to implement findings.

Task: Review the request-validation boundary for concrete correctness and security bugs. Cite files
and explain the smallest safe follow-up for each high-confidence issue.
```

## Expected flow

```text
workspace -> analyze -> status(afterRevision, waitMs <= 30000) -> result
```

Analysis runs in the selected source repository with Codex's read-only sandbox.
The source may be dirty, but findings should distinguish committed code from
local changes when that matters.

## Review checklist

- Confirm `mode` is `analyze`.
- Confirm the canonical root is the intended repository.
- Do not interpret event counts as percent complete.
- Treat model output as advisory until independently verified.
- Do not turn findings into a write job without separate user authorization.
