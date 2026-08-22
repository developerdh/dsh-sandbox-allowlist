/**
 * Durable manifest of the directories whose DACLs carry the plugin's
 * workspace write-SID ACE, and the pure diff helpers used to reconcile it.
 *
 * The ACEs are standing OS state: once materialized they persist across
 * server restarts. A config removal must therefore be mirrored by an actual
 * ACE removal (`acl-revoke.mjs`) — but only if the directory was in fact
 * granted. That knowledge lives here, in a JSON sidecar next to the user
 * settings document. The file is derived state, not user configuration: the
 * settings page and settings.yaml remain the only editing surfaces.
 *
 * Layout:
 *   { "workspaces": { "<canonical workspace root>": ["<root>", ...] } }
 * The manifest lists concrete canonical roots only (never patterns) and is
 * rebuilt on every reconcile, so a missing/corrupt file self-heals on the
 * next reconcile.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** File name of the manifest inside the DSH home directory. */
export const MANIFEST_FILE_NAME = 'sandbox-allowlist-grants.json'

/** The manifest sidecar location for a given store directory. */
export function manifestPath(storeDir) {
  return join(storeDir, MANIFEST_FILE_NAME)
}

/** Tolerant load: a missing or corrupt manifest yields an empty structure. */
export function loadManifest(file) {
  if (!existsSync(file)) return { workspaces: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      return { workspaces: parsed.workspaces }
    }
  } catch {
    // corrupt sidecar — treat as empty; the next reconcile rebuilds it
  }
  return { workspaces: {} }
}

/** Root names recorded for one workspace (canonical paths, stable order). */
export function workspaceGrants(manifest, workspaceRoot) {
  const list = manifest.workspaces[workspaceRoot]
  return Array.isArray(list) ? list : []
}

/** Atomic, best-effort persist: write a temp sibling then rename over. */
export function saveManifest(file, manifest) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/**
 * Pure set diff between the granted roots and the currently wanted roots.
 * @param {string[]} granted - canonical roots believed to carry the ACE.
 * @param {string[]} wanted - canonical roots the current patterns expand to.
 * @returns {{ toAdd: string[], toRemove: string[] }} — toRemove first, parent
 *   roots before children so a revoke never re-inherits from a sibling root.
 */
export function diffGranted(granted, wanted) {
  const wantedSet = new Set(wanted)
  const grantedSet = new Set(granted)
  const toAdd = [...new Set(wanted)].filter((root) => !grantedSet.has(root))
  const toRemove = granted.filter((root) => !wantedSet.has(root))
  const depth = (path) => path.split(/[\\/]+/).length
  toRemove.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  return { toAdd, toRemove }
}

/** Build a fresh manifest entry for one workspace from a root list. */
export function setWorkspaceGrants(manifest, workspaceRoot, roots) {
  manifest.workspaces[workspaceRoot] = [...new Set(roots)]
}