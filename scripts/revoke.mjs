#!/usr/bin/env node
/**
 * Remove the DSH workspace write-SID ACEs previously granted on trusted
 * directories (the inverse of policy.mjs's materialization). Windows only.
 *
 * Usage:
 *   node revoke.mjs <workspaceRoot> <dir> [<dir> ...]
 *
 * Example:
 *   node revoke.mjs "D:\Work\ProductCode\Devops\AI" "D:\Shared\Tools" "D:\Data\logs"
 *
 * The workspace root must be spelled exactly as DSH resolves it (the SID is
 * derived from the canonical path), i.e. the same value the dsh process was
 * started from / the session workspace.
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Mirrors `workspaceWriteSid` in @deepseek-ai/dsh-sandbox-windows-acl. */
function workspaceWriteSid(workspaceRoot) {
  const digest = createHash('sha256').update(workspaceRoot, 'utf8').digest()
  return `S-1-4-${digest.readUInt32LE(0) % (2 ** 30 - 1) + 1}-${digest.readUInt32LE(4) % (2 ** 30 - 1) + 1}`
}

const [, , workspaceRoot, ...dirs] = process.argv
if (workspaceRoot === undefined || dirs.length === 0) {
  console.error('usage: node revoke.mjs <workspaceRoot> <dir> [<dir> ...]')
  process.exit(2)
}
if (process.platform !== 'win32') {
  console.error('revoke.mjs only applies to the Windows ACL sandbox; on Linux/macOS remove the trusted roots from the provider config instead')
  process.exit(0)
}

let canonical
try {
  canonical = resolve(realpathSync.native(workspaceRoot))
} catch {
  canonical = resolve(workspaceRoot)
}
const sid = workspaceWriteSid(canonical)
console.log(`workspace write SID: ${sid}`)

let failed = false
for (const dir of dirs) {
  console.log(`removing ${sid} ACE from ${dir} ...`)
  // /remove:g removes every ACE granting to the SID (inheritable ones
  // included); /T recurses into children; /C continues past errors.
  const result = spawnSync('icacls', [dir, '/remove:g', `*${sid}`, '/T', '/C'], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`revoke failed for ${dir} (icacls exit ${result.status})`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
