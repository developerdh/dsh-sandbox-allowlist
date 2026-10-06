/**
 * Durable manifest of the directories whose DACLs carry the plugin's
 * workspace write-SID ACE, and the pure diff/accounting helpers used to
 * reconcile it.
 *
 * The ACEs are standing OS state: once materialized they persist across
 * server restarts. A config removal must therefore be mirrored by an actual
 * ACE removal (`acl-revoke.mjs`) — but only if the directory was in fact
 * granted. That knowledge lives here, in a JSON sidecar next to the user
 * settings document. The file is derived state, not user configuration: the
 * settings page and settings.yaml remain the only editing surfaces.
 *
 * Layout (version 2, per-root records instead of v1's bare path lists):
 *   { "version": 2, "workspaces": { "<canonical workspace root>": {
 *       "sid": "S-1-4-...", "updatedAt": "<ISO time>",
 *       "roots": [{ "path": "...", "status": "granted" | "failed",
 *                   "grantedAt": "...", "fromPatterns": ["..."],
 *                   "triggeredBy": "...", "excluded": false,
 *                   "error": null, "errorAt": null, "attempts": 0 }],
 *       "pendingRevoke": [{ "path": "...", "fromPatterns": [...],
 *                           "origin": "config-removed" | "excluded",
 *                           "error": "...", "attempts": 1,
 *                           "lastAttemptAt": "..." }],
 *       "history": [{ "path": "...", "revokedAt": "...",
 *                     "origin": "config-removed" | "excluded",
 *                     "fromPatterns": [...] }]
 *   } } }
 *
 * `excluded` is the runtime revocation list (deliberately not in Config):
 * setting the flag triggers a reconcile that strips the ACE; after a
 * successful strip the record moves to `history` (origin "excluded"), and an
 * entry whose origin is "excluded" in `history` STILL counts as excluded —
 * a covered path must not re-materialize until the exclusion is lifted
 * (`restore`). `pendingRevoke` holds revocations that failed (the record has
 * nowhere else to live: the config entry is gone or the root is excluded);
 * each reconcile retries them. `history` is a FIFO audit log capped at
 * {@link HISTORY_LIMIT} entries per workspace, oldest dropped first.
 *
 * The manifest lists concrete canonical roots only (never patterns as roots;
 * `fromPatterns` records which patterns covered a root at the last
 * reconcile). A missing/corrupt file self-heals: a v1 file (bare string
 * arrays) migrates in memory on load and is written back in v2 on the next
 * save.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { comparablePath } from './patterns.mjs'

/** File name of the manifest inside the DSH home directory. */
export const MANIFEST_FILE_NAME = 'sandbox-allowlist-grants.json'

/** The manifest sidecar location for a given store directory. */
export function manifestPath(storeDir) {
  return join(storeDir, MANIFEST_FILE_NAME)
}

/** Current manifest schema version. */
export const MANIFEST_VERSION = 2

/** FIFO cap of `history` entries per workspace (oldest dropped first). */
export const HISTORY_LIMIT = 200

/** Where a revocation came from — why the ACE had to go. */
export const REVOKE_ORIGINS = ['config-removed', 'excluded']

const nowIso = () => new Date().toISOString()

/** A fresh, empty per-workspace record. */
export function emptyWorkspaceRecord() {
  return { sid: null, updatedAt: null, roots: [], pendingRevoke: [], history: [] }
}

/** A fresh root entry with every contract field present. */
export function emptyRootEntry(path) {
  return {
    path,
    status: 'granted',
    grantedAt: null,
    fromPatterns: [],
    triggeredBy: '',
    excluded: false,
    error: null,
    errorAt: null,
    attempts: 0,
  }
}

/** Coerce one parsed root entry into the full record shape (defaults fill gaps). */
function normalizeRootEntry(value) {
  const entry = emptyRootEntry(typeof value?.path === 'string' ? value.path : '')
  if (value && typeof value === 'object') {
    if (value.status === 'failed' || value.status === 'granted') entry.status = value.status
    if (typeof value.grantedAt === 'string') entry.grantedAt = value.grantedAt
    if (Array.isArray(value.fromPatterns)) entry.fromPatterns = value.fromPatterns.filter((p) => typeof p === 'string')
    if (typeof value.triggeredBy === 'string') entry.triggeredBy = value.triggeredBy
    entry.excluded = value.excluded === true
    if (typeof value.error === 'string') entry.error = value.error
    if (typeof value.errorAt === 'string') entry.errorAt = value.errorAt
    if (Number.isFinite(value.attempts)) entry.attempts = value.attempts
  }
  return entry
}

/** Coerce an arbitrary parsed per-workspace value into the v2 record shape. */
function normalizeRecord(value) {
  const record = emptyWorkspaceRecord()
  if (Array.isArray(value)) {
    // v1: a bare list of granted paths — wrap every string as a granted record.
    record.roots = value.filter((p) => typeof p === 'string').map((p) => emptyRootEntry(p))
    return record
  }
  if (!value || typeof value !== 'object') return record
  if (Array.isArray(value.roots)) record.roots = value.roots.map(normalizeRootEntry)
  if (Array.isArray(value.pendingRevoke)) {
    record.pendingRevoke = value.pendingRevoke
      .filter((e) => e && typeof e === 'object' && typeof e.path === 'string')
      .map((e) => ({
        path: e.path,
        fromPatterns: Array.isArray(e.fromPatterns) ? e.fromPatterns.filter((p) => typeof p === 'string') : [],
        origin: REVOKE_ORIGINS.includes(e.origin) ? e.origin : 'config-removed',
        error: typeof e.error === 'string' ? e.error : null,
        attempts: Number.isFinite(e.attempts) ? e.attempts : 0,
        lastAttemptAt: typeof e.lastAttemptAt === 'string' ? e.lastAttemptAt : null,
      }))
  }
  if (Array.isArray(value.history)) {
    record.history = value.history
      .filter((e) => e && typeof e === 'object' && typeof e.path === 'string')
      .map((e) => ({
        path: e.path,
        revokedAt: typeof e.revokedAt === 'string' ? e.revokedAt : null,
        origin: REVOKE_ORIGINS.includes(e.origin) ? e.origin : 'config-removed',
        fromPatterns: Array.isArray(e.fromPatterns) ? e.fromPatterns.filter((p) => typeof p === 'string') : [],
      }))
  }
  if (typeof value.sid === 'string') record.sid = value.sid
  if (typeof value.updatedAt === 'string') record.updatedAt = value.updatedAt
  return record
}

/**
 * Tolerant load: a missing or corrupt manifest yields an empty v2 structure;
 * a v1 manifest (bare string arrays) migrates in memory — the next save
 * writes it back as v2. The returned object carries `needsWriteBack: true`
 * when such a migration happened (saveManifest strips the marker).
 */
export function loadManifest(file) {
  if (!existsSync(file)) return { version: MANIFEST_VERSION, workspaces: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      const workspaces = {}
      let needsWriteBack = false
      for (const [workspaceRoot, value] of Object.entries(parsed.workspaces)) {
        if (Array.isArray(value) || !value || typeof value !== 'object') needsWriteBack = true // v1 / malformed
        workspaces[workspaceRoot] = normalizeRecord(value)
      }
      const manifest = { version: MANIFEST_VERSION, workspaces }
      if (needsWriteBack) manifest.needsWriteBack = true
      return manifest
    }
  } catch {
    // corrupt sidecar — treat as empty; the next reconcile rebuilds it
  }
  return { version: MANIFEST_VERSION, workspaces: {} }
}

/**
 * The v2 record for one workspace, creating and storing an empty one when
 * absent (write-path helper; callers mutate the returned object and persist).
 */
export function workspaceRecord(manifest, workspaceRoot) {
  let record = manifest.workspaces[workspaceRoot]
  if (!record || typeof record !== 'object') {
    record = emptyWorkspaceRecord()
    manifest.workspaces[workspaceRoot] = record
  }
  return record
}

/** Stable key for path identity (separator/case platform rules). */
const keyOf = (path) => comparablePath(path)

/** The root entry for one path, or `undefined`. */
export function rootEntryAt(record, path) {
  const key = keyOf(path)
  return record.roots.find((entry) => keyOf(entry.path) === key)
}

/** The root entry for one path, creating it (contract defaults) when absent. */
export function ensureRootEntry(record, path) {
  let entry = rootEntryAt(record, path)
  if (entry === undefined) {
    entry = emptyRootEntry(path)
    record.roots.push(entry)
  }
  return entry
}

/** Remove the root entry for one path (revocation completed or dir gone). */
export function removeRootEntry(record, path) {
  const key = keyOf(path)
  const index = record.roots.findIndex((entry) => keyOf(entry.path) === key)
  if (index >= 0) record.roots.splice(index, 1)
  return index >= 0
}

/** Root entries believed to carry the ACE right now: granted and not excluded. */
export function activeEntries(record) {
  return record.roots.filter((entry) => entry.status === 'granted' && !entry.excluded)
}

/** Whether `path` sits in the exclusion registry: a live excluded root entry,
 * a pending exclusion revocation (origin "excluded" — the ACE may still be
 * standing and must not be re-granted), or a completed exclusion revocation
 * still recorded in `history` (the record left `roots` when the ACE was
 * stripped, but the exclusion stands until `restore` consumes it). */
export function isExcludedPath(record, path) {
  const key = keyOf(path)
  if (record.roots.some((entry) => entry.excluded && keyOf(entry.path) === key)) return true
  if (record.pendingRevoke.some((entry) => entry.origin === 'excluded' && keyOf(entry.path) === key)) return true
  return record.history.some((entry) => entry.origin === 'excluded' && keyOf(entry.path) === key)
}

/**
 * Pure diff between the manifest's accounting and the currently wanted
 * roots, exclusion-aware.
 * @param record - the workspace's v2 record.
 * @param wanted - canonical roots the current patterns expand to.
 * @returns {{ toAdd: string[], toRemove: string[] }} — `toAdd`: wanted roots
 *   not excluded (live flag or history-excluded) and not believed granted.
 *   `toRemove`: believed-granted roots the config no longer covers
 *   ("config-removed") plus excluded roots still believed granted — exclusion
 *   outranks pattern coverage, so those are revoked whatever the config says.
 *   `toRemove` is parent-first so a revoke never re-inherits from a sibling
 *   root revoked in the same run.
 */
export function diffGrantedV2(record, wanted) {
  const wantedKeys = new Set(wanted.map(keyOf))
  const active = activeEntries(record)
  const activeKeys = new Set(active.map((entry) => keyOf(entry.path)))
  const excludedKeys = new Set(record.roots.filter((e) => e.excluded).map((e) => keyOf(e.path)))

  const toAdd = [...new Set(wanted)].filter((root) => {
    const key = keyOf(root)
    return !activeKeys.has(key) && !excludedKeys.has(key) && !isExcludedPath(record, root)
  })
  const toRemove = [
    ...active.filter((entry) => !wantedKeys.has(keyOf(entry.path))).map((entry) => entry.path),
    ...record.roots.filter((entry) => entry.excluded && entry.status === 'granted').map((entry) => entry.path),
  ]
  const depth = (path) => path.split(/[\\/]+/).length
  toRemove.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  return { toAdd, toRemove }
}

/**
 * Refresh every record's `fromPatterns` from the live per-pattern expansion:
 * each root / pendingRevoke entry lists the patterns whose current expansion
 * covers it (audit mirror of the config at the last reconcile).
 * @param record - the workspace's v2 record.
 * @param patternRoots - `[{ pattern, roots }]` from the caller's expansion.
 */
export function refreshFromPatterns(record, patternRoots) {
  const covering = (path) => {
    const key = keyOf(path)
    return patternRoots
      .filter(({ roots }) => roots.some((root) => keyOf(root) === key))
      .map(({ pattern }) => pattern)
  }
  for (const entry of record.roots) entry.fromPatterns = covering(entry.path)
  for (const entry of record.pendingRevoke) entry.fromPatterns = covering(entry.path)
}

/**
 * Append a revocation to the audit history, FIFO-capped at
 * {@link HISTORY_LIMIT} per workspace (oldest dropped first, order kept).
 */
export function pushHistory(record, entry) {
  record.history.push({
    path: entry.path,
    revokedAt: entry.revokedAt ?? nowIso(),
    origin: REVOKE_ORIGINS.includes(entry.origin) ? entry.origin : 'config-removed',
    fromPatterns: [...(entry.fromPatterns ?? [])],
  })
  if (record.history.length > HISTORY_LIMIT) {
    record.history.splice(0, record.history.length - HISTORY_LIMIT)
  }
}

/**
 * Move a root entry out of `roots` into `history` (the revocation completed;
 * the record is not deleted but kept for audit). Returns whether an entry
 * was moved.
 */
export function moveRootToHistory(record, path, origin, revokedAt) {
  const entry = rootEntryAt(record, path)
  if (entry === undefined) return false
  pushHistory(record, { path: entry.path, origin, revokedAt, fromPatterns: entry.fromPatterns })
  removeRootEntry(record, path)
  return true
}

/**
 * Record a failed revocation: the entry leaves `roots` (it has nowhere to
 * hang off — the config entry is gone or the root is excluded) and lands in
 * `pendingRevoke` for the next reconcile's retry. A same-path entry is
 * replaced, so a path appears at most once.
 */
export function enterPendingRevoke(record, entry) {
  dropPendingRevoke(record, entry.path)
  record.pendingRevoke.push({
    path: entry.path,
    fromPatterns: [...(entry.fromPatterns ?? [])],
    origin: REVOKE_ORIGINS.includes(entry.origin) ? entry.origin : 'config-removed',
    error: entry.error ?? null,
    attempts: entry.attempts ?? 1,
    lastAttemptAt: entry.lastAttemptAt ?? nowIso(),
  })
}

/** Drop the pendingRevoke entry for one path (retry succeeded, dir gone, or cancelled). */
export function dropPendingRevoke(record, path) {
  const key = keyOf(path)
  const index = record.pendingRevoke.findIndex((entry) => keyOf(entry.path) === key)
  if (index >= 0) record.pendingRevoke.splice(index, 1)
  return index >= 0
}

/** Atomic, best-effort persist: write a temp sibling then rename over. */
export function saveManifest(file, manifest) {
  mkdirSync(dirname(file), { recursive: true })
  const clean = { version: MANIFEST_VERSION, workspaces: manifest.workspaces }
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}
