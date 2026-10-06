# Permission configuration test plan (dsh-sandbox-allowlist)

> English translation contributed by Bernd Weymann ([@weymann](https://github.com/weymann)),
> with local updates to the dsh 0.2.0-rc.2 semantics.

> **Purpose**: this plan lets an executing agent in a session run end-to-end validation of
> the plugin's three permission configuration kinds (authorized directories `allowedDirs` /
> command rules `commands` / read restrictions `noRead`). The command-rules part covers a
> variety of compound and mixed command shapes (`;` `&&` `&` `||` `|` chains, `$()`/backtick
> substitution, heredoc, redirection, env prefixes, metaprogram expansion, fail-closed
> structures, broad-rule shapes, and so on).
>
> **Applicable versions**: v0.1.0-beta.1 and above, adapted to dsh 0.2.0-rc.2 (the
> single-layer `allow` semantics = permit **and carry escalation authorization**; the
> rule selector is `pattern` (required) + optional `tool` (`bash` / `pwsh`, omitted =
> applies to both shells); every case in this plan omits `tool`).
> Before testing, read the "Command allow-list" and "Read restrictions" sections of
> `README.md` for the implemented semantics.
>
> **How to refer to it in a session**: give the executing agent an instruction such as —
> "Read `<repo>/docs/testing/test-plan-permissions.en.md` and run the permission-configuration test
> validation per the plan, using `<test directory>` as the test directory; do phases A/B
> first, and phase C requires dsh web to be running."

**Placeholder conventions** (replace with real values before executing; the substituted real
paths **must not** be written into any committed document — see the repository's
`AGENTS.md`):

| Placeholder | Meaning | Suggested value (example, please replace) |
|---|---|---|
| `<repo>` | absolute path of this repository (forward slashes) | the repository location the deployment directory junction points at |
| `<test directory>` | dedicated root directory for this test run | a newly created directory such as `%USERPROFILE%\dsh-perm-test` |
| `<DSH_HOME>` | dsh configuration directory (where settings.yaml lives) | the `$DSH_HOME` environment variable, or the default `~/.dsh` |

---

## 0. Safety red lines (read before running any test; stop immediately if any is violated)

1. **All write operations land inside the test directory only.** The read/write and execution
   effects of the dispatched shell commands, probe scripts and example files may only touch
   paths under `<test directory>`; `<test directory>` must be a directory created for and
   dedicated to this test run.
2. **Do not touch anything outside the test directory**: do not write, delete, move or rename
   any file in user directories, system directories or other project directories; destructive
   commands such as `rm`/`del`/`Remove-Item`/`format` may only point at a one-off
   subdirectory inside `<test directory>` (in this plan most of them are only judged by the
   engine and never actually executed).
3. **Configuration changes are permitted in exactly two places, both reversible**:
   - the `sandbox-allowlist` section of `$DSH_HOME/settings.yaml` (**back it up first**, see
     §1.3);
   - any file inside `<test directory>`.
   Do not modify the dsh profile structure, do not uninstall/reinstall the plugin, do not
   disable the sandbox, and do not change the global git configuration.
4. **Read-only exceptions** (permitted without going through the test directory): reading the
   decision log `sandbox-allowlist-decisions.jsonl` and the rule proposals
   `sandbox-allowlist-proposals.json` under `$DSH_HOME` (the validation needs them); and the
   probe script's module imports from `<repo>/lib` (pure reads).
5. **Canary discipline**: the "dangerous rider" in a compound command is always replaced by a
   harmless read-only command such as `whoami`, the same discipline as the repository's
   adversarial matrix (`test/verify-command-matrix.mjs`); example file contents are always
   `dummy` fake data, and **no real credentials or personal data** may appear.
6. After each phase, verify once: no new files were produced outside the test directory; if
   an out-of-bounds write is found, record it immediately, stop testing and report to the
   user.

---

## 1. Test environment preparation

### 1.1 Pre-flight checks

- [ ] dsh web has been started at least once with this repository's code (since 0.2.0,
  profile patch-layer changes hot-apply via HMR; after editing `lib/*.mjs` one restart is
  recommended for a clean load — if a live reload hits the KI-1 "Agent resolver is
  already registered" prompt, restarting the client recovers, see
  `docs/issues/ki-1-session-controller-reload-race.md`; settings-only changes apply
  live, the rule fields are volatile pass-through, no restart needed);
- [ ] the session's sandbox mode is `workspace-write` (`allowedDirs` and noRead do not apply
  under `danger-full-access`, and `read-only` refuses all writes);
- [ ] `node --version` works (≥ 20.11, the package.json engines requirement).

### 1.2 Create the test directory structure

Create the following under `<test directory>` (only phase C actually uses the files; phases
A/B do not depend on the directories existing):

```
<test directory>/
├── ws/                  # used as the session workspace (in-scope)
│   ├── scripts/demo.js  # for C6: console.log('perm-test demo ok')
│   └── package.json     # for C6: {"name":"perm-test","private":true,"scripts":{"test":"node ./scripts/demo.js"}}
├── allowed/             # will be configured as an authorized directory (in-scope, writable directly inside the sandbox)
├── outside/             # not authorized (out-of-scope, the target for the out-of-bounds write track)
└── secret/              # read-denial range (phase C puts dummy files here: id.pem / .env / notes.txt)
```

If phase C needs to observe the real behaviour of git commands, initialise a **local**
repository inside `ws` (no remote configured, so nothing is ever really pushed):

```bash
cd <test directory>/ws && git init -q
git -c user.name=tester -c user.email=test@example.com commit -q -m init --allow-empty
```

### 1.3 Back up the settings (phase C prerequisite)

```bash
cp <DSH_HOME>/settings.yaml <DSH_HOME>/settings.yaml.bak-permtest
```

Confirm the backup exists before injecting the configuration in §4. Use it to restore during
cleanup (see §6).

---

## 2. Phase A — repository self-checks (offline, 8 suites)

Run inside `<repo>` (the tests manage their own temporary files; no test directory needed):

```bash
npm test && npm run test:dry-mount && npm run test:patch \
  && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client
```

**Pass criteria**: all 8 suites pass; `test:matrix` prints `44 rows, 0 mismatches`;
`test:patch` requires `DSH_INSTALL_ANCHOR` to be set first (pointing into the dsh
installation, at
`<dsh-install>/node_modules/@deepseek-ai/dsh/package.json`; when it is unset the suite
prints a prompt and exits — that does not count as a failure); with the plugin mounted,
the output contains `plugin is mounted in the profile (4 patches, last layer)`, while an
unmounted environment prints the preflight hint — record it, it does not count as a
failure.

If any suite fails ⇒ fix it before continuing; do not proceed with red tests.

---

## 3. Phase B — command-rule engine probe (the core: a complex/mixed command matrix)

### 3.1 About the probe

- **Zero execution risk**: the probe only calls the decision engine
  (`lib/command-decision.mjs`) for pure string parsing; it never actually runs any command
  under test and reads/writes no files (the package.json manifest and the read-denial match
  are in-memory stubs). Phase B therefore satisfies §0's red lines by construction.
- Each case asserts **both phases**: the sandbox phase (`allow/ask/deny/delegate`) and the
  escalation phase (`AUTO` = escalation auto-approved / `manual` = manual approval prompt).
- The expected values have been calibrated one by one against the current implementation
  (50/50); if your run mismatches, the implementation or environment does not match the
  plan's assumptions — troubleshoot per §3.3, and **do not change the expected values to
  force a pass**.

### 3.2 Probe script

Save the whole block below as `<test directory>/probe.mjs`, replace the `REPO` / `T`
placeholders at the top with real absolute paths (forward slashes), then run
`node <test directory>/probe.mjs`.

```js
/**
 * dsh-sandbox-allowlist permission engine probe — complex/mixed command verdict matrix (phase B)
 *
 * Zero execution risk: this script only calls the decision engine for pure string parsing;
 * it never actually runs any command under test, and reads/writes no files (the package.json
 * manifest and the read-denial match are in-memory stubs).
 *
 * Replace two placeholders before use:
 *   REPO — absolute path of this repository (forward slashes); engine modules are imported from here;
 *   T    — absolute path of the test directory (forward slashes), matching §1.2 of the test plan.
 * Run: node <test directory>/probe.mjs   (expected output: all passed (50/50))
 */
const REPO = '<repo>'
const T = '<test directory>'

import { pathToFileURL } from 'node:url'
const { decide } = await import(pathToFileURL(`${REPO}/lib/command-decision.mjs`))
const { makeScriptExpander } = await import(pathToFileURL(`${REPO}/lib/command-expand.mjs`))

// Decision context matching the real-machine configuration in §4.1:
//   ws = workspace (in-scope), allowed = authorized directory (in-scope), everything else out-of-scope.
const context = { roots: [`${T}/ws`, `${T}/allowed`], cwd: `${T}/ws` }
// Metaprogram expansion stub: equivalent to this package.json existing in ws (real-machine check in §4 phase C)
const manifest = JSON.stringify({ scripts: { docs: 'git log --oneline -3', deploy: 'node ./scripts/deploy.js' } })
const expandScript = makeScriptExpander({ workspaceRoot: `${T}/ws`, readFile: () => manifest, onWarn: () => {} })
// Read-denial stub: equivalent to the noRead rule `*.pem → deny`
const noRead = (path) => (path.toLowerCase().endsWith('.pem') ? { pattern: '*.pem', action: 'deny' } : null)
const CTX = { ...context, expandScript, noRead }

// Three rule sources:
//   A narrow rules (main matrix)  B broad-rule variant (the cost of a broad pattern)  C variant with cat * added (verifies the noRead track is not overridden by allow)
const NARROW = [
  { pattern: 'pnpm test*', action: 'allow' },
  { pattern: 'git status*', action: 'allow' },
  { pattern: 'git push*', action: 'ask' },
  { pattern: 'echo *', action: 'allow' },
  { pattern: 'rm -rf *', action: 'deny' },
  { pattern: 'whoami*', action: 'deny' },
]
const SOURCES = {
  A: { rules: NARROW, default: 'delegate', escalation: 'capability', baseline: true },
  B: { rules: [...NARROW, { pattern: 'git *', action: 'allow' }, { pattern: 'pnpm *', action: 'allow' }], default: 'delegate', escalation: 'capability', baseline: true },
  C: { rules: [...NARROW, { pattern: 'cat *', action: 'allow' }], default: 'delegate', escalation: 'capability', baseline: true },
}

// Each row: [rule source, tool, command, expected sandbox verdict, expected escalation auto-approval, semantic point]
// Expected sandbox ∈ allow|ask|deny|delegate; expected escalation = true(AUTO)/false(manual)
const isWin = process.platform === 'win32'
const CASES = [
  // ── G1 basic matching ──────────────────────────────────────────────────
  ['A', 'bash', 'git status --porcelain', 'allow', true, 'rule git status* matches'],
  ['A', 'bash', 'git status', 'allow', true, 'a zero-length tail matches too (status* covers bare status)'],
  ['A', 'bash', 'git push origin main', 'ask', false, 'the rule requires approval'],
  ['A', 'bash', 'git log -5', 'allow', true, 'no rule; the built-in baseline recognises read-only'],
  ['A', 'bash', 'rm -rf ./junk', 'deny', false, 'a deny rule blocks outright'],
  ['A', 'bash', 'npx some-pkg', 'delegate', false, 'no rule and not benign ⇒ keep current behaviour'],
  ['A', 'bash', 'gitdb status', 'delegate', false, 'the pattern is anchored at the start; gitdb is not git'],
  ['A', 'pwsh', 'GIT STATUS', isWin ? 'allow' : 'delegate', isWin, 'case-insensitive on Windows (case-sensitive on POSIX)'],
  ['A', 'bash', 'git branch -D feature', 'delegate', false, 'the case-sensitive flag -D classifies as destructive; no rule allows it'],
  // ── G2 program-name normalization ──────────────────────────────────────
  ['A', 'pwsh', '"C:/Program Files/Git/git.exe" status', 'allow', true, 'quoted full path + .exe normalises to git status'],
  ['A', 'pwsh', '& git status --porcelain', 'allow', true, 'the pwsh call operator & is skipped'],
  ['A', 'pwsh', '"C:/Program Files/Git/git.exe" status && "C:/Program Files/Git/git.exe" push', 'ask', false, 'compound + normalization: the second segment matches ask'],
  // ── G3 compound/mixed splitting ────────────────────────────────────────
  ['A', 'bash', 'git status; whoami', 'deny', false, 'a deny rider in a ; chain is not masked by an allowing prefix'],
  ['A', 'bash', 'git status && whoami', 'deny', false, '&& chain'],
  ['A', 'bash', 'git status & whoami', 'deny', false, 'a single & is a separator too'],
  ['A', 'bash', 'git status || whoami', 'deny', false, '|| chain'],
  ['A', 'bash', 'git status | whoami', 'deny', false, 'a pipe is split as well'],
  ['A', 'bash', 'pnpm test\nwhoami', 'deny', false, 'newline separated'],
  ['A', 'bash', 'git status && git log -3', 'allow', true, 'a compound of all-benign/all-matching parts is allowed as a whole'],
  ['A', 'bash', 'echo one; echo two', 'allow', true, 'every segment matches echo *'],
  ['A', 'bash', 'echo a && echo b || whoami', 'deny', false, 'mixed chain with a rider at the end'],
  ['A', 'bash', 'pnpm test & git status', 'allow', true, 'background & plus a matching segment'],
  // ── G4 recursive verdicts on substitution bodies ───────────────────────
  ['A', 'bash', 'echo $(whoami)', 'deny', false, 'the $() substitution body is judged separately'],
  ['A', 'bash', 'echo `whoami`', 'deny', false, 'backticks are an equivalent substitution'],
  ['A', 'pwsh', 'Write-Output $(whoami)', 'deny', false, 'a pwsh subexpression gets the same treatment'],
  ['A', 'bash', 'echo $(git status --porcelain)', 'allow', true, 'a benign substitution body does not drag the whole down'],
  ['A', 'bash', 'echo $(echo $(whoami))', 'deny', false, 'with nested substitution the innermost deny still matches'],
  ['A', 'bash', 'git commit -m "$(date +%F)"', 'allow', true, 'a benign substitution inside an argument + a workspace write'],
  ['A', 'bash', 'git commit -m $(whoami)', 'deny', false, 'a substitution inside an argument matches deny'],
  // ── G5 fail-closed structures ──────────────────────────────────────────
  ['A', 'bash', 'diff <(whoami) x', 'delegate', false, 'process substitution is unparsable ⇒ falls back to manual'],
  ['A', 'bash', 'pnpm test "unbalanced', 'delegate', false, 'unbalanced quotes ⇒ falls back to manual'],
  ['A', 'bash', 'echo $((1+1))', 'delegate', false, '$(( arithmetic expansion is unparsable ⇒ falls back to manual'],
  ['A', 'bash', 'echo $(echo $(echo $(whoami)))', 'deny', false, 'deep nesting can still be judged recursively'],
  // ── G6 redirection ─────────────────────────────────────────────────────
  ['A', 'bash', 'git status > ./probe-out.txt', 'allow', true, 'redirection inside the workspace'],
  ['A', 'bash', 'git status 2>&1', 'allow', true, 'a harmless fd duplication'],
  ['A', 'bash', 'git status 2> ./err.txt', 'allow', true, 'stderr inside the workspace'],
  ['A', 'bash', 'echo x > ../outside/escape.txt', 'allow', false, 'track 2: allowed inside the sandbox but escalation is stopped by the out-of-bounds redirection'],
  ['A', 'pwsh', 'pnpm test 2>&1 | Select-Object -Last 20', 'allow', true, 'a pwsh pipeline needs no per-cmdlet enumeration'],
  // ── G7 environment-variable prefixes ───────────────────────────────────
  ['A', 'bash', 'FOO=bar git status --porcelain', 'allow', true, 'an env prefix only blocks the capability fallback, not an explicit rule'],
  ['A', 'bash', 'FOO=bar npx some-pkg', 'delegate', false, 'an env prefix blocks the baseline ⇒ keep current behaviour'],
  // ── G8 heredoc ─────────────────────────────────────────────────────────
  ['A', 'bash', 'cat <<EOF > ./note.txt\nhello\nEOF\n', 'allow', true, 'the heredoc body counts as data; the redirection is inside the workspace'],
  // ── G9 metaprogram expansion (package.json stub) ───────────────────────
  ['A', 'bash', 'pnpm docs', 'allow', true, 'expands to git log: judged benign by its real content'],
  ['A', 'bash', 'pnpm deploy', 'delegate', false, 'expands to node: invisible code, conservatively blocked'],
  ['A', 'bash', 'pnpm test', 'allow', true, 'the rule matches the container: the authorization overrides the expanded body'],
  ['A', 'bash', 'pnpm unknown-script', 'delegate', false, 'the script name does not exist ⇒ conservatively not auto-approved'],
  // ── G10 escalation track and broad-rule shapes ─────────────────────────
  ['A', 'bash', 'mkdir ../outside/x', 'delegate', false, 'track 2: out-of-bounds write with no rule backstop'],
  ['A', 'bash', 'cat ../secret/id.pem', 'delegate', false, 'track 3: a noRead target is never auto-escalated'],
  ['C', 'bash', 'cat ../secret/id.pem', 'allow', false, 'variant A: an allow rule does not override the noRead track (escalation stays manual)'],
  ['A', 'bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', 'delegate', false, 'a narrow rule does not match ⇒ protocol injection is unauthorized'],
  ['B', 'bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', 'allow', true, '⚠️ the broad rule git * authorizes protocol injection too (expected semantics, not a vulnerability)'],
]

let failures = 0
for (const [group, tool, command, wantSandbox, wantEscalate, note] of CASES) {
  const source = SOURCES[group]
  const sandbox = decide({ source, tool, command, phase: 'sandbox', context: CTX })
  const escalation = decide({ source, tool, command, phase: 'escalation', context: CTX })
  const gotSandbox = sandbox.verdict
  const gotEscalate = escalation.escalate === true
  const ok = gotSandbox === wantSandbox && gotEscalate === wantEscalate
  if (!ok) failures += 1
  const label = `${tool} ${command.replace(/\n/g, '\\n')}`
  console.log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${label}`)
  if (!ok) {
    console.log(`     expected sandbox=${wantSandbox} escalate=${wantEscalate}, actual sandbox=${gotSandbox} escalate=${gotEscalate}`)
    console.log(`     semantic point: ${note}`)
    console.log(`     engine reason: ${sandbox.reason ?? ''} / ${escalation.reason ?? ''}`)
  }
}
console.log('-'.repeat(72))
if (failures > 0) {
  console.log(`probe result: ${CASES.length - failures}/${CASES.length} passed, ${failures} mismatched — troubleshoot per the "engine reason" above`)
  process.exitCode = 1
} else {
  console.log(`probe result: all passed (${CASES.length}/${CASES.length})`)
}
```

### 3.3 Running, judging and troubleshooting

**Pass criteria**: `probe result: all passed (50/50)`, exit code 0.

Troubleshooting order on a mismatch:

1. look at the mismatching row's "engine reason" — the escalation phase's reason states which
   track (out-of-bounds / read-denied / deny / ask) or which capability class applies;
2. confirm the placeholders were substituted correctly (`T` must match the roots in the rule
   sources, otherwise every in/out-of-scope verdict is wrong);
3. confirm the platform: the `GIT STATUS` row is expected to be `delegate` on POSIX (the
   script already adapts per platform);
4. if it still mismatches after ruling all of that out ⇒ the implemented semantics changed:
   stop, report the mismatch list to the user, and let the user decide whether to change the
   implementation or the plan.

### 3.4 Case groups and semantic points at a glance

| Group | Coverage | Rows |
|---|---|---|
| G1 | basic pattern matching: prefix anchoring, zero-length tail, ask/deny, baseline read-only, unknown programs, case (per platform), case-sensitive flags | 9 |
| G2 | program-name normalization: quoted full path + `.exe`, the pwsh `&` call operator, normalization × compound commands | 3 |
| G3 | compound/mixed splitting: `;` `&&` `&` `||` `|` newline; a deny rider not masked by an allowing prefix; all-benign compounds allowed | 10 |
| G4 | recursive substitution bodies: `$()`, backticks, pwsh subexpressions, nesting, substitutions inside arguments (one benign, one deny) | 7 |
| G5 | fail-closed: process substitution `<(...)`, unbalanced quotes, `$((`, plus a control case where deep nesting still parses | 4 |
| G6 | redirection: in-workspace `>`/`2>&1`/`2>`, **out-of-bounds redirection (track 2: allowed in the sandbox but stopped at escalation)**, pwsh pipeline | 5 |
| G7 | env prefixes: blocking only the capability fallback, not explicit rules (new semantics) | 2 |
| G8 | heredoc body as data + in-workspace redirection | 1 |
| G9 | metaprogram expansion: benign script body allowed, opaque script body blocked, rule overriding the expanded body, unknown script conservative | 4 |
| G10 | escalation track and broad rules: out-of-bounds write, the noRead track (allow does not override), git protocol injection × narrow/broad rule comparison | 5 |

---

## 4. Phase C — real-machine end-to-end validation (dsh web must be running)

> This phase injects the §4.1 test configuration into `$DSH_HOME/settings.yaml` and really
> dispatches commands in a dsh session. **The paths of every dispatched command must land
> inside `<test directory>`** (§0 red lines). Tick each case off in the §5 record table when
> done; the decision log mentioned under "Observe" is read-only inspection.

### 4.1 Inject the test configuration

Edit `<DSH_HOME>/settings.yaml` and replace the `sandbox-allowlist:` section with the
following (leaving everything outside that section untouched):

```yaml
sandbox-allowlist:
  allowedDirs: []          # C9 temporarily changes this to [ '<test directory>\allowed' ]
  commands:
    default: delegate
    escalation: capability
    baseline: true
    rules:
      - pattern: 'git status*'
        action: allow
      - pattern: 'git push*'
        action: ask
      - pattern: 'rm -rf *'
        action: deny
      - pattern: 'whoami*'
        action: deny
      - pattern: 'pnpm test*'
        action: allow
  noRead:                  # injected before C10; use backslashes on Windows (literal inside YAML single quotes), forward slashes on POSIX
    - pattern: '*.pem'
      action: deny
    - pattern: 'id_rsa*'
      action: deny
    - pattern: '.env*'
      action: deny
```

Saving takes effect live, with no restart. Confirm that the dummy files are in place under
`<test directory>\secret` (`id.pem`, `.env`, `notes.txt`, all containing `dummy`).

### 4.2 Observing command-rule behaviour

Switch the session workspace to `<test directory>\ws`. For each case: **action** (the command
the session's AI is asked to run) → **expected observation**.

| # | Action | Expected observation (pass criteria) |
|---|---|---|
| C1 | `git status --porcelain` | runs directly, no approval prompt |
| C2 | `git push origin main` | command approval prompt (the ask rule); choose **reject**; ws has no remote, so even approving would not really push |
| C3 | first create an empty directory `junk/` in ws, then run `rm -rf ./junk` | blocked outright by the deny rule, command not executed (`junk/` still there) |
| C4 | `git status && whoami` | blocked as a whole (the second segment matches the `whoami*` deny), neither segment executed |
| C5 | `git add -A` | runs without asking (no rule matches; the baseline recognises an in-workspace write) |
| C6 | `pnpm test` | runs without asking, script prints `perm-test demo ok`; in the decision log this command's escalation phase is `escalate:true` (the `pnpm test*` rule carries escalation authorization) |

### 4.3 Authorized-directory write boundary

| # | Action | Expected observation |
|---|---|---|
| C7 | run `echo test > <test directory>/outside/a.txt` (unauthorized directory) | the sandbox refuses → the AI automatically retries with sandbox_permissions → an **escalation approval** prompt appears containing the `[sandbox-allowlist]` explanation (out-of-bounds write, track 2) and a suggested rule; **choose reject** |
| C8 | temporarily configure `allowedDirs` as `[ '<test directory>\allowed' ]`, then run `echo test > <test directory>/allowed/a.txt` | succeeds directly, **with no approval at all** — once the directory is authorized the sandbox allows it directly and no escalation request is produced at all ("authorizing by path beats command rules") |

### 4.4 Read restrictions (tool layer)

With the §4.1 noRead rules configured, have the AI operate on `<test directory>\secret` using
its **own file tools**:

| # | Action | Expected observation |
|---|---|---|
| C9 | the read tool reads `secret/id.pem` | refused outright (fs fence, reporting an `FS_READ_DENIED`-class error) |
| C10 | the edit tool modifies `secret/.env` | refused (edit implicitly reads first) |
| C11 | listDir lists `secret/` | no directory-wide rule configured yet ⇒ **listing is allowed** (file-name rules do not block listings); then add a directory-wide rule `'<test directory>\secret'` (absolute path, no wildcard) to noRead and list again ⇒ refused |
| C12 | the write tool **creates** `secret/new-dummy.txt` | allowed (what is denied is reading, not writing) |
| C13 | the read tool reads `ws/notes.txt` (an ordinary file no rule matches) | reads normally |
| C14 | the shell runs `cat <test directory>/secret/id.pem` | **cannot be intercepted** (honest boundary: shell subprocesses do not go through the tool layer) and reads `dummy` — this is a documented known boundary, not a vulnerability |

> C10's escalation-track interaction (a command referencing a read-denied target is not
> auto-escalated even with an allow rule) cannot be triggered reliably on a real machine
> (read commands do not provoke a sandbox refusal); it is covered by the phase B probe's
> G10 variant C case.

### 4.5 Manual approvals and rule proposals

| # | Action | Expected observation |
|---|---|---|
| C15 | redo C7, this time **approving by hand** in the escalation prompt; then run the exact same command again | the second run **prompts again** (the session-scoped command cache has been removed; every escalation requires manual confirmation) |
| C16 | inspect (read-only) `<DSH_HOME>/sandbox-allowlist-proposals.json` | after approving the same shape by hand ≥ 2 times the corresponding proposal appears (`action` is always `allow`); meanwhile the decision log `<DSH_HOME>/sandbox-allowlist-decisions.jsonl` contains each decision's reason and per-statement capability class |

### 4.6 Settings-page UI spot check (optional, needs a browser)

Open the settings page's "Sandbox authorization" section: the command-rules card should show
one **command-pattern input** per row plus the three-way `allow/ask/deny` action segmented
control (no "program (optional)" input, no `allow↑`); one visible "auto-approve sandbox
escalations" checkbox (labelled experimental); and "built-in capability baseline" folded
into the collapsed-by-default "Advanced" area. Change one rule and save ⇒ the
behaviour change is visible on C1/C2-style cases without a restart.

---

## 5. Recording results

The executing agent reports per the table below (each row: pass/fail/skip plus a one-line
note; a failure must include the engine reason or the prompt text):

| Case | Result | Note |
|---|---|---|
| Phase A: 8 suites |  | matrix 44 rows 0 mismatches; test:patch output |
| Phase B: probe 50/50 |  | mismatching rows include the "engine reason" |
| C1–C6 command rules |  | one by one |
| C7–C8 authorized directories/escalation track |  |  |
| C9–C14 read restrictions |  |  |
| C15–C16 cache and proposals |  |  |
| C17 settings-page spot check (optional) |  |  |
| Red-line self-check (§0.6: no new files outside the test directory) |  |  |

Overall **pass criteria**: phases A/B all green; C1–C16 with no failures (anything marked
"skip" must state the environment reason, e.g. skipping ACE-related observations on a
non-Windows environment).

---

## 6. Cleanup and restore

1. Restore the settings from the §1.3 backup:
   `cp <DSH_HOME>/settings.yaml.bak-permtest <DSH_HOME>/settings.yaml`
   (if settings.yaml was changed elsewhere during the test, instead remove the injected
   `sandbox-allowlist` section by hand);
2. restart dsh web (so the restored configuration takes effect cleanly);
3. delete the whole `<test directory>`;
4. the decision log and proposal files under `$DSH_HOME` need not be deleted (they are
   regenerable and rotate automatically); if they really must be cleaned up, first confirm
   they contain no history the user wants to keep.
5. if this session produced anything that needs committing (normally it should not — just
   report the test results), the privacy-scan trio in `AGENTS.md` must be run before
   committing.
