#!/usr/bin/env node
/**
 * Manual verification & emergency tooling for the Windows ACE
 * materialization the plugin performs (why: "I added an allowed directory
 * but its security properties show no S-1-4-* ACE", or the inverse: "there
 * are S-1-4-* ACEs on directories nothing accounts for"). Windows only; the
 * grant/revoke paths need an UNRESTRICTED terminal — ACE edits need
 * WRITE_OWNER on the target directory, which a sandboxed / restricted token
 * cannot do (a roundtrip run inside such a token fails with a Win32 error,
 * which is itself the answer to the mystery).
 *
 * Modes:
 *   node scripts/verify-ace.mjs <workspaceRoot> <dir> [<dir> ...]
 *       Check: compute the workspace write SID exactly like the plugin does
 *       and inspect each directory's DACL (icacls) for S-1-4-* ACEs,
 *       reporting whether the expected SID is present (plus what the v2
 *       grants manifest records for the workspace).
 *   node scripts/verify-ace.mjs --roundtrip
 *       Self-contained primitive test: create a throwaway temp directory,
 *       grant the write ACE via AclWriteGrant (the same primitive
 *       policy.mjs calls), verify with icacls, revoke, verify gone.
 *   node scripts/verify-ace.mjs scan [<dir>...] [--sid S-1-4-…] [--deep]
 *       Find standing workspace-SID ACEs, including residues nothing
 *       accounts for (ki-2: 无账残留). Default range = the v2 grants
 *       manifest's recorded roots ∪ the live expansion of their recorded
 *       patterns, across every workspace in the manifest; pass explicit
 *       directories to scan anywhere else (whole-drive scans are minutes,
 *       not seconds). Root pruning is on by default: a root whose own DACL
 *       carries no matching ACE has its subtree skipped; `--deep` disables
 *       the pruning to also catch explicit ACEs under a clean root. Hits are
 *       annotated explicit/inherited-copy and 账内 (the manifest records the
 *       path)/无账 (it does not — a cleanup candidate).
 *   node scripts/verify-ace.mjs revoke [<dir>...] [--sid S-1-4-…] [--deep] [--yes]
 *       Revoke: run the same scan, print the hit list and REQUIRE a typed
 *       confirmation (`--yes` skips) — the shape match has a theoretical
 *       false-positive face (foreign software writing authority-4 ACEs) —
 *       then strip the ACEs in one batched PowerShell pass per SID, and
 *       suggest a re-scan to verify zero.
 *
 * Example (示例，请替换为你的实际目录):
 *   node scripts/verify-ace.mjs "C:\Users\me\.dsh\profiles\desktop" "D:\Shared\Tools"
 *   node scripts/verify-ace.mjs scan "D:\Shared"
 *   node scripts/verify-ace.mjs revoke --deep --yes "D:\Shared"
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { writeSidForDirectory, scanOrphanAces } from '../lib/acl-scan.mjs'
import { expandTrustedRoots } from '../lib/patterns.mjs'
import { revokeWriteAces } from '../lib/acl-revoke.mjs'

if (process.platform !== 'win32') {
  console.error('verify-ace.mjs only applies to the Windows ACL sandbox')
  process.exit(0)
}

function canonical(path) {
  try {
    return resolve(realpathSync.native(path))
  } catch {
    return resolve(path)
  }
}

/** icacls output for one directory (raw text; SIDs appear as S-1-… strings). */
function icaclsText(dir) {
  return execFileSync('icacls', [dir], { encoding: 'utf8' })
}

/** Every S-1-4-* ACE line the DACL currently carries. */
function capabilityAces(dir) {
  return icaclsText(dir)
    .split(/\r?\n/u)
    .filter((line) => line.includes('S-1-4-'))
    .map((line) => line.trim())
}

const [, , ...args] = process.argv

// ── roundtrip: verify the primitive itself, in isolation ────────────────────
if (args[0] === '--roundtrip') {
  const { AclWriteGrant } = await import('@deepseek-ai/dsh-sandbox-windows-acl')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-ace-'))
  try {
    const sid = writeSidForDirectory(dir)
    console.log(`roundtrip dir: ${dir}`)
    console.log(`expected SID:  ${sid}`)
    const before = capabilityAces(dir)
    console.log(`before grant:  ${before.length === 0 ? 'no S-1-4-* ACEs (expected)' : JSON.stringify(before)}`)
    const grant = AclWriteGrant.create(sid)
    try {
      grant.add(dir, true)
    } catch (error) {
      console.error(`GRANT FAILED: ${String(error?.message ?? error)}`)
      console.error('→ the token running this script cannot rewrite DACLs (needs ownership /')
      console.error('  WRITE_OWNER). An unrestricted, elevated terminal should succeed.')
      process.exit(1)
    }
    const after = capabilityAces(dir)
    console.log(`after grant:   ${JSON.stringify(after)}`)
    if (!after.some((line) => line.includes(sid))) {
      console.error('ROUNDTRIP FAILED: the expected SID is not in the DACL after a successful grant')
      process.exit(1)
    }
    console.log('ROUNDTRIP OK: grant materialized the expected S-1-4-* ACE')
    grant.dispose() // standing grants survive dispose; only the SID handles are freed
    const disposed = capabilityAces(dir)
    console.log(`after dispose: ${disposed.length === 0 ? 'ACE still present (standing — expected)' : JSON.stringify(disposed)}`)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  process.exit(0)
}

// ── scan / revoke: orphaned-grant discovery and (confirmed) cleanup ─────────
function manifestScanContext() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'sandbox-allowlist-grants.json')
  const roots = new Set()
  const accounted = new Set()
  const patterns = new Set()
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    for (const record of Object.values(manifest?.workspaces ?? {})) {
      for (const entry of record?.roots ?? []) {
        if (typeof entry?.path !== 'string') continue
        roots.add(entry.path)
        accounted.add(entry.path.toLowerCase())
        for (const pattern of entry?.fromPatterns ?? []) {
          if (typeof pattern === 'string') patterns.add(pattern)
        }
      }
    }
  } catch {
    // missing/corrupt sidecar — the explicit-dir range still works
  }
  // The recorded fromPatterns are the audit mirror of the current config:
  // expand them live so the default range covers future children too.
  for (const pattern of patterns) {
    try {
      for (const root of expandTrustedRoots(pattern)) roots.add(root)
    } catch {
      // a pattern that cannot expand contributes nothing
    }
  }
  return { roots: [...roots], accounted, manifestFile: file }
}

async function runScanMode(mode, argv) {
  let sid = null
  let deep = false
  let yes = false
  const dirs = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--sid') sid = argv[(i += 1)] ?? null
    else if (arg === '--deep') deep = true
    else if (arg === '--yes') yes = true
    else if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`)
      process.exit(2)
    } else dirs.push(arg)
  }
  const context = manifestScanContext()
  let range = dirs.map((dir) => canonical(dir))
  if (range.length === 0) {
    range = context.roots
    if (range.length === 0) {
      console.error('no default scan range: grants manifest missing or empty — pass explicit directories')
      process.exit(2)
    }
    console.log(`default scan range from grants manifest (${context.manifestFile}): ${range.length} root(s)`)
  }
  const accounted = context.accounted
  console.log(`scanning ${range.length} root(s) — sid=${sid ?? 'shape match (any S-1-4-x-y)'}${deep ? ' — --deep (root pruning OFF)' : ' — root pruning ON'}`)

  const result = await scanOrphanAces({
    roots: range,
    sid,
    deep,
    onProgress: ({ scanned, hits }) => {
      process.stdout.write(`\r  scanned ${scanned} director(ies), ${hits} hit(s) so far`)
    },
  })
  process.stdout.write('\n')
  if (result.pruned.length > 0) console.log(`pruned ${result.pruned.length} clean root(s) (subtree skipped; --deep disables)`)
  for (const error of result.errors) console.warn(`  ! unreadable: ${error.path}: ${error.error}`)
  if (result.hits.length === 0) {
    console.log(`scan complete: ${result.scanned} director(ies) probed, no workspace-SID ACE hits`)
    return
  }
  console.log(`scan complete: ${result.scanned} director(ies) probed, ${result.hits.length} hit(s):`)
  for (const hit of result.hits) {
    const tag = hit.inherited ? 'inherited-copy' : 'explicit'
    const book = accounted.has(hit.path.toLowerCase()) ? '账内' : '无账'
    console.log(`  · ${hit.path}  [${tag}]  ${hit.sid}  ${book}`)
  }
  if (mode === 'scan') {
    console.log('(无账 hits are cleanup candidates — review them, then run the revoke mode with the same range)')
    return
  }

  // revoke: typed confirmation unless --yes (the shape match has a tiny
  // theoretical false-positive face — foreign authority-4 ACEs).
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Reclaim the workspace-SID ACEs on the ${result.hits.length} director(ies) above? Type 'yes' to confirm: `)
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('aborted — nothing was changed')
      return
    }
  }
  const bySid = new Map()
  for (const hit of result.hits) {
    if (!bySid.has(hit.sid)) bySid.set(hit.sid, new Set())
    bySid.get(hit.sid).add(hit.path)
  }
  let failedTotal = 0
  for (const [hitSid, paths] of bySid) {
    const reclaim = await revokeWriteAces([...paths], hitSid)
    failedTotal += reclaim.failed.length
    console.log(`reclaimed sid ${hitSid}: dirs=${reclaim.dirs} stripped=${reclaim.stripped} failed=${reclaim.failed.length}`)
    for (const item of reclaim.failed.slice(0, 10)) console.warn(`  ! failed: ${item.path}: ${item.error}`)
  }
  console.log(failedTotal === 0
    ? 'done — re-run the same scan command to verify zero hits'
    : 'done with failures — re-run the same revoke command to retry the rest')
}

if (args[0] === 'scan' || args[0] === 'revoke') {
  await runScanMode(args[0], args.slice(1))
  process.exit(0)
}

// ── check mode: compare expectation against the live DACL ───────────────────
const [workspaceRoot, ...dirs] = args
if (workspaceRoot === undefined || dirs.length === 0) {
  console.error('usage: node verify-ace.mjs <workspaceRoot> <dir> [<dir> ...]')
  console.error('       node verify-ace.mjs --roundtrip')
  console.error('       node verify-ace.mjs scan [<dir>...] [--sid S-1-4-…] [--deep]')
  console.error('       node verify-ace.mjs revoke [<dir>...] [--sid S-1-4-…] [--deep] [--yes]')
  process.exit(2)
}

const wsCanonical = canonical(workspaceRoot)
const sid = writeSidForDirectory(wsCanonical)
console.log(`workspace (canonical): ${wsCanonical}`)
console.log(`expected write SID:    ${sid}`)
console.log('')

// v2 manifest diagnostic: show what the plugin's accounting believes about
// this workspace (grants.json is derived state; v2 records carry status /
// grantedAt / exclusion flags / revocation history). Read-only and
// best-effort — a missing/corrupt sidecar must never fail the check.
const manifestFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sandbox-allowlist-grants.json')
try {
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    const record = manifest?.workspaces?.[wsCanonical] ?? manifest?.workspaces?.[workspaceRoot]
    if (record && Array.isArray(record.roots) && record.roots.length > 0) {
      console.log(`grants manifest (v${manifest.version ?? 1}) for this workspace:`)
      for (const entry of record.roots) {
        console.log(`  · ${entry.path}  status=${entry.status}${entry.excluded ? '  excluded=true' : ''}${entry.grantedAt ? `  grantedAt=${entry.grantedAt}` : ''}`)
      }
      if (Array.isArray(record.pendingRevoke) && record.pendingRevoke.length > 0) {
        console.log(`  pendingRevoke (retry on next reconcile): ${record.pendingRevoke.map((entry) => entry.path).join(', ')}`)
      }
      if (Array.isArray(record.history) && record.history.length > 0) {
        console.log(`  history entries: ${record.history.length} (revocations kept for audit)`)
      }
    } else {
      console.log(`grants manifest has no root record for this workspace (${manifestFile})`)
    }
    console.log('')
  }
} catch { /* diagnostic only */ }

let failures = 0
for (const dir of dirs) {
  const target = canonical(dir)
  console.log(`dir: ${target}`)
  if (!existsSync(target)) {
    console.log('  ✗ directory does not exist — expandTrustedRoots yields nothing for it, no ACE is ever written')
    failures += 1
    continue
  }
  const aces = capabilityAces(target)
  if (aces.length === 0) {
    console.log('  ✗ no S-1-4-* ACEs at all. Likely causes, in order:')
    console.log('    1. the running session mode is not workspace-write (grant only happens there);')
    console.log('    2. no resolve() ran since the save — trigger any command/tool call first (or restart);')
    console.log('    3. the grant threw (see the dsh log for "cannot grant write on ...").')
    failures += 1
    continue
  }
  for (const line of aces) console.log(`  · ${line}`)
  if (aces.some((line) => line.includes(sid))) {
    console.log('  ✓ expected workspace SID present')
  } else {
    console.log('  ✗ S-1-4-* ACEs exist but none matches the expected SID — the workspace root')
    console.log('    spelling differs from the one the running process derived (compare the')
    console.log('    "workspace (canonical)" line above with the key in sandbox-allowlist-grants.json).')
    failures += 1
  }
  console.log('')
}

process.exit(failures === 0 ? 0 : 1)
