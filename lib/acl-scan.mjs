/**
 * Orphaned-grant discovery — find standing workspace write-SID ACEs on disk
 * that no manifest accounts for, and (through verify-ace.mjs's revoke mode)
 * strip them after confirmation. Background: versions before the v2 manifest
 * could leave standing ACEs with no accounting record, and a lost or corrupt
 * manifest has the same effect (ki-2). Identification deliberately does NOT
 * depend on the manifest:
 *   - the workspace write SID is pure sha256 derivation from the canonical
 *     workspace path, so it can be recomputed even when the directory is gone;
 *   - when the path is unknown, DACL shape matching finds any
 *     two-subauthority `S-1-4-x-y` allow ACE — a shape regular Windows files
 *     never carry (integrity levels use S-1-16; the private temp SIDs are
 *     `S-1-4-x-y-1`, whose third subauthority excludes them).
 *
 * Scanning default scope, pruning and CLI surface live in verify-ace.mjs;
 * this module provides the pure helpers plus the batched read-only probe.
 * The actual stripping reuses `revokeWriteAces` from acl-revoke.mjs.
 * Platform-safe: probing spawns are win32-only; the pure helpers run anywhere.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { collectRevokeDirs, resolvePowerShell } from './acl-revoke.mjs'

/** Trustee shape of a workspace write SID inside an SDDL ACE (exactly two
 * 30-bit subauthorities — a third (`…-1`) marks the private temp SID). */
export const WORKSPACE_SID_SDDL_SOURCE = 'S-1-4-\\d+-\\d+'

/**
 * Derive the workspace write SID exactly like the official module (and
 * policy.mjs) does: sha256 over the CANONICAL workspace path. The input is
 * canonicalized here (realpath when it exists, resolve otherwise), so a
 * terminal-spelled path yields the same SID the running plugin materialized.
 * @param {string} workspaceRoot - the workspace path (any spelling).
 * @returns {string} the `S-1-4-<x>-<y>` SDDL form.
 */
export function writeSidForDirectory(workspaceRoot) {
  let canonical
  try {
    canonical = resolve(realpathSync.native(workspaceRoot))
  } catch {
    canonical = resolve(workspaceRoot)
  }
  const digest = createHash('sha256').update(canonical, 'utf8').digest()
  return `S-1-4-${digest.readUInt32LE(0) % (2 ** 30 - 1) + 1}-${digest.readUInt32LE(4) % (2 ** 30 - 1) + 1}`
}

/**
 * Parse the allow ACEs of one SDDL DACL for workspace-SID hits.
 * @param {string} sddl - DACL SDDL as produced by GetSecurityDescriptorSddlForm.
 * @param {string|null} sidFilter - exact SID to look for, or null for the
 *   workspace-SID shape (any two-subauthority `S-1-4-x-y`).
 * @returns {{ sid: string, inherited: boolean }[]} — one entry per
 *   (sid, explicit/inherited) combination; `inherited` = the ACE carries the
 *   `ID` flag (an inherited copy propagating from an ancestor's DACL).
 */
export function parseDaclHits(sddl, sidFilter = null) {
  const hits = []
  const seen = new Set()
  // SDDL ACE: (type;flags;rights;object-guid;inherit-object-guid;trustee)
  const re = /\(A;([A-Za-z]*);[^;()]*;[^;()]*;[^;()]*;([^()]+)\)/gu
  for (const match of sddl.matchAll(re)) {
    const flags = match[1].toUpperCase()
    const trustee = match[2]
    let sid = null
    if (sidFilter !== null) {
      if (trustee === sidFilter) sid = trustee
    } else if (new RegExp(`^${WORKSPACE_SID_SDDL_SOURCE}$`).test(trustee)) {
      sid = trustee
    }
    if (sid === null) continue
    const inherited = flags.includes('ID')
    const key = `${sid}|${inherited}`
    if (seen.has(key)) continue
    seen.add(key)
    hits.push({ sid, inherited })
  }
  return hits
}

/** PowerShell program reading a batch of DACLs (read-only — never Set-Acl). */
const PS_READ = String.raw`param([string]$dirsJson, [switch]$Pin51)
$ErrorActionPreference = 'Stop'
if ($Pin51) {
  # Pin the 5.1 module path (see acl-revoke.mjs): Get-Acl must load the 5.1
  # Microsoft.PowerShell.Security, not the Core one a pwsh host puts first.
  $env:PSModulePath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$data = Get-Content -Raw -LiteralPath $dirsJson | ConvertFrom-Json
$results = @()
foreach ($p in $data.dirs) {
  try {
    $acl = Get-Acl -LiteralPath $p
    $results += @{ path = $p; sddl = $acl.GetSecurityDescriptorSddlForm('Access') }
  } catch {
    $results += @{ path = $p; sddl = $null; error = $_.Exception.Message }
  }
}
Write-Output (ConvertTo-Json $results -Compress)`

/** Directories per PowerShell process — a whole typical subtree fits in one
 *  spawn; the chunk only bounds memory/JSON size on huge trees. */
const READ_CHUNK = 2000

/**
 * Read a batch of directories' DACLs (one PowerShell process per chunk of
 * {@link READ_CHUNK}; millisecond-level per directory).
 * @param {string[]} dirs
 * @returns {Promise<Map<string, { sddl: string|null, error: string|null }>>}
 */
export async function readDaclBatch(dirs) {
  const results = new Map()
  if (process.platform !== 'win32' || dirs.length === 0) return results
  const host = resolvePowerShell()
  if (host === null) throw new Error('no PowerShell host available (powershell.exe / pwsh.exe missing)')
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-allowlist-scan-'))
  const dirsFile = join(workdir, 'dirs.json')
  const scriptFile = join(workdir, 'read.ps1')
  try {
    writeFileSync(scriptFile, PS_READ, 'utf8')
    for (let offset = 0; offset < dirs.length; offset += READ_CHUNK) {
      const chunk = dirs.slice(offset, offset + READ_CHUNK)
      writeFileSync(dirsFile, JSON.stringify({ dirs: chunk }), 'utf8')
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-dirsJson', dirsFile]
      if (host.pin51) args.push('-Pin51')
      const output = await new Promise((settle) => {
        let stdout = ''
        let stderr = ''
        const child = spawn(host.exe, args, { windowsHide: true })
        child.stdout.on('data', (chunkData) => { stdout += chunkData })
        child.stderr.on('data', (chunkData) => { stderr += chunkData })
        child.on('error', (error) => {
          const message = String(error?.message ?? error)
          settle({ status: -1, stdout, stderr: stderr.length > 0 ? `${stderr.trim()}\n${message}` : message })
        })
        child.on('close', (code) => settle({ status: code, stdout, stderr }))
      })
      if (output.status !== 0) {
        throw new Error(`${host.exe} exit ${output.status}${output.stderr ? `: ${output.stderr.trim().slice(0, 300)}` : ''}`)
      }
      let parsed
      try {
        parsed = JSON.parse(output.stdout.trim())
      } catch {
        throw new Error(`unparsable scan output: ${String(output.stdout).slice(0, 200)}`)
      }
      for (const item of parsed) {
        results.set(item.path, { sddl: item.sddl ?? null, error: item.error ?? null })
      }
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
  return results
}

/**
 * Scan a set of candidate root subtrees for workspace-SID ACEs.
 *
 * Root pruning (default on): a root whose own DACL carries no matching ACE
 * has its whole subtree skipped — an inherited copy only exists where an
 * ancestor DACL carried the grantable ACE, and a revoke rewrote every
 * ancestor along the way. `deep: true` disables pruning to also catch the
 * rare explicit-ACE-under-clean-root residue (whole-tree cost).
 * @param {object} options
 * @param {string[]} options.roots - candidate root directories (existing).
 * @param {string|null} [options.sid] - exact SID, or null for shape matching.
 * @param {boolean} [options.deep] - disable root pruning.
 * @param {({ scanned: number, hits: number }) => void} [options.onProgress]
 * @returns {Promise<{ hits: { path: string, sid: string, inherited: boolean }[], scanned: number, pruned: { root: string }[], errors: { path: string, error: string }[] }>}
 */
export async function scanOrphanAces({ roots, sid = null, deep = false, onProgress = null } = {}) {
  const hits = []
  const errors = []
  const pruned = []
  if (process.platform !== 'win32') return { hits, scanned: 0, pruned, errors }
  const existing = [...new Set(roots.map((root) => resolve(root)))].filter((root) => existsSync(root))
  if (existing.length === 0) return { hits, scanned: 0, pruned, errors }

  // Probe the roots first; without --deep a clean root prunes its subtree.
  const rootAcls = await readDaclBatch(existing)
  const kept = []
  for (const root of existing) {
    const acl = rootAcls.get(root)
    if (acl?.error) {
      errors.push({ path: root, error: acl.error })
      continue
    }
    if (!deep && parseDaclHits(acl.sddl ?? '', sid).length === 0) {
      pruned.push({ root })
      continue
    }
    kept.push(root)
  }

  // Parents-first subtree walk (reuses the revoke walker's guarantees:
  // symlinks/junctions never followed), then probe everything left.
  const { dirs } = collectRevokeDirs(kept)
  let scanned = 0
  for (let offset = 0; offset < dirs.length; offset += READ_CHUNK) {
    const chunk = dirs.slice(offset, offset + READ_CHUNK)
    const acls = await readDaclBatch(chunk)
    for (const [path, acl] of acls) {
      if (acl.error) {
        errors.push({ path, error: acl.error })
        continue
      }
      scanned += 1
      for (const hit of parseDaclHits(acl.sddl ?? '', sid)) {
        hits.push({ path, sid: hit.sid, inherited: hit.inherited })
      }
    }
    onProgress?.({ scanned, hits: hits.length })
  }
  return { hits, scanned, pruned, errors }
}
