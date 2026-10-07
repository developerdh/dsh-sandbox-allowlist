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
 *      4f. a v1 manifest with one still-covered and one no-longer-covered
 *          path: the covered path gets grantedAt backfilled, the uncovered
 *          path goes through the REAL strip primitive into
 *          history(origin=config-removed);
 *      4g. a corrupt manifest self-heals into a valid v2 view on the first
 *          reconcile, with no ghost records;
 *      4h. fake-account correction: an out-of-band ACE strip (real primitive)
 *          makes the book lie — the panel revoke is an idempotent success and
 *          restore re-materializes with a fresh grantedAt;
 *      4i. a failing grant (seam fixture — see the scenario comment for why
 *          the real-ACL fixture is not deterministic unattended) records
 *          status=failed, and the panel's retry-grant flips it to granted
 *          with the accounting cleaned up;
 *      4j. workspace resolution priority: explicit workspace > sessionCwd
 *          hit > instance root; an unknown workspace is refused.
 *
 * Run from this directory:
 *   node dry-mount.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import FsPlugin from '../lib/fs.mjs'
import { applyStateRoutes, createApiHandler } from '../lib/state-routes.mjs'

// Machine-specific roots default to throwaway temp dirs so no real path is
// committed or required; point DSH_TEST_WORKSPACE / DSH_TEST_TRUSTED at real
// directories to probe an actual deployment layout.
const created = []
// 启动时清扫陈旧夹具：退出钩子是 best-effort，Windows 上偶发的 rmSync 失败会
// 每轮留下 1~2 个夹具目录（历史观察）。只扫超过 24h 的同名前缀目录——阈值远
// 大于任何一轮运行时长，并行运行中的新鲜目录不受影响；清扫失败不影响本次测试。
{
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const prefixes = ['dsh-drymount-', 'dsh-allowlist-', 'dsh-grants-', 'dsh-revoke-tree-', 'dsh-scan-sid-', 'dsh-verify-ace-']
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue
      try {
        const full = join(tmpdir(), name)
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
      } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}
// 兜底回收：断言中断时尾部清理不会执行，退出钩子重放同一套 best-effort 清理
//（fiber 随进程消亡；文件与目录是主要残留物）。
process.on('exit', () => {
  try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
  for (const dir of created) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
})
// Policy output (extraRoots, manifest entries, panel views) carries the host's
// canonicalPath() spelling (realpathSync.native with as-is fallback), while
// tmpdir() on GitHub runners yields the Windows 8.3 short form
// (C:\Users\RUNNER~1\...) — raw fixture spellings never equal policy output
// off a dev machine. Fixtures go through the same canonicalization.
const canon = (p) => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}
const mktemp = (prefix) => {
  const dir = canon(mkdtempSync(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}
const WORKSPACE = process.env.DSH_TEST_WORKSPACE ? canon(process.env.DSH_TEST_WORKSPACE) : mktemp('dsh-drymount-ws-')
const TRUSTED = process.env.DSH_TEST_TRUSTED ? canon(process.env.DSH_TEST_TRUSTED) : mktemp('dsh-drymount-trust-')
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
  `extraRoots contains the trusted root ${TRUSTED}, got ${JSON.stringify(policy.extraRoots)}`,
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

// 3b. 非 win32 平台门（L3-03）：状态路由完全不注册——路由不在，客户端就没有
//     入口信号（「Windows 才有入口」契约的 host 半边）。win32 机器上此块按
//     条件跳过（不得删除，保证跨平台机器上套件仍验证该契约）；win32 的正向
//     注册形状断言在第 5 节。
if (process.platform !== 'win32') {
  const freshL = new Context()
  freshL.provide('sessionProjections', { register() {}, stateOf: () => undefined })
  freshL.provide('systemPrompt', { context() { return () => {} } })
  freshL.provide('fileUploads', { registerAgentResolver() {} })
  const capturedL = { route: null }
  freshL.provide('webServer', { register(spec) { capturedL.route = spec; return () => {} } })
  const fiberL = freshL.plugin(PolicyPlugin, {
    mode: 'workspace-write', workspaceRoot: mktemp('dsh-drymount-ws-l-'), allowedDirs: [], expandTtlMs: 0,
  })
  await fiberL
  await new Promise((resolve) => setTimeout(resolve, 20)) // ctx.inject 回调窗口（此平台不会来）
  assert.equal(capturedL.route, null, 'a non-win32 host registers no state route (no client entry signal)')
  await fiberL.dispose()
  console.log('3b. non-win32: state routes correctly absent')
}

// 3c. L3-03 补充：平台门在任何平台都可真实执行——本块临时伪装 platform 跑一次
//     applyStateRoutes 后同步还原（同步代码 + finally 还原，不影响前后任何断言）。
//     win32 机器上 3b 按条件跳过，本块保证「非 win32 不注册」契约不再只是跳过态。
{
  const realPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    let injectCalled = false
    applyStateRoutes({ inject() { injectCalled = true } }, { _warn() {} })
    assert.equal(injectCalled, false, 'a non-win32 platform never reaches route registration')
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform })
  }
  console.log('3c. state-route platform gate holds (temporary platform fake)')
}

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

  // 4f. L2-01: v1 迁移条目 grantedAt 补记 + 配置已不含路径的真实剥离入史。
  //     4a 只断言迁回 v2 + fromPatterns 回填且仅一条仍覆盖路径；本场景补双侧。
  //     ACE 侧说明：v1 夹具从未物化过 ACE，未覆盖路径走的是真实剥离原语（未打
  //     桩，目录存在但无命中 ACE → 幂等成功），记账侧即其可观测效果。
  {
    const homeF = mktemp('dsh-drymount-home-f-')
    const wsF = mktemp('dsh-drymount-ws-f-')
    const coveredF = mktemp('dsh-drymount-root-fc-')
    const goneF = mktemp('dsh-drymount-root-fg-')
    writeFileSync(join(homeF, 'sandbox-allowlist-grants.json'), JSON.stringify({ workspaces: { [wsF]: [coveredF, goneF] } }), 'utf8')
    const mountF = await mountFreshPolicy({ workspaceRoot: wsF, allowedDirs: [coveredF], home: homeF })
    mountF.policy.resolve()
    await mountF.policy._reconcileTail
    const fileF = JSON.parse(readFileSync(join(homeF, 'sandbox-allowlist-grants.json'), 'utf8'))
    assert.equal(fileF.version, 2, '4f: manifest written back as v2')
    const recF = fileF.workspaces[wsF]
    const coveredEntryF = recF.roots.find((entry) => entry.path.toLowerCase() === coveredF.toLowerCase())
    assert.ok(coveredEntryF && coveredEntryF.status === 'granted', '4f: covered path stays a granted root record')
    assert.ok(typeof coveredEntryF.grantedAt === 'string' && !Number.isNaN(new Date(coveredEntryF.grantedAt).getTime()),
      '4f: grantedAt backfilled from null on the first v2 reconcile')
    assert.equal(recF.roots.some((entry) => entry.path.toLowerCase() === goneF.toLowerCase()), false, '4f: the uncovered path left roots[]')
    const historyF = recF.history.find((entry) => entry.path.toLowerCase() === goneF.toLowerCase())
    assert.ok(historyF, '4f: the uncovered path is audited in history')
    assert.equal(historyF.origin, 'config-removed', '4f: the real strip is accounted as config-removed')
    console.log('4f. v1 grantedAt backfilled; uncovered path stripped to history(config-removed)')
    await mountF.fiber.dispose()
  }

  // 4g. L2-02: 损坏清单自愈——非法 JSON → 首次对账重建合法 v2 视图，无幽灵记录。
  {
    const homeG = mktemp('dsh-drymount-home-g-')
    const wsG = mktemp('dsh-drymount-ws-g-')
    const rootG = mktemp('dsh-drymount-root-g-')
    writeFileSync(join(homeG, 'sandbox-allowlist-grants.json'), '{oops', 'utf8')
    const mountG = await mountFreshPolicy({ workspaceRoot: wsG, allowedDirs: [`${rootG}\\**`], home: homeG })
    mountG.policy.resolve()
    await mountG.policy._reconcileTail
    const fileG = JSON.parse(readFileSync(join(homeG, 'sandbox-allowlist-grants.json'), 'utf8'))
    assert.equal(fileG.version, 2, '4g: the corrupt manifest is rewritten as a valid v2 document')
    const recG = fileG.workspaces[wsG]
    assert.ok(recG, '4g: the workspace record is rebuilt')
    const entryG = recG.roots.find((entry) => entry.path.toLowerCase() === rootG.toLowerCase())
    assert.ok(entryG && entryG.status === 'granted' && typeof entryG.grantedAt === 'string',
      '4g: the covered directory is re-recorded as granted with grantedAt')
    // fromPatterns 的契约面在视图层：collectViews 每次读取都合并实时 pattern 覆盖
    //（文件层仅随其他脏标记落盘，见 4a 的 v1 迁移路径）——按「视图重建」断言。
    const viewG = await createApiHandler(mountG.policy)('state', {})
    assert.equal(viewG.ok, true)
    const viewEntryG = viewG.value.workspaces[wsG].roots.find((entry) => entry.path.toLowerCase() === rootG.toLowerCase())
    assert.ok(viewEntryG, '4g: the rebuilt root is visible in the view')
    assert.deepEqual(viewEntryG.fromPatterns, [`${rootG}\\**`], '4g: the view merges live pattern coverage into fromPatterns')
    assert.deepEqual(recG.pendingRevoke, [], '4g: no ghost pendingRevoke after the rebuild')
    assert.deepEqual(recG.history, [], '4g: no ghost history after the rebuild')
    console.log('4g. corrupt manifest self-heals into a valid v2 view')
    await mountG.fiber.dispose()
  }

  // 4h. L2-03: 假账纠正——账面 granted、磁盘无 ACE（真实剥离原语制造）→ 面板
  //     revoke 对无 ACE 目录幂等成功 → restore 重物化出新 grantedAt。
  {
    const homeH = mktemp('dsh-drymount-home-h-')
    const wsH = mktemp('dsh-drymount-ws-h-')
    const rootH = mktemp('dsh-drymount-root-h-')
    const mountH = await mountFreshPolicy({ workspaceRoot: wsH, allowedDirs: [`${rootH}\\**`], home: homeH })
    mountH.policy.resolve()
    await mountH.policy._reconcileTail
    const manifestFileH = join(homeH, 'sandbox-allowlist-grants.json')
    const readRecordH = () => JSON.parse(readFileSync(manifestFileH, 'utf8')).workspaces[wsH]
    const grantedAtH0 = readRecordH().roots.find((entry) => entry.path.toLowerCase() === rootH.toLowerCase()).grantedAt
    const sidH = readRecordH().sid
    assert.ok(typeof sidH === 'string' && sidH.startsWith('S-1-4-'), '4h precondition: the workspace SID is recorded')
    // 制造假账：真实剥离原语把 ACE 拿掉（账面仍 granted）
    const outOfBand = await mountH.policy._revokeAces([rootH], sidH)
    assert.ok(outOfBand.ok, `4h precondition: the out-of-band strip succeeds, got ${JSON.stringify(outOfBand)}`)
    const apiH = createApiHandler(mountH.policy)
    const revokedH = await apiH('revoke', { path: rootH, workspace: wsH })
    assert.equal(revokedH.ok, true, `4h: revoke over an ACE-less dir is an idempotent success, got ${JSON.stringify(revokedH)}`)
    assert.ok(revokedH.value.workspaces[wsH].history.some((entry) => entry.path.toLowerCase() === rootH.toLowerCase() && entry.origin === 'excluded'),
      '4h: the completed revocation is audited as excluded')
    const restoredH = await apiH('restore', { path: rootH, workspace: wsH })
    assert.equal(restoredH.ok, true, `4h: restore succeeds, got ${JSON.stringify(restoredH)}`)
    const restoredEntryH = restoredH.value.workspaces[wsH].roots.find((entry) => entry.path.toLowerCase() === rootH.toLowerCase())
    assert.ok(restoredEntryH && restoredEntryH.status === 'granted' && typeof restoredEntryH.grantedAt === 'string',
      '4h: restore re-materializes the root as granted')
    assert.ok(new Date(restoredEntryH.grantedAt) >= new Date(grantedAtH0), '4h: the restored root carries a fresh grantedAt')
    console.log('4h. fake-account correction: idempotent revoke + restore with a fresh grantedAt')
    await mountH.fiber.dispose()
  }

  // 4i. L2-04: failed 行「重试授权」——接缝夹具（方案 B）。真实 ACL 夹具（方案 A）
  //     要求目录 DACL 对当前令牌不可写：自建目录的所有者隐式持有 WRITE_DAC，非提
  //     升环境无法确定性地制造，且收权后清理自身也会失败留残留——故经 _grants 接
  //     缝注入失败/成功 grant 验证记账与重试链路（真实 Win32 错误文案路径不在本
  //     用例覆盖面，执行报告有注）。
  {
    const homeI = mktemp('dsh-drymount-home-i-')
    const wsI = mktemp('dsh-drymount-ws-i-')
    const rootI = mktemp('dsh-drymount-root-i-')
    const mountI = await mountFreshPolicy({ workspaceRoot: wsI, allowedDirs: [`${rootI}\\**`], home: homeI })
    const policyI = mountI.policy
    const manifestFileI = join(homeI, 'sandbox-allowlist-grants.json')
    const readRecordI = () => JSON.parse(readFileSync(manifestFileI, 'utf8')).workspaces[wsI]
    // 首次物化前注入必抛的 grant：记账走 failed 分支（failed 根不在 skip-set，逐次重试）
    policyI._grants.set(wsI, {
      add() { throw new Error('simulated Win32 5: ACCESS_DENIED (seam fixture, plan B)') },
      dispose() {},
    })
    policyI.resolve()
    await policyI._reconcileTail
    const entryI = readRecordI().roots.find((entry) => entry.path.toLowerCase() === rootI.toLowerCase())
    assert.ok(entryI, '4i: the root has a record')
    assert.equal(entryI.status, 'failed', '4i: the failing grant records status=failed')
    assert.ok(String(entryI.error).includes('simulated'), `4i: the error text is recorded, got ${entryI.error}`)
    assert.ok(typeof entryI.errorAt === 'string' && entryI.attempts >= 1, '4i: errorAt + attempts are recorded')
    // 修复后走面板「重试授权」（API grant）→ granted + 记账清理
    policyI._grants.set(wsI, { add() {}, dispose() {} })
    const apiI = createApiHandler(policyI)
    const retryI = await apiI('grant', { path: rootI, workspace: wsI })
    assert.equal(retryI.ok, true, `4i: the retry grant succeeds via api, got ${JSON.stringify(retryI)}`)
    const retriedI = retryI.value.workspaces[wsI].roots.find((entry) => entry.path.toLowerCase() === rootI.toLowerCase())
    assert.ok(retriedI && retriedI.status === 'granted', '4i: the retry reads back a granted record')
    assert.ok(typeof retriedI.grantedAt === 'string', '4i: the retry grants a fresh grantedAt')
    assert.equal(retriedI.error, null, '4i: the error is cleared on success')
    assert.equal(retriedI.attempts, 0, '4i: attempts reset on success')
    console.log('4i. failed-row retry grant: failed accounting → repaired → granted via api (seam fixture)')
    await mountI.fiber.dispose()
  }

  // 4j. L2-05: workspace 解析优先级——显式 workspace > sessionCwd 命中 > 实例根。
  //     注意 state 的 current 只走 sessionCwd→实例根（显式 workspace 只作用于
  //     revoke/restore/grant 的目标选择），因此「显式最高」用操作断言而非 current。
  {
    const homeJ = mktemp('dsh-drymount-home-j-')
    const wsJA = mktemp('dsh-drymount-ws-ja-')
    const wsJB = mktemp('dsh-drymount-ws-jb-')
    const rootJA = mktemp('dsh-drymount-root-ja-')
    const rootJB = mktemp('dsh-drymount-root-jb-')
    // 预置双工作区 v2 清单：B 键先有一条 granted 记录（A 键交给启动对账补齐）
    writeFileSync(join(homeJ, 'sandbox-allowlist-grants.json'), JSON.stringify({
      workspaces: {
        [wsJB]: {
          sid: null, updatedAt: null,
          roots: [{ path: rootJB, status: 'granted', grantedAt: '2026-10-01T00:00:00.000Z', fromPatterns: [], triggeredBy: '', excluded: false, error: null, errorAt: null, attempts: 0 }],
          pendingRevoke: [], history: [],
        },
      },
    }), 'utf8')
    const mountJ = await mountFreshPolicy({ workspaceRoot: wsJA, allowedDirs: [`${rootJA}\\**`], home: homeJ })
    mountJ.policy.resolve()
    await mountJ.policy._reconcileTail
    const apiJ = createApiHandler(mountJ.policy)
    // ① sessionCwd 命中 → state.current 解析到该工作区
    const hitJ = await apiJ('state', { sessionCwd: wsJB })
    assert.equal(hitJ.ok, true)
    assert.equal(hitJ.value.current, wsJB, 'a sessionCwd hit resolves current to that workspace')
    assert.ok(hitJ.value.workspaces[wsJB] && hitJ.value.workspaces[wsJA], 'both workspace slices are served')
    // ② sessionCwd 未命中 → 兜底实例根
    const missJ = await apiJ('state', { sessionCwd: join(homeJ, 'no-such-ws') })
    assert.equal(missJ.value.current, wsJA, 'an unmatched sessionCwd falls back to the instance root')
    // ③ 显式 workspace 压过 sessionCwd：操作落 A，B 不动
    const explicitJ = await apiJ('revoke', { path: rootJA, workspace: wsJA, sessionCwd: wsJB })
    assert.equal(explicitJ.ok, true, `the explicit workspace wins, got ${JSON.stringify(explicitJ)}`)
    assert.ok(explicitJ.value.workspaces[wsJA].history.some((entry) => entry.path.toLowerCase() === rootJA.toLowerCase()),
      'the explicit-wsA revoke is accounted in wsA')
    assert.equal(explicitJ.value.workspaces[wsJB].history.length, 0, 'wsB is untouched by the explicit-wsA action')
    // ④ 无显式参、sessionCwd 命中 → 操作落 B
    const cwdJ = await apiJ('revoke', { path: rootJB, sessionCwd: wsJB })
    assert.equal(cwdJ.ok, true, `the sessionCwd hit targets the matched workspace, got ${JSON.stringify(cwdJ)}`)
    assert.ok(cwdJ.value.workspaces[wsJB].history.some((entry) => entry.path.toLowerCase() === rootJB.toLowerCase()),
      'the sessionCwd-driven revoke is accounted in wsB')
    // ⑤ 显式未知工作区 → unknown-workspace
    const unknownJ = await apiJ('revoke', { path: rootJA, workspace: 'W:\\elsewhere-j' })
    assert.equal(unknownJ.ok, false)
    assert.equal(unknownJ.error.code, 'unknown-workspace')
    console.log('4j. workspace resolution priority: explicit > sessionCwd hit > instance root')
    await mountJ.fiber.dispose()
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

    // L3-02: HTTP 适配层——假 req/res 直驱 handleRequest（经捕获的路由句柄；
    // handleRequest 未导出，fake webServer 捕获是唯一入口）。契约：HTTP 恒 200
    // 形状 + 统一信封（成功 {ok,value} / 失败 {ok:false,error{code,message}}）。
    const httpHandler = captured.route.handler
    const httpCall = async (verb, url, chunks) => {
      const req = Readable.from(chunks ?? [])
      req.method = verb
      req.url = url
      const res = {
        headers: {}, body: null,
        setHeader(name, value) { this.headers[name.toLowerCase()] = value },
        end(payload) { this.body = payload },
      }
      await httpHandler(req, res)
      return res
    }
    // ① 非 POST → bad-method 信封，状态码从不改写、content-type 恒 JSON
    const getRes = await httpCall('GET', '/sandbox-allowlist/api/state')
    assert.equal(getRes.statusCode, undefined, 'the adapter never sets a non-200 status')
    assert.equal(getRes.headers['content-type'], 'application/json; charset=utf-8')
    const getEnvelope = JSON.parse(getRes.body)
    assert.equal(getEnvelope.ok, false)
    assert.equal(getEnvelope.error.code, 'bad-method')
    // ② body > 1MB → internal 错误信封
    const bigRes = await httpCall('POST', '/sandbox-allowlist/api/state', [Buffer.alloc(1024 * 1024 + 1)])
    const bigEnvelope = JSON.parse(bigRes.body)
    assert.equal(bigEnvelope.ok, false)
    assert.equal(bigEnvelope.error.code, 'internal')
    assert.ok(String(bigEnvelope.error.message).includes('too large'), `got ${JSON.stringify(bigEnvelope.error)}`)
    // ③ 非法 JSON body → internal 错误信封
    const badRes = await httpCall('POST', '/sandbox-allowlist/api/state', [Buffer.from('{oops', 'utf8')])
    const badEnvelope = JSON.parse(badRes.body)
    assert.equal(badEnvelope.ok, false)
    assert.equal(badEnvelope.error.code, 'internal')
    assert.ok(String(badEnvelope.error.message).includes('not valid JSON'), `got ${JSON.stringify(badEnvelope.error)}`)
    // ④ 空 body POST → 按 {} 处理 → state 正常 ok 信封
    const emptyRes = await httpCall('POST', '/sandbox-allowlist/api/state', [])
    const emptyEnvelope = JSON.parse(emptyRes.body)
    assert.equal(emptyEnvelope.ok, true, 'an empty body reads as {} and serves the state view')
    assert.equal(emptyEnvelope.value.supported, true)
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
