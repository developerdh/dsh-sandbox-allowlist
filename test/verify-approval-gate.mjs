/**
 * Verification for the escalation auto-approval gate: pure-function tests for
 * the pipeline splitter / allow-check, plus an end-to-end run inside a real
 * cordis context — mount the policy service (which registers both the
 * `tools/pre-execute` gate and the `approval/request` answerer), record a
 * shell call through the pre-execute waterfall, then dispatch the
 * `approval/request` waterfall the same way dsh-user-approval does and assert
 * the auto-approval / delegation outcomes.
 *
 * Run from the package root:
 *   node test/verify-approval-gate.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import {
  splitCommandSegments,
  pipelineFullyAllowed,
  shouldAutoAllow,
} from '../lib/command-approval-gate.mjs'

// ── pure: pipeline splitting ───────────────────────────────────────────────
assert.deepEqual(
  splitCommandSegments('pnpm lint 2>&1 | Select-Object -Last 20'),
  ['pnpm lint 2>&1', 'Select-Object -Last 20'],
  'pipe split keeps the 2>&1 redirect on the first segment',
)
assert.deepEqual(splitCommandSegments('a; b | c'), ['a', 'b', 'c'], 'splits on both ; and |')
assert.deepEqual(
  splitCommandSegments('Write-Output "a|b"; Write-Output \'c;d\''),
  ['Write-Output "a|b"', "Write-Output 'c;d'"],
  'separators inside quotes are literal',
)
assert.deepEqual(splitCommandSegments('a || b'), ['a', 'b'], 'double separators drop empty segments')
assert.deepEqual(splitCommandSegments('   '), [], 'whitespace-only yields no segments')

// ── pure: pipeline allow-check ─────────────────────────────────────────────
const rules = [
  { pattern: 'mvn *', action: 'allow' },
  { pattern: 'git status *', action: 'allow' },
  { pattern: 'pnpm build *', action: 'allow' },
  { pattern: 'pnpm lint *', action: 'allow' },
  { pattern: 'pnpm typecheck *', action: 'allow' },
  { pattern: 'Select-Object *', action: 'allow', tool: 'pwsh' },
]
assert.equal(
  pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20'),
  true,
  'both pipeline segments allow-listed (pwsh)',
)
assert.equal(
  pipelineFullyAllowed(rules, 'bash', 'pnpm lint 2>&1 | Select-Object -Last 20'),
  false,
  'Select-Object rule is pwsh-scoped, so the bash pipeline is NOT fully allowed',
)
assert.equal(
  pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint 2>&1 | Remove-Item C:\\Windows'),
  false,
  'a non-allowed segment (Remove-Item) blocks auto-approval',
)
assert.equal(pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint'), false, 'pnpm lint * needs the trailing argument prefix')
assert.equal(pipelineFullyAllowed(rules, 'pwsh', ''), false, 'empty command never auto-approved')
assert.equal(shouldAutoAllow({ rules, default: 'delegate' }, 'pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20'), true, 'source-level helper agrees')

// ── end-to-end: mount the policy (registers both gates) and dispatch ───────
const WORKSPACE = 'D:/Work/OtherCode/dsh-sandbox-allowlist'
const e2eRules = [
  { pattern: 'mvn *', action: 'allow' },
  { pattern: 'git add *', action: 'allow' },
  { pattern: 'git commit *', action: 'allow' },
  { pattern: 'git status *', action: 'allow' },
  { pattern: 'git logs *', action: 'allow' },
  { pattern: 'pnpm build *', action: 'allow' },
  { pattern: 'pnpm vitest run *', action: 'allow' },
  { pattern: 'pnpm test *', action: 'allow' },
  { pattern: 'pnpm lint *', action: 'allow' },
  { pattern: 'pnpm typecheck *', action: 'allow' },
  { pattern: 'Select-Object *', action: 'allow', tool: 'pwsh' },
]
const settingsSection = { allowedDirs: [], commands: { default: 'delegate', rules: e2eRules } }

const ctx = new Context()
ctx.provide('systemPrompt', { context() {} })
ctx.provide('tools', {})
ctx.provide('settings', {
  register(_ns, _schema, _options) {
    return { get: () => settingsSection, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})

const policyFiber = ctx.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: WORKSPACE })
await policyFiber

async function dispatchPre(tool, callId, command) {
  return ctx.waterfall(ctx, 'tools/pre-execute', { name: tool, callId, arguments: { command } }, () => Promise.resolve({ kind: 'allow' }))
}
async function dispatchApproval(req) {
  return ctx.waterfall(ctx, 'approval/request', req, () => Promise.resolve('unavailable'))
}
const escalation = (callId, tool = 'pwsh', reason = 'escalate sandbox to danger-full-access: eslint spawns worker processes over pipes that workspace-write blocks with EPERM; this lint run needs the wider sandbox.') => ({ toolName: tool, callId, reason })

// record the call, then auto-approve its escalation
await dispatchPre('pwsh', 'call-1', 'pnpm lint 2>&1 | Select-Object -Last 20')
assert.equal(await dispatchApproval(escalation('call-1')), 'allowed-once', 'fully allow-listed pipeline escalates without a prompt')

// every segment must be allowed: a Remove-Item segment keeps the stock prompt
await dispatchPre('pwsh', 'call-2', 'pnpm lint 2>&1 | Remove-Item C:\\Windows')
assert.equal(await dispatchApproval(escalation('call-2')), 'unavailable', 'mixed pipeline delegates to the UI answerer')

// tool-scoped rule: bash pipeline with Select-Object is not fully allowed
await dispatchPre('bash', 'call-3', 'pnpm lint 2>&1 | Select-Object -Last 20')
assert.equal(await dispatchApproval(escalation('call-3', 'bash')), 'unavailable', 'bash pipeline with pwsh-scoped segment delegates')

// non-escalation approvals are never auto-answered
await dispatchPre('pwsh', 'call-4', 'git logs test')
assert.equal(
  await dispatchApproval({ toolName: 'pwsh', callId: 'call-4', reason: 'sandbox-allowlist: command rule requires approval: git logs test' }),
  'unavailable',
  'non-escalation reason delegates',
)

// unknown call id / non-shell tool delegate
assert.equal(await dispatchApproval(escalation('call-nope')), 'unavailable', 'unknown call delegates')
assert.equal(await dispatchApproval({ ...escalation('call-1'), toolName: 'edit' }), 'unavailable', 'non-shell tool delegates')

console.log('verify-approval-gate: all assertions passed')
