/**
 * Verification for the escalation auto-approval gate: pure-function tests for
 * the statement splitter / shape guard / high-risk baseline / allow-check
 * (the P0 hardening from docs/设计评估-复合命令自动放行.md), plus an
 * end-to-end run inside a real cordis context — mount the policy service
 * (which registers both the `tools/pre-execute` gate and the
 * `approval/request` answerer), record a shell call through the pre-execute
 * waterfall, then dispatch the `approval/request` waterfall the same way
 * dsh-user-approval does and assert the auto-approval / delegation outcomes.
 *
 * Corpus discipline (evaluation report §2.1): the adversarial commands below
 * use only harmless read-only canaries (`whoami`, scratch-file redirects) —
 * no destructive payloads, and nothing here is ever executed; every check is
 * pure string matching.
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
import { hasComplexStructure, hitsHighRiskBaseline, HIGH_RISK_PROGRAMS } from '../lib/command-structure.mjs'

// ── pure: statement splitting (shared by both gates) ───────────────────────
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
assert.deepEqual(splitCommandSegments('a;;b'), ['a', 'b'], 'bash case ;; drops empty segments')
assert.deepEqual(splitCommandSegments('   '), [], 'whitespace-only yields no segments')

// P0: the previously-missed separators
assert.deepEqual(splitCommandSegments('a && b'), ['a', 'b'], '&& separates')
assert.deepEqual(splitCommandSegments('a&&b'), ['a', 'b'], '&& separates without spaces')
assert.deepEqual(splitCommandSegments('a & b'), ['a', 'b'], 'single & separates (bash background / pwsh call)')
assert.deepEqual(splitCommandSegments('a &'), ['a'], 'trailing & drops the empty tail')
assert.deepEqual(splitCommandSegments('a\nb\r\nc'), ['a', 'b', 'c'], 'newlines separate statements')
assert.deepEqual(splitCommandSegments('a 2>&1 & b'), ['a 2>&1', 'b'], '2>&1 masked, plain & still separates')
assert.deepEqual(splitCommandSegments('echo "2>&1" | cat'), ['echo "2>&1"', 'cat'], 'masked token restored inside quotes')

// dialect awareness
assert.deepEqual(splitCommandSegments('echo a\\;b', 'bash'), ['echo a\\;b'], 'bash backslash escapes the separator (raw text kept)')
assert.deepEqual(splitCommandSegments('echo a\\;b', 'pwsh'), ['echo a\\', 'b'], 'pwsh treats backslash literally, ; still separates')
assert.deepEqual(splitCommandSegments('echo a`;b', 'pwsh'), ['echo a`;b'], 'pwsh backtick escapes the separator')
assert.deepEqual(splitCommandSegments('echo `a;b`', 'bash'), ['echo `a', 'b`'], 'bash backtick is an ordinary char — fragments fail closed')
assert.deepEqual(splitCommandSegments("Write-Output 'it''s; fine'", 'pwsh'), ["Write-Output 'it''s; fine'"], 'pwsh doubled quote keeps the span together')

// ── pure: escalation shape guard (P0-2) ────────────────────────────────────
for (const ok of [
  'pnpm lint',
  'pnpm lint 2>&1',
  'pnpm lint 2>&1 | Select-Object -Last 20',
  'pnpm lint >/dev/null',
  'pnpm lint > /dev/null',
  'pnpm lint > $null',
  'pnpm lint >NUL',
  'pnpm lint >/dev/null 2>&1',
  'pnpm lint && pnpm typecheck',
  'echo "2>&1"', // redirect token inside a string literal
]) {
  assert.equal(hasComplexStructure(ok), false, `guard passes benign: ${ok}`)
}
for (const bad of [
  'pnpm lint > ./escape-probe.txt', // redirect with a target
  'pnpm lint >> ./append.log',
  'pnpm lint 2> ./err.txt',
  'pnpm lint &> ./all.txt',
  'pnpm lint < ./in.txt', // input redirect
  'pnpm lint <<EOF', // heredoc
  'pnpm lint <(whoami)', // process substitution
  'pnpm lint >(whoami)',
  'echo $(whoami)', // command substitution
  'echo `whoami`', // legacy backtick substitution
  'FOO=bar pnpm lint', // env-assignment prefix
  'pnpm lint "unbalanced',
  "pnpm lint 'unbalanced",
]) {
  assert.equal(hasComplexStructure(bad), true, `guard rejects: ${bad}`)
}

// ── pure: high-risk program baseline (P0-3) ────────────────────────────────
assert.ok(HIGH_RISK_PROGRAMS.has('npx') && HIGH_RISK_PROGRAMS.has('iex'), 'baseline covers npx and iex')
// Each command is allow-listed by its own rule — the baseline must still block it.
const baselineRules = [
  { pattern: 'bash *', action: 'allow' },
  { pattern: 'python *', action: 'allow' },
  { pattern: 'npx *', action: 'allow' },
  { pattern: 'env *', action: 'allow' },
  { pattern: 'xargs *', action: 'allow' },
  { pattern: 'iex *', action: 'allow' },
  { pattern: 'start-process *', action: 'allow' },
  { pattern: 'git *', action: 'allow' },
]
for (const command of [
  'bash -c "pnpm lint"',
  'python -c "import os"',
  'npx some-pkg',
  'env FOO=1 pnpm lint',
  'xargs pnpm lint',
  'iex "pnpm lint"',
  'Invoke-Expression pnpm lint',
  'Start-Process pnpm',
  "awk '{print}'", // blocked even without a matching rule
  '/usr/bin/env python x.py', // path-qualified program reduces to basename
  'git -c protocol.ext.allow=always ext::sh -c "whoami"', // git protocol injection
  'git ext::sh -c "whoami"',
]) {
  assert.equal(shouldAutoAllow({ rules: baselineRules }, 'pwsh', command), false, `baseline blocks: ${command}`)
}
assert.equal(shouldAutoAllow({ rules: baselineRules }, 'pwsh', 'git -c core.editor=x status'), true, 'benign git -c (no protocol injection) still auto-approves')
assert.equal(hitsHighRiskBaseline(['pnpm lint', 'whoami']), false, 'canary rider is not on the baseline')
assert.equal(hitsHighRiskBaseline(['pwsh', 'node server.mjs']), true, 'any segment on the baseline is enough')

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
  pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint 2>&1 | whoami'),
  false,
  'a non-allowed canary segment blocks auto-approval',
)
assert.equal(pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint'), false, 'pnpm lint * needs the trailing argument prefix')
assert.equal(pipelineFullyAllowed(rules, 'pwsh', ''), false, 'empty command never auto-approved')
assert.equal(shouldAutoAllow({ rules, default: 'delegate' }, 'pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20'), true, 'source-level helper agrees')

// ── pure: report risk matrix, post-P0 verdicts (canary corpus) ─────────────
const matrixRules = [
  { pattern: 'pnpm *', action: 'allow' },
  { pattern: 'echo *', action: 'allow' },
  { pattern: 'git *', action: 'allow' },
  { pattern: 'Select-Object *', action: 'allow', tool: 'pwsh' },
]
const matrix = [
  ['pwsh', 'pnpm lint', true, 'benign single command'],
  ['pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20', true, 'benign pipeline'],
  ['bash', 'pnpm lint > ./escape-probe.txt', false, 'redirect with target — guard (P0-2)'],
  ['pwsh', 'pnpm lint && whoami', false, 'rider segment not allow-listed (P0-1 split)'],
  ['bash', 'pnpm lint && whoami', false, '&& chain segmented'],
  ['bash', 'pnpm lint & whoami', false, '& chain segmented'],
  ['bash', 'pnpm lint\nwhoami', false, 'newline separated'],
  ['bash', 'echo $(whoami)', false, 'substitution — guard'],
  ['bash', 'echo `whoami`', false, 'backtick — guard'],
  ['pwsh', 'Write-Output $(whoami)', false, 'pwsh subexpression — guard'],
  ['bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', false, 'git injection — baseline'],
  ['bash', 'pnpm lint; whoami', false, '; chain segmented'],
  ['bash', 'pnpm lint || whoami', false, '|| chain segmented'],
  ['bash', 'pnpm lint |& whoami', false, '|& fragment fails closed'],
  ['bash', 'FOO=bar pnpm lint', false, 'env prefix — guard'],
  ['bash', 'pnpm run deploy', true, 'RESIDUAL F5: meta-program stays allow-ruled until P1 allow-escalate'],
  ['pwsh', 'pnpm lint && pnpm typecheck', true, 'benign && chain, both segments allow — now by mechanism'],
  ['bash', 'pnpm lint &', true, 'trailing background &, single benign segment'],
  ['bash', 'pnpm lint 2>&1', true, 'harmless no-target redirect'],
]
for (const [tool, command, expected, note] of matrix) {
  assert.equal(shouldAutoAllow({ rules: matrixRules }, tool, command), expected, `matrix [${note}]: ${tool} ${JSON.stringify(command)}`)
}

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

// every segment must be allowed: a non-allow-listed canary keeps the stock prompt
await dispatchPre('pwsh', 'call-2', 'pnpm lint 2>&1 | whoami')
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

// P0: && rider / command substitution keep the stock prompt
await dispatchPre('pwsh', 'call-5', 'pnpm lint && whoami')
assert.equal(await dispatchApproval(escalation('call-5')), 'unavailable', '&& rider segment delegates (P0-1 split + full-segment check)')

await dispatchPre('bash', 'call-6', 'echo $(whoami)')
assert.equal(await dispatchApproval(escalation('call-6', 'bash')), 'unavailable', 'command substitution is guard-rejected (P0-2)')

// unknown call id / non-shell tool delegate
assert.equal(await dispatchApproval(escalation('call-nope')), 'unavailable', 'unknown call delegates')
assert.equal(await dispatchApproval({ ...escalation('call-1'), toolName: 'edit' }), 'unavailable', 'non-shell tool delegates')

console.log('verify-approval-gate: all assertions passed')
await policyFiber.dispose()
