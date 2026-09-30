# dsh-sandbox-allowlist

A sandbox extension for DSH (DeepSeek Harness). The stock sandbox only permits writing
inside the workspace; this plugin adds three kinds of configurable permission rule on top
of it — all mounted through the official plugin mechanism, **without modifying any
`node_modules` or official package code**:

- **Authorized directories**: add trusted directories outside the workspace to the
  writable set. CLI commands inside the sandbox and the `write`/`edit` file tools can
  write there directly — **no per-write approval, and no need to disable the sandbox**;
- **Command allow-list**: configure which commands run without asking (`allow`), must ask
  (`ask`), or are blocked outright (`deny`). Matching is not whole-string comparison but
  "split into individual commands → classify by capability → aggregate": `git status &&
  git log` is allowed as a whole, while `git status && git push` is stopped;
- **Read restrictions (`noRead`)**: restrict what the model may read by file name or path
  pattern (the stock sandbox places no limit on reads). `deny` blocks hard; `ask` prompts
  for approval first.

All three rule kinds are edited visually in the settings page (the `sandbox-allowlist`
settings namespace) and **take effect on save without a restart**. **Windows (ACL sandbox)
and Linux (bwrap)** are supported.

> Current version `v0.1.0-beta.1`, compatibility baseline dsh **0.1.5-rc.2**.
> 📖 Full usage notes and scenario examples for the three rule kinds:
> [docs/guides/permission-rules.en.md](docs/guides/permission-rules.en.md)

> **Language**: the plugin's settings-page UI is bilingual. It registers `zh` and `en`
> dictionaries with the host's locale service (`ctx.locale.register(NS, { zh, en })`) and
> renders whichever the host's active language selects; the host's fallback chain ends at
> `en`, so a non-Chinese host gets English. Source of the copy:
> [`src/client/locales.ts`](src/client/locales.ts) (Chinese is the key-set source of
> truth, English mirrors it key-for-key).

## Installation

```bash
# From the npm registry / GitHub Releases (once published)
dsh plugin --profile web add dsh-sandbox-allowlist

# Local development (tarball)
pnpm pack --pack-destination /tmp/pkg
dsh plugin --profile web add /tmp/pkg/dsh-sandbox-allowlist-*.tgz
```

Requirements: dsh ≥ 0.1.5-rc.2, Node ≥ 20.11. Windows uses the official ACL sandbox;
Linux uses `bwrap` (landlock / seatbelt are not supported yet — they warn and are ignored).

`dsh plugin add` appends this package to the profile's `dsh.profile.bundles` layer, and its
`cordis.patch.yml` is mounted as a patch layer: it disables the official `sandbox-policy` /
`fs-sandbox` rows (plus the `sandbox` row on Linux) and inserts this package's replacement
rows. Afterwards **HMR applies it live**; no restart is needed.

## Quick start

The three rule kinds share the `sandbox-allowlist` settings namespace (editable in the
settings page, persisted to `$DSH_HOME/settings.yaml`). A minimal configuration
(**all paths are examples — replace them with your real directories**):

```yaml
sandbox-allowlist:
  # (1) Authorized directories: writable directly inside the sandbox (outside the workspace)
  allowedDirs:
    - 'D:\Shared\Tools'        # literal directory: the whole subtree is writable
    - 'D:\Data\logs\*'         # existing first-level subdirectories
  # (2) Command allow-list: keep dsh's current behaviour (ask when needed) when no rule matches
  commands:
    rules:
      - pattern: 'git status*' # narrow rule: allow only the read-only shape
        action: allow
      - pattern: 'rm -rf *'
        action: deny
  # (3) Read restrictions: reading is allowed by default; add limits as needed
  noRead:
    - pattern: '*.pem'
      action: deny
```

> ⚠️ **Security warning**: authorized directories will be written by sandboxed AI agents
> **without approval** (outside the workspace). Only add directories you fully trust; a
> directory must **already exist and be owned by the current user**. To revoke trust,
> delete the entry — previously granted write permission is reclaimed automatically (see
> [How it works](#how-it-works)).

## Configuration reference

### (1) Authorized directories (`allowedDirs`)

Wildcard vocabulary (`\` and `/` are both separators; POSIX forms work too):

| Pattern | Meaning |
|---|---|
| `D:\Shared\Tools` | literal directory → the whole subtree is writable |
| `D:\Shared\**` | explicit subtree (including the root itself and future subdirectories) |
| `D:\Data\logs\*` | existing first-level subdirectories |
| `D:\Archive\202?` | `?` matches a single non-separator character |

Expansion semantics: **lazily expanded** before each call (TTL-cached, tunable via
`expandTtlMs`); non-existent paths are skipped with a warning (`strict: true` turns that
into a throw); **patterns anchored at a drive/root and carrying `**` are rejected** (to
prevent whole-disk walks).

### (2) Command allow-list (`commands`)

```yaml
sandbox-allowlist:
  commands:
    default: delegate         # when no rule matches: delegate=keep current behaviour (default) / allow / ask / deny
    escalation: capability    # auto-approve sandbox escalation: capability (default) / never
    baseline: true            # built-in capability baseline (on by default)
    sessionCache: true        # session-scoped command cache (on by default)
    rules:                    # evaluated in declaration order; the last match wins
      - pattern: 'git status*'  # narrow: allow only read-only shapes like git status/log/diff…
        action: allow
      - pattern: 'git push*'    # a finer rule under the same prefix, written later, overrides it
        action: ask
      - tool: pwsh              # tool is optional (bash / pwsh; omitted = both shells)
        pattern: 'Select-Object *'
        action: allow
      - pattern: 'rm -rf *'
        action: deny
```

**`pattern` semantics**: a whole-command pattern (`*` any number of characters, `?` a
single character), judged **per individual command** (compound commands are split first).
The program token is normalised first — paths, quotes and `.exe`/`.cmd`-style suffixes are
stripped — so `git *` also matches `"C:\Program Files\Git\git.exe" status`. Using narrow
rules (`git status*`) rather than broad ones (`git *`) is what lets you "allow status, stop
push".

**Actions**:

| Action | Meaning |
|---|---|
| `allow` | run without asking, **and sandbox-escalation requests of that shape are auto-approved too (the command may run outside the sandbox)** |
| `ask` | force the approval prompt |
| `deny` | block outright, with a reason |

**Decision flow (three layers)**:

1. **Decomposition (structure)**: split on `;` `&&` `&` `|` `||` and newlines into
   individual commands (quote/escape aware); subcommands inside `$( … )` and backticks are
   expanded recursively and judged too; redirections have their **target path resolved** and
   compared against workspace ∪ authorized directories; heredoc bodies are treated as data;
   `FOO=bar cmd` has its prefix stripped before judging. Structures that cannot be parsed
   (process substitution, `$((`, unbalanced quotes, excessive recursion) **fail closed** to
   manual approval.
2. **Capability classification (semantics)**: each command is assigned to `read` /
   `local-write` / `repo-exec` / `external` / `opaque` / `destructive` / `unknown` — an
   unknown command is never auto-approved.
3. **Aggregation (backstop)**: `deny` > `ask` > `allow` > `default`. If any individual
   command matches `deny`, the whole thing is blocked — a dangerous command hidden in a
   compound command is not masked by an allowing prefix.

**Built-in capability baseline (`baseline: true`, on by default)**: read-only commands
(`ls` / `cat` / `grep` / `git status` / `Get-ChildItem` / `Where-Object` …) and commands
that only write inside the workspace/authorized directories are recognised without any
rule. Turn it off and only your rules decide.

**Auto-approve sandbox escalation (`escalation`)**: dsh has two kinds of prompt — command
approval, and **sandbox escalation** (after the sandbox refuses a command, the AI retries
with `sandbox_permissions`, which would run it outside the sandbox).

| Value | Meaning |
|---|---|
| `capability` (default) | every individual command matches an `allow` rule (an `allow` carries escalation authorization), or all are benign capability classes (`read`, or `local-write` whose targets are all inside the workspace/authorized directories) ⇒ auto-approved; interpreters, network, package managers, unknown programs and unparsable structures ⇒ prompt |
| `never` | never auto-approve (every escalation prompts) |

**Session-scoped command cache (`sessionCache`, on by default)**: a command you approved by
hand (**the exact same command text**) is not asked again in this session. Any change to its
arguments counts as a different command and needs approval again.

**Decision trail and rule proposals**:

- every decision is appended to `$DSH_HOME/sandbox-allowlist-decisions.jsonl` (the verdict,
  the reason, each command's capability class, and whether it may escalate); it rotates
  automatically at 2 MiB and keeps 3 historical copies, so it cannot grow without bound;
- when manual confirmation is needed, the prompt text includes **why it was not
  auto-approved** and **which rule you could add**;
- repeatedly approving the same command shape by hand accumulates candidate rules, written
  to `$DSH_HOME/sandbox-allowlist-proposals.json` and surfaced in the model context
  (**proposals only — never applied automatically**).

> **Design trade-off**: how much an `allow` rule grants depends on whether it allows the
> "command text" or the "thing the command actually does". This plugin splits the decision
> into three separately verifiable sub-problems — structure / semantics / backstop —
> corresponding to `lib/command-analyze.mjs` / `lib/command-classes.mjs` /
> `lib/command-decision.mjs`. Beyond that, **authorization gets more robust the closer it
> sits to a path**: rather than allowing a command shape, add the directory it wants to
> write to the authorized directories — directory authorization is enforced by the file
> sandbox, the command is never refused, and therefore never requests escalation approval.
> Command rules exist to cover the residue that directory authorization cannot reach
> (read-only reconnaissance, builds/tests, cross-network operations, and so on).

### (3) Read restrictions (`noRead`)

The stock sandbox places no limit on **reads** (the fs fence only stops writes), so
`noRead` is its orthogonal complement: it restricts what the model may read by **file name /
directory / path pattern**. Because reading is allowed by default, **there is no `allow`
action** (an explicit allow is identical to the default and pure noise); for "approve once,
then read", use `ask`.

```yaml
sandbox-allowlist:
  noRead:
    - pattern: '*.pem'       # (1) file-name pattern: .pem at any directory depth is read-denied
      action: deny           #     deny (default) = refuse the read outright
    - pattern: '.env*'       #     covers .env / .env.local / .env.production …
      action: deny
    - pattern: 'id_rsa*'
      action: deny
    - pattern: 'D:\Vault\**\*.key'  # (2) full path + wildcard: every .key under the vault
      action: deny
    - pattern: 'D:\Vault'    # (3) directory-wide: a literal absolute directory → the whole subtree is read-denied (listing included)
      action: deny           #     equivalent form: 'D:\Vault\**'
    - pattern: '*.crt'       # ask: prompts for manual approval when matched; once approved, allowed for that read
      action: ask
```

Pattern vocabulary (case-insensitive on Windows; the three forms are detected
automatically):

- **(1) file-name pattern** (no path separator): matched against the **file name** only, at
  any directory depth;
- **(2) full path + wildcards** (contains a separator and `*`/`?`): two consecutive `*`
  cross directories, a single `*` does not;
- **(3) directory-wide** (an **absolute** path with a separator but no wildcard): a literal
  directory (`D:\Vault`) or an explicit subtree (`D:\Vault\**`) → the directory itself and
  its whole subtree are read-denied, **including directory listings (`listDir`)**; if the
  path is actually a file, it is equivalent to denying that one file.

Guard rails: rules anchored at a drive/root (`D:\`, `/`) and pure-wildcard rules
(`*`/`**`/`?`) are **rejected with a warning** (to prevent collateral damage to a whole
disk); there is never a silent "configured but blocks everything / configured but does
nothing".

**Layered enforcement (`deny` applies at two layers, `ask` at one)**:

1. **fs enforcement layer**: a target matching `deny` — `read` / `read_image` / `edit`
   (which implicitly reads the old content), directory-wide `listDir`, and **a `write` that
   overwrites an existing file** (which must read the old content back to produce a diff) —
   all throw `FS_READ_DENIED`; **creating** a file of the same name/format is still allowed
   (what is restricted is reading, not writing);
2. **pre-execute gate**: `read` / `read_image` / `edit` whose `file_path` argument matches
   returns a decision immediately — `deny` blocks (without performing any file I/O), `ask`
   goes to approval (allowed-once; after approval the fs layer does not intercept again);
3. **model prompt context**: the read-denied list is injected into the system prompt so the
   model knows what it cannot read and what it must ask about, avoiding repeated attempts.

## How it works

Where the DSH sandbox permits writing is an allow-list. This plugin **appends the
authorized directories** to that list:

- **Windows**: the sandbox uses "the workspace write SID's Write ACE" as its allow-list.
  The plugin materializes an **inheritable Write ACE** for that SID on each authorized
  directory (`(OI)(CI)(W,D,DC)`) → confined CLI children can write directly, and future
  subdirectories inherit automatically; the write/edit tools are allowed through the same
  list by this package's own fs fence. **Revoking means reclaiming**: removing a directory
  from the configuration triggers automatic reconciliation which removes the Write ACEs
  previously written across that directory tree (subdirectories included) — no manual
  cleanup. The reconciliation manifest is persisted at
  `$DSH_HOME/sandbox-allowlist-grants.json`, so even if the configuration was changed while
  the process was down, the next startup backfills the reclamation.
- **Linux**: `bwrap` is extended with `--bind <root> <root>`.

## Security boundaries (please read)

- **A broad `pattern` grants machine-wide execution**: `allow` implies sandbox-escalation
  authorization, so one broad rule authorizes **any** command under that prefix to run
  outside the sandbox — `git *` also allows git protocol injection (`ext::sh`), and
  `pnpm *` amounts to allowing `pnpm run <any script>` / `pnpm dlx <any package>`. Express
  precise intent with narrow rules (`git status*`, `pnpm test*`).
- **Three hard tracks that no rule can override** (a match falls back to manual approval):
  1. structures that cannot be parsed: process substitution, `$((`, unbalanced quotes,
     excessive recursion — fail-closed;
  2. out-of-bounds paths: a write or redirection target outside the workspace and the
     authorized directories (including shapes that "look like a read but write", such as
     `uniq input output` or `git log --output=…`). To write outside the workspace, the
     right way is to add the directory as an authorized directory — then the command is
     not refused by the sandbox at all and needs no escalation approval;
  3. read-restriction linkage: escalation also lifts `noRead` limits, so a command that
     references a read-denied target is never auto-approved — `allow` rules do **not**
     override this track either.
- **`noRead` only constrains the model's file tools and reads through `ctx.fs`**:
  `cat`/`type`/`Get-Content` in `bash`/`pwsh` and the `grep`/`glob` tools (which spawn the
  native ripgrep, bypassing `ctx.fs`) cannot be intercepted below the surface by file
  name/extension (process-level ACL deny / bwrap directory hiding are future work). **Move
  genuinely sensitive files out of the model's reach**, or use command rules to deny obvious
  read commands. Also: under a directory-wide read restriction, the **parent** directory
  listing still shows that directory's name (the model can see the directory exists but
  cannot read any of its content); and while a session is in `danger-full-access` (explicit
  full trust), read restrictions do not apply — consistent with the write sandbox.
- **The capability table is a deliberately conservative hand-written table**: a program not
  in the table is always `unknown` (prompts only, never auto-approved). A few intentional
  conservative choices: `sed` is classified `opaque` (its `e`/`w`/`r` commands can execute
  and write files, and per-script parsing is unreliable); PowerShell verbs of the `get-*`
  form are treated as read-only per the "approved verbs" convention (which cannot be
  confirmed from the string). Each program belongs to exactly one table (`test/test.mjs`
  asserts single ownership), and a new entry must come with a test.
- **Metaprogram expansion only covers package.json scripts**: `pnpm run <script>`
  (including `pre`/`post` hooks) is judged by the script's actual content, and stays
  conservative when the manifest cannot be read or the script name does not exist;
  `node script.mjs`, `mvn deploy` and the like have no capability fallback and need an
  explicit `allow` rule. Note: if the container command itself matches an `allow` rule,
  that authorization overrides the expanded script body (the cost of a broad rule).

## Known limitations

- **Windows**: an authorized directory must exist and be owned by the current user (its
  DACL must be modifiable); directories whose reclamation fails (for example because
  ownership changed or the DACL cannot be rewritten) stay in the grants manifest and are
  retried at the next reconciliation, while deleted directories are treated as already
  reclaimed. Reclamation prefers the system's own Windows PowerShell 5.1 and falls back to
  PowerShell 7 (pwsh) when it is missing; with neither available, reclamation is suspended
  with a warning. If the plugin is uninstalled while ACEs remain on directories,
  `node scripts/revoke.mjs` can clean up in an emergency (normally unnecessary).
- **Linux**: `bwrap` is fully supported; `landlock`/`seatbelt` are not supported yet.
- The write/edit tools only allow authorized directories in `workspace-write` mode.
- `noRead`'s `ask` rules only apply to the read / read_image / edit tools; a `write` that
  overwrites an old file is only intercepted by `deny` rules at the fs layer, and creation
  is unrestricted; a directory-wide `deny` additionally intercepts `listDir`.
- If a dsh upgrade changes the signatures of the base classes (`SandboxPolicyService` /
  `SandboxedFileSystem` / `LocalSandboxProvider`), this plugin may need small adjustments
  (in 0.1.5 none of the three base-class signatures changed; only the
  `static inject = ['sessionProjections']` dependency was added).

## Development and tests

```bash
npm test                     # self-tests (wildcards, rule engine, capability classes, structure parsing, decision engine, audit/cache/proposals, noRead, schema)
npm run test:command-gate    # end-to-end command gate (real cordis context + tools/pre-execute dispatch)
npm run test:approval-gate   # end-to-end escalation approval gate (capability baseline / allow escalation authorization / noRead linkage / session cache / rule proposals)
npm run test:matrix          # adversarial regression matrix (sandbox phase × escalation phase, dual-column assertions)
npm run test:read-gate       # end-to-end noRead restriction (policy mount + fs enforcement layer + pre-execute deny/ask)
npm run test:client          # settings-page client bundle render assertions (includes two-file anti-drift markers)
npm run test:dry-mount       # dry mount (end-to-end validation on a temporary cordis context)
npm run test:patch           # patch composition pre-check (requires DSH_INSTALL_ANCHOR first, see below)
```

Machine-specific paths are never hardcoded: tests use a temporary directory (or the
repository itself) by default, and environment variables override that when a real
environment is needed —

| Environment variable | Purpose | Default |
|---|---|---|
| `DSH_TEST_WORKSPACE` | workspace root for tests (dry-mount / verify-*) | system temporary directory |
| `DSH_TEST_TRUSTED` | dry-mount's authorized directory | system temporary directory |
| `DSH_TEST_PROBE_DIR` | readonly-probe's out-of-workspace probe directory | system temporary directory |
| `DSH_INSTALL_ANCHOR` | dsh install anchor needed by test:patch to compose a real web profile | **none (required)** |
| `DHS_INSTALL_ANCHOR` | install anchor the resolve-hook uses to resolve @deepseek-ai/* | the repository's own node_modules |

Real-machine verification points: a confined pwsh / the write tool should succeed writing
an authorized directory with no approval; writing an out-of-workspace **untrusted**
directory should still be intercepted (`FS_SANDBOX_DENIED`); `icacls <dir>` should show the
workspace SID `S-1-4-...` with a `(OI)(CI)(W,D,DC)` ACE; after deleting that directory in
the settings page and saving, the same `icacls` output should no longer show that ACE
(including inherited copies in subdirectories) — revoking means reclaiming.

**Settings-page client**: source `src/client/index.tsx`, with the hand-written runtime
equivalent `lib/client.js` (the two must stay in step; `test:client` has anti-drift
assertions). To rebuild from source:

```bash
# Inside the dsh development repository's pnpm workspace (client deps must resolve)
pnpm install
pnpm run build:client      # tsc + tsdown → lib/client.js (__ModuleLoader__ format)
```

Only once the artifact is in place may package.json declare `dsh.client.inject`
(declaring it while missing breaks web application loading; since dsh 0.1.5 the semantics
of `inject` are "the factory must arrive after the package rows listed here", not purely
informational metadata). To deploy a change: overwrite the web profile's
`node_modules/dsh-sandbox-allowlist/lib/client.js` and refresh the page
(`/plugins/<id>/client.js` is read from disk on every request; no server restart needed).

A bare cordis context used in tests must provide `sessionProjections` and `systemPrompt`
stubs (since 0.1.5 `SandboxPolicyService` registers a `sandboxMode` projection on
construction) — see the comments in `test/dry-mount.mjs`; the `systemPrompt` context order
is derived from the official `getContextOrder('SANDBOX_POLICY')` (falling back to the
constant `110` on older hosts).

## Package layout

```
lib/policy.mjs      replaces sandbox-policy: authorized-directory expansion + Windows ACE
                    materialization and reclamation reconciliation (grant-manifest.mjs
                    persists the manifest) + settings namespace registration + model prompt
                    context + command gate and escalation approval gate mounting + noRead chain
lib/grant-manifest.mjs  grant manifest persistence (reliable memory for cross-restart reconciliation)
lib/acl-revoke.mjs  Windows ACE reclamation primitives (SDDL read-modify-write; icacls is unusable on this platform)
lib/command-rules.mjs  rule engine: pattern (whole-command glob, matched after program-name normalization) + allow/ask/deny
lib/command-structure.mjs  statement splitter (quote/escape and both-dialect aware)
lib/command-analyze.mjs    structural parsing: recursive substitution bodies, redirection target resolution, heredoc, env prefixes
lib/command-classes.mjs    capability table: read/local-write/repo-exec/external/opaque/destructive/unknown
lib/command-expand.mjs     metaprogram expansion: pnpm/npm/yarn run → package.json script text
lib/command-decision.mjs   the single decision engine (sandbox phase + escalation phase) + path-scope judgement + explanation
lib/command-audit.mjs      decision trail (ring + JSONL), session cache, rule-proposal counters
lib/command-gate.mjs       tools/pre-execute gate: sandbox-phase verdict + call correlation + audit
lib/command-approval-gate.mjs  approval/request gate: escalation-phase verdict + prompt explanation + learning
lib/read-deny.mjs   read-restriction rule engine (file-name/path matching + deny/ask, pure functions)
lib/read-gate.mjs   tools/pre-execute interception gate: deny/ask decisions for read/read_image/edit
lib/fs.mjs          replaces fs-sandbox: write/edit fence allowing extraRoots + noRead read enforcement layer
lib/provider.mjs    replaces sandbox (Linux only): bwrap --bind extension
lib/patterns.mjs    wildcard matching and directory expansion (shared)
cordis.patch.yml    bundle patch layer (mounted on install)
scripts/revoke.mjs  Windows emergency cleanup script (normally unnecessary: revocation is reclaimed automatically)
src/client/         settings-page "Sandbox authorization" section source (needs the dsh dev toolchain to build)
src/client/locales.ts  UI dictionaries (zh source of truth + en mirror)
test/               self-tests / end-to-end validation / adversarial regression matrix / patch composition pre-check / dry mount
```

## License

MIT
