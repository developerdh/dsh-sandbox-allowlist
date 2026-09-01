/**
 * Auto-approval gate for sandbox escalation on fully allow-listed command
 * pipelines.
 *
 * Semantics (v0.2.0-beta.2, P0-hardened per docs/设计评估-复合命令自动放行.md):
 * an `allow` command rule still skips the pre-execute approval prompt, and —
 * when a sandbox escalation request (`escalate sandbox to <mode>: …`, raised
 * by the bash/pwsh tool's `approveEscalation` after a sandbox-denied retry)
 * arrives for the SAME call — this gate answers `allowed-once` only when ALL
 * of the following hold:
 *
 *   1. shape guard (P0-2, `hasComplexStructure`): the command embeds no
 *      structure the statement tokenizer cannot vouch for — command
 *      substitution (`$(…)`), backticks, input/heredoc/process-substitution
 *      redirects, output redirects with a target beyond the harmless
 *      whitelist (`2>&1`, `>/dev/null`, `>$null`, `>NUL`), unbalanced quotes,
 *      or a leading env-assignment prefix;
 *   2. full-segment allow (`pipelineFullyAllowed`): every top-level statement
 *      segment — split on `;`, `|`, `&&`, `&`, `||`, and newlines, quote- and
 *      dialect-aware — resolves to `allow`, so a non-allow-listed rider can
 *      never piggyback on an allowed prefix command;
 *   3. high-risk baseline (P0-3, `hitsHighRiskBaseline`): no segment's
 *      program is an interpreter / program loader (bash, python, npx, env,
 *      xargs, iex, …) or a git protocol-injection attempt — configured allow
 *      rules cannot override this baseline.
 *
 * Any other request (non-escalation reason, non-shell tool, unknown callId,
 * failed guard/baseline/allow check) delegates via `next()`, keeping the
 * stock UI approval.
 *
 * Security note: `allowed-once` grants the escalation — the command then runs
 * with the requested wider mode (e.g. `danger-full-access`), i.e. OUTSIDE the
 * file/process sandbox. The guard + full-segment allow + baseline checks are
 * the compensating controls; a residual meta-program risk remains for
 * allow-listed `pnpm run` / `mvn` style programs until P1 splits `allow`
 * from `allow-escalate` (evaluation report §5.2, finding F5).
 *
 * Correlation: the approval request carries the SAME `callId` the
 * `tools/pre-execute` listener saw (the tool passes `exec.callId` into
 * `approveEscalation`), so the gate records each shell call by `callId` in a
 * short-lived store and the approval listener looks the command back up.
 *
 * @module dsh-sandbox-allowlist/command-approval-gate
 */

import { SHELL_TOOLS, compileCommandRules } from './command-rules.mjs'
import { splitCommandSegments, hasComplexStructure, hitsHighRiskBaseline } from './command-structure.mjs'
import { normalizeRuleSource } from './command-gate.mjs'

/** Re-exported for compatibility with existing imports/tests. */
export { splitCommandSegments } from './command-structure.mjs'

export const name = 'dsh-sandbox-allowlist-approval-gate'

/** Prefix of every sandbox-escalation approval reason (built by dsh-sandbox's `approveEscalation`). */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

/**
 * True when EVERY top-level statement segment of the command resolves to
 * `allow` under the given rules for the given tool. An empty segment list
 * (no command at all) is never allowed.
 * @param rules - the configured rule list (see command-rules.mjs).
 * @param tool - the shell tool name (`bash`, `pwsh`).
 * @param command - the raw command string.
 * @returns `true` only when every segment is allow-listed.
 */
export function pipelineFullyAllowed(rules, tool, command) {
  const segments = splitCommandSegments(command, tool)
  if (segments.length === 0) return false
  const resolve = compileCommandRules(rules)
  return segments.every((segment) => resolve(tool, segment) === 'allow')
}

/**
 * Decide whether an escalation for this shell call should be auto-approved:
 * shape guard + full-segment allow + high-risk baseline (see module docs).
 * @param source - the current rule source (`{ rules, default? }`, see
 *   `normalizeRuleSource`).
 * @param tool - the shell tool name.
 * @param command - the raw command string.
 * @returns `true` only when the command is guard-clean, fully allow-listed
 *   per segment, and free of baseline programs.
 */
export function shouldAutoAllow(source, tool, command) {
  const { rules } = normalizeRuleSource(source)
  if (hasComplexStructure(command)) return false
  const segments = splitCommandSegments(command, tool)
  if (segments.length === 0) return false
  if (hitsHighRiskBaseline(segments)) return false
  const resolve = compileCommandRules(rules)
  return segments.every((segment) => resolve(tool, segment) === 'allow')
}

export const inject = []

/**
 * Plugin entry — registers the `approval/request` answerer that auto-approves
 * sandbox escalations for fully allow-listed pipelines. Registered `prepend`
 * so it runs before the UI answerer; when it declines (returns `next()`), the
 * stock approval window appears unchanged.
 *
 * The call store is shared with the command gate (`apply` in
 * command-gate.mjs): the gate records `callId -> { tool, command }` at
 * `tools/pre-execute`, this listener consumes it by the request's `callId`.
 *
 * @param ctx - the cordis context.
 * @param config - `{ getRuleSource, callStore }`. `callStore` must be a `Map`;
 *   without it the gate is inert (delegates everything), keeping stock
 *   behavior for deployments that do not wire the pair.
 */
export function apply(ctx, config = {}) {
  const getRuleSource = typeof config.getRuleSource === 'function'
    ? config.getRuleSource
    : () => null
  const callStore = config.callStore
  if (!(callStore instanceof Map)) return

  ctx.on('approval/request', (req, next) => {
    if (!SHELL_TOOLS.includes(req.toolName)) return next()
    if (typeof req.reason !== 'string' || !req.reason.startsWith(ESCALATION_REASON_PREFIX)) return next()
    if (req.callId === undefined) return next()
    const record = callStore.get(req.callId)
    if (record === undefined) return next()
    if (shouldAutoAllow(getRuleSource(), record.tool, record.command)) return 'allowed-once'
    return next()
  }, { prepend: true })
}
