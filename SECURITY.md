# Security Policy

## Supported versions

The project is pre-stable. Until the first public release, security fixes target
the current default branch only. After releases begin, this table will name
supported version lines explicitly.

| Version                    | Supported   |
| -------------------------- | ----------- |
| Current default branch     | Yes         |
| Unreleased local snapshots | Best effort |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting or a private draft Security
Advisory for this repository when that feature is enabled. If it is not
available, contact a maintainer privately through their verified GitHub profile
and share only enough information to establish a secure reporting channel.

Include:

- affected revision or version;
- operating system, Node.js version, Codex CLI version, and Claude Code version;
- minimal reproduction using a disposable repository and fake secrets;
- expected and observed behavior;
- security impact and any known workaround.

Never include live provider tokens, `auth.json`, private source, or unrelated
personal data.

Maintainers should acknowledge a complete report, establish a private
remediation channel, and coordinate disclosure after a fix is available. No
response-time SLA is promised before a formal maintainer team and contact
channel are published.

## Security boundary

The worker is a local process running with the current operating-system user's
permissions. It is not a security sandbox by itself.

- Analyze jobs ask Codex to use a read-only sandbox.
- Proposal jobs use `workspace-write` only in a disposable local clone.
- The original repository is never a proposal execution root.
- A proposal is output data. The worker never applies it.
- Job metadata and results exist only in process memory; this release has no
  durable audit log.
- Codex model traffic, retention, and account controls are governed by Codex CLI
  and the user's OpenAI configuration, not by this project.

Read [docs/security-model.md](docs/security-model.md) before enabling proposal
mode or forwarding authentication environment variables.

## Out of scope for a vulnerability report

- Model output that is incorrect but does not cross an enforced boundary.
- Token usage, latency, or model availability controlled by a provider.
- Edits performed manually or by another tool outside this worker.
- Jobs disappearing after the stdio server exits; v0.1 is intentionally
  in-memory.

Boundary bypasses, command injection, unexpected writes to the source
repository, patch-validation bypasses, secret disclosure, symlink escapes, and
unauthorized path access are in scope.
