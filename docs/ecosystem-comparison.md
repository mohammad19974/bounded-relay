# Ecosystem comparison

> Snapshot: 2026-08-28. This is an architectural comparison based on each
> project's official documentation. It is not a benchmark, ranking, endorsement,
> or claim that one tool is universally better.

## BoundedRelay's design center

BoundedRelay is a deliberately narrow, asymmetric orchestration boundary:

```text
human -> Claude Code host orchestrator -> local BoundedRelay MCP -> Codex worker
```

Claude Code owns the workflow, user interaction, and authorized integration.
BoundedRelay constrains what its Codex child can read or propose. It adds a
model-free router, isolated proposals, detached strict-review clones, and
content-addressed host-then-Codex evidence. Portable
[project profiles](project-profiles.md) specialize routing and verification
through strict data without adding executable plugins. BoundedRelay does not
launch Claude, merge patches, or attempt to be a general swarm platform.

## Nearby projects

| Project                                                                        | Documented focus                                                                                                                                           | Relationship to BoundedRelay's design center                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [crew-mcp](https://github.com/chasenstark/crew-mcp#readme)                     | A host-as-captain MCP crew with multiple provider workers, isolated worktrees, review panels, acceptance criteria, and explicit merge/discard operations.  | A broader multi-provider crew. BoundedRelay keeps a one-way Claude-host-to-Codex boundary and does not expose an automatic merge operation.                               |
| [AWO](https://github.com/ystepanoff/awo#readme)                                | A standalone CLI for isolated Claude/Codex worktrees, writer-reviewer or competitive modes, verification commands, and per-run proof-pack artifacts.       | A run-oriented CLI. BoundedRelay remains MCP-native, keeps the Claude Code host in control, and writes a bounded digest index instead of a long-form provider transcript. |
| [Agent Orchestrator](https://github.com/ralphkrauss/agent-orchestrator#readme) | A persistent local daemon with typed orchestration turns, several CLI backends, follow-ups, cancellation, notifications, logs, and durable run inspection. | A durability- and backend-oriented supervisor. BoundedRelay v0.1 has process-lifetime MCP jobs and a narrower Codex authority boundary.                                   |
| [Ruflo](https://github.com/ruvnet/ruflo#readme)                                | A broad meta-harness with swarms, plugins, memory, multi-provider routing, federation, and observability.                                                  | A platform-breadth design. BoundedRelay intentionally uses deterministic policy, two fixed lanes, and no mutable cross-run routing memory.                                |
| [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD#readme)             | A planning and delivery methodology with explicit decisions, progressive context, and specialized roles.                                                   | A methodology-first system. BoundedRelay adds a local runtime boundary and evidence validators around one Codex worker path.                                              |
| [GitHub Spec Kit](https://github.github.com/spec-kit/)                         | Durable specs, plans, tasks, checklists, agent integrations, resumable workflows, loops, and human gates.                                                  | Spec Kit supplies the optional process engine. BoundedRelay constrains its own Codex subprocesses; it does not sandbox arbitrary Spec Kit shell steps.                    |

The
[official OpenAI Claude Code plugin comparison](comparison-with-codex-plugin-cc.md)
covers the closest vendor-supported Claude-to-Codex option separately.

## Ideas adopted and specialized here

The projects above are prior art, not compatibility claims. BoundedRelay adopts
several documented patterns but implements a narrower contract:

- The visible host/captain pattern and human-controlled integration mirror the
  interaction model documented by
  [crew-mcp](https://github.com/chasenstark/crew-mcp#how-it-works), while
  BoundedRelay exposes a smaller asymmetric worker surface.
- Disposable write and review checkouts are common to
  [crew-mcp](https://github.com/chasenstark/crew-mcp#readme) and
  [AWO](https://github.com/ystepanoff/awo#readme). BoundedRelay specializes them
  into an origin-free read-only review clone and a revision-pinned proposal
  clone that can return a patch but cannot integrate it.
- The optional pack uses Spec Kit's documented
  [`do-while`, resumability, and human-gate primitives](https://github.com/github/spec-kit/blob/main/docs/reference/workflows.md)
  to drive one dependency wave at a time. BoundedRelay adds the `execution.json`
  chain: each wave starts from the previous verified clean commit, has at most
  one writer, requires one direct-child non-merge writer commit, binds checks to
  the tested Git tree, and proves a persisted Codex patch reconstructs that tree
  in a disposable index.
- AWO documents a per-run
  [proof-pack artifact](https://github.com/ystepanoff/awo#artifact-layout).
  BoundedRelay adopts the proof-pack idea but stores a bounded digest-only JSON
  index and reruns full authoritative routing projections, strict evidence,
  historical wave validation, exact execution/review source chains, and current
  convergence freshness before delivery.
- Human-confirmed Spec Kit artifacts, independent cross-provider review, and
  exact-or-refuse critical Codex profiles are combined here with fail-closed
  content-addressed evidence. Every rejection aborts the chain and requires a
  fresh corrected run.
- The MCP runtime remains usable without Spec Kit; the full SDD pack is an
  explicit local installation for repositories that need these extra gates.
- Portable project profiles provide a deliberately smaller extensibility seam
  than a general agent/plugin registry: capability fit, narrower write scopes,
  required check descriptors, and Codex policy are canonical data intersected
  with server policy. They cannot load code, add providers, or execute hooks.

## Intentionally deferred

- durable jobs across MCP server restarts, a local daemon, and push
  notifications;
- automatic commit, patch application, merge, push, pull request, or deploy;
- generic Claude/Codex/Gemini/local-model crews or recursive provider calls;
- competitive execution of every task, which adds cost without guaranteeing a
  better result;
- self-learning routing, vector memory, federation, or mutable cross-run agent
  state;
- provider-wide cost optimization until comparable Claude usage is observable;
- a preventive filesystem interlock for Claude-host edits. The optional pack
  mechanically detects an invalid wave at the clean checkpoint, but BoundedRelay
  does not intercept Claude Code's filesystem tools before then;
- numeric quality, speed, token, or savings claims until a reproducible pinned
  benchmark exists.

## Choosing by invariant

BoundedRelay is a fit when the desired invariant is: stay inside Claude Code,
delegate bounded work to Codex, preserve one integration writer, explain every
route, and require same-revision independent review without adopting a broad
swarm or autonomous merge service.

Choose a broader orchestrator when multiple interchangeable providers, durable
daemon state, distributed agents, competitive candidates, or automated
integration are the main requirement. Choose a methodology-first tool when the
primary need is product discovery and planning depth rather than runtime
isolation.

Feature surfaces change. Re-check the linked primary sources before making an
adoption decision. Model choice, prompts, repository quality, tests, and task
decomposition remain major outcome factors that this table does not measure.
