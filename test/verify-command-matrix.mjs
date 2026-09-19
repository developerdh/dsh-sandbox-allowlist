/**
 * Adversarial regression matrix for the command gates.
 *
 * This is the consolidated, asserted form of the two discussion probes
 * (`probe-fallback-reasons.mjs`, `probe-capability-classes.mjs`) plus the
 * 20-case corpus of docs/temp/设计评估-复合命令自动放行.md §2.2. Every row
 * carries the verdict BOTH phases must return, so a future change to the
 * tokenizer, the capability tables or the escalation policy that widens or
 * narrows a decision fails here loudly.
 *
 * Canary discipline (report §2.1): the corpus uses only harmless read-only
 * riders (`whoami`) and never executes anything — the whole file is pure
 * string matching plus the injected manifest reader.
 *
 * Run from the package root:
 *   node test/verify-command-matrix.mjs
 */
import assert from 'node:assert/strict'
import { decide } from '../lib/command-decision.mjs'
import { makeScriptExpander } from '../lib/command-expand.mjs'

const WORKSPACE = 'D:/Repo'
const context = { roots: [WORKSPACE], cwd: WORKSPACE }

/** The rule set of the evaluation report §2.2, plus an argv-level pair. */
const rules = [
  { pattern: 'pnpm *', action: 'allow' },
  { pattern: 'echo *', action: 'allow' },
  { pattern: 'git *', action: 'allow' },
  { tool: 'pwsh', pattern: 'Select-Object *', action: 'allow' },
  { pattern: 'whoami*', action: 'deny' },
]
const source = { rules, default: 'delegate', escalation: 'capability', baseline: true }

/** A workspace manifest for the meta-program expansion rows. */
const manifest = JSON.stringify({
  scripts: { deploy: 'sh ./deploy.sh', docs: 'git log --oneline -5', test: 'vitest run' },
})
const expandScript = makeScriptExpander({ workspaceRoot: WORKSPACE, readFile: () => manifest, onWarn: () => {} })
const withScripts = { ...context, expandScript }

/**
 * One matrix row.
 * @typedef {[tool: string, command: string, sandbox: string, escalation: boolean|'auto', note: string]}
 */
const rows = [
  // ── the evaluation report's original corpus ──────────────────────────────
  // Since the single-layer `allow` (a rule grant includes the escalation
  // authorization), every rule-matched row flips the escalation column to
  // AUTO — that is the documented cost of a wide pattern, not a bug. The
  // SANDBOX column is the strong invariant: single-layer allow only affects
  // the escalation phase.
  ['pwsh', 'pnpm lint', 'allow', true, '#1 single command: rule-matched, and the rule carries the escalation grant'],
  ['pwsh', 'pnpm lint 2>&1 | Select-Object -Last 20', 'allow', true, '#2 benign pipeline: both statements ruled'],
  ['bash', 'pnpm lint > ./escape-probe.txt', 'allow', true, '#3 in-workspace redirect: rule-matched'],
  ['pwsh', 'pnpm lint && whoami', 'deny', false, '#4 deny rule reaches the rider (was a full both-gate bypass)'],
  ['bash', 'pnpm lint && whoami', 'deny', false, '#5 same in bash'],
  ['bash', 'pnpm lint & whoami', 'deny', false, '#6 single & is a separator'],
  ['bash', 'pnpm lint\nwhoami', 'deny', false, '#7 newline separation is explicit (no reliance on regex details)'],
  ['bash', 'echo $(whoami)', 'deny', false, '#8 the substitution body is judged, so the deny rule bites inside it'],
  ['bash', 'echo `whoami`', 'deny', false, '#9 bash backticks are substitutions'],
  ['pwsh', 'Write-Output $(whoami)', 'deny', false, '#10 pwsh subexpression, same treatment'],
  ['bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', 'allow', true, '#11 ⚠️ wide `git *` rule covers git-as-loader too — a wide pattern grants what the capability table would refuse'],
  ['bash', 'pnpm lint; whoami', 'deny', false, '#12 ; chain: the deny rule is no longer masked by the allow prefix'],
  ['bash', 'pnpm lint || whoami', 'deny', false, '#13 || chain'],
  ['bash', 'pnpm lint |& whoami', 'deny', false, '#14 |& chain'],
  ['bash', 'FOO=bar pnpm lint', 'allow', true, '#15 the env prefix withholds only the capability baseline, never a written rule'],
  ['bash', 'pnpm run deploy', 'allow', true, '#16 meta-program unexpanded: rule-matched (the wide-pattern cost)'],
  ['bash', 'npx some-pkg', 'delegate', false, '#17 no rule matches; nothing is granted'],
  ['bash', 'pnpm lint && pnpm typecheck', 'allow', true, '#18 both statements ruled'],
  ['bash', 'pnpm lint &', 'allow', true, '#19 trailing background &'],
  ['bash', 'pnpm lint 2>&1', 'allow', true, '#20 harmless fd duplication'],

  // ── capability baseline: what works WITHOUT any rule ─────────────────────
  ['bash', 'git status --porcelain && git log --oneline -3', 'allow', true, 'read-only chain auto-escalates (by class and by rule)'],
  ['pwsh', 'Get-ChildItem src -Recurse | Where-Object { $_.Length -gt 1000 } | Select-Object -First 5', 'allow', true, 'a pwsh pipeline needs no cmdlet enumeration'],
  ['bash', 'cat <<EOF > ./notes.md\nhello\nEOF\n', 'allow', true, 'a heredoc plus an in-workspace redirect'],
  ['bash', 'echo $(date +%F)', 'allow', true, 'a benign substitution no longer blocks the upgrade'],
  ['bash', 'git add -A && git commit -m "x"', 'allow', true, 'local repository mutation inside the workspace'],

  // ── escalation refusals that must stay refusals ──────────────────────────
  // The rails below bind EVEN when a rule matches (rails precede rules in the
  // escalation gate): unresolved structures, out-of-scope paths, noRead.
  ['bash', 'git push origin main', 'allow', true, 'network, but rule-matched: `git *` carries the escalation grant'],
  ['bash', 'rm -rf ./build', 'delegate', false, 'destructive: unmatched by rules, never escalated'],
  ['bash', 'node scripts/build.mjs', 'delegate', false, 'interpreter: opaque, no rule'],
  ['bash', 'git config --global user.name x', 'allow', false, 'rail: the ~/.gitconfig write is outside the workspace, rules cannot override'],
  ['bash', 'mkdir D:/Elsewhere/x', 'delegate', false, 'rail: writes outside the workspace'],
  ['bash', 'diff <(whoami) x', 'delegate', false, 'process substitution stays unresolved (fail-closed)'],
  ['bash', 'pnpm lint "unbalanced', 'delegate', false, 'unbalanced quotes stay unresolved'],
  ['bash', 'git reset --hard HEAD~1', 'allow', true, 'destructive git flag, but rule-matched (the wide-pattern cost)'],
  ['bash', 'cat D:/Elsewhere/secret.txt', 'delegate', false, 'rail: an out-of-scope path keeps even a read off the escalation path'],
  ['bash', 'git log --output=D:/Elsewhere/log.txt', 'allow', false, 'rail: the --output target is outside the roots'],
  ['bash', 'uniq ./a.txt D:/Elsewhere/out.txt', 'delegate', false, "rail: uniq's second positional argument is an output file"],

  // ── meta-program expansion: the body decides ─────────────────────────────
  // The container's own `pnpm *` allow is inherited by its body statements,
  // so expansion no longer withholds the escalation — a wide pnpm rule grants
  // every script body it expands to.
  ['bash', 'pnpm docs', 'allow', true, 'expanded to `git log`: benign body'],
  ['bash', 'pnpm deploy', 'allow', true, 'expanded to `sh ./deploy.sh`: the inherited allow covers the body too'],
  ['bash', 'pnpm test', 'allow', true, 'expanded to `vitest run`: same inheritance'],

  // ── label laundering: things that look like a read but are not ───────────
  ['bash', 'cat ./notes.md', 'allow', true, 'an in-scope read still auto-escalates (the common case must survive)'],
  ['bash', 'yq -i .a ./f.yml', 'allow', true, 'yq -i writes in place, inside the workspace'],
  ['bash', "sed '1e whoami' ./f.txt", 'delegate', false, 'sed scripts can execute (e) and write (w/r): opaque, no rule'],
  ['bash', 'pnpm config set registry https://example.com', 'allow', true, 'the ~/.npmrc write is implicit (not a named path), so the rule grant applies'],
  ['bash', 'git difftool --tool=x', 'allow', true, 'difftool launches an external program, but rule-matched'],
]

const pad = (value, width) => String(value).padEnd(width)
console.log(`${pad('tool', 6)}${pad('sandbox', 10)}${pad('escalation', 12)}command`)
console.log('-'.repeat(120))

let failures = 0
const contextual = (command) =>
  /^pnpm (docs|deploy|test)\b/.test(command) ? withScripts : context
for (const [tool, command, expectedSandbox, expectedEscalation, note] of rows) {
  const decisionContext = contextual(command)
  const sandbox = decide({ source, tool, command, phase: 'sandbox', context: decisionContext })
  const escalation = decide({ source, tool, command, phase: 'escalation', context: decisionContext })
  const sandboxLabel = sandbox.verdict
  const escalationLabel = escalation.escalate ? 'AUTO' : 'manual'
  const ok = sandboxLabel === expectedSandbox && escalation.escalate === expectedEscalation
  if (!ok) failures += 1
  console.log(`${pad(ok ? ' ' : '!', 6)}${pad(sandboxLabel, 10)}${pad(escalationLabel, 12)}${command.replace(/\n/g, '\\n')}`)
  assert.equal(
    sandboxLabel,
    expectedSandbox,
    `[${note}] sandbox verdict for ${tool} ${JSON.stringify(command)}`,
  )
  assert.equal(
    escalation.escalate,
    expectedEscalation,
    `[${note}] escalation verdict for ${tool} ${JSON.stringify(command)}`,
  )
}
console.log('-'.repeat(120))
console.log(`verify-command-matrix: ${rows.length} rows, ${failures} mismatches (0 expected)`)
