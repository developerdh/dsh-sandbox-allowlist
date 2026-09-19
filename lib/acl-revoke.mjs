/**
 * Windows ACE reclamation — the inverse of the official
 * `@deepseek-ai/dsh-sandbox-windows-acl` materialization, implemented
 * without touching official packages.
 *
 * Why not `icacls`: the manual cleanup command
 * (`icacls <dir> /remove '*S-1-4-…'`) fails with ERROR_NONE_MAPPED (1332)
 * on this platform for custom-authority SIDs (verified), so the official
 * module's README points at "reclaim via the module" for standing ACEs —
 * and the module exposes no revoke API for standing grants. The working
 * primitive here is PowerShell SDDL round-tripping: read a directory's DACL
 * as SDDL, drop the ACE segments naming the workspace write SID (explicit
 * and inherited copies alike), write it back with Set-Acl, and repeat for
 * every directory under the revoked root (walked parents-first so a child
 * never re-inherits from a sibling batch root that is revoked as well).
 *
 * This module is platform-safe: everything except the pure SDDL helper is a
 * no-op outside win32. The spawn prefers Windows PowerShell 5.1
 * (powershell.exe — always installed at its well-known System32 location on
 * supported Windows) and falls back to PowerShell 7 (pwsh) for stripped
 * environments; with neither present the reclaim reports a clear failure and
 * the policy retries on the next reconcile (fail-closed, never a wrong grant).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Pure: remove every allowed-ACE segment naming `sid` from an SDDL DACL
 * string (`D:...`). Inherited copies serialize identically (with the `ID`
 * segment flag), so one pass clears both explicit and inherited ACEs.
 * @param {string} sddl - DACL SDDL as produced by GetSecurityDescriptorSddlForm.
 * @param {string} sid - the `S-1-4-…` workspace write SID to drop.
 * @returns {{ sddl: string, count: number }}
 */
export function stripDaclSddl(sddl, sid) {
  const pattern = `\\(A[^()]*?;;;${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`
  const re = new RegExp(pattern, 'g')
  const count = (sddl.match(re) ?? []).length
  return count === 0 ? { sddl, count } : { sddl: sddl.replace(re, ''), count }
}

/** PowerShell program invoked once per revocation batch (5.1- and pwsh-compatible). */
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

/**
 * Collect every directory under `roots` (including the roots), parents
 * first, never following symlinks/junction points; missing roots are
 * reported separately.
 * @param {string[]} roots
 * @returns {{ dirs: string[], missing: string[] }}
 */
export function collectRevokeDirs(roots) {
  const dirs = []
  const missing = []
  for (const root of roots) {
    if (!existsSync(root)) {
      missing.push(root)
      continue
    }
    const walk = (current) => {
      dirs.push(current)
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        return // unreadable directory — the per-dir strip reports failures
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        walk(join(current, entry.name))
      }
    }
    walk(root)
  }
  const depth = (path) => path.split(/[\\/]+/).length
  const unique = [...new Set(dirs)]
  unique.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  return { dirs: unique, missing }
}

/**
 * PowerShell host resolution (win32 only). Windows PowerShell 5.1 is
 * preferred: its well-known location is stable on every supported Windows.
 * PowerShell 7 (pwsh) is the fallback for stripped/Server images without
 * 5.1 — resolved on PATH first, then the standard install dir.
 * @returns {null | { exe: string, pin51: boolean }} pin51 = pin PSModulePath
 *   to the 5.1 System32 modules (see PS_STRIP) — true only for powershell.exe.
 */
export function resolvePowerShell() {
  if (process.platform !== 'win32') return null
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

/**
 * Reclaim (remove) the workspace write SID's ACEs on a set of directories
 * and their subtrees. No-op outside win32.
 * @param {string[]} roots - canonical directories to reclaim.
 * @param {string} sid - the workspace write SID.
 * @returns {{ ok: boolean, dirs: number, stripped: number, missing: string[], failed: { path: string, error: string }[] }}
 */
export function revokeWriteAces(roots, sid) {
  if (process.platform !== 'win32') {
    return { ok: true, dirs: 0, stripped: 0, missing: [], failed: [] }
  }
  const { dirs, missing } = collectRevokeDirs(roots)
  if (dirs.length === 0) {
    return { ok: true, dirs: 0, stripped: 0, missing, failed: [] }
  }
  const host = resolvePowerShell()
  if (host === null) {
    const error = 'no PowerShell host available (powershell.exe / pwsh.exe missing) for ACE reclamation'
    return { ok: false, dirs: dirs.length, stripped: 0, missing, failed: dirs.map((path) => ({ path, error })) }
  }

  const workdir = mkdtempSync(join(tmpdir(), 'dsh-allowlist-revoke-'))
  const dirsFile = join(workdir, 'dirs.json')
  const scriptFile = join(workdir, 'strip.ps1')
  try {
    writeFileSync(dirsFile, JSON.stringify({ sid, dirs }), 'utf8')
    writeFileSync(scriptFile, PS_STRIP, 'utf8')
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-dirsJson', dirsFile]
    if (host.pin51) args.push('-Pin51')
    const result = spawnSync(host.exe, args, { encoding: 'utf8', windowsHide: true })
    let failed = []
    let stripped = 0
    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim())
        for (const item of parsed) {
          if (item.stripped < 0) failed.push({ path: item.path, error: item.error ?? 'unknown' })
          else if (item.stripped > 0) stripped += item.stripped
        }
      } catch {
        failed = dirs.map((path) => ({ path, error: `unparsable reclaim output: ${String(result.stdout).slice(0, 200)}` }))
      }
    } else {
      failed = dirs.map((path) => ({ path, error: `${host.exe} exit ${result.status}${result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : ''}` }))
    }
    return { ok: failed.length === 0, dirs: dirs.length, stripped, missing, failed }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}