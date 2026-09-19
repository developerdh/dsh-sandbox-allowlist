/**
 * Command allow-list rule engine for DSH shell tools (`bash`, `pwsh`).
 *
 * A rule binds an optional tool name to a command `pattern` and an action; the
 * LAST matching rule wins. The pattern is an opencode/Claude-Code style glob
 * over the whole normalized statement (`git *`, `git status*`, `rm -rf *`).
 *
 * A compound command is split into statements first (command-structure.mjs)
 * and each statement is judged on its own, so `pattern: 'git status*'` allows
 * `git status && git push` only for the first half. Program spelling is
 * normalized away BEFORE matching: the statement's first token is reduced to
 * its bare program name (quotes, directory part and Windows launcher suffixes
 * stripped), so `pattern: 'git *'` also matches
 * `"C:\Program Files\Git\git.exe" status`.
 *
 * Actions:
 *   - `allow` — run without the approval prompt, and a sandbox ESCALATION
 *     (the retry that would run the command outside the sandbox, e.g. with
 *     `danger-full-access`) for this shape is auto-approved too. One grant,
 *     one meaning: the paths a rule cannot override (unresolved structures,
 *     out-of-scope writes, noRead targets) stay gated by the decision engine.
 *   - `ask`   — force the approval prompt.
 *   - `deny`  — block the command.
 *
 * Vocabulary:
 *   - tool     — optional shell tool the rule applies to (`bash`, `pwsh`).
 *                Omitted ⇒ applies to every shell tool.
 *   - pattern  — whole-statement glob; `*` matches any run of characters,
 *                `?` exactly one. Everything else is literal.
 *
 * This module is pure and side-effect free so it can be unit-tested without a
 * running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/command-rules
 */

/** The shell tools this allow-list operates on. */
export const SHELL_TOOLS = ['bash', 'pwsh']

/** Valid rule actions. */
export const COMMAND_ACTIONS = ['allow', 'ask', 'deny']

/** The fallback action when no rule matches ("keep current behavior"). */
export const DEFAULT_COMMAND_ACTION = 'ask'

/** How an escalation may be auto-approved (settings `commands.escalation`). */
export const ESCALATION_MODES = ['capability', 'never']

/** Default escalation mode: benign capability classes plus explicit grants. */
export const DEFAULT_ESCALATION_MODE = 'capability'

/** Windows folds case for program names and command text; POSIX does not. */
const CASE_INSENSITIVE = process.platform === 'win32'

const ACTION_SET = new Set(COMMAND_ACTIONS)

/**
 * Normalize a raw command string for matching: trim and collapse runs of
 * whitespace so `  git  status  ` and `git status` agree. Internal argument
 * spacing is collapsed too (double spaces between args are treated as one),
 * matching how a shell tokenizes whitespace-separated arguments. Quote
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
  return CASE_INSENSITIVE ? collapsed.toLowerCase() : collapsed
}

/**
 * Reduce a program token to its comparable form: surrounding quotes removed,
 * directory part dropped, a Windows launcher suffix (`.exe`, `.cmd`, `.bat`,
 * `.ps1`) stripped, case folded on Windows.
 * @param token - the raw first token of a statement.
 * @returns the comparable program name (possibly `''`).
 */
export function normalizeProgram(token) {
  if (typeof token !== 'string') return ''
  let value = token.trim().replace(/^["']+|["']+$/g, '')
  value = value.split(/[\\/]/).pop() ?? value
  value = value.replace(/\.(exe|cmd|bat|ps1|com)$/i, '')
  return CASE_INSENSITIVE ? value.toLowerCase() : value
}

/**
 * Split a statement into its program and its argument text. A leading pwsh
 * call operator (`& prog`) is skipped, and a leading quoted program (a path
 * containing spaces, e.g. `"C:\Program Files\nodejs\pnpm.cmd" run build`) is
 * kept as one token. Other non-plain shapes simply yield the first token as
 * program, which the capability classifier treats as unknown (fail-closed).
 * @param statement - one statement (segment) of a compound command.
 * @returns `{ program, rest }` — comparable program name and argument text.
 */
export function splitProgram(statement) {
  if (typeof statement !== 'string') return { program: '', rest: '' }
  const trimmed = statement.trim()
  let call = trimmed
  if (call.startsWith('&')) call = call.slice(1).trim() // pwsh call operator
  const quote = call[0]
  if (quote === '"' || quote === "'") {
    const end = call.indexOf(quote, 1)
    if (end !== -1) {
      return {
        program: normalizeProgram(call.slice(0, end + 1)),
        rest: call.slice(end + 1).trim(),
      }
    }
  }
  const tokens = call.split(/[ \t]+/)
  return {
    program: normalizeProgram(tokens[0] ?? ''),
    rest: tokens.slice(1).join(' '),
  }
}

/**
 * A statement descriptor: the unit both the rule engine and the capability
 * classifier judge. Produced by {@link describeStatement} (and by the command
 * analyzer, which adds class/redirect information on top).
 *
 * `normalized` — what command patterns match against — has the program token
 * reduced to its comparable form first, so `git status` and
 * `"C:\Program Files\Git\git.exe" status` share one normalized text.
 * `rest` keeps its ORIGINAL case because capability classification has to
 * read case-sensitive flags (`git branch -D` deletes, `-d` does not; `sort -o`
 * writes, `-O` does not). `restNormalized` is the case-folded argument text.
 *
 * @typedef {object} StatementDescriptor
 * @property {string} text - the statement text as written.
 * @property {string} normalized - program-normalized, whitespace-collapsed,
 *   case-folded text.
 * @property {string} program - comparable program name (see {@link normalizeProgram}).
 * @property {string} rest - argument text as written.
 * @property {string} restNormalized - whitespace-collapsed, case-folded arguments.
 */

/**
 * Build the descriptor the rule engine matches against.
 * @param statement - one statement of a compound command.
 * @returns {StatementDescriptor}
 */
export function describeStatement(statement) {
  const { program, rest } = splitProgram(statement)
  const restNormalized = normalizeCommand(rest)
  const normalized = program.length > 0
    ? (restNormalized.length > 0 ? `${program} ${restNormalized}` : program)
    : normalizeCommand(statement)
  return {
    text: typeof statement === 'string' ? statement.trim() : '',
    normalized,
    program,
    rest,
    restNormalized,
  }
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
  return new RegExp(`^${source}$`, CASE_INSENSITIVE ? 'iu' : 'u')
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
    return `command rule needs a non-empty "pattern", got ${JSON.stringify(rule.pattern)}`
  }
  if (!ACTION_SET.has(rule.action)) {
    return `command rule action must be one of ${COMMAND_ACTIONS.join(', ')} (or omitted), got ${JSON.stringify(rule.action)}`
  }
  return null
}

/**
 * Whether a compiled rule matches one statement.
 * @param rule - a compiled rule entry.
 * @param tool - the shell tool name.
 * @param descriptor - the statement descriptor (see {@link describeStatement}).
 * @returns `true` when the rule selects this statement.
 */
function ruleMatches(rule, tool, descriptor) {
  if (rule.tool !== null && rule.tool !== tool) return false
  return rule.pattern !== null && rule.pattern.test(descriptor.normalized)
}

/**
 * Compile a list of rules into a reusable matcher. Matching is
 * last-match-wins and tool-aware: only rules whose `tool` matches the call's
 * tool (or whose `tool` is omitted) are considered.
 *
 * The returned resolver accepts either a raw statement string (legacy call
 * style, normalized internally) or a prebuilt {@link StatementDescriptor}.
 *
 * @param rules - the configured rule list.
 * @returns a function `resolve(tool, statement)` returning the winning action
 *   or `null` when no rule matches.
 */
export function compileCommandRules(rules) {
  const compiled = []
  for (const rule of (Array.isArray(rules) ? rules : [])) {
    const issue = validateCommandRule(rule)
    if (issue !== null) continue // skip malformed rules defensively
    compiled.push({
      tool: rule.tool ?? null,
      pattern: patternToCommandRegExp(rule.pattern.trim()),
      action: rule.action,
      source: rule,
    })
  }
  /**
   * Resolve the effective action for one statement.
   * @param tool - the shell tool name (`bash`, `pwsh`).
   * @param statement - a statement string or a {@link StatementDescriptor}.
   * @returns the winning action, or `null` when no rule matches.
   */
  return (tool, statement) => {
    const descriptor = typeof statement === 'string' ? describeStatement(statement) : statement
    if (descriptor === null || descriptor === undefined || descriptor.normalized === '') return null
    let winner = null
    for (const rule of compiled) {
      if (ruleMatches(rule, tool, descriptor)) winner = rule.action
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

/**
 * Human-readable rendering of one rule, used in decision traces and in the
 * approval prompt ("which rule matched").
 * @param rule - the raw rule object.
 * @returns a short label such as `pwsh pattern "git *"`.
 */
export function describeRule(rule) {
  if (rule === null || typeof rule !== 'object') return '(invalid rule)'
  const tool = typeof rule.tool === 'string' ? `${rule.tool} ` : ''
  return `${tool}pattern "${rule.pattern}"`
}
