/**
 * Command allow-list gate — the `tools/pre-execute` listener that turns
 * configured command rules into `allow` / `deny` / `ask` dispositions for the
 * shell tools (`bash`, `pwsh`).
 *
 * For every model tool call this gate matches the command string against the
 * configured rules (see command-rules.mjs, opencode/Claude-Code style):
 *
 *   - a rule with action `allow`  ⇒ return `{ kind: 'allow' }` — the call
 *     proceeds WITHOUT the downstream approval prompt;
 *   - a rule with action `deny`   ⇒ return `{ kind: 'deny', reason }` — block;
 *   - a rule with action `ask`    ⇒ return `{ kind: 'ask', reason }` — force a
 *     prompt through `ctx.approval`;
 *   - no rule matches            ⇒ `next()` — delegate, keeping whatever the
 *     deployment already does (the configured `default` or stock behavior).
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

export const name = 'dsh-sandbox-allowlist-command-gate'

/**
 * Prepare the `default` value when it is unset: keep stock behavior by
 * delegating (`next()`), which is modeled here as the sentinel `'delegate'`.
 * When `default` is `allow`/`ask`, unmatched commands resolve to that action;
 * `deny` blocks unmatched commands.
 */
const DELEGATE = 'delegate'

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
  const resolved = compileCommandRules(rules)(tool, command)
  const action = resolved === null ? defaultAction : resolved
  return dispositionForAction(action)
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
 * @param config - `{ getRuleSource: () => { rules, default? } }`. When absent,
 *   the gate is inert (delegates everything), which keeps a deployment that
 *   does not configure command rules on the exact stock path.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null

  // Register at the FRONT of the `tools/pre-execute` waterfall (like
  // dsh-tool-jobs does) so an `allow` rule short-circuits any downstream
  // ask-producing listener, and `deny`/`ask` rules are authoritative.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!SHELL_TOOLS.includes(exec.name)) return next()
    const command = exec.arguments?.command
    if (typeof command !== 'string' || command.trim().length === 0) return next()

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
