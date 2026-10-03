#!/usr/bin/env node
/**
 * Manual verification for the Windows ACE materialization the plugin performs
 * (why: "I added an allowed directory but its security properties show no
 * S-1-4-* ACE"). Windows only; run from an UNRESTRICTED terminal — the ACE
 * edits need WRITE_OWNER on the target directory, which a sandboxed /
 * restricted token cannot do (a roundtrip run inside such a token fails with
 * a Win32 error, which is itself the answer to the mystery).
 *
 * Modes:
 *   node scripts/verify-ace.mjs <workspaceRoot> <dir> [<dir> ...]
 *       Compute the workspace write SID exactly like the plugin does and
 *       check each directory's DACL (icacls) for S-1-4-* ACEs, reporting
 *       whether the expected SID is present.
 *   node scripts/verify-ace.mjs --roundtrip
 *       Self-contained primitive test: create a throwaway temp directory,
 *       grant the write ACE via AclWriteGrant (the same primitive
 *       policy.mjs calls), verify with icacls, revoke, verify gone.
 *
 * Example (示例，请替换为你的实际目录):
 *   node scripts/verify-ace.mjs "C:\Users\me\.dsh\profiles\desktop" "D:\Shared\Tools"
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

if (process.platform !== 'win32') {
  console.error('verify-ace.mjs only applies to the Windows ACL sandbox')
  process.exit(0)
}

/** Mirrors `workspaceWriteSid` in @deepseek-ai/dsh-sandbox-windows-acl. */
function workspaceWriteSid(workspaceRoot) {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest()
  return `S-1-4-${digest.readUInt32LE(0) % (2 ** 30 - 1) + 1}-${digest.readUInt32LE(4) % (2 ** 30 - 1) + 1}`
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
    const sid = workspaceWriteSid(dir)
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

// ── check mode: compare expectation against the live DACL ───────────────────
const [workspaceRoot, ...dirs] = args
if (workspaceRoot === undefined || dirs.length === 0) {
  console.error('usage: node verify-ace.mjs <workspaceRoot> <dir> [<dir> ...]')
  console.error('       node verify-ace.mjs --roundtrip')
  process.exit(2)
}

const wsCanonical = canonical(workspaceRoot)
const sid = workspaceWriteSid(wsCanonical)
console.log(`workspace (canonical): ${wsCanonical}`)
console.log(`expected write SID:    ${sid}`)
console.log('')

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
