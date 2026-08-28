# Project Profile Examples

[`starter.json`](starter.json) is a provider-neutral, read-only starting point:

- both lanes receive the same placeholder capability score;
- every supported task kind has a policy so read-only examples can route;
- no check command is declared;
- Codex model and reasoning values use the server/runtime defaults; and
- `allowedRoots` is empty, so every write task fails until a maintainer reviews
  and explicitly narrows the repository's allowed write roots.

Validate it without credentials or a provider call:

```bash
npm run build
node dist/cli.js profile validate < examples/profiles/starter.json
```

This file is illustrative data, not a model ranking or a universal repository
policy. Review every field before use. To route critical work, add an explicit
non-null `codexPolicy.byRisk.critical` model and reasoning effort, then ensure
the MCP server operator separately allowlists that exact model.

See [Portable project profiles](../../docs/project-profiles.md) for the full
contract and security boundary.
