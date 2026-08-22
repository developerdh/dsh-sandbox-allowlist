#!/usr/bin/env node
/**
 * Emergency manual reclamation of the DSH workspace write-SID ACEs previously
 * granted on trusted directories (the inverse of policy.mjs's materialization).
 * Windows only.
 *
 * Normally this is NOT needed: policy.mjs automatically reclaims the ACEs of
 * every directory removed from the allowlist (on settings change and on
 * startup). Use this script only when you want to clean leftovers outside a
 * running dsh (e.g. after uninstalling the plugin, or for directories the
 * auto-reclaim could not reach).
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
 *
 * Mechanism: `icacls /remove` fails with ERROR_NONE_MAPPED (1332) for the
 * custom-authority `S-1-4-…` workspace SIDs on this platform, so the script
 * uses PowerShell SDDL round-tripping instead: each directory's DACL is read
 * as SDDL, the ACE segments naming the workspace SID are dropped (explicit
 * and inherited copies alike), and the DACL is written back. Directories are
 * processed parents-first so a child never re-inherits from a batch root
 * that is being reclaimed in the same run.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

/** PowerShell program applied to every directory under the targets. */
const PS_STRIP = String.raw`param([string]$dirsJson, [switch]$Pin51)
$ErrorActionPreference = 'Stop'
if ($Pin51) {
  # Pin the 5.1 module path: when powershell.exe is spawned from a pwsh-7
  # host, the inherited PSModulePath lists the .NET-Core module dirs first
  # and Get-Acl/Set-Acl break (the incompatible Microsoft.PowerShell.Security
  # fails to autoload). The System32 copy is always the right one for 5.1.
  $env:PSModulePath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$data = Get-Content -Raw -LiteralPath $dirsJson | ConvertFrom-Json
$results = @()
foreach ($p in $data.dirs) {
  try {
    $acl = Get-Acl -LiteralPath $p
    $sddl = $acl.GetSecurityDescriptorSddlForm('Access')
    $pattern = '\(A[^()]*?;;;' + [regex]::Escape([string]$data.sid) + '\)'
    $n = ([regex]::Matches($sddl, $pattern)).Count
    if ($n -gt 0) {
      $newSddl = [regex]::Replace($sddl, $pattern, '')
      $acl.SetSecurityDescriptorSddlForm($newSddl)
      Set-Acl -LiteralPath $p -AclObject $acl
    }
    $results += @{ path = $p; stripped = $n }
  } catch {
    $results += @{ path = $p; stripped = -1; error = $_.Exception.Message }
  }
}
Write-Output (ConvertTo-Json $results -Compress)`

const allDirs = []
for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.warn(`skipping missing directory: ${dir}`)
    continue
  }
  const walk = (current) => {
    allDirs.push(current)
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      walk(join(current, entry.name))
    }
  }
  walk(resolve(dir))
}
const depth = (path) => path.split(/[\\/]+/).length
allDirs.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
if (allDirs.length === 0) {
  console.error('no existing directories to process')
  process.exit(1)
}

/** Prefer Windows PowerShell 5.1; fall back to PowerShell 7 (pwsh). */
function resolvePowerShell() {
  const winDir = process.env.WINDIR ?? 'C:\\Windows'
  const ps51 = join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(ps51)) return { exe: ps51, pin51: true }
  const onPath = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true })
  if (onPath.status === 0 && onPath.stdout && onPath.stdout.trim().length > 0) {
    return { exe: 'pwsh.exe', pin51: false }
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pwsh7 = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(pwsh7)) return { exe: pwsh7, pin51: false }
  return null
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-allowlist-revoke-'))
const dirsFile = join(workdir, 'dirs.json')
const scriptFile = join(workdir, 'strip.ps1')
let failed = false
try {
  writeFileSync(dirsFile, JSON.stringify({ sid, dirs: allDirs }), 'utf8')
  writeFileSync(scriptFile, PS_STRIP, 'utf8')
  const host = resolvePowerShell()
  if (host === null) {
    console.error('no PowerShell host available (powershell.exe / pwsh.exe missing) — cannot reclaim ACEs')
    failed = true
  } else {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-dirsJson', dirsFile]
    if (host.pin51) args.push('-Pin51')
    const result = spawnSync(host.exe, args, { encoding: 'utf8', stdio: 'inherit' })
    if (result.status !== 0) {
      console.error(`reclaim failed (${host.exe} exit ${result.status})`)
      failed = true
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)