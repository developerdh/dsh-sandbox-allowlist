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
 * approves by hand, the shape is counted toward a rule proposal (never applied
 * automatically).
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

/** Statements previewed in the 命令分解 block before the rest is elided —
 * a huge compound command must not flood the approval prompt. */
const STATEMENT_PREVIEW_LIMIT = 10

/**
 * Build the explanation appended to a manual escalation prompt. One block per
 * concern; the statement breakdown FOCUSES on the statements that caused the
 * refusal (the rest are already escalatable and the full command is visible in
 * the prompt's command area below). The line structure IS the structure the
 * user sees — the prompt renders the text verbatim (pre-wrap).
 * @param decision - the escalation-phase decision.
 * @returns the text to append (without the leading newline), or `null`.
 */
export function explainForPrompt(decision) {
  const lines = [`${EXPLANATION_MARKER} 未自动放行沙箱升级：${decision?.reason ?? '未知原因'}`]
  const statements = decision?.trace?.statements ?? []
  if (statements.length > 0) {
    lines.push('命令分解：')
    // 聚焦导致拦截的语句（escalatable=false，附未放行原因）；其余语句已可自动
    // 升级，折叠为一行计数。守卫类拒绝（无法解析的结构/越界重定向/禁读目标）
    // 没有逐语句标记，回退为全量列表。
    const blockers = statements.filter((entry) => entry.escalatable === false)
    const rest = statements.filter((entry) => entry.escalatable !== false)
    const focus = blockers.length > 0 ? blockers : statements
    const shown = focus.slice(0, STATEMENT_PREVIEW_LIMIT)
    for (const entry of shown) {
      lines.push(`  · ${entry.text} [${entry.kind}]${entry.escalatable === false && entry.escalateWhy ? ` —— ${entry.escalateWhy}` : ''}`)
    }
    if (focus.length > shown.length) {
      lines.push(`  · …（其余 ${focus.length - shown.length} 条语句略）`)
    }
    if (blockers.length > 0 && rest.length > 0) {
      lines.push(`  · …（其余 ${rest.length} 条语句均可自动升级，完整命令见下方）`)
    }
  }
  const suggestions = decision?.trace?.suggestions ?? []
  if (suggestions.length > 0) {
    lines.push('如确认可信，可在「沙箱授权 → 命令规则」添加规则（allow = 放行，且允许该命令在沙箱外运行）：')
    for (const suggestion of suggestions.slice(0, 2)) {
      lines.push(`  · ${suggestion}`)
    }
  }
  return lines.join('\n')
}

export const inject = []

/**
 * Plugin entry — registers the `approval/request` answerer.
 *
 * @param ctx - the cordis context registering the listener.
 * @param config - `{ getRuleSource, callStore, getContext?, audit?, proposals? }`.
 *   `callStore` must be a `Map`; without it the gate is inert (delegates
 *   everything), keeping stock behavior for deployments that do not wire the
 *   pair.
 * @returns the listener disposer (or `undefined` when the gate is inert),
 *   owned by the caller: wrap this call in `ctx.effect(...)` so a plugin
 *   reload disposes the previous listener instead of stacking a duplicate.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null
  const callStore = config.callStore
  if (!(callStore instanceof Map)) return undefined
  const getContext = typeof config.getContext === 'function' ? config.getContext : () => ({})
  const audit = config.audit
  const proposals = config.proposals

  return ctx.on('approval/request', async (req, next) => {
    if (!SHELL_TOOLS.includes(req.toolName)) return next()
    if (typeof req.reason !== 'string' || !req.reason.startsWith(ESCALATION_REASON_PREFIX)) return next()
    if (req.callId === undefined) return next()
    const record = callStore.get(req.callId)
    if (record === undefined) return next()
    const context = getContext()

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

    // Not automatic: explain the refusal in the prompt the user is about to
    // see. The approval audit event is appended by dsh-user-approval BEFORE
    // this waterfall runs, so annotating the request only changes what the
    // human (and the model) sees — never the recorded audit trail.
    // dsh 0.2.0 renders `displayReason` OVER `reason` when present, and its
    // approveEscalation always supplies the localized pair for escalations —
    // an explanation riding `reason` alone never reaches the prompt.
    if (typeof req.reason === 'string' && !req.reason.includes(EXPLANATION_MARKER)) {
      const explanation = explainForPrompt(decision)
      // 空行分段：解释块与宿主本地化文案/代理说明之间留一空行，pre-wrap 下形成
      // 视觉段落边界。
      try {
        req.reason = `${req.reason}\n\n${explanation}`
      } catch {
        // A frozen request object is fine: the explanation is a nicety.
      }
      const display = req.displayReason
      if (typeof display === 'string') {
        if (!display.includes(EXPLANATION_MARKER)) {
          try {
            req.displayReason = `${display}\n\n${explanation}`
          } catch { /* frozen — same nicety rule */ }
        }
      } else if (display !== null && typeof display === 'object') {
        for (const key of Object.keys(display)) {
          if (typeof display[key] !== 'string' || display[key].includes(EXPLANATION_MARKER)) continue
          try {
            display[key] = `${display[key]}\n\n${explanation}`
          } catch { /* frozen — same nicety rule */ }
        }
      }
    }

    const outcome = await next()
    if (outcome === 'allowed-once') {
      noteProposals(ctx, proposals, record, decision)
    }
    return outcome
  }, { prepend: true })
}

/**
 * Count one escalation approval toward a rule proposal. The proposal is only
 * ever REPORTED — applying it stays a human decision in the settings page.
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
