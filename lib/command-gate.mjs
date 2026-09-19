/**
 * Command allow-list gate — the `tools/pre-execute` listener that turns
 * configured command rules plus the built-in capability baseline into an
 * `allow` / `ask` / `deny` disposition for the shell tools (`bash`, `pwsh`).
 *
 * The decision itself lives in command-decision.mjs (one engine shared with
 * the escalation gate); this module is the cordis wiring:
 *
 *   - it records every shell call in a `callId -> { tool, command }` store so
 *     the escalation request of the SAME call can be correlated later
 *     (command-approval-gate.mjs consumes it);
 *   - it consults the session decision cache — a command the user already
 *     approved by hand in this session is not asked about again;
 *   - it writes every decision (verdict, reason, per-statement trace) into the
 *     shared audit log, which is what makes "why did this not auto-approve?"
 *     answerable after the fact.
 *
 * Disposition semantics (deny > ask > allow > default): an `allow` disposition
 * only skips the approval prompt — the command still runs inside the file
 * sandbox, so writes stay governed by the sandbox boundaries.
 */

import { SHELL_TOOLS, COMMAND_ACTIONS, validateCommandRule } from './command-rules.mjs'
import { DELEGATE, decide } from './command-decision.mjs'

export const name = 'dsh-sandbox-allowlist-command-gate'

export { DELEGATE }

/**
 * Cap on the shared `callId -> { tool, command }` store (FIFO eviction). The
 * store lives only long enough for the same call's escalation approval to
 * look it up, so a small bounded map is plenty; the cap just prevents a
 * runaway model loop from growing memory.
 */
export const CALL_STORE_CAP = 512

/**
 * Effective disposition for one rule action. `DELEGATE` means "hand the
 * decision to the next listener".
 * @param action - a rule action (`allow`, `ask`, `deny`).
 * @returns `{ kind }` or the `DELEGATE` sentinel.
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
 * listener; exported for direct testing and for the discussion probes.
 *
 * @param source - the current rule source (see {@link normalizeRuleSource}).
 * @param tool - the shell tool name (`bash`, `pwsh`).
 * @param command - the raw command string.
 * @param context - optional resolution context (see command-decision.mjs).
 * @returns a `PreToolDecision`-shaped result, or the `DELEGATE` sentinel.
 */
export function decideCommand(source, tool, command, context = {}) {
  if (!SHELL_TOOLS.includes(tool)) return DELEGATE
  const decision = decide({ source, tool, command, phase: 'sandbox', context })
  if (decision.verdict === DELEGATE) return DELEGATE
  // Bare disposition, matching the original contract: the listener builds the
  // user-facing reason itself (from the engine's richer decision).
  return { kind: decision.verdict }
}

/** Build a human-readable denial reason for a blocked command. */
export function denyReason(tool, command, detail) {
  const preview = typeof command === 'string' ? command.slice(0, 120) : String(command)
  const suffix = typeof detail === 'string' && detail.length > 0 ? ` — ${detail}` : ''
  return `sandbox-allowlist: the ${tool} command is blocked by a configured deny rule: "${preview}"${suffix}`
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
 * @param config - `{ getRuleSource, callStore?, getContext?, audit?, sessionCache? }`.
 *   When `getRuleSource` is absent the gate is inert (delegates everything),
 *   which keeps a deployment that does not configure command rules on the
 *   exact stock path. `callStore` (a `Map`) is the shared
 *   `callId -> { tool, command }` record consumed by the escalation gate.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null
  const callStore = config.callStore instanceof Map ? config.callStore : undefined
  const getContext = typeof config.getContext === 'function' ? config.getContext : () => ({})
  const audit = config.audit
  const sessionCache = config.sessionCache

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

    const cached = sessionCache?.lookup(exec.name, command)
    if (cached !== null && cached !== undefined) {
      audit?.record({
        phase: 'sandbox',
        tool: exec.name,
        command,
        verdict: 'allow',
        escalate: false,
        reason: '本会话中用户已手工批准过同一条命令（会话级缓存）',
      })
      return { kind: 'allow' }
    }

    const decision = decide({
      source: getRuleSource(),
      tool: exec.name,
      command,
      phase: 'sandbox',
      context: getContext(),
    })
    audit?.record({
      phase: 'sandbox',
      tool: exec.name,
      command,
      verdict: decision.verdict,
      escalate: decision.escalate,
      reason: decision.reason,
      trace: decision.trace,
    })
    if (decision.verdict === DELEGATE) return next()
    if (decision.verdict === 'ask') {
      return { kind: 'ask', reason: `sandbox-allowlist: command rule requires approval: ${command.trim().slice(0, 120)}` }
    }
    if (decision.verdict === 'deny') {
      return { kind: 'deny', reason: denyReason(exec.name, command, decision.reason) }
    }
    return { kind: 'allow' }
  }, { prepend: true })
}
