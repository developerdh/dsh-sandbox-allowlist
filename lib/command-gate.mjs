/**
 * Command allow-list gate — the `tools/pre-execute` listener that turns
 * configured command rules into `allow` / `deny` / `ask` dispositions for the
 * shell tools (`bash`, `pwsh`).
 *
 * For every model tool call this gate splits the command into top-level
 * statement segments (see command-structure.mjs — `;`, `|`, `&&`, `&`, `||`,
 * newlines, quote- and dialect-aware) and resolves each segment against the
 * configured rules (see command-rules.mjs, opencode/Claude-Code style), then
 * aggregates with deny > ask > allow > default:
 *
 *   - any segment `deny`          ⇒ return `{ kind: 'deny', reason }` — block;
 *   - else any segment `ask`      ⇒ return `{ kind: 'ask', reason }` — force a
 *     prompt through `ctx.approval`;
 *   - else every segment `allow`  ⇒ return `{ kind: 'allow' }` — the call
 *     proceeds WITHOUT the downstream approval prompt;
 *   - else (some segment unmatched) ⇒ the configured `default` action, where
 *     `delegate` means `next()` — keep whatever the deployment already does.
 *
 * Per-segment aggregation (P0-1 of the evaluation report) closes the evasion
 * where an allow prefix like `pnpm *` masked a `;`/`&&`-chained rider that a
 * deny rule was written for: `pnpm lint; whoami` now fires the `whoami *`
 * deny instead of the whole string matching `pnpm *`. This is the SAME
 * segmentation the escalation auto-approval gate uses, so both gates judge a
 * compound command identically.
 *
 * The `allow` disposition only bypasses the approval gate: the command still
 * runs under the file sandbox, so writes stay governed by the existing
 * sandbox boundaries. This matches the confirmed "skip the prompt only"
 * semantics.
 *
 * The rules come from a `getRules` provider (the policy service / settings
 * namespace), so edits take effect live without restart.
 */

import { SHELL_TOOLS, COMMAND_ACTIONS, compileCommandRules, validateCommandRule } from './command-rules.mjs'
import { splitCommandSegments } from './command-structure.mjs'

export const name = 'dsh-sandbox-allowlist-command-gate'

/**
 * Prepare the `default` value when it is unset: keep stock behavior by
 * delegating (`next()`), which is modeled here as the sentinel `'delegate'`.
 * When `default` is `allow`/`ask`, unmatched commands resolve to that action;
 * `deny` blocks unmatched commands.
 */
const DELEGATE = 'delegate'

/**
 * Cap on the shared `callId -> { tool, command }` store (FIFO eviction). The
 * store lives only long enough for the same call's escalation approval to
 * look it up, so a small bounded map is plenty; the cap just prevents a
 * runaway model loop from growing memory.
 */
export const CALL_STORE_CAP = 512

/**
 * Effective disposition for one rule action once the `default` fallback has
 * been applied. `DELEGATE` means "hand the decision to the next listener".
 */
export function dispositionForAction(action) {
  if (action === 'allow') return { kind: 'allow' }
  if (action === 'deny') return { kind: 'deny' }
  if (action === 'ask') return { kind: 'ask' }
  return DELEGATE
}

/**
 * Rule source abstraction: a plain object (or the raw settings section) with
 * `rules` (array) and an optional `default` action.
 * @param source - the effective rule source.
 * @returns `{ rules, defaultAction }` with `defaultAction` in
 *   `['allow','ask','deny','delegate']` (defaults to `delegate`).
 */
export function normalizeRuleSource(source) {
  const rules = Array.isArray(source?.rules) ? source.rules : []
  const fallback = source?.default
  let defaultAction = DELEGATE
  if (COMMAND_ACTIONS.includes(fallback)) defaultAction = fallback
  return { rules, defaultAction }
}

/**
 * Apply the command allow-list to one tool call. Used by the pre-execute
 * listener; exported for direct testing.
 *
 * The command is split into top-level statement segments and each segment is
 * resolved independently; the aggregation is deny > ask > allow > default
 * (see the module docs). This closes the separator-based deny/ask evasion —
 * a command hidden after `;`, `&&`, `&`, `|`, or a newline is judged on its
 * own and can no longer ride through under an allow-listed prefix.
 *
 * @param source - the current rule source (see {@link normalizeRuleSource}).
 * @param tool - the shell tool name (`bash`, `pwsh`).
 * @param command - the raw command string.
 * @returns a `PreToolDecision`-shaped result to return from the listener, or
 *   a promise of it (sync here) — the caller resolves the `DELEGATE` sentinel
 *   by calling `next()`.
 */
export function decideCommand(source, tool, command) {
  if (!SHELL_TOOLS.includes(tool)) return DELEGATE
  const { rules, defaultAction } = normalizeRuleSource(source)
  const resolve = compileCommandRules(rules)
  const segments = splitCommandSegments(command, tool)
  if (segments.length === 0) {
    // Nothing segmentable (non-string / whitespace) — whole-string fallback.
    const action = resolve(tool, command)
    return dispositionForAction(action === null ? defaultAction : action)
  }
  let sawAsk = false
  let sawUnmatched = false
  for (const segment of segments) {
    const action = resolve(tool, segment)
    if (action === 'deny') return dispositionForAction('deny')
    if (action === 'ask') sawAsk = true
    if (action === null) sawUnmatched = true
  }
  if (sawAsk) return dispositionForAction('ask')
  if (!sawUnmatched) return dispositionForAction('allow')
  return dispositionForAction(defaultAction)
}

/** Build a human-readable denial reason for a blocked command. */
export function denyReason(tool, command) {
  const preview = typeof command === 'string' ? command.slice(0, 120) : String(command)
  return `sandbox-allowlist: the ${tool} command is blocked by a configured deny rule: "${preview}"`
}

/** Optional helper exposed for schema/runtime validation messaging. */
export { validateCommandRule }

export const inject = ['tools']

/**
 * Plugin entry — registers the `tools/pre-execute` listener that applies the
 * command allow-list to every shell-tool call.
 *
 * The rule source is resolved lazily on each call through `getRuleSource()`
 * (supplied by the caller, typically the policy service / settings namespace),
 * so edits to the command rules take effect live without restart.
 *
 * @param ctx - the cordis context.
 * @param config - `{ getRuleSource: () => { rules, default? }, callStore? }`.
 *   When absent, the gate is inert (delegates everything), which keeps a
 *   deployment that does not configure command rules on the exact stock path.
 *   `callStore` (a `Map`) is the shared `callId -> { tool, command }` record
 *   consumed by the escalation auto-approval gate (command-approval-gate.mjs):
 *   each shell call is recorded here so the approval request of the SAME call
 *   can be correlated by `callId` and checked against the allow rules.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null
  const callStore = config.callStore instanceof Map ? config.callStore : undefined

  // Register at the FRONT of the `tools/pre-execute` waterfall (like
  // dsh-tool-jobs does) so an `allow` rule short-circuits any downstream
  // ask-producing listener, and `deny`/`ask` rules are authoritative.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!SHELL_TOOLS.includes(exec.name)) return next()
    const command = exec.arguments?.command
    if (typeof command !== 'string' || command.trim().length === 0) return next()

    // Correlate this call for the escalation auto-approval gate: record the
    // command under the same callId the tool passes into `approveEscalation`.
    if (callStore !== undefined && exec.callId !== undefined) {
      if (callStore.size >= CALL_STORE_CAP) {
        const oldest = callStore.keys().next().value
        if (oldest !== undefined) callStore.delete(oldest)
      }
      callStore.set(exec.callId, { tool: exec.name, command })
    }

    const disposition = decideCommand(getRuleSource(), exec.name, command)
    if (disposition === DELEGATE) return next()
    if (disposition.kind === 'ask') {
      return {
        kind: 'ask',
        reason: `sandbox-allowlist: command rule requires approval: ${command.trim().slice(0, 120)}`,
      }
    }
    if (disposition.kind === 'deny') {
      return { kind: 'deny', reason: denyReason(exec.name, command) }
    }
    return disposition // { kind: 'allow' }
  }, { prepend: true })
}
