/**
 * Dry-mount: instantiate the policy + fs plugins inside a scratch cordis
 * context — the same mounting the loader performs — and exercise the real
 * behavior end-to-end:
 *   1. resolve() carries extraRoots for the configured pattern;
 *   2. on Windows this also MATERIALIZES the workspace write-SID ACE on the
 *      trusted root (standing — reused by the real deployment later);
 *   2b. on Windows a runtime allowlist addition (volatile in-place save) is
 *       persisted to grants.json by the SAME resolve() as a v2 record with
 *       status/grantedAt — the manifest never lags the OS state (regression:
 *       grants-manifest lag);
 *   3. the fs fence allows a write under the trusted root and denies one
 *      outside it;
 *   4. (win32) v2 manifest accounting suite, each with a throwaway context:
 *      4a. a legacy v1 manifest (bare string list) migrates in memory and is
 *          written back as v2 by the first reconcile, fromPatterns backfilled;
 *      4b. exclusion → strip → history(origin=excluded) → still no
 *          re-materialization while excluded → restore consumes the history
 *          record and re-materializes with a fresh grantedAt;
 *      4c. a failed revocation lands in pendingRevoke (attempts increment on
 *          retry) → success moves it to history; a revocation whose target
 *          dir went missing is a plain accounting drop (no history);
 *      4d. — covered by the pure-function suite in test.mjs (history FIFO cap,
 *          diff exclusion rules); nothing extra to mount here.
 *      4e. exclusion gates BOTH enforcement layers: a panel-revoked root
 *          leaves resolve().extraRoots (the built-in write/edit fence) and
 *          the command gate scope immediately, restore puts it back, and the
 *          `_patternRoots()` audit mirror never loses it (the panel's
 *          restore depends on the unfiltered view).
 *
 * Run from this directory:
 *   node dry-mount.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import FsPlugin from '../lib/fs.mjs'
import { createApiHandler } from '../lib/state-routes.mjs'

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
// A second trusted root for the runtime-grant persistence regression check
// (section 2b): it joins the allowlist only AFTER the first resolve, the way
// a settings save mutates the volatile array in place.
const TRUSTED2 = mktemp('dsh-drymount-trust2-')

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
  // expandRoots() TTL-caches its snapshot; zero makes every resolve() re-expand,
  // so the section-2b in-place allowlist change is visible immediately.
  expandTtlMs: 0,
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

  // 2b. Runtime-grant persistence: a volatile in-place allowlist change (the
  //     shape a settings save produces) must reach grants.json on the NEXT
  //     resolve(), not only on the one-shot startup reconcile of a future
  //     instance — and v2 records carry status/grantedAt (授权清单 v2 记账).
  //     Manifest writing is win32-only (acl === null returns early on other
  //     platforms), so the regression check lives here too.
  const manifestFile = join(process.env.DSH_HOME, 'sandbox-allowlist-grants.json')
  const readManifest = () => JSON.parse(readFileSync(manifestFile, 'utf8'))
  // Precondition: the startup reconcile already recorded the first root under
  // the workspace key (that path predates the fix).
  const firstRecord = readManifest().workspaces[WORKSPACE]
  assert.ok(firstRecord, 'startup manifest records the workspace')
  assert.equal(firstRecord.roots.some((entry) => entry.path.toLowerCase() === TRUSTED.toLowerCase()), true,
    `startup manifest records the first trusted root, got ${JSON.stringify(firstRecord.roots)}`)
  const firstEntry = firstRecord.roots.find((entry) => entry.path.toLowerCase() === TRUSTED.toLowerCase())
  assert.equal(firstEntry.status, 'granted', 'v2 record: materialized root is granted')
  assert.ok(typeof firstEntry.grantedAt === 'string' && firstEntry.grantedAt.length > 0, 'v2 record carries grantedAt')
  // The save: add a second root at runtime, then let any consumer resolve().
  // The schema wraps volatile values in a cosmokit Volatile: a frozen snapshot
  // behind `get()`, replaced wholesale by the owning runtime through the
  // `cosmokit.volatile.write` symbol — replicate that protocol exactly (a
  // plain-array shape falls back to a direct push).
  if (!existsSync(TRUSTED2)) mkdirSync(TRUSTED2, { recursive: true })
  const raw = ctx.sandboxPolicy.patterns
  const WRITE = Symbol.for('cosmokit.volatile.write')
  if (raw !== null && typeof raw === 'object' && WRITE in raw) {
    raw[WRITE](Object.freeze([...raw.get(), TRUSTED2]))
  } else {
    raw.push(TRUSTED2)
  }
  const policy2 = ctx.sandboxPolicy.resolve()
  assert.ok(
    policy2.extraRoots.some((root) => root.toLowerCase() === TRUSTED2.toLowerCase()),
    'the second root resolves immediately (TTL cache disabled)',
  )
  // THE REGRESSION: the manifest must already list it — no restart, no reload.
  const secondRecord = readManifest().workspaces[WORKSPACE]
  const secondEntry = secondRecord.roots.find((entry) => entry.path.toLowerCase() === TRUSTED2.toLowerCase())
  assert.ok(secondEntry, `grants.json must persist a runtime grant immediately, got ${JSON.stringify(secondRecord.roots)}`)
  assert.equal(secondEntry.status, 'granted')
  assert.ok(typeof secondEntry.grantedAt === 'string', 'runtime grant record carries grantedAt')
  console.log(`runtime grant persisted immediately: ${JSON.stringify(secondRecord.roots.map((entry) => entry.path))}`)
  // Let the fire-and-forget startup reconcile settle before the fence checks.
  await ctx.sandboxPolicy._reconcileTail
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

// 4. v2 manifest accounting suite (win32: materialization is win32-only).
//    Fresh throwaway contexts per scenario; the PowerShell-backed strip is
//    FAKED through the policy's `_revokeAces` seam — the unit here is the
//    manifest accounting, not the primitive (verify-ace --roundtrip and the
//    startup reconcile above cover the real one).
if (process.platform === 'win32') {
  const mountFreshPolicy = async ({ workspaceRoot, allowedDirs, home }) => {
    process.env.DSH_HOME = home
    created.push(home)
    const fresh = new Context()
    fresh.provide('sessionProjections', { register() {}, stateOf: () => undefined })
    fresh.provide('systemPrompt', { context() { return () => {} } })
    fresh.provide('fileUploads', { registerAgentResolver() {} })
    const fiber = fresh.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot, allowedDirs, expandTtlMs: 0 })
    await fiber
    return { policy: fresh.sandboxPolicy, fiber }
  }
  const fakeStripOk = async (roots) => ({ ok: true, dirs: roots.length, stripped: roots.length, missing: [], failed: [] })

  // 4a. v1 → v2 self-heal: a legacy bare-list manifest migrates in memory on
  //     load and is written back as v2 by the first mount+resolve, with the
  //     first reconcile backfilling fromPatterns from the live expansion.
  {
    const homeA = mktemp('dsh-drymount-home-a-')
    const wsA = mktemp('dsh-drymount-ws-a-')
    const rootA = mktemp('dsh-drymount-root-a-')
    writeFileSync(join(homeA, 'sandbox-allowlist-grants.json'), JSON.stringify({ workspaces: { [wsA]: [rootA] } }), 'utf8')
    const mountA = await mountFreshPolicy({ workspaceRoot: wsA, allowedDirs: [rootA], home: homeA })
    mountA.policy.resolve()
    await mountA.policy._reconcileTail
    const fileA = JSON.parse(readFileSync(join(homeA, 'sandbox-allowlist-grants.json'), 'utf8'))
    assert.equal(fileA.version, 2, 'manifest written back as v2')
    const recA = fileA.workspaces[wsA]
    assert.ok(recA, 'workspace record survived the migration')
    const entryA = recA.roots.find((entry) => entry.path.toLowerCase() === rootA.toLowerCase())
    assert.ok(entryA && entryA.status === 'granted', 'legacy root carried over as a granted record')
    assert.deepEqual(entryA.fromPatterns, [rootA], 'first reconcile backfills fromPatterns')
    console.log('4a. v1 manifest migrated to v2 on first reconcile')
    await mountA.fiber.dispose()
  }

  // 4b. 排除 → 撤销（剥离成功）→ 入史 → 排除期间不重新物化 → 恢复 → 新 grantedAt
  {
    const homeB = mktemp('dsh-drymount-home-b-')
    const wsB = mktemp('dsh-drymount-ws-b-')
    const rootB = mktemp('dsh-drymount-root-b-')
    const mountB = await mountFreshPolicy({ workspaceRoot: wsB, allowedDirs: [`${rootB}\\**`], home: homeB })
    mountB.policy.resolve()
    await mountB.policy._reconcileTail // settle the startup reconcile before driving exclusion
    const manifestFileB = join(homeB, 'sandbox-allowlist-grants.json')
    const readRecordB = () => JSON.parse(readFileSync(manifestFileB, 'utf8')).workspaces[wsB]
    const entryB0 = readRecordB().roots.find((entry) => entry.path.toLowerCase() === rootB.toLowerCase())
    assert.ok(entryB0?.status === 'granted' && typeof entryB0?.grantedAt === 'string', '4b precondition: granted with grantedAt')
    mountB.policy._revokeAces = fakeStripOk
    const excluded = mountB.policy.setRootExcluded(wsB, rootB, true)
    assert.ok(excluded.ok, 'excluding a recorded root succeeds')
    await excluded.done
    let recB = readRecordB()
    assert.equal(recB.roots.length, 0, 'excluded root leaves roots[] after the strip')
    assert.equal(recB.history.length, 1, 'completed exclusion lands in history')
    assert.equal(recB.history[0].origin, 'excluded')
    assert.ok(recB.history[0].path.toLowerCase() === rootB.toLowerCase() && typeof recB.history[0].revokedAt === 'string')
    // Still excluded (pattern keeps covering the path): a fresh resolve must
    // NOT re-materialize — history(origin=excluded) is exclusion membership.
    mountB.policy.resolve()
    recB = readRecordB()
    assert.equal(
      recB.roots.filter((entry) => entry.path.toLowerCase() === rootB.toLowerCase()).length, 0,
      'exclusion survives re-resolves while the pattern still covers the root',
    )
    // restore → the history record is consumed and the root re-materializes.
    const restored = mountB.policy.setRootExcluded(wsB, rootB, false)
    assert.ok(restored.ok)
    await restored.done
    recB = readRecordB()
    const entryB1 = recB.roots.find((entry) => entry.path.toLowerCase() === rootB.toLowerCase())
    assert.ok(entryB1?.status === 'granted' && typeof entryB1?.grantedAt === 'string', 'restore re-materializes the root')
    assert.ok(new Date(entryB1.grantedAt) >= new Date(entryB0.grantedAt), 'restored root carries a fresh grantedAt')
    assert.equal(recB.history.length, 0, 'restore consumes the exclusion record')
    console.log('4b. exclusion → history → restore cycle holds')
    await mountB.fiber.dispose()
  }

  // 4c. 撤销失败进 pendingRevoke（重试自增 attempts）→ 成功转 history；missing 直接剔除
  {
    const homeC = mktemp('dsh-drymount-home-c-')
    const wsC = mktemp('dsh-drymount-ws-c-')
    const rootC = mktemp('dsh-drymount-root-c-')
    const mountC = await mountFreshPolicy({ workspaceRoot: wsC, allowedDirs: [`${rootC}\\**`], home: homeC })
    mountC.policy.resolve()
    await mountC.policy._reconcileTail // settle the startup reconcile before driving exclusion
    const manifestFileC = join(homeC, 'sandbox-allowlist-grants.json')
    const readRecordC = () => JSON.parse(readFileSync(manifestFileC, 'utf8')).workspaces[wsC]
    mountC.policy._revokeAces = async (roots) => ({
      ok: false, dirs: roots.length, stripped: 0, missing: [],
      failed: roots.map((path) => ({ path, error: 'simulated: no PowerShell host' })),
    })
    const failedRevoke = mountC.policy.setRootExcluded(wsC, rootC, true)
    assert.ok(failedRevoke.ok)
    await failedRevoke.done
    let recC = readRecordC()
    assert.equal(recC.roots.length, 0, 'failed revocation leaves roots[]')
    assert.equal(recC.pendingRevoke.length, 1, 'failed revocation lands in pendingRevoke')
    assert.equal(recC.pendingRevoke[0].origin, 'excluded')
    assert.equal(recC.pendingRevoke[0].attempts, 1)
    assert.ok(String(recC.pendingRevoke[0].error).includes('simulated'))
    await mountC.policy._reconcile(wsC) // the next reconcile retries — still failing
    recC = readRecordC()
    assert.equal(recC.pendingRevoke[0].attempts, 2, 'retry increments attempts')
    mountC.policy._revokeAces = fakeStripOk // the strip starts succeeding
    await mountC.policy._reconcile(wsC)
    recC = readRecordC()
    assert.equal(recC.pendingRevoke.length, 0, 'retry success clears pendingRevoke')
    assert.equal(recC.history.length, 1)
    assert.equal(recC.history[0].origin, 'excluded')
    // restore, then a revocation whose target dir went missing: plain drop
    const restoreC = mountC.policy.setRootExcluded(wsC, rootC, false)
    assert.ok(restoreC.ok)
    await restoreC.done
    mountC.policy._revokeAces = async (roots) => ({ ok: true, dirs: roots.length, stripped: 0, missing: [...roots], failed: [] })
    const missingRevoke = mountC.policy.setRootExcluded(wsC, rootC, true)
    assert.ok(missingRevoke.ok)
    await missingRevoke.done
    recC = readRecordC()
    assert.ok(
      recC === undefined || (recC.roots.length === 0 && recC.pendingRevoke.length === 0 && recC.history.length === 0),
      'missing dir is dropped from accounting (empty record → workspace key gone)',
    )
    console.log('4c. pendingRevoke retry loop and missing-drop hold')
    await mountC.fiber.dispose()
  }

  // 4e. 排除状态必须同时挡住两条强制层——修复回归：面板撤销只影响 ACL 层
  //     （_ensureGrants 跳过排除根），内置 write/edit 经 resolve().extraRoots
  //     仍可任意写入。核心断言：排除中的根不得出现在 extraRoots（栅栏层）
  //     与 _commandContext().roots（命令门 scope），恢复后两条路径同时放回；
  //     全程 _patternRoots()（UI 审计镜像）始终覆盖该根——面板的「恢复」
  //     按钮依赖这份不被过滤的全集。
  {
    const homeE = mktemp('dsh-drymount-home-e-')
    const wsE = mktemp('dsh-drymount-ws-e-')
    const rootE = mktemp('dsh-drymount-root-e-')
    const mountE = await mountFreshPolicy({ workspaceRoot: wsE, allowedDirs: [`${rootE}\\**`], home: homeE })
    const policyE = mountE.policy
    const hasExtraRoot = (resolved) => Array.isArray(resolved.extraRoots)
      && resolved.extraRoots.some((root) => root.toLowerCase() === rootE.toLowerCase())
    const commandScopeHas = () => policyE._commandContext().roots
      .some((root) => root.toLowerCase() === rootE.toLowerCase())
    const patternMirrors = () => policyE._patternRoots()
      .some(({ roots }) => roots.some((root) => root.toLowerCase() === rootE.toLowerCase()))

    // 覆盖中：extraRoots 与命令门 scope 都含该根。
    const covered = policyE.resolve()
    await policyE._reconcileTail // settle the startup reconcile before driving exclusion
    assert.ok(hasExtraRoot(covered), '4e precondition: covered root resolves into extraRoots')
    assert.ok(commandScopeHas(), '4e precondition: command gate scope includes the covered root')
    assert.ok(patternMirrors(), '4e precondition: _patternRoots mirrors the root for the UI')

    // 撤销（不重启、立即再解析）：extraRoots 不再含它 → 栅栏回落 stock 路径；
    // 唯一根被排除后 extraRoots 整个不设置，命令门 scope 同步收窄；UI 镜像不丢。
    const excluded = policyE.setRootExcluded(wsE, rootE, true)
    assert.ok(excluded.ok)
    await excluded.done
    const revoked = policyE.resolve()
    assert.equal(hasExtraRoot(revoked), false, 'excluded root must NOT resolve into extraRoots (fence layer)')
    assert.equal(revoked.extraRoots, undefined, 'the only excluded root leaves extraRoots unset (stock fence path)')
    assert.equal(commandScopeHas(), false, 'excluded root leaves the command gate scope')
    assert.ok(patternMirrors(), 'excluded root stays visible to the UI audit mirror')

    // 恢复：两条强制层同时放回。
    const restored = policyE.setRootExcluded(wsE, rootE, false)
    assert.ok(restored.ok)
    await restored.done
    const recovered = policyE.resolve()
    assert.ok(hasExtraRoot(recovered), 'restore puts the root back into extraRoots')
    assert.ok(commandScopeHas(), 'restore puts the root back into the command gate scope')
    assert.ok(patternMirrors(), 'UI audit mirror still covers the root after restore')
    console.log('4e. exclusion gates extraRoots and the command gate scope; the UI mirror stays complete')
    await mountE.fiber.dispose()
  }

  // 5. state-routes 契约（会话区授权面板的 host 半件，自建路由 + 统一信封）：
  //    注入捕获型 fake webServer 验证注册形状，并直驱 createApiHandler 验证
  //    视图 JSON、payload 校验、错误信封与 revoke/restore/grant 全链路——
  //    剥离用真实 PowerShell 原语（未打桩），即排除撤销的真实 DACL 回收验证。
  {
    const homeD = mktemp('dsh-drymount-home-d-')
    const wsD = mktemp('dsh-drymount-ws-d-')
    const rootD = mktemp('dsh-drymount-root-d-')
    process.env.DSH_HOME = homeD
    created.push(homeD)
    const fresh = new Context()
    fresh.provide('sessionProjections', { register() {}, stateOf: () => undefined })
    fresh.provide('systemPrompt', { context() { return () => {} } })
    fresh.provide('fileUploads', { registerAgentResolver() {} })
    const captured = { route: null }
    fresh.provide('webServer', {
      register(spec) { captured.route = spec; return () => {} },
    })
    const fiberD = fresh.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: wsD, allowedDirs: [`${rootD}\\**`], expandTtlMs: 0 })
    await fiberD
    const policyD = fresh.sandboxPolicy
    policyD.resolve()
    await policyD._reconcileTail
    await new Promise((resolve) => setTimeout(resolve, 20)) // webServer 注册走 ctx.inject，等回调落地
    assert.ok(captured.route, 'state route registered on webServer')
    assert.equal(captured.route.kind, 'prefix')
    assert.equal(captured.route.path, '/sandbox-allowlist/api')
    assert.equal(typeof captured.route.handler, 'function')
    const api = createApiHandler(policyD)

    // READ：视图镜像已授权记录（含 grantedAt）；sessionCwd 命中时 current 解析到该工作区
    const readEnvelope = await api('state', { sessionCwd: wsD })
    assert.equal(readEnvelope.ok, true, 'state read returns an ok envelope')
    const view = readEnvelope.value
    assert.equal(view.supported, true, 'view carries the platform flag')
    assert.equal(view.current, wsD, 'sessionCwd match resolves current to that workspace')
    assert.ok(view.workspaces && view.workspaces[wsD], 'view slices per workspace')
    const sliceD = view.workspaces[wsD]
    const viewRoot = (sliceD.roots || []).find((entry) => entry.path.toLowerCase() === rootD.toLowerCase())
    assert.ok(viewRoot && viewRoot.status === 'granted' && typeof viewRoot.grantedAt === 'string', 'view carries the granted record')
    assert.deepEqual(viewRoot.fromPatterns, [`${rootD}\\**`], 'view merges live pattern coverage into fromPatterns')

    // WRITE：payload 校验与错误信封
    const foreign = await api('revoke', { path: join(rootD, 'not-recorded') })
    assert.equal(foreign.ok, false, 'a path outside the manifest is rejected')
    assert.ok(foreign.error && foreign.error.code === 'unknown-path', `error envelope carries a code, got ${JSON.stringify(foreign.error)}`)
    const badMethod = await api('drop table', { path: rootD })
    assert.equal(badMethod.ok, false, 'the method charset is enforced')

    // revoke（真实剥离）→ roots 清空、history origin=excluded；restore → 重新物化
    const revoked = await api('revoke', { path: rootD, workspace: wsD })
    assert.equal(revoked.ok, true, `revoke via api succeeds, got ${JSON.stringify(revoked)}`)
    assert.equal(revoked.value.workspaces[wsD].roots.length, 0, 'the revoked record left roots[]')
    assert.equal(revoked.value.workspaces[wsD].history.length, 1, 'the completed revocation is in history')
    assert.equal(revoked.value.workspaces[wsD].history[0].origin, 'excluded')
    const restored = await api('restore', { path: rootD, workspace: wsD })
    assert.equal(restored.ok, true, 'restore via api succeeds')
    const restoredRoot = (restored.value.workspaces[wsD].roots || []).find((entry) => entry.path.toLowerCase() === rootD.toLowerCase())
    assert.ok(restoredRoot && restoredRoot.status === 'granted' && typeof restoredRoot.grantedAt === 'string', 'restore re-materializes with a fresh grantedAt')
    // 手动重试授权（失败行的「重试授权」）：覆盖路径上强制重物化并回读状态
    const grantRetry = await api('grant', { path: rootD, workspace: wsD })
    assert.equal(grantRetry.ok, true, `grant retry via api succeeds, got ${JSON.stringify(grantRetry)}`)
    const retriedRoot = (grantRetry.value.workspaces[wsD].roots || []).find((entry) => entry.path.toLowerCase() === rootD.toLowerCase())
    assert.ok(retriedRoot && retriedRoot.status === 'granted', 'grant retry reads back a granted record')
    // 未知工作区被拒绝
    const unknownWs = await api('revoke', { path: rootD, workspace: String.raw`W:\elsewhere` })
    assert.equal(unknownWs.ok, false, 'an unknown workspace is rejected')
    assert.equal(unknownWs.error.code, 'unknown-workspace')
    console.log('5. state-routes contract (view JSON + api revoke/restore/grant with the real strip) holds')
    await fiberD.dispose()
  }
  process.env.DSH_HOME = join(tmpdir(), 'dsh-drymount-home-exited-')
}

await policyFiber.dispose()
await fsFiber.dispose()
try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
for (const dir of created) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
console.log('dry-mount: all checks passed')
