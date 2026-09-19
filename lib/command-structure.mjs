/**
 * Statement splitting for raw shell command strings (`bash`, `pwsh`).
 *
 * `splitCommandSegments` is the tokenizer the whole allow-list is built on:
 * it cuts a compound command into the independent statements inside it so
 * every statement can be judged on its own program, arguments and targets.
 * A compound command is therefore no longer "one string that a prefix rule
 * happens to match" but "N statements, each with its own verdict".
 *
 * Dialect-aware and quote-aware:
 *   - inside double quotes: the tool's escape char pairs with the next char;
 *     the closing quote ends the span (separators inside are literal);
 *   - inside single quotes: everything is literal; the pwsh doubled quote
 *     `''` stays inside the span (bash closes and reopens — same net effect);
 *   - outside quotes: the escape char pairs with the next char, so bash
 *     `a\;b` is one word and `\<newline>` continues the line, while pwsh
 *     treats `\` as a plain char and still separates on its `;`;
 *   - `2>&1` is masked before scanning so its `&` is never a separator
 *     (restored in the returned segments);
 *   - bash backticks are ordinary characters here — command substitution is
 *     resolved earlier, in command-analyze.mjs, by extracting the body and
 *     analysing it recursively.
 *
 * Separators: `;`, `|`, `&&`, `&`, `||`, newlines. Empty segments (`a;;b`,
 * `a || b`, a trailing `&`) are dropped.
 *
 * Structures this tokenizer deliberately does not vouch for (process
 * substitution, arithmetic substitution, unbalanced quotes, nesting overflow)
 * are reported by command-analyze.mjs as `unresolved`, and any unresolved
 * structure means "never auto-approve" — the fail-closed direction is the
 * same as the shape guard this replaced, but scoped to what is genuinely
 * unresolvable instead of to every redirect or substitution.
 *
 * Test-corpus discipline (evaluation report §2.1): adversarial commands use
 * only harmless read-only riders (`whoami`) — no destructive payloads.
 *
 * This module is pure and side-effect free so it can be unit-tested without a
 * running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/command-structure
 */

/** Placeholder protecting the exact token `2>&1` from `&`-separation. */
const REDIRECT_MASK = '\x00'

/**
 * The escape char that pairs with the next character, per shell dialect:
 * bash uses backslash (outside single quotes and inside double quotes),
 * pwsh uses the backtick (outside quotes and inside double quotes). Inside
 * single quotes neither dialect honors an escape char.
 * @param tool - the shell tool name (`bash`, `pwsh`).
 * @returns the escape character for the dialect.
 */
function escapeCharFor(tool) {
  return tool === 'bash' ? '\\' : '`'
}

/**
 * Split a raw command into top-level statement segments (see the module docs
 * for the exact quoting/escaping rules).
 * @param command - the raw command string.
 * @param tool - shell dialect (`bash` or `pwsh`; default `pwsh`).
 * @returns trimmed non-empty segments.
 */
export function splitCommandSegments(command, tool = 'pwsh') {
  if (typeof command !== 'string') return []
  const escape = escapeCharFor(tool)
  const masked = command.replace(/2>&1/g, REDIRECT_MASK)
  const segments = []
  let current = ''
  let quote = null
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i]
    const next = masked[i + 1]
    if (quote !== null) {
      current += ch
      if (quote === '"' && ch === escape) {
        if (next !== undefined) {
          current += next
          i += 1
        }
      } else if (quote === '"' && ch === '"') {
        quote = null
      } else if (quote === "'" && ch === "'" && next === "'") {
        current += next
        i += 1
      } else if (quote === "'" && ch === "'") {
        quote = null
      }
      continue
    }
    if (ch === escape) {
      current += ch
      if (next !== undefined) {
        current += next
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n' || ch === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments
    .map((segment) => segment.replaceAll(REDIRECT_MASK, '2>&1').trim())
    .filter((segment) => segment.length > 0)
}

/**
 * Walk the command honoring dialect quoting/escaping and report whether it
 * ends outside any quote span (no unterminated `"` or `'`).
 * @param command - the raw command string.
 * @param tool - shell dialect (`bash`, `pwsh`).
 * @returns `true` when quotes are balanced.
 */
export function quotesBalanced(command, tool = 'pwsh') {
  const escape = escapeCharFor(tool)
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    if (quote === '"') {
      if (ch === escape) {
        if (next !== undefined) i += 1
      } else if (ch === '"') {
        quote = null
      }
    } else if (quote === "'") {
      if (ch === "'" && next === "'") i += 1
      else if (ch === "'") quote = null
    } else if (ch === escape) {
      if (next !== undefined) i += 1
    } else if (ch === '"' || ch === "'") {
      quote = ch
    }
  }
  return quote === null
}
