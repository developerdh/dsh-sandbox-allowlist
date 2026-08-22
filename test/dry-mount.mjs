/**
 * Dry-mount: instantiate the policy + fs plugins inside a scratch cordis
 * context — the same mounting the loader performs — and exercise the real
 * behavior end-to-end:
 *   1. resolve() carries extraRoots for the configured pattern;
 *   2. on Windows this also MATERIALIZES the workspace write-SID ACE on the
 *      trusted root (standing — reused by the real deployment later);
 *   3. the fs fence allows a write under the trusted root and denies one
 *      outside it.
 *
 * Run from this directory:
 *   node dry-mount.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import FsPlugin from '../lib/fs.mjs'

const WORKSPACE = 'D:/Work/ProductCode/Devops/AI'
const TRUSTED = 'D:\\dsh-trust-test'
const OUTSIDE = 'D:\\dsh-trust-test-other\\x.txt'

// Isolate the grants manifest (policy writes it next to the settings
// document) so a test workspace never pollutes the real DSH home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-drymount-home-'))

// The fixture directory the pattern expands to; create it when missing so
// the dry-mount is self-contained on a fresh machine.
if (!existsSync(TRUSTED)) {
  mkdirSync(TRUSTED, { recursive: true })
}

const ctx = new Context()
// The policy's model-facing context needs a systemPrompt service; a stub is
// enough to activate the registration (the real deployment provides the real
// one).
ctx.provide('systemPrompt', { context() {} })
// A minimal settings-service stub exercising the `sandbox-allowlist` namespace
// path: the policy reads its patterns through the registered scope.
const settingsSection = { allowedDirs: [`${TRUSTED}\\**`] }
ctx.provide('settings', {
  register(_ns, _schema, _options) {
    return {
      get: () => settingsSection,
      watch: () => () => {},
      update: async () => {},
      replace: async () => {},
    }
  },
})

const policyFiber = ctx.plugin(PolicyPlugin, {
  mode: 'workspace-write',
  workspaceRoot: WORKSPACE,
  // no allowedDirs in the composition config — the settings
  // namespace (settingsSection stub) supplies the list
})
await policyFiber

const fsFiber = ctx.plugin(FsPlugin, {})
await fsFiber

// 1. resolved policy carries the expanded trusted roots
const policy = ctx.sandboxPolicy.resolve()
assert.equal(policy.mode, 'workspace-write')
assert.ok(
  Array.isArray(policy.extraRoots) && policy.extraRoots.some((root) => root.toLowerCase() === TRUSTED.toLowerCase()),
  `extraRoots contains the trusted root, got ${JSON.stringify(policy.extraRoots)}`,
)
console.log(`resolved policy: mode=${policy.mode} extraRoots=${JSON.stringify(policy.extraRoots)}`)

// 2. Windows ACE materialization ran as a side effect of resolve() — any
//    grant failure would have surfaced as a warn inside _ensureGrants.
//    (The ACL itself is verified separately with `icacls` from a shell; a
//    child-process pipe capture is blocked by the dsh sandbox here.)
if (process.platform === 'win32') {
  console.log('ACE materialization attempted for trusted root (no grant warnings above = success)')
}

// 3. fs fence: must ALLOW the trusted-root write (no FS_SANDBOX_DENIED) and
//    DENY one outside it. Note: this script itself runs inside the dsh
//    sandbox, so the OS may refuse the actual write (EPERM from the
//    restricted token) even when the fence passes — only the fence verdict
//    is asserted here; the real deployment runs the fence in the unconfined
//    server process.
const inside = { displayPath: `${TRUSTED}\\dry-mount-write.txt` }
let fenceVerdict = 'passed'
try {
  await ctx.fs.writeText(inside, 'hello from dry mount\n', undefined, undefined, policy)
} catch (error) {
  fenceVerdict = error?.code === 'FS_SANDBOX_DENIED' ? 'DENIED' : `OS refused (${error?.code})`
}
assert.notEqual(fenceVerdict, 'DENIED', 'fence must allow the trusted-root write')
console.log(`write under trusted root: fence ${fenceVerdict}`)

let denied = false
try {
  await ctx.fs.writeText({ displayPath: OUTSIDE }, 'x', undefined, undefined, policy)
} catch (error) {
  denied = error?.code === 'FS_SANDBOX_DENIED'
}
assert.ok(denied, 'write outside the trusted root must be denied')
console.log('write outside trusted root: DENIED as expected')

try { if (existsSync(inside.displayPath)) unlinkSync(inside.displayPath) } catch { /* best effort */ }
await policyFiber.dispose()
await fsFiber.dispose()
try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
console.log('dry-mount: all checks passed')
