/**
 * Read-restriction gate — the `tools/pre-execute` listener that turns
 * configured `noRead` rules into `deny` / `ask` dispositions for the
 * content-reading tools (`read`, `read_image`, `edit`), mirroring how the
 * command allow-list gate (command-gate.mjs) treats the shell tools.
 *
 *   - no rule matches        ⇒ `next()` — reading stays permitted (stock);
 *   - a `deny` rule matches  ⇒ `{ kind: 'deny', reason }` — the call is
 *     blocked before any file I/O, with the matched rule named;
 *   - an `ask` rule matches  ⇒ `{ kind: 'ask', reason }` — the pipeline runs
 *     the approval service; only `allowed-once` lets the call proceed (no
 *     approval service ⇒ the ask degrades to a denial, fail-closed). Once
 *     approved, the fs fence does NOT re-refuse: ask rules are enforced only
 *     at this gate, deny rules at both this gate AND the fs fence (fs.mjs).
 *
 * The `write` tool is intentionally absent from {@link NO_READ_TOOLS}:
 * creating a new file of a restricted format stays allowed, and overwriting
 * an existing one needs an existence check that lives in the fs fence
 * (writeText override), not here.
 *
 * Rules come from a `getRules` provider (the policy service / settings
 * namespace) and the enabled check from the deployment mode, so edits take
 * effect live without restart.
 */

import { NO_READ_TOOLS, compileNoReadRules, resolveNoRead } from './read-deny.mjs'

export const name = 'dsh-sandbox-allowlist-read-gate'

/** Sentinel meaning "no restriction applies — delegate downstream". */
export const DELEGATE = 'delegate'

/** Human-readable denial reason naming the matched rule. */
export function denyReason(filePath, pattern) {
  return `sandbox-allowlist: reading "${String(filePath).slice(0, 200)}" is blocked by the noRead rule "${pattern}" (deny). Remove it from the sandbox-allowlist.noRead settings to allow reading.`
}

/** Human-readable ask reason naming the matched rule. */
export function askReason(filePath, pattern) {
  return `sandbox-allowlist: reading "${String(filePath).slice(0, 200)}" matches the noRead rule "${pattern}" (ask) — approve this call to read it once.`
}

/**
 * Decide one tool call against the compiled rules.
 * @param compiled - output of `compileNoReadRules`.
 * @param tool - the tool name being called.
 * @param filePath - the call's `file_path` argument.
 * @returns `{ kind: 'deny'|'ask', reason }`, or the `DELEGATE` sentinel.
 */
export function decideNoRead(compiled, tool, filePath) {
  if (!NO_READ_TOOLS.includes(tool)) return DELEGATE
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return DELEGATE
  const hit = resolveNoRead(compiled, filePath)
  if (hit === null) return DELEGATE
  if (hit.action === 'deny') return { kind: 'deny', reason: denyReason(filePath, hit.pattern) }
  return { kind: 'ask', reason: askReason(filePath, hit.pattern) }
}

export const inject = ['tools']

/**
 * Plugin entry — registers the `tools/pre-execute` listener applying the
 * noRead rules to every content-reading tool call.
 * @param ctx - the cordis context.
 * @param config - `{ getRules: () => raw rule list, isEnabled: () => boolean }`.
 *   `getRules` is resolved lazily per call so settings edits take effect live;
 *   without a `getRules` function the gate is inert (delegates everything).
 */
export function apply(ctx, config = {}) {
  const getRules = typeof config.getRules === 'function' ? config.getRules : () => []
  const isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : () => true

  // Prepend like the command gate so a deny/ask decision is authoritative and
  // an ask is not swallowed by a downstream allow-producing listener.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!isEnabled()) return next()
    const decision = decideNoRead(compileNoReadRules(getRules()), exec.name, exec.arguments?.file_path)
    if (decision === DELEGATE) return next()
    return decision
  }, { prepend: true })
}
