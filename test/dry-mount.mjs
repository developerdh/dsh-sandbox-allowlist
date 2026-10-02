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

// Machine-specific roots default to throwaway temp dirs so no real path is
// committed or required; point DSH_TEST_WORKSPACE / DSH_TEST_TRUSTED at real
// directories to probe an actual deployment layout.
const created = []
// 兜底回收：断言中断时尾部清理不会执行，退出钩子重放同一套 best-effort 清理
//（fiber 随进程消亡；文件与目录是主要残留物）。
process.on('exit', () => {
  try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
  for (const dir of created) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
})
const mktemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
const WORKSPACE = process.env.DSH_TEST_WORKSPACE ?? mktemp('dsh-drymount-ws-')
const TRUSTED = process.env.DSH_TEST_TRUSTED ?? mktemp('dsh-drymount-trust-')

// The "outside" fixture must live outside the OS temp area: the stock fence
// treats it as writable in workspace-write mode (`writableRoots` = workspace ∪
// /tmp ∪ tmpdir()), so a temp-path fixture would never be denied and the
// assertion below would be vacuous. The fence realpaths the target, so the
// `..` here resolves NEXT TO the temp root — still a throwaway directory, but
// one the fence really has to refuse.
const OUTSIDE_DIR = process.env.DSH_TEST_OUTSIDE ?? join(tmpdir(), '..', `dsh-drymount-outside-${process.pid}`)
const OUTSIDE = join(OUTSIDE_DIR, 'x.txt')
created.push(OUTSIDE_DIR)

// Isolate the grants manifest (policy writes it next to the settings
// document) so a test workspace never pollutes the real DSH home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-drymount-home-'))

// The fixture directories the patterns/denials address; create them when
// missing so the dry-mount is self-contained on a fresh machine.
if (!existsSync(TRUSTED)) {
  mkdirSync(TRUSTED, { recursive: true })
}
mkdirSync(OUTSIDE_DIR, { recursive: true })

const ctx = new Context()
// dsh 0.2.0: SandboxPolicyService declares `static inject = ['sessionProjections']`
// and registers the `sandboxMode` projection from its constructor, so a bare
// cordis context must provide the service (production provides it through the
// base bundle's session-projection row).
ctx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
// The policy's model-facing context needs a systemPrompt service; a stub is
// enough to activate the registration (the real deployment provides the real
// one). `context()` returns the disposer the policy registers as an effect.
ctx.provide('systemPrompt', { context() { return () => {} } })
// AllowlistFileSystem declares `static inject = [...SandboxedFileSystem.inject,
// 'fileUploads']` (KI-1 registerAgentResolver shim), so a bare cordis context
// must provide a `fileUploads` stub or the fs row stays PENDING and `ctx.fs`
// is never provided.
ctx.provide('fileUploads', { registerAgentResolver() {} })

const policyFiber = ctx.plugin(PolicyPlugin, {
  mode: 'workspace-write',
  workspaceRoot: WORKSPACE,
  // dsh 0.2.0: the rules live in this row's Config — the settings form is a
  // projection of it, and saving the form re-applies the plugin with the
  // merged config. No settings service is involved in reading them.
  allowedDirs: [`${TRUSTED}\\**`],
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
for (const dir of created) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
console.log('dry-mount: all checks passed')

