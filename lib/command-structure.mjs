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
 *   - fd-duplication redirects (`2>&1`, `>&2`, `1>&2`, …) are masked before
 *     scanning so their `&` is never a separator (restored in the returned
 *     segments);
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

/**
 * Harmless fd-duplication redirects (`2>&1`, `>&2`, `1>&2`, `3>&1`, …): their
 * `&` is not a statement separator. Shared with command-analyze.mjs so the
 * redirect scanner and this tokenizer mask the SAME set of forms — masking
 * here without masking there (or vice versa) would split or skip them
 * inconsistently.
 * @type {RegExp}
 */
export const FD_DUPLICATION = /\d?>&\d/g

/** Placeholder standing in for one fd-duplication match during scanning. */
const REDIRECT_MASK = /\x00(\d+)\x00/g

/**
 * Mask every fd-duplication match with an indexed placeholder, remembering
 * the original spelling of each match.
 * @param command - the text to mask.
 * @returns `{ masked, masks }` — the masked text and the matches in order.
 */
function maskFdDuplications(command) {
  const masks = []
  const masked = command.replace(FD_DUPLICATION, (match) => {
    masks.push(match)
    return `\x00${masks.length - 1}\x00`
  })
  return { masked, masks }
}

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
  const { masked, masks } = maskFdDuplications(command)
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
    .map((segment) => segment.replace(REDIRECT_MASK, (_, index) => masks[Number(index)] ?? '').trim())
    .filter((segment) => segment.length > 0)
}
