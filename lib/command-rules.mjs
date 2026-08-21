/**
 * Command allow-list rule engine for DSH shell tools (`bash`, `pwsh`).
 *
 * Modeled on the permission-rule design of opencode and Claude Code: each
 * rule binds an optional tool name to a command-string pattern and an action
 * (`allow` / `ask` / `deny`), and the LAST matching rule wins. Patterns are
 * matched against the normalized command string (`git status --porcelain`),
 * so a prefix rule like `git *` naturally ignores every argument after the
 * program — the "consider some arguments, ignore others" requirement.
 *
 * Vocabulary:
 *   - tool     — optional shell tool the rule applies to (`bash`, `pwsh`).
 *                Omitted ⇒ applies to every shell tool.
 *   - pattern  — command pattern; `*` matches any run of characters, `?`
 *                matches exactly one character. Everything else literal.
 *   - action   — `allow` (run without an approval prompt), `ask` (prompt),
 *                `deny` (block the command).
 *
 * This module is pure and side-effect free so it can be unit-tested without
 * a running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/command-rules
 */

/** The shell tools this allow-list operates on. */
export const SHELL_TOOLS = ['bash', 'pwsh']

/** Valid rule actions. */
export const COMMAND_ACTIONS = ['allow', 'ask', 'deny']

/** The fallback action when no rule matches ("keep current behavior"). */
export const DEFAULT_COMMAND_ACTION = 'ask'

const ACTION_SET = new Set(COMMAND_ACTIONS)

/**
 * Normalize a raw command string for matching: trim and collapse runs of
 * surrounding whitespace so `  git  status  ` and `git status` agree. Internal
 * argument spacing is collapsed too (double spaces between args are treated as
 * one), matching how a shell tokenizes whitespace-separated arguments. Quote
 * characters and their whitespace are preserved as-is — they are part of the
 * literal command text.
 * @param command - the raw command string.
 * @returns the normalized command, lower-cased on Windows (case-insensitive
 *   program names), or `''` when input is not a non-empty string.
 */
export function normalizeCommand(command) {
  if (typeof command !== 'string') return ''
  const trimmed = command.trim()
  if (trimmed.length === 0) return ''
  const collapsed = trimmed.replace(/[ \t]+/gu, ' ')
  return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed
}

/**
 * Translate one command pattern into a regular expression. `*` matches any
 * run of characters, `?` exactly one. Matching is anchored and, on Windows,
 * case-insensitive (program names are case-insensitive there).
 * @param pattern - a command pattern containing optional `*` / `?`.
 * @returns an anchored `RegExp` for the pattern.
 */
export function patternToCommandRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'iu' : 'u')
}

/**
 * Validate one command rule object. Returns a stringified validation issue or
 * `null` when the rule is well formed.
 * @param rule - a candidate rule (any shape).
 * @returns an error string, or `null` when valid.
 */
export function validateCommandRule(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    return `command rule must be an object, got ${JSON.stringify(rule)}`
  }
  if (rule.tool !== undefined && rule.tool !== null && !SHELL_TOOLS.includes(rule.tool)) {
    return `command rule tool must be one of ${SHELL_TOOLS.join(', ')} (or omitted), got ${JSON.stringify(rule.tool)}`
  }
  if (typeof rule.pattern !== 'string' || rule.pattern.trim().length === 0) {
    return `command rule pattern must be a non-empty string, got ${JSON.stringify(rule.pattern)}`
  }
  if (!ACTION_SET.has(rule.action)) {
    return `command rule action must be one of ${COMMAND_ACTIONS.join(', ')} (or omitted), got ${JSON.stringify(rule.action)}`
  }
  return null
}

/**
 * Compile a list of rules into a reusable matcher. The match operation is
 * last-match-wins and tool-aware: only rules whose `tool` matches the call's
 * tool (or whose `tool` is omitted) are considered.
 * @param rules - the configured rule list.
 * @returns a function `resolve(tool, command)` returning the winning action or
 *   `null` when no rule matches.
 */
export function compileCommandRules(rules) {
  const compiled = []
  for (const rule of rules) {
    const issue = validateCommandRule(rule)
    if (issue !== null) continue // skip malformed rules defensively
    compiled.push({
      tool: rule.tool ?? null,
      regex: patternToCommandRegExp(rule.pattern.trim()),
      action: rule.action,
      pattern: rule.pattern.trim(),
    })
  }
  /**
   * Resolve the effective action for one shell call.
   * @param tool - the shell tool name (`bash`, `pwsh`).
   * @param command - the raw (un-normalized) command string.
   * @returns the winning action, or `null` when no rule matches.
   */
  return (tool, command) => {
    const normalized = normalizeCommand(command)
    if (normalized === '') return null
    let winner = null
    for (const rule of compiled) {
      if (rule.tool !== null && rule.tool !== tool) continue
      if (rule.regex.test(normalized)) winner = rule.action
    }
    return winner
  }
}

/**
 * Resolve the effective disposition for one shell call, applying the
 * configured fallback when no rule matches. Thin convenience wrapper over
 * {@link compileCommandRules}.
 * @param rules - the configured rule list.
 * @param tool - the shell tool name.
 * @param command - the raw command string.
 * @param fallback - action used when no rule matches (defaults to the module
 *   `DEFAULT_COMMAND_ACTION`, meaning "delegate to downstream").
 * @returns the resolved action as a string.
 */
export function resolveCommandAction(rules, tool, command, fallback = DEFAULT_COMMAND_ACTION) {
  const resolved = compileCommandRules(rules)(tool, command)
  return resolved === null ? fallback : resolved
}
