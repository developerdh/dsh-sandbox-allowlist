/**
 * Command analysis: turn one raw shell command string into the set of
 * statements it actually executes, each with a capability class.
 *
 * This replaces the blanket "shape guard" that used to reject every command
 * containing `$( … )`, a backtick, any `<`, a redirect with a target, or a
 * leading `FOO=bar` assignment (see docs/temp/设计评估-复合命令自动放行.md
 * §5.1 P0-2). Those shapes are the ones agents emit most often, and rejecting
 * them wholesale is what made the allow-list feel useless. Here they are
 * RESOLVED instead of refused:
 *
 *   - `$( … )` / bash backticks — the inner command is analyzed recursively and
 *     judged by the same rules, so `git commit -m "$(date +%F)"` is judged as
 *     `git commit …` plus `date` (both benign) rather than as one opaque blob;
 *   - output/input redirects — the target is resolved against the workspace ∪
 *     granted roots, so `> ./out.txt` (already sandbox-legal) passes while
 *     `> C:\Windows\Temp\x` does not;
 *   - heredoc bodies — recognized as data and removed before analysis (a
 *     heredoc whose command line is a shell is already `opaque`);
 *   - `FOO=bar cmd` — assignments are stripped, recorded, and treated as a
 *     reason to withhold auto-approval of a sandbox escalation.
 *
 * What cannot be resolved stays fail-closed: the analyzer reports it in
 * `unresolved`, and any unresolved structure means "never auto-approve".
 * Deliberately NOT resolved, hence always unresolved:
 *
 *   - process substitution (`<( … )`, `>( … )`) and arithmetic substitution
 *     (`$(( … ))`) — their evaluation model is outside statement analysis;
 *   - unbalanced quotes, unterminated substitutions, nesting beyond
 *     `maxDepth`.
 *
 * Script blocks (`{ … }`) are not a special case: a script block used as an
 * ARGUMENT (`Where-Object { $_.Length -gt 1 }`) stays a plain argument, while
 * a bare `& { … }` statement has `{` as its program and therefore classifies
 * as `unknown` (prompt).
 *
 * The module is pure; the one impure input (reading a workspace manifest to
 * expand `pnpm run <script>`, finding F5/§5.2 C2 of the evaluation report) is
 * injected as `options.expandScript`.
 *
 * @module dsh-sandbox-allowlist/command-analyze
 */

import { splitCommandSegments } from './command-structure.mjs'
import { describeStatement } from './command-rules.mjs'
import { classifyStatement, pathTokens } from './command-classes.mjs'

/** Recursion budget for substitutions and script expansion. */
export const DEFAULT_MAX_DEPTH = 3

/** Harmless fd-duplication redirects, masked before scanning. */
const FD_DUPLICATION = /\d?>&\d/g

/** Placeholder that survives scanning and is restored in the cleaned text. */
const MASK = '\u0001'

/**
 * Reason codes an unresolved structure can carry.
 * @type {Readonly<Record<string, string>>}
 */
export const UNRESOLVED = Object.freeze({
  PROCESS_SUBSTITUTION: 'process-substitution',
  ARITHMETIC: 'arithmetic-substitution',
  UNBALANCED_QUOTES: 'unbalanced-quotes',
  UNTERMINATED_SUBSTITUTION: 'unterminated-substitution',
  DEPTH: 'depth-exceeded',
  EMPTY: 'nothing-to-analyze',
})

/**
 * The escape char that pairs with the next character for a shell dialect.
 * @param tool - `bash` or `pwsh`.
 * @returns the escape character.
 */
function escapeCharFor(tool) {
  return tool === 'bash' ? '\\' : '`'
}

/**
 * Whether a quoted span permits command substitution in this dialect: bash
 * substitutes inside double quotes (not single), pwsh substitutes inside
 * double quotes (not single).
 * @param quote - the active quote character or `null`.
 * @returns `true` when substitutions are live in the current span.
 */
function substitutionLiveIn(quote) {
  return quote === null || quote === '"'
}

/**
 * Try to read a command substitution starting at `index`.
 * @param command - the command text.
 * @param index - the index of the candidate `$` or backtick.
 * @param tool - the shell dialect.
 * @param issues - collector for unresolved structures.
 * @returns `{ body, end }` where `end` is the index of the last character of
 *   the substitution, or `null` when there is no substitution here.
 */
function trySubstitution(command, index, tool, issues) {
  const ch = command[index]
  if (ch === '`' && tool === 'bash') {
    const end = command.indexOf('`', index + 1)
    if (end === -1) {
      issues.push({ kind: UNRESOLVED.UNTERMINATED_SUBSTITUTION, text: command.slice(index, index + 40) })
      return { body: '', end: command.length }
    }
    return { body: command.slice(index + 1, end), end }
  }
  if (ch !== '$' || command[index + 1] !== '(') return null
  const arithmetic = command[index + 2] === '('
  const open = index + 1
  const end = findMatchingParens(command, open)
  if (end === -1) {
    issues.push({ kind: UNRESOLVED.UNTERMINATED_SUBSTITUTION, text: command.slice(index, index + 40) })
    return { body: '', end: command.length }
  }
  if (arithmetic) {
    issues.push({ kind: UNRESOLVED.ARITHMETIC, text: '$((' })
    return { body: '0', end }
  }
  return { body: command.slice(open + 1, end), end }
}

/**
 * Extract command substitutions (`$( … )` and, for bash, backticks) from the
 * command, returning the text with each substitution replaced by a neutral
 * placeholder plus the bodies found. Substitutions are live outside quotes and
 * inside DOUBLE quotes (both dialects); single quotes suppress them.
 * @param command - the raw command text.
 * @param tool - the shell dialect.
 * @param issues - collector for unresolved structures.
 * @returns `{ cleaned, bodies }`.
 */
function extractSubstitutions(command, tool, issues) {
  const escape = escapeCharFor(tool)
  let cleaned = ''
  const bodies = []
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === escape && quote !== "'") {
        cleaned += ch
        if (command[i + 1] !== undefined) {
          cleaned += command[i + 1]
          i += 1
        }
        continue
      }
      if (ch === quote) {
        quote = null
        cleaned += ch
        continue
      }
      if (quote === '"') {
        const found = trySubstitution(command, i, tool, issues)
        if (found !== null) {
          if (found.body.length > 0) bodies.push(found.body)
          cleaned += MASK
          i = found.end
          continue
        }
      }
      cleaned += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cleaned += ch
      continue
    }
    if (ch === escape && tool === 'bash') {
      cleaned += ch
      if (command[i + 1] !== undefined) {
        cleaned += command[i + 1]
        i += 1
      }
      continue
    }
    const found = trySubstitution(command, i, tool, issues)
    if (found !== null) {
      if (found.body.length > 0) bodies.push(found.body)
      cleaned += MASK
      i = found.end
      continue
    }
    cleaned += ch
  }
  if (quote !== null) issues.push({ kind: UNRESOLVED.UNBALANCED_QUOTES, text: command.slice(0, 60) })
  return { cleaned, bodies }
}

/**
 * Index of the `)` closing the `(` at `open`, honoring nesting and quotes.
 * @param text - the scanned text.
 * @param open - index of the `(`.
 * @returns the index of the matching `)`, or `-1`.
 */
function findMatchingParens(text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\' && quote === '"') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Remove heredoc bodies (`<<EOF … EOF`, also `<<-EOF`) from the command,
 * recording them. A heredoc body is stdin DATA, not statements; the command
 * line that consumes it is analyzed normally (and a shell consuming it is
 * `opaque` anyway).
 * @param command - the command text.
 * @returns `{ cleaned, heredocs }`.
 */
function extractHeredocs(command) {
  const heredocs = []
  const lines = command.split(/\r?\n/)
  const kept = []
  let pending = null
  for (const line of lines) {
    if (pending !== null) {
      if (line.trim() === pending.delimiter) pending = null
      continue
    }
    const marker = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line)
    kept.push(line)
    if (marker !== null) {
      pending = { delimiter: marker[3] }
      heredocs.push({ delimiter: marker[3] })
    }
  }
  return { cleaned: kept.join('\n'), heredocs }
}

/**
 * Extract redirections from the (substitution-free) command text, resolve
 * their targets against the scope predicate, and return the text with the
 * redirect clauses removed.
 * @param command - the command text.
 * @param tool - the shell dialect.
 * @param options - `{ inScope }`.
 * @param issues - collector for unresolved structures.
 * @returns `{ cleaned, redirects }`.
 */
function extractRedirects(command, tool, options, issues) {
  const escape = escapeCharFor(tool)
  const inScope = typeof options.inScope === 'function' ? options.inScope : () => true
  const masked = command.replace(FD_DUPLICATION, (match) => MASK.repeat(match.length))
  const redirects = []
  const spans = []
  let quote = null
  let i = 0
  while (i < masked.length) {
    const ch = masked[i]
    if (quote !== null) {
      if (ch === escape && quote !== "'") i += 2
      else {
        if (ch === quote) quote = null
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === escape && tool === 'bash') {
      i += 2
      continue
    }
    if (ch === '<' || ch === '>') {
      if (masked[i + 1] === '(') {
        issues.push({ kind: UNRESOLVED.PROCESS_SUBSTITUTION, text: command.slice(i, i + 30) })
        i += 2
        continue
      }
      let operator = ch
      let cursor = i + 1
      if (masked[cursor] === ch) {
        operator += ch
        cursor += 1
      }
      const herestring = operator === '<<' && masked[cursor] === '<'
      if (herestring) cursor += 1
      // Optional fd prefix already consumed by the operator; skip whitespace.
      while (masked[cursor] === ' ' || masked[cursor] === '\t') cursor += 1
      const start = cursor
      while (cursor < masked.length && !/[\s|;&]/.test(masked[cursor]) && masked[cursor] !== MASK) cursor += 1
      const rawTarget = command.slice(start, cursor)
      const target = rawTarget.replace(/^["']+|["']+$/g, '')
      const harmless = target.length === 0 || /^&\d+$/.test(target) || herestring
      if (!harmless) {
        redirects.push({
          operator: herestring ? '<<<' : operator,
          target,
          inScope: inScope(target),
          direction: ch === '<' ? 'in' : 'out',
        })
      } else {
        redirects.push({ operator: herestring ? '<<<' : operator, target, inScope: true, harmless: true, direction: ch === '<' ? 'in' : 'out' })
      }
      spans.push([i, cursor])
      i = cursor
      continue
    }
    i += 1
  }
  if (spans.length === 0) return { cleaned: command.replaceAll(MASK, '0'), redirects }
  let cleaned = ''
  let last = 0
  for (const [from, to] of spans) {
    cleaned += command.slice(last, from)
    last = to
  }
  cleaned += command.slice(last)
  return { cleaned: cleaned.replaceAll(MASK, '0'), redirects }
}

/**
 * Strip a leading `FOO=bar` assignment run from a statement.
 * @param statement - one statement.
 * @returns `{ text, assignments }` — the statement without its prefix, and
 *   the assignments found (empty when there were none).
 */
function stripEnvPrefix(statement) {
  let text = statement.trim()
  const assignments = []
  for (;;) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|\S*)[ \t]+/.exec(text)
    if (match === null) break
    assignments.push(`${match[1]}=${match[2]}`)
    text = text.slice(match[0].length)
  }
  return { text, assignments }
}

/**
 * Analyze one command string into the statements it runs.
 * @param command - the raw command string.
 * @param tool - the shell tool (`bash`, `pwsh`).
 * @param options - `{ inScope?: (token) => boolean, expandScript?: (program, rest, tool) => string|null, maxDepth?: number }`.
 * @returns `{ statements, redirects, unresolved, paths, substitutions }`.
 */
export function analyzeCommand(command, tool = 'pwsh', options = {}) {
  const statements = []
  const redirects = []
  const unresolved = []
  const paths = []
  const substitutions = []
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH

  if (typeof command !== 'string' || command.trim().length === 0) {
    return { statements, redirects, unresolved: [{ kind: UNRESOLVED.EMPTY, text: '' }], paths, substitutions }
  }

  const collectPaths = (text) => {
    for (const token of pathTokens(text)) {
      paths.push(token)
    }
  }

  /**
   * Recursive walk over one command level.
   * @param text - the command text at this level.
   * @param depth - the current depth.
   * @param source - provenance label for the statements found here.
   */
  const walk = (text, depth, source) => {
    if (depth > maxDepth) {
      unresolved.push({ kind: UNRESOLVED.DEPTH, text: text.slice(0, 60) })
      return
    }
    const heredocPass = extractHeredocs(text)
    const substitutionPass = extractSubstitutions(heredocPass.cleaned, tool, unresolved)
    for (const body of substitutionPass.bodies) {
      substitutions.push(body.trim())
      walk(body, depth + 1, 'substitution')
    }
    const redirectPass = extractRedirects(substitutionPass.cleaned, tool, options, unresolved)
    for (const redirect of redirectPass.redirects) {
      redirects.push(redirect)
      if (redirect.target.length > 0 && !redirect.harmless) paths.push(redirect.target)
    }
    const segments = splitCommandSegments(redirectPass.cleaned, tool)
    for (const segment of segments) {
      const stripped = stripEnvPrefix(segment)
      if (stripped.text.length === 0) continue
      collectPaths(stripped.text)
      const descriptor = describeStatement(stripped.text)
      const verdict = classifyStatement(descriptor, { inScope: options.inScope })
      statements.push({
        ...descriptor,
        source,
        envPrefix: stripped.assignments.length > 0 ? stripped.assignments : null,
        kind: verdict.kind,
        why: verdict.why,
        outside: verdict.outside,
      })
      if (typeof options.expandScript === 'function' && depth + 1 <= maxDepth) {
        let expanded = null
        try {
          expanded = options.expandScript(descriptor.program, descriptor.rest, tool)
        } catch {
          expanded = null
        }
        if (typeof expanded === 'string' && expanded.trim().length > 0) {
          const containerIndex = statements.length - 1
          const childrenStart = statements.length
          walk(expanded, depth + 1, 'script')
          const childrenEnd = statements.length
          if (childrenEnd > childrenStart) {
            // The runner is a CONTAINER: its own class is the worst of the
            // statements it expands to, so `pnpm run deploy` is judged by
            // deploy's body rather than by "package manager".
            Object.assign(statements[containerIndex], {
              container: true,
              childrenStart,
              childrenEnd,
              expandedFrom: descriptor.program,
            })
          }
        }
      }
    }
  }

  walk(command, 0, 'command')
  if (statements.length === 0 && unresolved.length === 0) {
    unresolved.push({ kind: UNRESOLVED.EMPTY, text: command.slice(0, 60) })
  }
  return { statements, redirects, unresolved, paths, substitutions }
}

/**
 * Compact one-line rendering of the analysis, used in decision traces and the
 * approval prompt: `git status [read] | node x.mjs [opaque]`.
 * @param analysis - the object returned by {@link analyzeCommand}.
 * @returns a human-readable summary.
 */
export function describeAnalysis(analysis) {
  if (analysis === null || typeof analysis !== 'object') return '(no analysis)'
  const parts = analysis.statements.map((statement) => `${statement.text} [${statement.kind}]`)
  if (analysis.unresolved.length > 0) {
    parts.push(`unresolved: ${analysis.unresolved.map((item) => item.kind).join(', ')}`)
  }
  return parts.join(' | ')
}
