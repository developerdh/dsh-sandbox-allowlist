/**
 * Offline pre-flight for the bundle patch (cordis.patch.yml): composes the
 * real web profile exactly as `dsh --profile web --dump-config` would, with
 * this package's bundle patch appended as an extra layer, and asserts the
 * composed rows. Nothing is written to the real configuration.
 *
 * Run from the package root (node_modules junction resolves @deepseek-ai/*),
 * with DSH_INSTALL_ANCHOR pointing at a file inside the dsh installation to
 * compose (e.g. <dsh-install>/node_modules/@deepseek-ai/dsh/package.json).
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadOverlayPatches, loadProfile, renderConfigDump } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh'
// Real machine paths stay out of the repo: the dsh installation to compose is
// provided via env instead of a hardcoded default.
const ANCHOR = process.env.DSH_INSTALL_ANCHOR
if (!ANCHOR) {
  console.error('validate-patch: set DSH_INSTALL_ANCHOR to a file inside the dsh installation (e.g. <dsh-install>/node_modules/@deepseek-ai/dsh/package.json)')
  process.exit(1)
}
const BUNDLE_PATCH = join(import.meta.dirname, '..', 'cordis.patch.yml')

// Faithful copy of the loader's patch algorithm (dsh-app-boot applyEntryPatches).
function applyEntryPatches(data, patches, warn) {
  data = structuredClone(data)
  if (!patches?.length) return data
  const entryMap = new Map()
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)
    }
  }
  buildMap(data)
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch
    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) { warn(`patch insert: entry ${id} not found`); continue }
        if (!target.group) { warn(`patch insert: entry ${id} is not a group`); continue }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else data.push(...insert)
      buildMap(insert)
      continue
    }
    if (!id) { warn('patch: id is required for non-insert patches'); continue }
    const target = entryMap.get(id)
    if (!target) { warn(`patch: entry ${id} not found`); continue }
    if (name && name !== target.name) { warn(`patch: name mismatch for ${id} (expected ${target.name}, got ${name}), skipping`); continue }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue
      target[key] = value
    }
  }
  return data
}

const profile = loadProfile(NAME, 'web', ANCHOR)
const layers = [
  ...profile.layers.map((layer) => ({ label: layer.packageName, patches: layer.patches })),
  { label: profile.patchPath, patches: profile.patches },
]
const warnings = []
const bundle = loadOverlayPatches(NAME, BUNDLE_PATCH)
assert.ok(Array.isArray(bundle) && bundle.length > 0, 'bundle patch parses as a non-empty list')

// When the plugin is INSTALLED in this profile (dsh.profile.bundles lists it),
// its patch already arrives as the last profile layer — appending it again
// would apply the `insert` twice and make the row assertions ambiguous. So:
// use the mounted layer when present, otherwise preflight the not-yet-installed
// case by appending the patch ourselves.
const mounted = profile.layers.find((layer) => layer.packageName === 'dsh-sandbox-allowlist')
if (mounted !== undefined) {
  assert.ok(
    profile.layers[profile.layers.length - 1].packageName === 'dsh-sandbox-allowlist',
    'the plugin layer must be LAST so its disables/inserts apply after the layers defining the stock rows',
  )
  assert.ok((mounted.patches?.length ?? 0) > 0, 'the mounted layer carries the bundle patch')
  console.log(`validate-patch: plugin is mounted in the profile (${mounted.patches.length} patches, last layer)`)
} else {
  layers.push({ label: BUNDLE_PATCH, patches: bundle })
  console.log('validate-patch: plugin is NOT mounted — preflighting the patch as an extra layer')
}

// Official composition path (same call dump-config makes) must not warn.
const dump = renderConfigDump(NAME, join(profile.dir, 'cordis.yml'), layers, (line) => warnings.push(line))
assert.deepEqual(warnings, [], `composition warnings:\n${warnings.join('\n')}`)

// Manual row-level assertions with the exact same algorithm.
const rows = applyEntryPatches([], layers.flatMap((layer) => layer.patches), (line) => warnings.push(line))
assert.deepEqual(warnings, [], `apply warnings:\n${warnings.join('\n')}`)
const byId = new Map(rows.filter((row) => row?.id).map((row) => [row.id, row]))

assert.equal(byId.get('sandbox-policy')?.disabled, true, 'stock sandbox-policy disabled')
assert.equal(byId.get('fs-sandbox')?.disabled, true, 'stock fs-sandbox disabled')
assert.ok(byId.get('sandbox')?.disabled !== undefined, 'stock sandbox provider disabled by platform expression')
const sandboxDisabledExpr = JSON.stringify(byId.get('sandbox')?.disabled)
assert.ok(sandboxDisabledExpr.includes('win32'), `sandbox disabled expression: ${sandboxDisabledExpr}`)

assert.equal(byId.get('sandbox-allowlist-policy')?.name, 'dsh-sandbox-allowlist', 'replacement policy row present (bare package name for client-manifest scanning)')
const modeExpr = JSON.stringify(byId.get('sandbox-allowlist-policy')?.config?.mode)
assert.ok(modeExpr.includes('workspace-write'), `mode expression carried: ${modeExpr}`)
assert.equal(byId.get('sandbox-allowlist-fs')?.name, 'dsh-sandbox-allowlist/lib/fs.mjs', 'replacement fs row present')
assert.equal(byId.get('sandbox-allowlist-provider')?.name, 'dsh-sandbox-allowlist/lib/provider.mjs', 'replacement provider row present')
const providerDisabledExpr = JSON.stringify(byId.get('sandbox-allowlist-provider')?.disabled)
assert.ok(providerDisabledExpr.includes('win32'), `provider disabled expression: ${providerDisabledExpr}`)

console.log('validate-patch: OK — bundle patch composes cleanly over the web profile; 6 rows checked')
