# KI-2 Orphaned grants from older versions: a workspace write-SID ACE lives on disk with no manifest record

[简体中文](ki-2-orphaned-grant-cleanup.md) ｜ English

- **Status**: historical plugin defect (`0.2.0-beta.1` and earlier). Root cause fixed;
  existing residue can be identified and cleaned with the plugin's own scan/revoke tool.
- **Scope**: machines that used "sandbox authorized directories" (Windows) on an affected
  version under any of the situations below; the affected directories' DACLs carry a
  workspace write-SID (`S-1-4-…`) ACE.
- **First recorded**: 2026-10-04 (characterized during the grants-manifest v2 work).

### Symptoms

- On affected versions the authorization state of "sandbox authorized directories" is
  **completely invisible**: neither the UI nor any manifest file shows which directories
  were granted;
- `icacls <dir>` (example — replace with your actual directory) or the security
  properties dialog shows an `(OI)(CI)(W,D,DC)` ACE for `S-1-4-…`, yet:
  - the directory was removed from the allowlist long ago, or
  - no correspondence can be established at all (the workspace directory was renamed or
    deleted, so nothing in the config maps back to it);
- These ACEs are **standing**: they survive process restarts and are never reclaimed
  automatically.

### Trigger (how the unaccounted residue arose)

Once materialized, a workspace write-SID ACE is standing OS state; reclaiming it requires
an explicit revocation. The defect in `0.2.0-beta.1` and earlier was **the manifest did
not keep accounts**:

1. Grants were materialized into DACLs on every resolve, but `grants.json` never recorded
   the runtime materializations;
2. The "config removal → revoke reconcile" chain therefore had nothing to look up:
   directories absent from the manifest were never reconciled away;
3. Two amplifiers:
   - **Workspace renamed/deleted**: the write SID is derived from the canonical workspace
     path, so a path change mints a new SID — the old SID's ACEs became orphans the
     config can no longer match;
   - **Manifest file lost/corrupt**: even with the newer manifest, losing the file degrades
     to the same "no accounts" state.

### Root cause

- The old `grants.json` was only rebuilt at the startup reconcile; runtime materializations
  never reached the disk (manifest lag) — root cause fixed: the v2 manifest persists
  **immediately** on every grant/revoke;
- ACEs are standing OS state that **survives restarts**; without a ledger nothing can
  even find them.

### Disposal (scan → human confirmation → revoke)

Identification and cleanup **do not depend on the manifest**: the workspace write SID is
pure sha256 derivation from the workspace path (computable even when the directory is
gone); when the path is unknown, DACL shape matching finds `S-1-4-<x>-<y>` allow ACEs
(exactly two subauthorities — a third segment ending in `-1` marks the private temp SID
and is distinguishable; regular Windows files essentially never carry authority-4 ACEs,
so the false-positive face is near zero).

Run the commands below in an **unrestricted terminal** (a token that can rewrite DACLs);
every path is an **example — replace with your actual directory**:

```bash
# 1) Scan: default range = the manifest's recorded roots ∪ their pattern expansion;
#    explicit directories scan anywhere else
node scripts/verify-ace.mjs scan
node scripts/verify-ace.mjs scan "D:\Shared"
#    --deep disables root pruning (by default a root whose own DACL has no hit skips
#    the whole subtree) for the rare "clean parent, explicit residue on a child" case;
#    whole-drive scans take minutes — use with care
node scripts/verify-ace.mjs scan --deep "D:\Shared"

# 2) Review the hit list: each hit is annotated explicit / inherited-copy and
#    accounted / unaccounted (whether the current manifest records that path) —
#    unaccounted hits are the cleanup candidates

# 3) Batch strip after confirmation (the list is printed again and a typed 'yes' is
#    required; --yes skips the confirmation)
node scripts/verify-ace.mjs revoke "D:\Shared"

# 4) Re-scan to verify zero
node scripts/verify-ace.mjs scan "D:\Shared"
```

Notes:

- revoke strips **all** hits inside the confirmed range (including ones tagged
  "accounted") — read the annotations before confirming; to clean only unaccounted
  residue, narrow the range or target one SID with `--sid S-1-4-…`;
- shape matching has a tiny theoretical false-positive face (foreign software writing
  authority-4 ACEs), which is why revoke always requires a typed confirmation and only
  `--yes` skips it;
- run the script directly on the machine (a restricted token cannot rewrite DACLs and
  will fail with a Win32 error at the materialize/strip step — which is itself the
  answer: switch to an unrestricted terminal).

### Prevention

- The **grants manifest v2** (delivered after `0.2.0-beta.1`): the manifest persists
  immediately on every runtime grant/revoke (records carry status, grant time, source
  patterns, an exclusion flag, failure reasons and the revocation history) — no more lag;
- failed revocations are no longer dropped silently: they enter `pendingRevoke` and every
  reconcile retries them until they succeed into history;
- deleting an allowed directory in the settings page (or revoking from the session
  panel) triggers the reconcile reclaim — normal use no longer produces new unaccounted
  residue; the ki-2 tool is for abnormal scenes only (lost manifest, old-version leftovers).

### See also

- The session "authorization panel" shows the current workspace's grant records in real
  time (status / time / source / revocation history);
- revocation semantics and the exclusion mechanism are documented in the revocation
  chapter of the permission rules guide.
