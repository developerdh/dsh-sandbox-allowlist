/**
 * Verification of the escalation auto-approval gate and the shared decision
 * engine: statement splitting, capability classification, structural
 * resolution (substitutions / redirects / heredocs / env prefixes), the
 * escalation question itself, and the end-to-end wiring through a real cordis
 * context (mounted policy registers both gates).
 *
 * Canary discipline (evaluation report §2.1): adversarial commands use only
 * harmless read-only riders (`whoami`) — no destructive payloads.
 *
 * Run from the package root:
 *   node test/verify-approval-gate.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import PolicyPlugin from '../lib/policy.mjs'
import {
  splitCommandSegments,
  pipelineFullyAllowed,
  shouldAutoAllow,
  explainForPrompt,
} from '../lib/command-approval-gate.mjs'
import { decide } from '../lib/command-decision.mjs'
import { analyzeCommand } from '../lib/command-analyze.mjs'
import { classifyStatement } from '../lib/command-classes.mjs'

// Isolate derived state (decision audit + rule proposals) from the real DSH
// home, exactly like test/dry-mount.mjs isolates the grants manifest.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-allowlist-home-'))

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
assert.deepEqual(splitCommandSegments('a && b'), ['a', 'b'], '&& separates')
assert.deepEqual(splitCommandSegments('a&&b'), ['a', 'b'], '&& separates without spaces')
assert.deepEqual(splitCommandSegments('a & b'), ['a', 'b'], 'single & separates (bash background / pwsh call)')
assert.deepEqual(splitCommandSegments('a &'), ['a'], 'trailing & drops the empty tail')
assert.deepEqual(splitCommandSegments('a\nb\r\nc'), ['a', 'b', 'c'], 'newlines separate statements')
assert.deepEqual(splitCommandSegments('a 2>&1 & b'), ['a 2>&1', 'b'], '2>&1 masked, plain & still separates')
assert.deepEqual(splitCommandSegments('echo "2>&1" | cat'), ['echo "2>&1"', 'cat'], 'masked token restored inside quotes')
assert.deepEqual(splitCommandSegments('echo a\\;b', 'bash'), ['echo a\\;b'], 'bash backslash escapes the separator')
assert.deepEqual(splitCommandSegments('echo a\\;b', 'pwsh'), ['echo a\\', 'b'], 'pwsh treats backslash literally, ; still separates')
assert.deepEqual(splitCommandSegments('echo a`;b', 'pwsh'), ['echo a`;b'], 'pwsh backtick escapes the separator')
assert.deepEqual(splitCommandSegments("Write-Output 'it''s; fine'", 'pwsh'), ["Write-Output 'it''s; fine'"], 'pwsh doubled quote keeps the span together')

// ── pure: capability classification ────────────────────────────────────────
const classify = (statement, options) => classifyStatement(analyzeCommand(statement, 'bash').statements[0] ?? { program: '', rest: '' }, options)
assert.equal(classify('git status --porcelain').kind, 'read', 'git status reads')
assert.equal(classify('git push origin main').kind, 'external', 'git push reaches the network')
assert.equal(classify('git reset --hard HEAD~1').kind, 'destructive', 'git reset --hard is destructive')
assert.equal(classify('git config --global user.name x').kind, 'local-write', 'git config --global writes out of workspace')
assert.deepEqual(classify('git config --global user.name x').outside, ['~/.gitconfig'], 'and records the out-of-workspace target')
assert.equal(classify('rm -rf ./build').kind, 'destructive', 'rm is destructive')
assert.equal(classify('mkdir ./logs').kind, 'local-write', 'mkdir writes through its path argument')
assert.equal(classify('node server.mjs').kind, 'opaque', 'node is opaque')
assert.equal(classify('node --version').kind, 'read', 'node --version is a read-only form')
assert.equal(classify('ls -la').kind, 'read', 'ls reads')
assert.equal(classify('sed -i s/a/b/ f.txt').kind, 'opaque', 'sed is opaque either way (its scripts can execute and write)')
assert.equal(classify('find . -name "*.ts"').kind, 'read', 'find without -exec reads')
assert.equal(classify('find . -exec rm {} \\;').kind, 'local-write', 'find -exec is not a read')
assert.equal(classify('Get-ChildItem -Recurse').kind, 'read', 'Get- verb is read by convention')
assert.equal(classify('Where-Object { $_.x }').kind, 'read', 'Where-Object reads')
assert.equal(classify('Some-UnknownTool --flag').kind, 'unknown', 'anything unlisted is unknown')
assert.equal(classify('pnpm test').kind, 'repo-exec', 'package-script runners are repo-exec')
assert.equal(classify('pnpm install').kind, 'external', 'pnpm install reaches the network')
assert.equal(classify('pnpm ls').kind, 'read', 'pnpm ls reads')

// ── pure: structural resolution (replaces the blanket shape guard) ─────────
const analyzed = analyzeCommand('git commit -m "$(date +%F)" > ./log.txt', 'bash', {
  inScope: (token) => !token.startsWith('/'),
})
assert.deepEqual(
  analyzed.statements.map((statement) => statement.program),
  ['date', 'git'],
  'the substitution body is analyzed as a statement of its own',
)
assert.equal(analyzed.redirects.length, 1, 'the redirect is resolved, not refused')
assert.equal(analyzed.redirects[0].target, './log.txt', 'redirect target captured')
assert.equal(analyzed.redirects[0].inScope, true, 'relative target resolves inside the workspace')
assert.equal(analyzed.unresolved.length, 0, 'nothing unresolved about a substitution + redirect')

const heredoc = analyzeCommand('cat <<EOF > ./notes.md\nhello\nEOF\n', 'bash', { inScope: () => true })
assert.equal(heredoc.unresolved.length, 0, 'a heredoc is data, not an unresolved structure')
assert.equal(heredoc.statements[0].program, 'cat', 'the heredoc command line is what gets classified')

assert.ok(
  analyzeCommand('diff <(whoami) x', 'bash', { inScope: () => true }).unresolved
    .some((item) => item.kind === 'process-substitution'),
  'process substitution stays unresolved (fail-closed)',
)
assert.ok(
  analyzeCommand('echo "unbalanced', 'bash', { inScope: () => true }).unresolved
    .some((item) => item.kind === 'unbalanced-quotes'),
  'unbalanced quotes stay unresolved',
)
const envPrefixed = analyzeCommand('FOO=bar pnpm test', 'bash', { inScope: () => true })
assert.deepEqual(envPrefixed.statements[0].envPrefix, ['FOO=bar'], 'env-assignment prefix recorded')

// ── pure: the escalation question ──────────────────────────────────────────
const ctx = { roots: ['/repo'], cwd: '/repo', inScope: (token) => !token.startsWith('/') }
const source = (rules, extra = {}) => ({ rules, default: 'delegate', ...extra })

// Capability baseline: read-only and in-scope writes need no rule at all.
assert.equal(shouldAutoAllow(source([]), 'bash', 'git status --porcelain && git diff --stat', ctx), true, 'read-only chain auto-escalates with no rules')
assert.equal(shouldAutoAllow(source([]), 'bash', 'echo $(whoami)', ctx), true, 'a read-only substitution auto-escalates (the old shape guard refused it)')
assert.equal(shouldAutoAllow(source([]), 'bash', 'cat <<EOF > ./notes.md\nhello\nEOF\n', ctx), true, 'an in-workspace redirect auto-escalates')
assert.equal(shouldAutoAllow(source([]), 'pwsh', 'Get-ChildItem src -Recurse | Where-Object { $_.Length -gt 1000 } | Select-Object -First 5', ctx), true, 'a pwsh read pipeline auto-escalates (no cmdlet enumeration needed)')

// The rules below appear in TWO groups. Under the single-layer `allow`, a rule
// hit carries the escalation grant — so statements covered by `pnpm *` / `git *`
// became AUTO. Only the rails (unresolved structures, out-of-scope paths,
// noRead) and unmatched non-benign classes still refuse.
for (const [tool, command, note] of [
  ['bash', 'node scripts/verify.mjs --fix', 'interpreter, no rule'],
  ['bash', 'npx tsc --noEmit', 'package runner, no rule'],
  ['bash', 'rm -rf ./build', 'destructive, no rule'],
  ['bash', 'dsh plugin --profile web add /tmp/x.tgz', 'unknown program, no rule'],
  ['bash', 'git config --global user.name x', 'rail: out-of-workspace write beats the `git *` rule'],
  ['bash', 'diff <(whoami) x', 'rail: unresolved structure'],
  ['bash', 'pnpm lint "unbalanced', 'rail: unbalanced quotes'],
]) {
  assert.equal(
    shouldAutoAllow(source([{ pattern: 'pnpm *', action: 'allow' }, { pattern: 'git *', action: 'allow' }]), tool, command, ctx),
    false,
    `not auto-escalated (${note}): ${command}`,
  )
}

// A rule `allow` IS the escalation grant now (the documented wide-pattern cost).
for (const [tool, command, note] of [
  ['bash', 'git push origin main', 'network, but the `git *` rule speaks'],
  ['bash', 'pnpm install --frozen-lockfile', 'installer, but the `pnpm *` rule speaks'],
  ['bash', 'FOO=bar pnpm test', 'env prefix withholds only the baseline, never a written rule'],
  ['bash', 'pnpm run deploy', 'meta-program unexpanded: rule-matched'],
  ['bash', 'pnpm lint && whoami', 'pnpm lint is ruled, the canary rider is a benign read'],
]) {
  assert.equal(
    shouldAutoAllow(source([{ pattern: 'pnpm *', action: 'allow' }, { pattern: 'git *', action: 'allow' }]), tool, command, ctx),
    true,
    `auto-escalated via the allow rule (${note}): ${command}`,
  )
}

// A narrow `allow` rule grants the upgrade for exactly its shape.
assert.equal(
  shouldAutoAllow(source([{ pattern: 'pnpm lint*', action: 'allow' }]), 'bash', 'pnpm lint 2>&1', ctx),
  true,
  'an allow rule grants the upgrade for its shape',
)
assert.equal(
  shouldAutoAllow(source([{ pattern: 'node *', action: 'allow' }]), 'bash', 'node scripts/verify.mjs', ctx),
  true,
  'an allow rule overrides the opaque baseline for that shape',
)
assert.equal(
  shouldAutoAllow(source([{ pattern: 'pnpm lint*', action: 'allow' }, { pattern: 'whoami*', action: 'deny' }]), 'bash', 'pnpm lint; whoami', ctx),
  false,
  'a deny rule always wins over the grant',
)

// escalation modes: `never` disables it entirely; the legacy `explicit-only`
// value no longer exists and falls back to the default (capability).
assert.equal(shouldAutoAllow(source([], { escalation: 'never' }), 'bash', 'git status', ctx), false, 'escalation=never disables it entirely')
assert.equal(
  shouldAutoAllow(source([], { escalation: 'explicit-only' }), 'bash', 'git status', ctx),
  true,
  'the removed explicit-only value falls back to the capability default (read-only still escalates)',
)

// baseline off: behaviour is exactly what the rules say
assert.equal(shouldAutoAllow(source([], { baseline: false }), 'bash', 'git status', ctx), false, 'baseline=false removes the built-in classes')

// out-of-scope redirect
assert.equal(
  shouldAutoAllow(source([]), 'bash', 'git status > /etc/escape-probe.txt', ctx),
  false,
  'a redirect target outside the workspace blocks the escalation',
)

// noRead interaction: the wider mode lifts the read fence, so a protected
// path must never ride along.
assert.equal(
  shouldAutoAllow(
    source([]),
    'bash',
    'Get-Content ./secrets.pem',
    { ...ctx, noRead: (path) => (path.endsWith('.pem') ? { pattern: '*.pem', action: 'deny' } : null) },
  ),
  false,
  'a command referencing a noRead target is never auto-escalated',
)

// ── pure: pipeline allow-check (legacy helper, unchanged meaning) ──────────
const rules = [
  { pattern: 'mvn *', action: 'allow' },
  { pattern: 'git status*', action: 'allow' },
  { pattern: 'pnpm build *', action: 'allow' },
  { pattern: 'pnpm lint *', action: 'allow' },
  { pattern: 'pnpm typecheck *', action: 'allow' },
  { pattern: 'Select-Object *', action: 'allow', tool: 'pwsh' },
]
assert.equal(pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20'), true, 'both pipeline segments allow-listed (pwsh)')
assert.equal(pipelineFullyAllowed(rules, 'bash', 'pnpm lint 2>&1 | Select-Object -Last 20'), false, 'Select-Object rule is pwsh-scoped, so the bash pipeline is NOT fully allowed')
assert.equal(pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint 2>&1 | whoami'), false, 'a non-allowed canary segment blocks auto-approval')
assert.equal(pipelineFullyAllowed(rules, 'pwsh', 'pnpm lint'), false, 'the pattern needs its trailing argument prefix')
assert.equal(pipelineFullyAllowed(rules, 'pwsh', ''), false, 'empty command never auto-approved')
assert.equal(pipelineFullyAllowed(rules, 'bash', 'git status --porcelain'), true, 'the pattern matches the statement')

// ── pure: pattern rules judge per statement ────────────────────────────────
const argvRules = [
  { pattern: 'git status*', action: 'allow' },
  { pattern: 'git push*', action: 'ask' },
]
const argvDecision = (command) => decide({ source: source(argvRules), tool: 'bash', command, phase: 'sandbox', context: ctx })
assert.equal(argvDecision('git status --porcelain').verdict, 'allow', 'git status allowed by its pattern')
assert.equal(argvDecision('git push origin main').verdict, 'ask', 'git push caught by its pattern (last match wins)')
assert.equal(argvDecision('git status && git push origin main').verdict, 'ask', 'the compound form is judged per statement')
assert.equal(argvDecision('gitdb status').verdict, 'delegate', 'patterns anchor at the start, so gitdb never matches git')

// ── pure: explanation rendering ────────────────────────────────────────────
const refused = decide({ source: source([]), tool: 'bash', command: 'node scripts/verify.mjs --fix', phase: 'escalation', context: ctx })
assert.match(explainForPrompt(refused), /未自动放行沙箱升级/, 'the prompt explanation names the outcome')
assert.match(explainForPrompt(refused), /action: "allow"/, 'and suggests the allow rule that would avoid it')
assert.match(explainForPrompt(refused), /沙箱外/, 'the suggestion says what allow now means (runs outside the sandbox)')

// ── end-to-end: mount the policy (registers both gates) and dispatch ───────
const WORKSPACE = process.env.DSH_TEST_WORKSPACE ?? join(tmpdir(), 'dsh-verify-ws')
const e2eRules = [
  { pattern: 'pnpm lint*', action: 'allow' },
  { pattern: 'mvn *', action: 'allow' },
  { pattern: 'git status*', action: 'allow' },
  { pattern: 'git add*', action: 'allow' },
  { pattern: 'git commit*', action: 'allow' },
  { pattern: 'Select-Object *', action: 'allow', tool: 'pwsh' },
]
const settingsSection = {
  allowedDirs: [],
  noRead: [{ pattern: '*.pem', action: 'deny' }],
  commands: { default: 'delegate', escalation: 'capability', baseline: true, sessionCache: true, rules: e2eRules },
}

const appCtx = new Context()
// dsh 0.1.5: the policy base class requires `sessionProjections` (it registers
// the `sandboxMode` projection while constructing) — see test/dry-mount.mjs.
appCtx.provide('sessionProjections', { register() {}, stateOf: () => undefined })
appCtx.provide('systemPrompt', { context() {} })
appCtx.provide('tools', {})
appCtx.provide('settings', {
  register(_ns, _schema, _options) {
    return { get: () => settingsSection, watch: () => () => {}, update: async () => {}, replace: async () => {} }
  },
})

const policyFiber = appCtx.plugin(PolicyPlugin, { mode: 'workspace-write', workspaceRoot: WORKSPACE })
await policyFiber

async function dispatchPre(tool, callId, command) {
  return appCtx.waterfall(appCtx, 'tools/pre-execute', { name: tool, callId, arguments: { command } }, () => Promise.resolve({ kind: 'allow' }))
}
async function dispatchApproval(req, fallback = 'unavailable') {
  return appCtx.waterfall(appCtx, 'approval/request', req, () => Promise.resolve(fallback))
}
const escalation = (callId, tool = 'pwsh', reason = 'escalate sandbox to danger-full-access: eslint spawns worker processes over pipes that workspace-write blocks with EPERM; this lint run needs the wider sandbox.') => ({ toolName: tool, callId, reason })

// an allow rule carries the escalation grant: the upgrade is auto-approved
await dispatchPre('pwsh', 'call-1', 'pnpm lint 2>&1 | Select-Object -Last 20')
assert.equal(await dispatchApproval(escalation('call-1')), 'allowed-once', 'the allow rule grants the escalation for its shape')

// the capability baseline auto-approves a read-only pipeline with no rules at all
await dispatchPre('pwsh', 'call-read', 'Get-ChildItem src -Recurse | Select-Object -First 5')
assert.equal(await dispatchApproval(escalation('call-read')), 'allowed-once', 'read-only pipeline auto-escalates by capability class')

// a rider statement outside every benign class keeps the stock prompt
const rider = escalation('call-2')
await dispatchPre('pwsh', 'call-2', 'pnpm lint 2>&1 | npx whoami')
assert.equal(await dispatchApproval(rider), 'unavailable', 'a rider statement blocks the automatic answer')
assert.match(rider.reason, /\[sandbox-allowlist\]/, 'the manual prompt carries the explanation')
assert.match(rider.reason, /未自动放行沙箱升级/, 'and says why it was not automatic')

// a noRead-protected target must never ride an escalation (the wider mode
// lifts the read fence)
await dispatchPre('bash', 'call-3', 'Get-Content ./id.pem')
assert.equal(await dispatchApproval(escalation('call-3', 'bash')), 'unavailable', 'noRead targets block the automatic answer')

// meta-program expansion: the repo's own `test` script runs `node test/test.mjs`
await dispatchPre('bash', 'call-4', 'pnpm test')
assert.equal(await dispatchApproval(escalation('call-4', 'bash')), 'unavailable', 'the resolved script body (an interpreter) blocks the escalation')

// non-escalation approvals are never auto-answered
await dispatchPre('pwsh', 'call-5', 'git status')
assert.equal(
  await dispatchApproval({ toolName: 'pwsh', callId: 'call-5', reason: 'sandbox-allowlist: command rule requires approval: git status' }),
  'unavailable',
  'non-escalation reason delegates',
)

// a manual approval is remembered for the session: the same command is not asked twice
const repeat = 'node scripts/verify.mjs --fix'
await dispatchPre('bash', 'call-6a', repeat)
assert.equal(await dispatchApproval(escalation('call-6a', 'bash'), 'allowed-once'), 'allowed-once', 'the user approves by hand')
await dispatchPre('bash', 'call-6b', repeat)
assert.equal(await dispatchApproval(escalation('call-6b', 'bash')), 'allowed-once', 'the same command is auto-approved for the rest of the session')

// repeating hand approvals produce a rule proposal (never applied automatically)
await dispatchPre('bash', 'call-7a', 'cargo fmt')
assert.equal(await dispatchApproval(escalation('call-7a', 'bash'), 'allowed-once'), 'allowed-once', 'first hand approval')
await dispatchPre('bash', 'call-7b', 'cargo fmt')
assert.equal(await dispatchApproval(escalation('call-7b', 'bash'), 'allowed-once'), 'allowed-once', 'second hand approval')
const proposals = appCtx.sandboxPolicy?._proposals?.proposals() ?? []
assert.ok(
  proposals.some((proposal) => proposal.program === 'cargo' && proposal.action === 'allow'),
  'a repeated hand approval yields an allow proposal',
)

// unknown call id / non-shell tool delegate
assert.equal(await dispatchApproval(escalation('call-nope')), 'unavailable', 'unknown call delegates')
assert.equal(await dispatchApproval({ ...escalation('call-1'), toolName: 'edit' }), 'unavailable', 'non-shell tool delegates')

console.log('verify-approval-gate: all assertions passed')
await policyFiber.dispose()
