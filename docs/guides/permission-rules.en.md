# dsh-sandbox-allowlist — guide to the three permission rule kinds

This plugin adds three kinds of **configurable permission rule** on top of the official DSH
sandbox. All of them are edited in the settings page's "Sandbox authorization" section (the
`sandbox-allowlist` settings namespace, persisted to `$DSH_HOME/settings.yaml`) and take
effect immediately on save:

| Rule | Problem it solves | In one line | Applies to |
|---|---|---|---|
| **Authorized directories** `allowedDirs` | you want the agent to write outside the workspace | which extra directories may be **written** | directories |
| **Command rules** `commands` | you want some commands to skip / require / be refused approval | which commands are **allow / ask / deny** | shell commands |
| **Read restrictions** `noRead` | you do not want the agent to read certain things | which files/directories **must not be read** (or need approval) | files / directories |

The three are independent and stack: authorized directories govern "can it write", command
rules govern "is the command asked about / blocked", read restrictions govern "can it read".
Read restrictions **deliberately have no `allow` action** — reading is allowed by default, so
an allow rule would be a no-op; when you need a one-off exception, use `ask` (which prompts
for manual approval).

> Terminology: **approval** = the manual confirmation shown to the user before a tool runs;
> **sandbox** = the filesystem-level write boundary (the three modes read-only /
> workspace-write / danger-full-access).

---

## 1. Authorized directories (allowedDirs) — permitting writes outside the workspace

### Purpose
DSH only allows writing inside the workspace (plus temporary directories) by default.
`allowedDirs` adds several **trusted writable directories**: CLI commands inside the sandbox
and the write/edit tools may write them **without approval**.

### Syntax
```yaml
sandbox-allowlist:
  allowedDirs:
    - 'D:\Shared\Tools'   # literal directory: the whole subtree is writable
    - 'D:\Shared\**'      # explicit subtree (including future subdirectories)
    - 'D:\Data\logs\*'    # existing first-level subdirectories
    - 'D:\Archive\202?'      # ? matches a single non-separator character
    - '/opt/tools/**'     # POSIX is supported too
```

### Notes
- **What is allowed is writing**, unrelated to reading (reading is allowed anyway by the
  official sandbox); a directory must **already exist and be owned by the current user**;
- Windows: the plugin materializes "the workspace write SID's Write ACE" onto these
  directories (inherited by subdirectories) so confined CLI children can write; deleting a
  directory from the list automatically reclaims that ACE (reconciliation is persisted and
  backfilled after a restart);
- Linux: `bwrap` is extended with `--bind <directory> <directory>`;
- only permitted in `workspace-write` mode; `read-only` still refuses all writes, and
  `danger-full-access` has no sandbox and needs no such list;
- wildcards are lazily expanded before each call (TTL cache); patterns anchored at a
  drive/root and carrying `**` are rejected (to prevent whole-disk walks).

### Scenario examples
1. **Tools/scripts directory**: the agent needs to maintain scripts and batch files under
   `D:\Shared\Tools`:
   ```yaml
   allowedDirs:
     - 'D:\Shared\Tools'
   ```
2. **Data output**: let test artifacts be written into `D:\Data\exports` (first-level
   subdirectories separated by year):
   ```yaml
   allowedDirs:
     - 'D:\Data\exports\*'
   ```
3. **Personal notes vault (example placeholder path — replace it with your real directory)**:
   your own Obsidian vault `D:\Notes\MyVault` outside the workspace, writable as a whole
   (use `**` for future directories):
   ```yaml
   allowedDirs:
     - 'D:\Notes\MyVault\**'
   ```

---

## 2. Command rules (commands) — skipping / requiring / blocking approval

### Purpose
dsh's bash / pwsh tools may prompt for approval before running a command; after the sandbox
refuses a command the AI also retries with `sandbox_permissions`, which prompts a second
time (**sandbox escalation** approval: the command would run outside the sandbox).
`commands` decides what happens in both places: which commands just run, which must ask, and
which are blocked.

Matching is not "whole-string comparison": commands are first split into individual
commands, each is judged by its **capability class** (read-only / writes the workspace / runs
the repository toolchain / cross-network / executes invisible code / destructive / unknown),
and the results are aggregated as `deny > ask > allow > default`. That is why
`git status && git log` is allowed as a whole while `git status && git push` is stopped, and
why a PowerShell pipeline does not require enumerating every cmdlet.

### Syntax
```yaml
sandbox-allowlist:
  commands:
    default: delegate        # when no rule matches: delegate=keep current behaviour (default) | allow | ask | deny
    escalation: capability   # auto-approve sandbox escalation: capability (default) | never
    baseline: true           # built-in capability baseline (on by default)
    sessionCache: true       # session-scoped command cache (on by default)
    rules:                   # evaluated in declaration order; the last match wins
      - tool: bash           # optional: bash / pwsh; omitted = both apply
        pattern: 'git status*'
        action: allow        # narrow: allow only shapes like git status / git status -s…
      - pattern: 'git push*'
        action: ask          # a finer rule under the same prefix, written later, overrides
      - pattern: 'rm -rf *'
        action: deny         # blocks under both shells
```

### The three actions
| Action | Meaning |
|---|---|
| `allow` | run without asking, **and sandbox-escalation requests of that shape are auto-approved too (the command may run outside the sandbox)** |
| `ask` | force the approval prompt |
| `deny` | block, with a reason |

### Notes
- **The command string is normalised** (whitespace collapsed; case-insensitive on Windows)
  and the program token is normalised first (path, quotes and `.exe`/`.cmd`-style suffixes
  stripped) before matching — `git *` also matches
  `"C:\Program Files\Git\git.exe" status`;
- `*` matches any number of characters, `?` matches a single character; rules are anchored at
  the start of the command (`git *` will not accidentally match `gitdb status`);
- compound commands are **split and judged per segment** on `;` `|` `&&` `&` `||` and
  newlines; any segment denying ⇒ the whole is blocked, any segment asking ⇒ the whole asks;
- subcommands inside `$( … )` / backticks are **expanded recursively and judged together**
  (so `whoami` inside `echo $(whoami)` matches a deny rule aimed at `whoami`);
  redirections have their **target path resolved** and compared against workspace ∪
  authorized directories; heredoc bodies are treated as data;
- **anything that cannot be parsed fails closed** (process substitution `<(...)`, `$((`,
  unbalanced quotes, excessive recursion);
- ⚠️ **A broad pattern grants machine-wide execution**: `git *` → `allow` authorizes **any**
  command under that prefix (including git protocol injection `ext::sh`) to run outside the
  sandbox, and `pnpm *` → `allow` amounts to allowing `pnpm run <any script>`. Express
  precise intent with narrow rules (`git status*`, `pnpm test*`);
- rules only govern the **bash / pwsh shell tools**; other tools are unrelated to command
  rules.

### Built-in capability baseline (`baseline`)
When enabled (the default), read-only commands
(`ls`/`cat`/`grep`/`git status`/`Get-ChildItem`/`Where-Object`…) and commands that "only write
inside the workspace/authorized directories" are recognised **without any rule**. Turn it off
and only your rules decide.

### Auto-approve sandbox escalation (`escalation`)
| Value | Meaning |
|---|---|
| `capability` (default) | every individual command matches an `allow` rule (**an allow carries escalation authorization**), or all are benign capability classes (read-only, or writing only inside the workspace/authorized directories) ⇒ auto-approved; everything else (interpreters, network, package managers, unknown programs, unparsable structures) prompts |
| `never` | never auto-approve |

Three hard constraints (**no rule can override them**; they always apply regardless of
configuration):
1. a command referencing a **noRead read-denied target** is never auto-approved — escalation
   would also lift the read restriction, and `allow` rules do not lift this track either;
2. a write/redirection target **outside the workspace and authorized directories** is not
   auto-approved — the right fix is to add it under "Sandbox authorization → Authorized
   directories", so the command is never refused by the sandbox in the first place;
3. a segment matching a `deny` / `ask` rule is not auto-approved.

There is one more conservative rule: **a read-only command that names a path outside the
workspace/authorized directories does not fall through the capability backstop either**
(argument positions that "look like a read but write" — `uniq input output`,
`git log --output=…`, `tree -o file` — cannot be parsed per program, so asking once more is
preferred).

**Environment-variable prefixes** (`FOO=bar cmd`) only block the capability fallback:
explicit `allow` rules still apply as written.

**Metaprogram expansion**: `pnpm run <script>` / `pnpm <script>` reads the script text (with
`pre`/`post` hooks) from the workspace `package.json` and judges by the real content. When
the manifest cannot be read it stays conservative. Note: if the container command itself
matches an `allow` rule, that authorization overrides the expanded script body (the cost of
a broad rule).

### Session-scoped command cache (`sessionCache`)
A command you approved by hand (**the exact same command text**) is not asked again in this
session; any change to its arguments counts as a different command.

### Scenario examples
4. **Everyday allowances**: pnpm / npm / git (except push) without asking:
   ```yaml
   commands:
     default: delegate
     rules:
       - pattern: 'pnpm test*'
         action: allow
       - pattern: 'npm run*'
         action: allow
       - pattern: 'git status*'
         action: allow
       - pattern: 'git log*'
         action: allow
       - pattern: 'git add*'
         action: allow
       - pattern: 'git commit*'
         action: allow
       - pattern: 'git push*'
         action: ask          # pushing needs your nod
   ```
5. **Blocking high-risk commands**: deletion and disk-cleanup commands are all stopped, and
   you are told to use approval (ask) or run them yourself:
   ```yaml
   commands:
     rules:
       - pattern: 'rm *'
         action: deny
       - pattern: 'format *'
         action: deny
       - pattern: 'git reset*'
         action: ask          # resetting needs your nod
   ```
6. **Letting one specific shape run outside the sandbox** (for example a build script you
   trust): `allow` carries escalation authorization, so one narrow rule is enough:
   ```yaml
   commands:
     rules:
       - pattern: 'pnpm build*'
         action: allow        # no asking, and sandbox escalation is auto-approved too
   ```
   ⚠️ The real authorization this rule grants is "that shape may obtain machine-wide
   execution permission" — use it only for programs/scripts you have confirmed to be
   trustworthy. The more robust approach is to keep the pattern narrow (e.g. `pnpm build*`
   rather than `pnpm *`) and let `pnpm run <script>` be judged by the real content of the
   script in `package.json` wherever possible.

---

## 3. Read restrictions (noRead) — limiting what can be read

### Purpose
The official sandbox places no limit at all on **reads**; `noRead` restricts reading by
"file name / full path / directory". Each rule is either `deny` (refuse outright, with the fs
enforcement layer as backstop) or `ask` (prompt once for manual approval when matched, and
allow that read once approved).

### The three pattern forms (detected automatically)
```yaml
sandbox-allowlist:
  noRead:
    # (1) file-name pattern: no path separator → matched by name at any directory depth
    - pattern: '*.pem'
      action: deny
    - pattern: '.env*'
      action: deny
    - pattern: 'id_rsa*'
      action: deny

    # (2) full path + wildcard: contains a separator and * or ?
    - pattern: 'D:\Vault\**\*.key'
      action: deny

    # (3) directory-wide: an absolute path with a separator and no wildcard → the whole subtree is read-denied (listings included)
    - pattern: 'D:\Vault'        # literal directory (= D:\Vault\**)
      action: deny
    - pattern: 'C:\Users\me\.ssh'
      action: deny

    # ask: use ask when you want "occasionally allow once"
    - pattern: '*.crt'
      action: ask
```

Pattern essentials (case-insensitive on Windows):
- (1) compares the **file name** only: `.env*` covers `.env` / `.env.local`; `id_rsa` does
  not block `id_rsa.pub`;
- (2) two consecutive `*` cross directories, a single `*` does not;
- (3) a literal absolute directory = the directory itself plus its whole subtree are
  read-denied, **including directory listings (`listDir`)**; if that path is actually a file,
  it is equivalent to denying that one file;
- guard rails: rules anchored at a drive/root (`D:\`, `/`) and pure wildcards
  (`*`/`**`/`?`) are **rejected with a warning**, so there is never the silent trap of
  "configured means everything is blocked / configured but useless".

### Coverage and boundaries
| Operation | When a deny rule matches |
|---|---|
| read / read_image (tools) | refused (the pre-execute gate denies directly; the fs layer throws `FS_READ_DENIED`) |
| edit (which implicitly reads the old content first) | refused |
| write **overwriting an existing file** (reads the old content back to build a diff) | refused |
| write **creating** a file (reading no old content) | **allowed** (what is denied is reading, not writing) |
| listDir (directory-wide rules) | refuses to list the denied directory and subdirectories within its tree |
| `cat`/`type`/`Get-Content` in bash/pwsh | not interceptable in this release (see below) |
| grep / glob tools (spawn the native ripgrep) | not interceptable in this release (see below) |

**Honest boundary**: `noRead` only constrains dsh's own file-reading tools and any read
going through `ctx.fs` — those are an "iron gate at the code layer"; while bash/pwsh
subprocesses and grep/glob go through the operating system or independent processes and
**cannot be intercepted below the surface by file name/extension** (Windows ACL deny / bwrap
directory hiding are future work). For genuinely sensitive content, the first choice is to
**move the file/directory out of the model's reach**, or use command rules to block obvious
read commands, and only then layer noRead as a backstop for the model's tools.
Also: once a session switches to `danger-full-access` (explicit full trust), read
restrictions no longer apply — consistent with the write sandbox.

### Scenario examples
6. **Keys/credentials**: `.env`, `*.pem`, `id_rsa*` scattered in the workspace must not be
   read:
   ```yaml
   noRead:
     - pattern: '*.pem'
       action: deny
     - pattern: '.env*'
       action: deny
     - pattern: 'id_rsa*'
       action: deny
   ```
7. **Blocking a whole corporate private directory**: `D:\Vault` and the home-directory
   `.ssh` plus their subdirectories — neither content nor listings may be seen or read by
   the model:
   ```yaml
   noRead:
     - pattern: 'D:\Vault'
       action: deny
     - pattern: 'D:\Vault\**'
       action: deny          # or write just the literal directory, see (3)
     - pattern: 'C:\Users\me\.ssh'
       action: deny
   ```
8. **Low-frequency exceptions with ask**: for things like `.crt` that you "normally do not
   look at but occasionally allow":
   ```yaml
   noRead:
     - pattern: '*.crt'
       action: ask
   ```
9. **Forbidding reads of a specific configuration file**: the model tends to read
   `config.json` into context as sensitive information; deny the whole directory holding the
   configuration, or that file's path:
   ```yaml
   noRead:
     - pattern: 'C:\App\etc'
       action: deny
     - pattern: 'C:\App\etc\config.json'
       action: deny
   ```

---

## 4. Combined examples

10. **A drop directory that is writable but not readable**: the agent must write export
    files into a trusted directory, but the model should not read the existing content into
    context:
    ```yaml
    sandbox-allowlist:
      allowedDirs:
        - 'D:\Shared\exports\**'   # allow writing
      noRead:
        - pattern: 'D:\Shared\exports'
          action: deny             # but the whole tree is read-denied (including overwriting existing files)
    ```
    Effect: creating new files is fine; reading, editing and overwriting existing old files
    are all refused.
11. **No external network + read restrictions + a command allow-list: a three-layer
    sandwich** (a typical least-privilege combination):
    ```yaml
    sandbox-allowlist:
      allowedDirs:
        - 'D:\Shared\output'
      commands:
        default: delegate
        rules:
          - pattern: 'git *'
            action: allow
          - pattern: 'rm -rf *'
            action: deny
      noRead:
        - pattern: '*.pem'
          action: deny
        - pattern: '.env*'
          action: deny
        - pattern: 'D:\Secrets'
          action: deny
    ```

---

## 5. Effect and troubleshooting quick reference

| Question | Answer |
|---|---|
| Where do I configure it? | The settings page's "Sandbox authorization" section (three cards), or edit the `sandbox-allowlist:` section of `$DSH_HOME/settings.yaml` directly |
| When does it take effect? | On save, live (the server-side policy reads it hot; updating server-side module code requires restarting dsh web to load) |
| My rules are not working? | Check the "Known limitations" boundaries (shell/grep are not interceptable); confirm the session is not `danger-full-access`; confirm the configuration was not rejected by the schema (a save error) and that no pattern was dropped by a guard rail (the server log warns `noRead rule ignored`) |
| Why is there no allow? | Reading is allowed by default, so allow would be a no-op; use ask when you need an exception |
| Can read restrictions stop the shell? | Not by file name (this release); move the content out of reach or add a command rule |
| How do command rules relate to the file sandbox? | `allow` = permit **and carry escalation authorization** (the command may run outside the sandbox); the three hard tracks — out-of-bounds write paths, read-denied targets and unparsable structures — are unaffected by rules |
| An authorized directory and a read restriction both match? | They are orthogonal: allowedDirs governs writing, noRead governs reading, and they may point at the same directory (combined example 10) |
| I configured rules, so why is it still prompting? | Look at the `[sandbox-allowlist]` part of the prompt: it states **why it was not auto-approved** (which individual command, its capability class, whether it is out of bounds or read-denied); the same part also suggests a rule you could add |
| How do I see what the engine actually decided? | Every decision is appended to `$DSH_HOME/sandbox-allowlist-decisions.jsonl` (verdict / reason / per-command capability class / whether it may escalate) |
| Why am I asked about the same command repeatedly? | After you approve it once by hand it is not asked again this session (`sessionCache`, on by default); for a long-term allowance, look at the candidate rules in `$DSH_HOME/sandbox-allowlist-proposals.json` |
| I want to allow `git status` but stop `git push`? | Use two narrow pattern rules: `git status*` → allow written first, `git push*` → ask written after; rules are "the last match wins", so put finer rules later |

Companion documents: the README (installation / principles / package layout) and the design
documents under `docs/guides/` and `docs/upgrade/`.
