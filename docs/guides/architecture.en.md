# Architecture and security boundaries

> Language: English ｜ [简体中文](architecture.md)
>
> This document explains how the plugin works, its security boundaries, and its known
> limitations. For using the three rule kinds, see the
> [permission rules guide](permission-rules.en.md). Applies to `v0.2.1-beta.1`,
> compatibility baseline dsh `0.2.0-rc.2`.

## How it works

What the DSH sandbox may write = an allow-list. This plugin **appends the authorized
directories** to that list:

- **Windows**: the sandbox uses the workspace write SID's Write ACE as its allow-list.
  The plugin materializes that SID's **inherited write ACE** (`(OI)(CI)(W,D,DC)`) on
  every authorized directory → confined CLI processes can write directly and future
  subdirectories inherit automatically; the write/edit tools are admitted by the
  plugin's own fs fence against the same list.
  **Revocation reclaims**: removing a directory from the configuration triggers an
  automatic reconcile that removes the write ACEs previously written into that tree
  (subdirectories included) — no manual cleanup needed. The reconcile manifest is
  persisted at `$DSH_HOME/sandbox-allowlist-grants.json`; even edits made while the
  process was offline are backfilled on the next start.
- **Linux**: `bwrap` is extended with `--bind <root> <root>`.

## Security boundaries (must read)

- **A broad `pattern` grants machine-wide execution**: the `allow` semantics include
  sandbox-escalation authorization, so one broad rule authorizes **any** command under
  that prefix to run outside the sandbox — `git *` even admits git protocol injection
  (`ext::sh`), and `pnpm *` amounts to allowing `pnpm run <any script>` / `pnpm dlx
  <any package>`. Express precise intent with narrow rules (`git status*`,
  `pnpm test*`).
- **Three hard tracks no rule can override** (a hit falls back to manual approval):
  1. unparseable structure: process substitution, `$((`, unbalanced quotes, excessive
     recursion — fail-closed;
  2. out-of-bounds paths: a write or redirection target outside the workspace and the
     authorized directories (including shapes that "look like a read but write", such as
     `uniq input output` or `git log --output=…`). To write outside the workspace, the
     right way is to add the directory to the authorized directories — the command is
     then never refused by the sandbox and never needs an escalation approval;
  3. read-restriction linkage: an escalation would also lift the `noRead` limits, so a
     command referencing a read-denied target is never auto-approved — `allow` rules
     do **not** override this track either.
- **noRead only constrains the model's file tools and reads going through `ctx.fs`**:
  `cat`/`type`/`Get-Content` in bash/pwsh and the `grep`/`glob` tools (which spawn the
  native ripgrep, bypassing `ctx.fs`) cannot be enforced below the surface by file
  name/extension (process-level ACL deny / bwrap directory hiding are future work).
  **For genuinely sensitive files, move them out of the model's reach**, or use command
  rules to deny obvious read commands. Also: under a directory-wide deny rule, the
  **parent** directory's listing still shows the directory's name (the model can see
  that it exists, but cannot read anything inside it); read restrictions do not apply
  in a `danger-full-access` session (explicit full trust), consistent with the write
  sandbox.
- **The capability class table is a conservative hand-written table**: programs missing
  from it are `unknown` (prompt only, never auto-approved). A few deliberate
  conservative choices: `sed` is classed `opaque` (its `e`/`w`/`r` commands can execute
  and write files, so per-script parsing is unreliable); `get-*` PowerShell verbs are
  treated as read-only by the approved-verb convention (not confirmable from the
  string). Every program maps to exactly one table entry (`test/test.mjs` asserts the
  single source); new entries must come with tests.
- **Metaprogram expansion only covers package.json scripts**: `pnpm run <script>`
  (including `pre`/`post` hooks) is judged by the script's real content; when the
  manifest cannot be read or the script name does not exist, the engine stays
  conservative. `node script.mjs`, `mvn deploy` and the like have no capability-class
  fallback and need an explicit `allow` rule. Note: if the container command itself
  matches an `allow` rule, that authorization overrides the expanded script body (the
  cost of a broad rule).

## Known limitations

- **Windows**: authorized directories must exist and be owned by the current user (the
  DACL must be writable); directories whose reclaim fails (e.g. ownership changed, DACL
  no longer writable) stay in the grants manifest and are retried on the next reconcile,
  while deleted directories count as reclaimed directly. The reclaim host prefers the
  built-in Windows PowerShell 5.1 and falls back to PowerShell 7 (pwsh); if both are
  missing the reclaim is deferred with a warning. If the plugin was uninstalled while
  ACEs remain, `node scripts/revoke.mjs` cleans them up in an emergency (normally
  unnecessary).
- **Linux**: the `bwrap` path is implemented but not yet real-machine verified;
  `landlock`/`seatbelt` are not supported.
- The write/edit tools only admit authorized directories in `workspace-write` mode.
- noRead `ask` rules only apply to the read / read_image / edit tools; a write that
  overwrites an old file is only intercepted by `deny` rules at the fs layer, creation
  is unrestricted; a directory-wide `deny` additionally intercepts `listDir`.
- Installing/uninstalling/toggling the plugin while running relies on the dsh host's
  dynamic reload of the profile patch layer; if anything misbehaves, see
  [known issues](../issues/ki-1-session-controller-reload-race.md).
- If a dsh upgrade changes the base-class signatures (`SandboxPolicyService` /
  `SandboxedFileSystem` / `LocalSandboxProvider`), this plugin needs corresponding
  adjustments.

## Companion documents

- [Permission rules guide](permission-rules.en.md)
  ([简体中文](permission-rules.md)) — using and troubleshooting the three rule kinds
- [README](../../README.en.md) ([简体中文](../../README.md)) — installation and quick start
- [Development and testing](../development.en.md)
  ([简体中文](../development.md)) — tests, build and internal contracts
- [Known issues](../issues/ki-1-session-controller-reload-race.md) — background and
  handling of the KI-1 reload race
