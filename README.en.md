# dsh-sandbox-allowlist

English ｜ [简体中文](README.md)

A DSH (DeepSeek Harness) sandbox extension plugin: three kinds of configurable
permission rules on top of the official sandbox, all mounted through the official
plugin mechanism — **no official package code is modified**.

| Rule | Problem it solves | In one line |
|---|---|---|
| **Authorized directories** `allowedDirs` | the agent must write outside the workspace | trusted directories become writable as a whole — no approvals, no disabling the sandbox |
| **Command rules** `commands` | command approvals are too noisy or too loose | allow / ask / deny by command pattern; compound commands are judged segment by segment |
| **Read restrictions** `noRead` | certain things must not be read by the model | deny outright by file name/path, or allow once via ask |

All three are edited visually in the settings page and take effect on save. Windows
(ACL sandbox) is verified on real machines; Linux (bwrap) is implemented but **not yet
real-machine verified**.

> Current version `v0.2.0-beta.1`, compatibility baseline dsh `0.2.0-rc.2`.

## Install

```bash
# From the npm registry / GitHub Releases (once published)
dsh plugin --profile web add dsh-sandbox-allowlist

# Local development (tarball)
pnpm pack --pack-destination /tmp/pkg
dsh plugin --profile web add /tmp/pkg/dsh-sandbox-allowlist-*.tgz
```

Requirements: dsh ≥ 0.2.0-rc.2 (the only verified version; earlier versions are
untested), Node ≥ 20.11. Installing appends a patch layer to the profile; later
configuration changes **hot-apply via HMR** — no restart needed.

## Quick start

The recommended way is editing the "Sandbox authorization" section in the settings
page; the same configuration can also be edited directly in the profile's patch layer
(the `config` of this plugin's row in `<profile>/cordis.patch.yml`). A minimal
configuration (**paths are examples — replace them with your real directories**):

```yaml
- id: sandbox-allowlist-policy
  config:
    # (1) Authorized directories: writable directly from inside the sandbox
    allowedDirs:
      - 'D:\Shared\Tools'
    # (2) Command rules: unmatched commands keep the current dsh behavior (ask as needed)
    commands:
      rules:
        - pattern: 'git status*'   # narrow rule: read-only shapes only
          action: allow
        - pattern: 'rm -rf *'
          action: deny
    # (3) Read restrictions: reading is allowed by default; restrict as needed
    noRead:
      - pattern: '*.pem'
        action: deny
```

> ⚠️ **Security warning**: authorized directories may be written by sandboxed AI
> agents **without approval** (outside the workspace). Only add fully trusted
> directories; directories must **already exist and be owned by the current user**.
> Revoking trust = removing the entry; the previously granted write access is
> reclaimed automatically.

## Configuration quick reference

| Field | Purpose | Details |
|---|---|---|
| `allowedDirs` | trusted writable directories outside the workspace, with `**` / `*` / `?` wildcards | [guide §1](docs/guides/permission-rules.en.md) |
| `commands.rules` | command pattern + action; matched in order, last match wins; compound commands judged segment by segment | [guide §2](docs/guides/permission-rules.en.md) |
| `commands.default` | default action when no rule matches: `delegate` / `allow` / `ask` / `deny` | same |
| `commands.escalation` | auto-approve sandbox escalations: `capability` (default) / `never` | same |
| `commands.baseline` / `sessionCache` | built-in capability baseline / session-scoped command cache (on by default) | same |
| `noRead` | read restrictions: file-name / full-path / directory-wide forms, `deny` / `ask` | [guide §3](docs/guides/permission-rules.en.md) |

Full semantics (the three-layer decision flow, hard tracks, Auto review delegation,
decision trail, scenario examples, troubleshooting) live in the
**[permission rules guide](docs/guides/permission-rules.en.md)**.

## How it works (summary)

What the sandbox may write is an allow-list; this plugin **appends the authorized
directories** to it: on Windows it materializes inherited write ACEs for the workspace
write SID (revocation reclaims automatically, with a persisted reconcile manifest); on
Linux it extends `bwrap` with `--bind`. For the mechanics, security design and the
reconcile loop see [architecture and security boundaries](docs/guides/architecture.en.md).

## Security boundaries (must read)

- **A broad `pattern` grants machine-wide execution**: `allow` includes
  sandbox-escalation authorization — `git *` even admits git protocol injection.
  Express precise intent with narrow rules (`git status*`, `pnpm test*`).
- **Three hard tracks no rule can override**: unparseable structures fail closed;
  out-of-bounds write paths are never auto-approved; a command referencing a
  read-denied target is never auto-approved.
- **noRead only constrains the model's file tools and `ctx.fs` reads**: `cat` in
  bash/pwsh and the grep/glob tools cannot be intercepted — move genuinely sensitive
  files out of the model's reach.
- Full boundary analysis in
  [architecture and security boundaries](docs/guides/architecture.en.md).

## Known limitations

- Windows: authorized directories must already exist and be owned by the current user;
  leftover ACEs can be cleaned up with `node scripts/revoke.mjs` (normally
  unnecessary).
- Linux: the `bwrap` path is implemented but **not yet real-machine verified**;
  `landlock`/`seatbelt` are not supported.
- The write/edit tools only admit authorized directories in `workspace-write` mode.
- If installing/uninstalling/toggling the plugin while running misbehaves, see
  [known issues](docs/issues/ki-1-session-controller-reload-race.md).

## Documentation

| Document | Contents |
|---|---|
| [Permission rules guide](docs/guides/permission-rules.en.md) ([中文](docs/guides/permission-rules.md)) | full syntax, semantics, scenarios and troubleshooting for the three rule kinds |
| [Architecture and security boundaries](docs/guides/architecture.en.md) ([中文](docs/guides/architecture.md)) | how it works, security boundaries, known limitations |
| [Development and testing](docs/development.en.md) ([中文](docs/development.md)) | test suites, build and deployment, internal contracts, package layout |
| [Permission configuration test plan](docs/testing/test-plan-permissions.en.md) ([中文](docs/testing/test-plan-permissions.md)) | in-session end-to-end validation script |
| [docs directory guide](docs/agents.md) | docs structure and collaboration conventions (for collaborators and AI) |

## Development

```bash
npm test && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client \
  && npm run test:dry-mount
```

Test environment variables, real-machine verification points and internal contracts:
[development and testing](docs/development.en.md).

## License

MIT
