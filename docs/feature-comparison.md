# Feature comparison

A capability-level comparison against the closest projects in the
Claude-Code-to-Codex space, plus the locking library whose algorithm this
project's lease manager is modelled on.

This compares **enforceable mechanisms**, not model quality, speed, or cost. It
is not a benchmark. Rows marked ⚠️ are honest gaps, not marketing.

Verified 2026-08-28 against the public READMEs of each project and, for
BoundedRelay, against its own source and test suite.

## Delegation and orchestration

| Capability                                | `openai/codex-plugin-cc` | `magic-cc-codex-worker` | **BoundedRelay** |
| ----------------------------------------- | :----------------------: | :---------------------: | :--------------: |
| Run Codex from inside Claude Code         |            ✅            |           ✅            |        ✅        |
| Vendor-supported                          |            ✅            |           ❌            |        ❌        |
| Parallel worker fan-out                   |            ❌            |           ✅            | ⚠️ deliberate no |
| Per-worker isolation                      |            ❌            |      git worktree       | disposable clone |
| Role specialization                       |            ❌            |           ✅            |        ❌        |
| Thread continuity across jobs             |            ❌            |           ✅            |        ✅        |
| Deterministic task routing, no model call |            ❌            |           ❌            |        ✅        |

Parallelism is refused on purpose: routing waves permit at most one writer, and
each writer checkpoint must be a single non-merge commit parented by the active
baseline. That trade buys reconstructible history and costs throughput.

## Policy boundary

This is the column that motivates the project.

| Control                                          | `codex-plugin-cc` | `magic-cc-codex-worker` | **BoundedRelay** |
| ------------------------------------------------ | :---------------: | :---------------------: | :--------------: |
| Inherits the user's `~/.codex/config.toml`       |   ✅ by design    |           ✅            |  ❌ **refused**  |
| User config cannot weaken the effective policy   |        ❌         |           ❌            |        ✅        |
| Server owns sandbox, model, env, timeout, output |        ❌         |         partial         |        ✅        |
| Read-only by default                             |    review only    |  ❌ implementer writes  |        ✅        |
| Writes never reach the source worktree           |        ❌         |      ❌ merge step      |        ✅        |
| Patch validated before it is returned            |        ❌         |           ❌            |        ✅        |
| Live activity sanitized (no command text or CoT) |        ❌         |         partial         |        ✅        |

BoundedRelay spawns Codex with
`--strict-config --ignore-user-config --ignore-rules`, so the policy the server
computed is the policy that runs. A user cannot relax the sandbox from their own
config file. Neither comparison project offers this; both intentionally inherit
local settings instead.

Verified live on 2026-08-28: a proposal run produced a correct 245-byte patch
touching only the allowlisted file, while the source repository kept its
original content, a clean worktree, and an unchanged `HEAD`.

## Lease and concurrency safety

The lease manager follows the heartbeat design of
[`moxystudio/node-proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile)
(MIT). The implementation here is independent and dependency-free.

| Property                                      | `proper-lockfile`  | **BoundedRelay**  |
| --------------------------------------------- | :----------------: | :---------------: |
| Atomic acquisition (`mkdir`)                  |         ✅         |        ✅         |
| Complete record published atomically          |        n/a         | ✅ staging rename |
| Liveness by periodic `mtime` refresh          |         ✅         |        ✅         |
| Staleness threshold                           |    10s default     |    10s default    |
| Holder detects that its lock was taken        | ✅ `onCompromised` |  ✅ token check   |
| Release refuses to remove a foreign lock      |         ✅         |        ✅         |
| Correct across machines sharing the directory |         ✅         |        ✅         |
| Recovers a lock orphaned mid-acquire          |        n/a         |        ✅         |
| Fully closed ABA window                       |         ✅         |    ⚠️ narrowed    |

⚠️ The theoretical ABA race — two acquirers each concluding a stale lock is
theirs — is narrowed but not proven closed. Its concrete harm is fixed: a worker
never deletes a lease it no longer owns. Closing it fully needs a fencing token
verified after publication, and that work is not started because no
deterministic failing test for it exists yet.

## Lifecycle and durability

| Capability                           | `codex-plugin-cc` | `magic-cc-codex-worker` | **BoundedRelay** |
| ------------------------------------ | :---------------: | :---------------------: | :--------------: |
| Async job handle, poll while running |        ✅         |           ✅            |        ✅        |
| Revision-aware long polling          |        ❌         |           ❌            |        ✅        |
| Resume a thread in a later job       |        ❌         |           ✅            |        ✅        |
| Jobs survive a server restart        |        ❌         |           ✅            |      ⚠️ no       |
| Persistent job store or daemon       |        ❌         |           ✅            |      ⚠️ no       |

Thread continuity is opt-in per job: `persistSession` keeps the Codex session
recorded, and `resumeSessionId` continues it. Ephemeral execution stays the
default so the privacy posture is unchanged unless a caller asks for a
continuable chain. Verified live: two separate jobs sharing one thread id, with
the second recalling a fact established in the first.

Job state itself is process-lifetime memory only. A server restart loses the
queue. Persistence is deliberately deferred — it needs a crash-recovery and
ownership design, not a storage bolt-on.

## Verification posture

|                              | `codex-plugin-cc` | `magic-cc-codex-worker` |  **BoundedRelay**  |
| ---------------------------- | :---------------: | :---------------------: | :----------------: |
| Published JSON schemas       |        ❌         |           ❌            |         ✅         |
| Policy conformance corpus    |        ❌         |           ❌            | ✅ credential-free |
| Installed-package smoke test |        ❌         |           ❌            |         ✅         |
| Enforced coverage thresholds |        ❌         |           ❌            |   ✅ 85/90/90/90   |
| Cross-platform CI matrix     |        ❌         |           ✅            |  ✅ 3 OS × 2 Node  |
| Windows fully green          |      unknown      |         unknown         |     ⚠️ one gap     |

⚠️ One Windows check is skipped: the native run of the isolated handoff proof
revalidation. The `win32` branch stays covered on POSIX by mocking
`process.platform`. The native failure is not yet diagnosed; `failChild` in
`evidence-core.mjs` now attaches the child's real error so the next Windows run
reports the cause instead of an empty message.

## Licensing note

`magic-cc-codex-worker` is PolyForm Noncommercial. No code from it is used here;
only publicly documented Codex CLI behaviour (`exec resume`) informed the
thread-continuity work. `proper-lockfile` is MIT and its algorithm is credited
in `src/core/lease-manager.ts`.

## Choosing between them

- Want vendor support and the shortest path → `openai/codex-plugin-cc`.
- Want many Codex agents working at once on isolated branches →
  `magic-cc-codex-worker`.
- Want a policy boundary the user's own config cannot weaken, patches that never
  touch the source tree, and sanitized live progress → BoundedRelay.
