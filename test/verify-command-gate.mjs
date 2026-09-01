/**
 * End-to-end verification of the command allow-list gate inside a real cordis
 * context: mount the policy service (which registers the `tools/pre-execute`
 * listener), provide `tools` + `settings` + `systemPrompt`, then dispatch the
 * `tools/pre-execute` waterfall the same way dsh-tools does and assert the
 * allow/deny/ask/delegate decisions — including that an `allow` rule
 * short-circuits a downstream "ask" listener.
 *
 * Run from the package root:
 *   node test/verify-command-gate.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'

const WORKSPACE = 'D:/Work/OtherCode/dsh-sandbox-allowlist'
const rules = [
  { tool: 'bash', pattern: 'git *', action: 'allow' },
  { tool: 'pwsh', pattern: 'git *', action: 'ask' },
  { pattern: 'pnpm *', action: 'allow' },
  { pattern: 'whoami *', action: 'deny' }, // canary stand-in for any protected command (report §2.1)
]
const settingsSection = { allowedDirs: [], commands: { default: 'delegate', rules } }

const ctx = new Context()
ctx.provide('systemPrompt', { context() {} })
ctx.provide('tools', {}) // our gate only checks ctx.on + exec; the service identity is what ctx.inject awaits
ctx.provide('settings', {
  register(_ns, _schema, _options) {
    return { get: () => settingsSection, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})

const policyFiber = ctx.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: WORKSPACE })
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

// mixed allow/unmatched line falls back to the default — the pre-P0 behavior
// (whole-string `pnpm *` allow) is intentionally tightened to a delegate
decision = await terminal.bash('pnpm lint; echo done')
assert.equal(decision.kind, 'ask', 'unmatched second segment falls back to default → delegate → downstream ask')
assert.equal(calls.downstream, 3, 'mixed allow/unmatched line reaches the downstream listener')

console.log('verify-command-gate: all checks passed')
await policyFiber.dispose()
