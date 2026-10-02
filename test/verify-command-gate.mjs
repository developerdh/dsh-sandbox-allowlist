/**
 * End-to-end verification of the command allow-list gate inside a real cordis
 * context: mount the policy service (which registers the `tools/pre-execute`
 * listener), provide `tools` + `systemPrompt`, then dispatch the
 * `tools/pre-execute` waterfall the same way dsh-tools does and assert the
 * allow/deny/ask/delegate decisions — including that an `allow` rule
 * short-circuits a downstream "ask" listener.
 *
 * dsh 0.2.0 model: the rules come from the plugin's Config (the settings form
 * is a projection of that schema), and a settings save re-applies the plugin.
 * The reload-hygiene block below therefore mounts, disposes and re-mounts
 * against a systemPrompt stub that REFUSES a duplicate section name — the
 * exact failure the effect-owned registrations exist to prevent.
 *
 * Run from the package root:
 *   node test/verify-command-gate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'

// Isolate derived state (decision audit + rule proposals) from the real DSH
// home, exactly like test/dry-mount.mjs isolates the grants manifest.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-allowlist-home-'))

const WORKSPACE = process.env.DSH_TEST_WORKSPACE ?? join(tmpdir(), 'dsh-verify-ws')
// 退出时回收隔离目录：DSH_HOME 总是删；测试工作区仅在使用默认临时路径时删
// （外部通过 DSH_TEST_WORKSPACE 指向真实目录时绝不动它）。
process.on('exit', () => {
  try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
  if (!process.env.DSH_TEST_WORKSPACE) {
    try { rmSync(WORKSPACE, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
const rules = [
  { tool: 'bash', pattern: 'git *', action: 'allow' },
  { tool: 'pwsh', pattern: 'git *', action: 'ask' },
  { pattern: 'pnpm *', action: 'allow' },
  { pattern: 'whoami *', action: 'deny' }, // canary stand-in for any protected command (report §2.1)
]
// dsh 0.2.0: the rules live in this row's Config; the settings form projects
// them from the same schema and saving it re-applies the plugin with the
// merged config. No settings service is involved in reading them.
const config = { mode: 'workspace-write', workspaceRoot: WORKSPACE, commands: { default: 'delegate', rules } }

const ctx = new Context()
// dsh 0.2.0: the policy base class requires `sessionProjections` (it registers
// the `sandboxMode` projection while constructing) — see test/dry-mount.mjs.
ctx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
// `context()` returns the disposer the policy registers as an effect.
ctx.provide('systemPrompt', { context() { return () => {} } })
ctx.provide('tools', {}) // our gate only checks ctx.on + exec; the service identity is what ctx.inject awaits

const policyFiber = ctx.plugin(PolicyPlugin, config)
await policyFiber

// A downstream "ask" listener to prove allow short-circuits it.
ctx.on('tools/pre-execute', (_exec, next) => {
  calls.downstream += 1
  return Promise.resolve({ kind: 'ask' })
})

const calls = { downstream: 0 }

// Dispatch exactly like dsh-tools: ctx.waterfall(scope, 'tools/pre-execute', exec, default)
async function dispatch(exec) {
  return ctx.waterfall(ctx, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
}

const terminal = {
  bash: (command) => dispatch({ name: 'bash', arguments: { command } }),
  pwsh: (command) => dispatch({ name: 'pwsh', arguments: { command } }),
}

// allow (bash) — must NOT reach the downstream ask listener
let decision = await terminal.bash('git status --porcelain')
assert.deepEqual(decision, { kind: 'allow' })
assert.equal(calls.downstream, 0, 'allow rule short-circuits the downstream ask listener')

// ask (pwsh) — our gate returns ask for pwsh git; the reason field marks OUR
// listener (the downstream one carries no reason) — proving prepend wins
decision = await terminal.pwsh('git commit -m hi')
assert.deepEqual(decision, { kind: 'ask', reason: 'sandbox-allowlist: command rule requires approval: git commit -m hi' })
assert.equal(calls.downstream, 0, 'our prepend ask wins over the downstream listener')

// deny — blocks regardless of tool, with a reason (canary `whoami /all` stands
// in for any protected command; the corpus never contains destructive payloads)
decision = await terminal.bash('whoami /all')
assert.equal(decision.kind, 'deny')
assert.match(decision.reason, /deny rule/)
assert.equal(calls.downstream, 0)

// P0-1 per-segment aggregation: a deny rule after a separator is no longer
// masked by an allow prefix (the F1 evasion from the evaluation report)
decision = await terminal.bash('pnpm lint; whoami /all')
assert.equal(decision.kind, 'deny', 'deny fires on the second segment despite the allow prefix')

decision = await terminal.bash('pnpm lint && whoami /all')
assert.equal(decision.kind, 'deny', '&& chain is segmented — the rider hits the deny rule')

decision = await terminal.bash('pnpm lint & whoami /all')
assert.equal(decision.kind, 'deny', 'single & chain is segmented too')

decision = await terminal.bash('pnpm lint; pnpm typecheck')
assert.deepEqual(decision, { kind: 'allow' }, 'all-allow segments keep the allow disposition')

decision = await terminal.pwsh('git status; git commit -m hi')
assert.equal(decision.kind, 'ask', 'any ask segment forces ask even when others match')

// no match + default delegate → delegates to downstream (which asks)
decision = await terminal.bash('npm test')
assert.deepEqual(decision, { kind: 'ask' })
assert.equal(calls.downstream, 1, 'unmatched command with default=delegate reaches the downstream listener')

// non-shell tools are never gated by us — they flow through to downstream listeners
decision = await dispatch({ name: 'read', arguments: { path: '/etc/hostname' } })
assert.equal(decision.kind, 'ask', 'non-shell tool reaches the downstream listener')
assert.equal(calls.downstream, 2, 'non-shell tool delegates past our gate (npm test was the 1st delegate)')

// mixed allow/unmatched line: `echo done` is a read-only statement, so the
// built-in capability baseline allows it without any rule (layer-1 change —
// the pre-baseline behavior delegated the whole line).
decision = await terminal.bash('pnpm lint; echo done')
assert.deepEqual(decision, { kind: 'allow' }, 'the baseline covers the read-only second statement')

// an unmatched statement the baseline does NOT cover still falls back to the
// configured default (delegate → downstream)
decision = await terminal.bash('pnpm lint; acme-deploy --now')
assert.equal(decision.kind, 'ask', 'an unknown second statement falls back to default → delegate')
assert.equal(calls.downstream, 3, 'mixed allow/unknown line reaches the downstream listener')

// pattern rules are judged per statement: allow `git status`, ask on
// `git push` — two narrow patterns instead of one whole-string prefix that
// would have allowed everything under `git`
{
  const argvCommands = {
    default: 'delegate',
    rules: [
      { pattern: 'git status*', action: 'allow' },
      { pattern: 'git push*', action: 'ask' },
    ],
  }
  const argvCtx = new Context()
  argvCtx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
  argvCtx.provide('systemPrompt', { context() { return () => {} } })
  argvCtx.provide('tools', {})
  const argvFiber = argvCtx.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: WORKSPACE, commands: argvCommands })
  await argvFiber
  const argvTerminal = (command) => argvCtx.waterfall(argvCtx, 'tools/pre-execute', { name: 'bash', arguments: { command } }, () => Promise.resolve({ kind: 'allow' }))
  assert.deepEqual(await argvTerminal('git status --porcelain'), { kind: 'allow' }, 'the status pattern allows git status')
  assert.equal((await argvTerminal('git push origin main')).kind, 'ask', 'the push pattern forces a prompt on git push')
  assert.equal((await argvTerminal('git status && git push')).kind, 'ask', 'the compound form is judged per statement')
  await argvFiber.dispose()
}

// Reload model (dsh 0.2.0): a settings save makes the Loader reconcile the
// entry and re-apply this plugin with the merged config. Two things must hold:
//   1. the re-applied instance reads the NEW config (no live watch exists any
//      more — the composition is the only rule source);
//   2. the previous round's registrations are gone before the next round runs.
//      The systemPrompt stub below refuses a duplicate section name, which is
//      exactly what a dropped disposer would trigger on the second mount.
{
  const liveSections = new Map()
  const guardedSystemPrompt = {
    context(section) {
      if (liveSections.has(section.name)) throw new Error(`duplicate context section: ${section.name}`)
      liveSections.set(section.name, section)
      return () => { liveSections.delete(section.name) }
    },
  }
  const liveCtx = new Context()
  liveCtx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
  liveCtx.provide('systemPrompt', guardedSystemPrompt)
  liveCtx.provide('tools', {})

  let liveFiber = liveCtx.plugin(PolicyPlugin, {
    mode: 'workspace-write',
    workspaceRoot: WORKSPACE,
    commands: { default: 'delegate', sessionCache: true, rules: [] },
  })
  await liveFiber
  const cache = liveCtx.sandboxPolicy._sessionCache
  assert.equal(cache.enabled, true, 'the cache starts enabled (config default)')
  cache.remember('bash', 'acme-tool build')
  assert.ok(cache.lookup('bash', 'acme-tool build') !== null, 'a hand-approved command is remembered')
  assert.equal(liveSections.size, 3, 'the first mount owns three prompt sections')

  await liveFiber.dispose()
  assert.equal(liveSections.size, 0, 'disposing the fiber withdraws every prompt section')

  // Re-apply with the merged config, exactly like the Loader does after a save.
  liveFiber = liveCtx.plugin(PolicyPlugin, {
    mode: 'workspace-write',
    workspaceRoot: WORKSPACE,
    commands: { default: 'delegate', sessionCache: false, rules: [] },
  })
  await liveFiber
  const reloaded = liveCtx.sandboxPolicy._sessionCache
  assert.notEqual(reloaded, cache, 'the reload builds a fresh instance')
  assert.equal(reloaded.enabled, false, 'the reloaded instance honors the new sessionCache:false')
  assert.equal(reloaded.lookup('bash', 'acme-tool build'), null, 'the fresh cache carries no previous session memory')
  assert.equal(liveSections.size, 3, 'the second mount registers its own prompt sections without a duplicate error')

  await liveFiber.dispose()
  assert.equal(liveSections.size, 0, 'the reload is disposable too')
}

// Auto review sessions: the official LLM reviewer owns the whole decision —
// our rules (allow AND deny alike) must delegate, while a non-Auto session on
// the same context keeps the exact current behavior. The probe reads
// `ctx.permissionPresets.current(session)` and compares it with the AUTO preset
// id preset.mjs resolves from `@deepseek-ai/dsh-permission-presets` (a dev
// dependency of this repo; its fallback literal is the same verified string).
{
  const autoCtx = new Context()
  autoCtx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
  autoCtx.provide('systemPrompt', { context() { return () => {} } })
  autoCtx.provide('tools', {})
  // Same service name + contract the official auto-review layer relies on.
  autoCtx.provide('permissionPresets', { current: (session) => session?.permissionPreset })
  const autoFiber = autoCtx.plugin(PolicyPlugin, config)
  await autoFiber

  let autoDownstream = 0
  autoCtx.on('tools/pre-execute', (_exec, next) => {
    autoDownstream += 1
    return Promise.resolve({ kind: 'ask' })
  })
  const autoDispatch = (command, preset) =>
    autoCtx.waterfall(
      autoCtx,
      'tools/pre-execute',
      { name: 'bash', arguments: { command }, agent: { session: { permissionPreset: preset } } },
      () => Promise.resolve({ kind: 'allow' }),
    )

  // Auto session: an `allow` rule must NOT short-circuit — the official
  // reviewer (here: the downstream listener) must see the call.
  let decision = await autoDispatch('git status --porcelain', 'auto')
  assert.deepEqual(decision, { kind: 'ask' }, 'Auto session: our allow rule delegates to the official reviewer')
  assert.equal(autoDownstream, 1, 'Auto session: the allow rule did not short-circuit the downstream listener')

  // Auto session: a deny rule must not fire either (全放行给 auto review).
  decision = await autoDispatch('whoami /all', 'auto')
  assert.deepEqual(decision, { kind: 'ask' }, 'Auto session: our deny rule delegates too')
  assert.equal(autoDownstream, 2)

  // Non-Auto session on the same context: rules keep working unchanged.
  decision = await autoDispatch('whoami /all', 'workspace-write')
  assert.equal(decision.kind, 'deny', 'non-Auto session: the deny rule still fires')
  assert.equal(autoDownstream, 2, 'non-Auto session: the deny short-circuits the downstream listener')

  decision = await autoDispatch('git status --porcelain', 'workspace-write')
  assert.deepEqual(decision, { kind: 'allow' }, 'non-Auto session: the allow rule still applies')

  // Agentless call (no agent/session on the exec): probe cannot answer —
  // fall back to the exact current behavior (judge by rules).
  decision = await autoCtx.waterfall(
    autoCtx,
    'tools/pre-execute',
    { name: 'bash', arguments: { command: 'whoami /all' } },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny', 'agentless call: no session => current behavior (deny rule fires)')

  // Host without the presets service: the probe reads undefined => current
  // behavior even when the session object claims Auto (cannot happen on a
  // real host, but the degradation must not throw).
  const bareCtx = new Context()
  bareCtx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
  bareCtx.provide('systemPrompt', { context() { return () => {} } })
  bareCtx.provide('tools', {})
  const bareFiber = bareCtx.plugin(PolicyPlugin, config)
  await bareFiber
  decision = await bareCtx.waterfall(
    bareCtx,
    'tools/pre-execute',
    { name: 'bash', arguments: { command: 'whoami /all' }, agent: { session: { permissionPreset: 'auto' } } },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny', 'no presets service => not Auto => current behavior')
  await bareFiber.dispose()
  await autoFiber.dispose()
}

console.log('verify-command-gate: all checks passed')
await policyFiber.dispose()

