/**
 * Auto-approval gate for sandbox escalation on fully allow-listed command
 * pipelines.
 *
 * Semantics (confirmed with the user, v0.2.0-beta.1+): an `allow` command rule
 * no longer only skips the pre-execute approval prompt — when a sandbox
 * escalation request (`escalate sandbox to <mode>: …`, raised by the bash/pwsh
 * tool's `approveEscalation` when the model retries a sandbox-denied command
 * with `sandbox_permissions`) is about a command whose EVERY pipeline / `;`
 * statement segment matches an `allow` rule, this gate answers the approval
 * request itself with `allowed-once`, so no approval window appears. Any
 * segment that is not explicitly `allow`-listed (or an unknown call, a
 * non-escalation reason, a non-shell tool) delegates via `next()`, keeping the
 * stock UI approval.
 *
 * Security note: `allowed-once` grants the escalation — the command then runs
 * with the requested wider mode (e.g. `danger-full-access`), i.e. OUTSIDE the
 * file/process sandbox. This is the confirmed trade-off: "allow" rules now
 * also lift sandbox constraints, and the multi-segment check is the guard —
 * a mixed pipeline (`pnpm lint | Remove-Item C:\*`) is never auto-approved
 * because the `Remove-Item` segment matches no allow rule.
 *
 * Correlation: the approval request carries the SAME `callId` the
 * `tools/pre-execute` listener saw (the tool passes `exec.callId` into
 * `approveEscalation`), so the gate records each shell call by `callId` in a
 * short-lived store and the approval listener looks the command back up.
 *
 * @module dsh-sandbox-allowlist/command-approval-gate
 */

import { SHELL_TOOLS, compileCommandRules } from './command-rules.mjs'
import { normalizeRuleSource } from './command-gate.mjs'

export const name = 'dsh-sandbox-allowlist-approval-gate'

/** Prefix of every sandbox-escalation approval reason (built by dsh-sandbox's `approveEscalation`). */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

/**
 * Split a command string into pipeline / statement segments on `|` and `;`
 * (PowerShell dialect), quote-aware: `|` and `;` inside double quotes
 * (respecting backtick escapes) or single quotes are literal text, not
 * separators. Empty segments (double separators like `||`) are dropped.
 * @param command - the raw command string.
 * @returns trimmed non-empty segments.
 */
export function splitCommandSegments(command) {
  const segments = []
  let current = ''
  let quote = null // '"' | "'" | null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote === '"') {
      current += ch
      if (ch === '`' && i + 1 < command.length) {
        current += command[i + 1]
        i += 1
      } else if (ch === '"') {
        quote = null
      }
      continue
    }
    if (quote === "'") {
      current += ch
      if (ch === "'") quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '|' || ch === ';') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/**
 * True when EVERY pipeline/statement segment of the command resolves to
 * `allow` under the given rules for the given tool. An empty segment list
 * (no command at all) is never allowed.
 * @param rules - the configured rule list (see command-rules.mjs).
 * @param tool - the shell tool name (`bash`, `pwsh`).
 * @param command - the raw command string.
 * @returns `true` only when every segment is allow-listed.
 */
export function pipelineFullyAllowed(rules, tool, command) {
  const segments = splitCommandSegments(command)
  if (segments.length === 0) return false
  const resolve = compileCommandRules(rules)
  return segments.every((segment) => resolve(tool, segment) === 'allow')
}

/**
 * Decide whether an escalation for this shell call should be auto-approved.
 * @param source - the current rule source (`{ rules, default? }`, see
 *   `normalizeRuleSource`).
 * @param tool - the shell tool name.
 * @param command - the raw command string.
 * @returns `true` when every pipeline segment is allow-listed.
 */
export function shouldAutoAllow(source, tool, command) {
  const { rules } = normalizeRuleSource(source)
  return pipelineFullyAllowed(rules, tool, command)
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
