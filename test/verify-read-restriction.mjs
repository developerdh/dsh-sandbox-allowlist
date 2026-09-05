/**
 * End-to-end verification of the noRead read-restriction feature inside a
 * real cordis context: mount the policy service (which attaches the compiled
 * rules to every resolved policy and registers the pre-execute gate) plus the
 * fs fence, then exercise
 *
 *   1. policy: resolve() carries noReadRules under workspace-write and drops
 *      them under danger-full-access;
 *   2. fs fence: readText/streamText/readBytes/editText/writeText-over-existing
 *      on a deny-rule target throw FS_READ_DENIED; reading a normal file and
 *      creating a NEW restricted-format file stay allowed; ask rules are NOT
 *      enforced at the fence;
 *   3. gate: tools/pre-execute returns deny for `read`/`read_image`/`edit` on
 *      a deny target, ask on an ask target, and delegates other tools and
 *      non-matching paths (the stock read-allowed behavior).
 *
 * Run from the package root:
 *   node test/verify-read-restriction.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import FsPlugin from '../lib/fs.mjs'

const WORKSPACE = 'D:/Work/OtherCode/dsh-sandbox-allowlist'
const scratch = mkdtempSync(join(WORKSPACE, '.sabx-noRead-verify-'))
const T = (name) => join(scratch, name)

// deny `*.pem` and every `.env*`; ask for `*.crt`; deny two directories under
// the scratch root (a double-star subtree rule and a literal-dir rule).
const settingsSection = {
  allowedDirs: [],
  commands: { default: 'delegate', rules: [] },
  noRead: [
    { pattern: '*.pem', action: 'deny' },
    { pattern: '.env*', action: 'deny' },
    { pattern: '*.crt', action: 'ask' },
    { pattern: join(scratch, 'vault', '**'), action: 'deny' },
    { pattern: join(scratch, 'bank'), action: 'deny' },
  ],
}

const ctx = new Context()
ctx.provide('systemPrompt', { context() {} })
ctx.provide('tools', {}) // activates the policy's tools/pre-execute gate registrations
ctx.provide('settings', {
  register(_ns, _schema, _options) {
    return { get: () => settingsSection, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})

const policyFiber = ctx.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: WORKSPACE })
await policyFiber
const fsFiber = ctx.plugin(FsPlugin, {})
await fsFiber

const target = (path) => ({ displayPath: path, targetKey: path })
const isFsReadDenied = (error) => error?.code === 'FS_READ_DENIED'

try {
  // ── 1. policy carries the compiled rules (except under danger-full-access) ──
  const policy = ctx.sandboxPolicy.resolve()
  assert.equal(policy.mode, 'workspace-write')
  assert.ok(Array.isArray(policy.noReadRules) && policy.noReadRules.length === 5,
    `resolve() attaches the compiled noRead rules, got ${JSON.stringify(policy.noReadRules)}`)
  const openPolicy = ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' })
  assert.equal(openPolicy.noReadRules, undefined, 'danger-full-access drops the read restriction')
  console.log('1. policy.noReadRules attached (workspace-write); dropped under danger-full-access')

  // ── fixtures ──
  writeFileSync(T('plain.txt'), 'plain text\n', 'utf8')
  writeFileSync(T('secret.pem'), '-----BEGIN PRIVATE KEY-----\nsecret\n', 'utf8')
  writeFileSync(T('cert.crt'), 'certificate data\n', 'utf8')
  writeFileSync(T('.env.local'), 'TOKEN=x\n', 'utf8')

  // ── 2. fs fence: deny rules hard-block every content read ──
  await assert.rejects(
    () => ctx.fs.readText(target(T('secret.pem'))),
    (error) => isFsReadDenied(error) && /noRead rule "\*\.pem"/u.test(error.message),
    'readText on a deny target throws FS_READ_DENIED naming the rule',
  )
  await assert.rejects(
    async () => { await ctx.fs.streamText(target(T('secret.pem'))) },
    (error) => isFsReadDenied(error),
    'streamText on a deny target throws FS_READ_DENIED',
  )
  await assert.rejects(
    () => ctx.fs.readBytes(target(T('secret.pem')), undefined, 1024),
    (error) => isFsReadDenied(error),
    'readBytes (read_image path) on a deny target throws FS_READ_DENIED',
  )
  await assert.rejects(
    () => ctx.fs.editText(target(T('secret.pem')), { oldString: 'secret', newString: 'x' }, undefined, undefined, policy),
    (error) => isFsReadDenied(error) && /cannot edit/u.test(error.message),
    'editText on a deny target is refused (edit returns the old content)',
  )
  await assert.rejects(
    () => ctx.fs.writeText(target(T('.env.local')), 'TOKEN=changed\n', undefined, undefined, policy),
    (error) => isFsReadDenied(error) && /overwriting requires reading/u.test(error.message),
    'writeText over an EXISTING deny target is refused (old content would be read back)',
  )
  console.log('2a. fence blocks reads/edits/overwrites of deny-rule targets (FS_READ_DENIED)')

  // deny rules do not touch allowed behavior: reading a normal file works
  assert.equal(await ctx.fs.readText(target(T('plain.txt'))), 'plain text\n', 'plain reads still pass')
  // creating a NEW restricted-format file stays allowed (only reading is
  // restricted). NOTE: this script runs inside the dsh sandbox, so the OS may
  // refuse the physical write (EACCES from the restricted token) even when the
  // fence allows it — only the fence verdict (no FS_READ_DENIED) is asserted.
  let created = false
  try {
    await ctx.fs.writeText(target(T('fresh.pem')), 'new pem content\n', undefined, undefined, policy)
    created = existsSync(T('fresh.pem'))
  } catch (error) {
    assert.notEqual(error?.code, 'FS_READ_DENIED', 'creating a new restricted-format file passes the fence')
  }
  if (created) {
    await assert.rejects(
      () => ctx.fs.readText(target(T('fresh.pem'))),
      (error) => isFsReadDenied(error),
      'the freshly created restricted file is not readable',
    )
  }
  // ask rules are NOT enforced at the fence (approval lives at the gate)
  assert.equal(await ctx.fs.readText(target(T('cert.crt'))), 'certificate data\n', 'ask-rule reads are not hard-blocked by the fence')
  console.log('2b. plain reads / new restricted-format creation / ask-rule reads pass the fence')

  // ── 2c. directory-level deny rules: whole subtree + listings refused ──
  mkdirSync(T('vault'), { recursive: true })
  mkdirSync(T('bank'), { recursive: true })
  writeFileSync(join(T('vault'), 'inner.txt'), 'vault secret\n', 'utf8')
  writeFileSync(join(T('bank'), 'ledger.txt'), 'bank data\n', 'utf8')

  await assert.rejects(
    () => ctx.fs.readText(target(join(T('vault'), 'inner.txt'))),
    (error) => isFsReadDenied(error) && /cannot read/u.test(error.message),
    'reading a file under a double-star denied directory is refused',
  )
  await assert.rejects(
    () => ctx.fs.listDir(target(T('vault'))),
    (error) => isFsReadDenied(error) && /cannot list/u.test(error.message),
    'listing a double-star denied directory is refused',
  )
  await assert.rejects(
    () => ctx.fs.readText(target(join(T('bank'), 'ledger.txt'))),
    (error) => isFsReadDenied(error),
    'reading a file under a literal-dir denied directory is refused',
  )
  await assert.rejects(
    () => ctx.fs.listDir(target(T('bank'))),
    (error) => isFsReadDenied(error),
    'listing a literal-dir denied directory is refused',
  )
  const scratchEntries = await ctx.fs.listDir(target(scratch))
  assert.ok(Array.isArray(scratchEntries), 'listing a non-denied directory still works')
  console.log('2c. directory-level deny rules block subtree reads and listings')

  // ── 3. pre-execute gate: deny / ask / delegate decisions ──
  async function dispatch(exec) {
    return ctx.waterfall(ctx, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  }
  const call = (name, filePath) => dispatch({ name, arguments: { file_path: filePath } })

  let decision = await call('read', 'D:/x/secret.pem')
  assert.equal(decision.kind, 'deny', 'read on a deny target is denied')
  assert.match(decision.reason, /noRead rule "\*\.pem"/u)

  decision = await call('read_image', join(scratch, 'nested', '..', 'secret.pem'))
  assert.equal(decision.kind, 'deny', 'read_image with a nested path is denied by basename match')

  decision = await call('edit', 'app/.env.local')
  assert.equal(decision.kind, 'deny', 'edit on a deny target is denied')

  decision = await call('read', 'a/b/cert.crt')
  assert.equal(decision.kind, 'ask', 'read on an ask target requests approval')
  assert.match(decision.reason, /approve this call to read it once/u)

  decision = await call('read', 'notes.txt')
  assert.deepEqual(decision, { kind: 'allow' }, 'non-matching paths delegate to the default (allow = stock)')

  decision = await call('write', 'D:/x/secret.pem')
  assert.deepEqual(decision, { kind: 'allow' }, 'write is not gate-restricted (new files allowed; overwrite lives at the fence)')

  decision = await call('bash', 'ignored')
  assert.deepEqual(decision, { kind: 'allow' }, 'non-file tools are never gated')
  console.log('3. gate decisions: deny / ask / delegate as configured')

  console.log('verify-read-restriction: all checks passed')
} finally {
  try { await policyFiber.dispose() } catch { /* best effort */ }
  try { await fsFiber.dispose() } catch { /* best effort */ }
  rmSync(scratch, { recursive: true, force: true })
}
