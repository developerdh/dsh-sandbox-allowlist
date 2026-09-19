/**
 * Auto-approval gate for sandbox escalation, plus the two "layer 0"
 * behaviours that live on this path: explaining a manual prompt and learning
 * the rules the user keeps approving by hand.
 *
 * An `allow` command rule skips the pre-execute approval prompt AND carries
 * the escalation grant: the bash/pwsh tool may retry the same call with
 * `sandbox_permissions` (e.g. `danger-full-access`), and the command then runs
 * OUTSIDE the file and process sandbox. This gate answers that request with
 * `allowed-once` only when command-decision.mjs says so — i.e. when every
 * statement the command really executes is covered by an `allow` rule or is a
 * benign capability class (`read`, or a `local-write` whose targets stay
 * inside the workspace ∪ granted roots) — with no deny/ask rule, no unresolved
 * structure, no out-of-scope path (redirects included), and no reference to a
 * noRead-restricted path (an escalation also lifts the read fence). Those
 * rails bind even an explicit `allow` rule.
 *
 * Everything else delegates via `next()`, which keeps the stock approval UI —
 * but with the gate's analysis appended to the prompt, so the user sees WHY it
 * was not automatic and which rule would have avoided it. When the user then
 * approves by hand, this listener remembers the exact command for the rest of
 * the session (no repeat prompt for the same retry) and counts the shape
 * toward a rule proposal (never applied automatically).
 *
 * Correlation: the approval request carries the SAME `callId` the
 * `tools/pre-execute` listener saw (the tool passes `exec.callId` into
 * `approveEscalation`), so the gate records each shell call by `callId` in a
 * short-lived store and the approval listener looks the command back up.
 *
 * @module dsh-sandbox-allowlist/command-approval-gate
 */

import { SHELL_TOOLS, compileCommandRules } from './command-rules.mjs'
import { DELEGATE, decide } from './command-decision.mjs'
import { analyzeCommand } from './command-analyze.mjs'

export const name = 'dsh-sandbox-allowlist-approval-gate'

/** Prefix of every sandbox-escalation approval reason (built by dsh-sandbox's `approveEscalation`). */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

/** Marker inserted before the explanation so a re-entry never appends twice. */
const EXPLANATION_MARKER = '[sandbox-allowlist]'

/** Re-exported for compatibility with existing imports/tests. */
export { splitCommandSegments } from './command-structure.mjs'

/**
 * True when EVERY top-level statement of the command is matched by an
 * `allow` rule. Kept as a narrow primitive: it answers "would the rules alone
 * cover this command?", independent of the capability baseline and of the
 * escalation mode. An empty statement list is never allowed.
 * @param rules - the configured rule list.
 * @param tool - the shell tool name.
 * @param command - the raw command string.
 * @param context - optional resolution context (see command-decision.mjs).
 * @returns `true` only when every top-level statement is allow-listed.
 */
export function pipelineFullyAllowed(rules, tool, command, context = {}) {
  const analysis = analyzeCommand(command, tool, { inScope: context.inScope })
  const topLevel = analysis.statements.filter((statement) => statement.source !== 'script')
  if (topLevel.length === 0) return false
  const resolve = compileCommandRules(rules)
  return topLevel.every((statement) => resolve(tool, statement) === 'allow')
}

/**
 * Decide whether an escalation for this shell call should be auto-approved.
 * Thin wrapper over the shared engine's escalation phase.
 * @param source - the current rule source.
 * @param tool - the shell tool name.
 * @param command - the raw command string.
 * @param context - optional resolution context (see command-decision.mjs).
 * @returns `true` only when the escalation may be auto-approved.
 */
export function shouldAutoAllow(source, tool, command, context = {}) {
  return decide({ source, tool, command, phase: 'escalation', context }).escalate === true
}

/**
 * Build the explanation appended to a manual escalation prompt.
 * @param decision - the escalation-phase decision.
 * @returns the text to append (without the leading newline), or `null`.
 */
export function explainForPrompt(decision) {
  const lines = [`${EXPLANATION_MARKER} 未自动放行沙箱升级：${decision?.reason ?? '未知原因'}`]
  const statements = decision?.trace?.statements ?? []
  if (statements.length > 0) {
    lines.push(`命令分解：${statements.map((statement) => `${statement.text} [${statement.kind}]`).join(' | ')}`)
  }
  const suggestions = decision?.trace?.suggestions ?? []
  if (suggestions.length > 0) {
    lines.push(`如确认可信，可在「沙箱授权 → 命令规则」添加规则（allow = 放行，且允许该命令在沙箱外运行）：${suggestions.slice(0, 2).join(' ; ')}`)
  }
  return lines.join('\n')
}

export const inject = []

/**
 * Plugin entry — registers the `approval/request` answerer.
 *
 * @param ctx - the cordis context.
 * @param config - `{ getRuleSource, callStore, getContext?, audit?, sessionCache?, proposals? }`.
 *   `callStore` must be a `Map`; without it the gate is inert (delegates
 *   everything), keeping stock behavior for deployments that do not wire the
 *   pair.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null
  const callStore = config.callStore
  if (!(callStore instanceof Map)) return
  const getContext = typeof config.getContext === 'function' ? config.getContext : () => ({})
  const audit = config.audit
  const sessionCache = config.sessionCache
  const proposals = config.proposals

  ctx.on('approval/request', async (req, next) => {
    if (!SHELL_TOOLS.includes(req.toolName)) return next()
    if (typeof req.reason !== 'string' || !req.reason.startsWith(ESCALATION_REASON_PREFIX)) return next()
    if (req.callId === undefined) return next()
    const record = callStore.get(req.callId)
    if (record === undefined) return next()
    const context = getContext()

    // The decision is always computed, even when the session cache will answer:
    // the trace feeds the audit log, and a repeating command is exactly the
    // signal the rule-proposal counter is built on.
    const decision = decide({
      source: getRuleSource(),
      tool: record.tool,
      command: record.command,
      phase: 'escalation',
      context,
    })
    audit?.record({
      phase: 'escalation',
      tool: record.tool,
      command: record.command,
      verdict: decision.verdict,
      escalate: decision.escalate,
      reason: decision.reason,
      trace: decision.trace,
    })
    if (decision.escalate === true) return 'allowed-once'

    const cached = sessionCache?.lookup(record.tool, record.command)
    if (cached !== null && cached !== undefined) {
      noteProposals(ctx, proposals, record, decision)
      return 'allowed-once'
    }

    // Not automatic: explain the refusal in the prompt the user is about to
    // see. The approval audit event is appended by dsh-user-approval BEFORE
    // this waterfall runs, so annotating the request only changes what the
    // human (and the model) sees — never the recorded audit trail.
    if (typeof req.reason === 'string' && !req.reason.includes(EXPLANATION_MARKER)) {
      try {
        req.reason = `${req.reason}\n${explainForPrompt(decision)}`
      } catch {
        // A frozen request object is fine: the explanation is a nicety.
      }
    }

    const outcome = await next()
    if (outcome === 'allowed-once') {
      sessionCache?.remember(record.tool, record.command, { phase: 'escalation', reason: decision.reason })
      noteProposals(ctx, proposals, record, decision)
    }
    return outcome
  }, { prepend: true })
}

/**
 * Count one escalation approval (or an auto-answer from the session cache)
 * toward a rule proposal. The proposal is only ever REPORTED — applying it
 * stays a human decision in the settings page.
 * @param ctx - the cordis context (for the log line).
 * @param proposals - the shared {@link ProposalStore}, when configured.
 * @param record - the correlated `{ tool, command }` record.
 * @param decision - the escalation decision whose trace supplies the shapes.
 */
function noteProposals(ctx, proposals, record, decision) {
  if (proposals === undefined || proposals === null) return
  for (const statement of decision?.trace?.statements ?? []) {
    if (statement.kind === undefined || statement.text === undefined) continue
    const proposal = proposals.note({
      tool: record.tool,
      program: statement.program,
      rest: statement.rest,
      kind: statement.kind,
      phase: 'escalation',
      command: record.command,
    })
    if (proposal !== null && proposal !== undefined) {
      ctx.logger?.info?.(`sandbox-allowlist: 该命令形状已被批准 ${proposal.count} 次，可考虑添加规则 program="${proposal.program}" action="${proposal.action}"`)
    }
  }
}

export { DELEGATE }
