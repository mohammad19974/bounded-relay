# Development

## Requirements

- Node.js `^22.13.0 || ^24.0.0`;
- npm compatible with the checked-in lockfile;
- Git;
- Codex CLI only for optional manual smoke tests.

Automated tests must not require Claude Code, Codex authentication, provider
credentials, network access, or a paid model call.

## Setup

```bash
npm ci
npm run build
npm test
```

When a lockfile is present, CI and clean local verification should use `npm ci`.

## Commands

| Command                 | Purpose                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`           | Start the TypeScript stdio server for local development. It waits for an MCP client. |
| `npm run format`        | Apply Prettier formatting.                                                           |
| `npm run format:check`  | Verify formatting.                                                                   |
| `npm run lint`          | Run ESLint with zero allowed warnings.                                               |
| `npm run typecheck`     | Run strict TypeScript checks without emit.                                           |
| `npm test`              | Run deterministic Vitest tests once.                                                 |
| `npm run test:coverage` | Run tests with repository coverage thresholds.                                       |
| `npm run build`         | Emit the ESM package and declarations to `dist/`.                                    |
| `npm run pack:check`    | Pack, clean-install, and exercise the real npm artifact without publishing.          |
| `npm run check`         | Run all release-quality local gates.                                                 |

## Source layout

```text
src/
├── cli.ts                    # CLI entrypoint and signal handling
├── worker-application.ts     # Composition root
├── config/                   # Environment parsing and limits
├── core/                     # Job state, leases, public types, errors
├── mcp/                      # Tool schemas and stdio transport
├── runtime/                  # Codex, Git, workspace, and proposal adapters
├── sdd/                      # Adaptive routing, revision seals, evidence, and gates
└── security/                 # Paths, executables, environment, state, prompts
```

Keep domain and policy logic independent from MCP presentation where practical.
The server owns public schemas; the job manager owns state transitions; adapters
own subprocess details.

## Testing strategy

### Unit tests

Cover configuration parsing, path containment, executable resolution,
environment allowlisting, prompt authority, JSONL decoding, event normalization,
error mapping, idempotency, job transitions, history eviction, canonical SDD
routing, revision seals, evidence validation, freshness, and gate evaluation.

### Integration tests

Use temporary Git repositories and a fake Codex executable. The fake process
should support deterministic JSONL, malformed events, failure exits, timeouts,
output floods, signal handling, and controlled file changes.

Proposal integration coverage should prove:

- the source worktree is unchanged byte-for-byte;
- dirty trees and revision drift are rejected;
- submodules are rejected;
- origin and hooks are disabled in the clone;
- changed paths and symlinks are enforced;
- `HEAD` and refs cannot change;
- binary patch bytes and digest are stable;
- clone and lease cleanup occurs on success, failure, cancellation, and timeout.

SDD integration coverage should prove:

- semantically identical task graphs produce the same v2 fingerprint and
  reasons;
- hard eligibility and task-kind fit win before neutral share metadata;
- preference affects only exact base-fit ties, and risk does not bias a lane;
- true neutral odd ties prefer Codex and execution waves have one writer;
- strict review rejects dirty, unsafe, malformed, fenced, mismatched, and stale
  evidence;
- host findings are frozen before Codex and absent from the generated Codex
  prompt;
- draft review never produces a ready gate;
- integration fixtures need no Claude CLI, provider credentials, or paid call.

### MCP contract tests

Start the built stdio executable through an MCP client transport and verify:

- exact registered tool names;
- proposal tool presence only when enabled;
- schemas reject unsafe input before job creation;
- `structuredContent` and text JSON agree;
- errors set `isError` and include stable codes;
- status exposes only the fixed activity projection and supports `afterRevision`
  polling;
- list results use the documented `{ "jobs": [...] }` envelope;
- result omits patch by default and includes it only when requested;
- SDD route input/output and fingerprints match the JSON contracts;
- specialized review uses status/result lifecycle and returns a validated gate,
  while generic analysis cannot satisfy it;
- stdout contains protocol traffic only.

### Installed-package contract

`npm run pack:check` is the distribution gate. It checks the actual tarball
rather than importing source through `tsx`: required runtime and integration
files must ship, private/development files must not ship, an empty consumer must
install the artifact, and its CLI, ESM entrypoint, npm shim, structural SDD
validator, and credential-free MCP surface must work. CI repeats this contract
on every supported operating-system and Node.js pair.

Documentation contract tests also keep local links, JSON examples, package
identity, generated brand assets, and packaged integration manifests from
drifting before publication.

### Real-provider smoke tests

These are manual and optional. Use a disposable, non-sensitive repository. Never
add them to normal CI or require a contributor to spend provider quota.

## Manual MCP inspection

After building, register the absolute local path in a disposable repository, or
use the MCP Inspector if it is installed separately:

```bash
npx @modelcontextprotocol/inspector node /absolute/path/to/dist/cli.js serve
```

The command may download the Inspector package. Review and pin third-party
tooling according to your environment's supply-chain policy.

## Adding or changing a tool

1. Define the public need and least authority.
2. Update the threat model and add an ADR for a new trust boundary.
3. Add strict input validation and honest MCP annotations.
4. Add deterministic unit, integration, and stdio contract tests.
5. Update tool reference, schemas, examples, troubleshooting, and changelog.
6. Run `npm run check` and test the packed tarball as a consumer.

Do not expose arbitrary commands, raw environment values, shell strings, direct
patch application, or an option that changes the original repository.

## Release preparation

There is intentionally no publishing workflow in v0.1. Before a first release:

- confirm the npm name and repository URL;
- add real package metadata without placeholders;
- verify the lockfile and clean install;
- run the full OS/Node CI matrix;
- inspect `npm pack --dry-run` and install the tarball into a clean consumer
  project;
- perform a manual read-only smoke test and an isolated proposal smoke test;
- enable GitHub private vulnerability reporting;
- create release notes from `CHANGELOG.md`;
- configure npm trusted publishing/provenance in a separately reviewed change.

Never add long-lived provider credentials to GitHub Actions.
