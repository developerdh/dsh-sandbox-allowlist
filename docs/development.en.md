# Development and testing

> Language: English ｜ [简体中文](development.md)
>
> For maintainers and contributors: test suites, environment variables, client build
> and deployment, internal contracts. User documentation starts at the
> [README](../README.en.md); see [docs/agents.md](agents.md) for the directory guide.

## Test suites

```bash
npm test                     # self-tests (wildcards, rule engine, capability classes, structure parsing, decision engine, audit/cache/proposals, noRead, schema, volatileForm projection guard)
npm run test:command-gate    # end-to-end command gate (real cordis context + tools/pre-execute dispatch)
npm run test:approval-gate   # end-to-end escalation approval gate (capability baseline / allow escalation authorization / noRead linkage / session cache / rule proposals)
npm run test:matrix          # adversarial regression matrix (sandbox phase × escalation phase, dual-column assertions)
npm run test:read-gate       # end-to-end noRead restriction (policy mount + fs enforcement layer + pre-execute deny/ask)
npm run test:client          # settings-page client bundle render assertions (anti-drift markers + i18n dictionary assertions)
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
| `DSH_TEST_OUTSIDE` | dry-mount's out-of-workspace probe path | parent of the temp directory (isolated per pid) |
| `DSH_INSTALL_ANCHOR` | dsh install anchor needed by test:patch to compose a real web profile | **none (required)** |
| `DHS_INSTALL_ANCHOR` | install anchor the resolve-hook uses to resolve @deepseek-ai/* | the repository's own node_modules |

Real-machine verification points (**Windows**; the Linux bwrap path is not yet
real-machine verified): a confined pwsh / the write tool should succeed writing
an authorized directory with no approval; writing an out-of-workspace **untrusted**
directory should still be intercepted (`FS_SANDBOX_DENIED`); `icacls <dir>` should show the
workspace SID `S-1-4-...` with a `(OI)(CI)(W,D,DC)` ACE; after deleting that directory in
the settings page and saving, the same `icacls` output should no longer show that ACE
(including inherited copies in subdirectories) — revoking means reclaiming. For a complete
in-session validation script see the
[permission configuration test plan](testing/test-plan-permissions.en.md).

## Settings-page client

Source `src/client/index.tsx`, with the hand-written runtime equivalent `lib/client.js`
(the two must stay in step; `test:client` has anti-drift assertions). All user-visible
copy goes through the host locale service (`ctx.locale`, namespace `sandbox-allowlist`);
the dictionaries live in `src/client/locales.ts` (zh source of truth + en mirror, with
one inlined copy in `lib/client.js`). The i18n dictionary work was adopted from the
contribution by Bernd Weymann ([@weymann](https://github.com/weymann)). To rebuild from
source:

```bash
# Inside the dsh development repository's pnpm workspace (client deps must resolve)
pnpm install
pnpm run build:client      # tsc + tsdown → lib/client.js (__ModuleLoader__ format)
```

Only once the artifact is in place may package.json declare `dsh.client.inject`
(the semantics of `inject` are "the factory must arrive after the listed package
rows"; declaring it while missing breaks web application loading). To deploy a change:
overwrite the web profile's `node_modules/dsh-sandbox-allowlist/lib/client.js` and
refresh the page (`/plugins/<id>/client.js` is read from disk on every request; no
server restart needed).

A bare cordis context used in tests must provide `sessionProjections`, `systemPrompt`
and `fileUploads` stubs — see the comments in `test/dry-mount.mjs` for the reasons.

## Plugins-page slots

Besides the settings-page section, the client half registers two official configuration
slots on the plugin detail pages — `plugins.bundle.config` (keyed by package name;
rendered between the description and the row list on the bundle page) and
`plugins.row.config` (keyed by `<package>#sandbox-allowlist-policy`; gives the policy row
a "Configure" entry) — both backed by the same data as the settings-page section. The
`summary` view (under the official card title / as the row description fallback) returns a
one-line summary. The provider row additionally registers platform notices: the
`plugins.detail.badge` badge on the detail page ("Linux only") plus a row explanation page
(opened via `row.config`, describing the behavior on Linux/Windows/macOS) — together with
provider.mjs's inert behavior on Windows, enabling it on the wrong platform no longer
raises an error; it just explains itself.

## Row display metadata

The plugin manager resolves `<specifier>/locale/*.json` `meta.title` /
`meta.description` per row's module specifier (falling back to the package.json at that
address). `lib/fs.mjs` and `lib/provider.mjs` are subpath specifiers, so their zh/en
descriptions live in `lib/meta/<row>/locale/`, mapped by exact `exports` keys in
package.json to `<row-address>/locale/*.json`; the locale directory may only contain
language-named JSON files (app boot errors on any other file name). The provider row
description states the platform restriction explicitly (Linux bwrap only, inert on
Windows).

## volatile contract (do not remove)

The three rule fields on `AllowlistPolicyService.Config` (`allowedDirs` / `commands` /
`noRead`) must stay `.volatile()` — the host projects only volatile-marked fields into
the settings form (`volatileForm` in dsh-settings); an entry without any volatile field
is not served by `settings.describe` at all, the client's `configForms.get()` sees no
served namespace, and the settings page is stuck read-only (prompting "the host does not
serve this plugin's settings form"). After loader validation the volatile fields arrive
as cosmokit `Volatile<T>` stable references (the host updates the value in place on
save, no remount needed), and the server always reads through them via
`_currentPatterns()` / `_currentCommands()` / `_currentNoRead()` — any code reading
`this.patterns` and friends directly would crash on a real host with the reference
object.

## Package layout

```
lib/policy.mjs      replaces sandbox-policy: authorized-directory expansion + Windows ACE
                    materialization and reclamation reconciliation (grant-manifest.mjs
                    persists the manifest) + model prompt context + command gate and
                    escalation approval gate mounting + noRead chain
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
lib/fs.mjs          replaces fs-sandbox: write/edit fence admitting extraRoots + noRead read enforcement layer
lib/provider.mjs    replaces sandbox (Linux only): bwrap --bind extension
lib/meta/           row display metadata (zh/en descriptions for fs/provider, exports-mapped
                    to <row-address>/locale/*.json for the plugin manager)
lib/patterns.mjs    wildcard matching and directory expansion (shared)
cordis.patch.yml    bundle patch layer (mounted on install)
scripts/revoke.mjs  Windows emergency cleanup script (normally unnecessary: revocation is reclaimed automatically)
src/client/         settings-page "Sandbox authorization" section source (needs the dsh dev toolchain to build)
src/client/locales.ts  UI dictionaries (zh source of truth + en mirror)
test/               self-tests / end-to-end validation / adversarial regression matrix / patch pre-check / dry mount
```

## Repository and collaboration conventions

For the docs structure, bilingual sync and writing rules see
[docs/agents.md](agents.md); internal working notes (such as version upgrade plans)
live in `docs/internal/` and make no user-facing promises.
