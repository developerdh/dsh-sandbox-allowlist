/**
 * Structural analysis of raw shell command strings (`bash`, `pwsh`), shared
 * by both gates of dsh-sandbox-allowlist (P0 hardening, see
 * docs/设计评估-复合命令自动放行.md):
 *
 *   - `splitCommandSegments` — quote- and dialect-aware statement splitter.
 *     Splits a raw command on the target shell's top-level separators
 *     (`;`, `|`, `&&`, `&`, `||`, newlines) so every gate can judge each
 *     independent command on its own. Separators inside quotes are literal;
 *     the tool's escape char pairs with the next char (bash `\`, pwsh `` ` ``);
 *     `2>&1` is masked before scanning so its `&` is never mistaken for a
 *     separator. This is deliberately a tokenizer, not a full parser: the
 *     structures it must not vouch for are rejected for escalation
 *     auto-approval by {@link hasComplexStructure} instead.
 *
 *   - `hasComplexStructure` — the escalation shape guard (fail-closed):
 *     commands embedding command substitution (`$( … )`), backticks, input /
 *     heredoc / process-substitution redirects, output redirects with a target
 *     beyond the harmless whitelist (`2>&1`, `>/dev/null`, `>$null`, `>NUL`),
 *     unbalanced quotes, or a leading env-assignment prefix never
 *     auto-approve a sandbox escalation; they fall back to the manual
 *     approval UI.
 *
 *   - `hitsHighRiskBaseline` — built-in baseline for escalation
 *     auto-approval: interpreters and program loaders (bash, node, python,
 *     npx, env, xargs, iex, …) execute code from places no command-string
 *     rule can see, and `git` can be turned into a loader via its `ext::`
 *     protocol. When any segment's program is on this list, escalation is
 *     never auto-approved, regardless of configured allow rules.
 *
 * Test-corpus discipline (evaluation report §2.1): adversarial commands use
 * only harmless read-only riders (`whoami`) — no destructive payloads.
 *
 * This module is pure and side-effect free so it can be unit-tested without
 * a running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/command-structure
 */

/** Placeholder protecting the exact token `2>&1` from `&`-separation. */
const REDIRECT_MASK = '\x00'

/** Harmless no-target redirect tokens masked out before structural checks. */
const REDIRECT_MASK_PATTERNS = [
  /2>&1/g, // duplicate stdout onto stderr (bash + pwsh)
  />[ \t]*\/dev\/null/gi, // bash bit bucket
  />[ \t]*\$null/gi, // PowerShell null sink
  />[ \t]*NUL\b/gi, // Windows NUL device
]

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
 * Split a raw command into top-level statement segments on the target
 * shell's separators — `;`, `|`, `&&`, `&`, `||`, and newlines — quote-aware
 * and dialect-aware:
 *
 *   - inside double quotes: the tool's escape char pairs with the next char;
 *     the closing quote ends the span (separators inside are literal);
 *   - inside single quotes: everything is literal; the `''` doubled quote
 *     stays inside the span (pwsh escaped quote; bash close-immediately-
 *     reopen — same net effect);
 *   - outside quotes: the escape char pairs with the next char, so bash
 *     `a\;b` is one word and `\<newline>` continues the line, while pwsh
 *     treats `\` as a plain char and still separates on its `;`;
 *   - `2>&1` is masked before scanning so its `&` is never a separator
 *     (restored in the returned segments);
 *   - bash backticks are ordinary characters — a substitution containing a
 *     separator splits into fragments that (intentionally) fail closed;
 *     escalation auto-approval rejects backticks outright via the guard.
 *
 * Empty segments (`a;;b`, `a || b`, a trailing `&`) are dropped.
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
 * @param tool - shell dialect (`bash` or `pwsh`).
 * @returns `true` when quotes are balanced.
 */
function quotesBalanced(command, tool) {
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

/**
 * Escalation shape guard (P0-2): `true` when the command embeds a structure
 * the statement tokenizer must not vouch for, and therefore must never
 * auto-approve a sandbox escalation:
 *
 *   - command substitution: bash/pwsh `$( … )` and legacy bash backticks;
 *   - any `<` — input redirect, heredoc `<<`, herestring `<<<`, process
 *     substitution `<(` — and any pwsh-invalid usage;
 *   - any `>` beyond the harmless whitelist masked out first (`2>&1`,
 *     `>/dev/null`, `>$null`, `>NUL`), i.e. every redirect with a target;
 *   - unbalanced quotes under EITHER dialect's scan (both must agree);
 *   - a leading env-assignment prefix (`FOO=bar cmd`).
 *
 * Note `&&`, `&`, `;`, `|`, and newlines are NOT guard rejects: the splitter
 * handles them, and per-segment allow checks plus this guard together cover
 * their risk. Quoted `>` / `<` characters also reject (fail-closed; the
 * benign cost is a manual approval for string literals containing them).
 * @param command - the raw command string.
 * @returns `true` when the command must not auto-approve an escalation.
 */
export function hasComplexStructure(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return true
  let masked = command
  for (const pattern of REDIRECT_MASK_PATTERNS) {
    masked = masked.replace(pattern, REDIRECT_MASK)
  }
  if (masked.includes('$(')) return true // command substitution (bash / pwsh subexpression)
  if (masked.includes('`')) return true // bash legacy substitution / pwsh escape — reject wholesale
  if (masked.includes('<')) return true // heredoc / herestring / <( / input redirect
  if (masked.includes('>')) return true // redirect with a target beyond the whitelist
  if (!quotesBalanced(command, 'bash') || !quotesBalanced(command, 'pwsh')) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/.test(command.trim())) return true // env-assignment prefix
  return false
}

/**
 * Programs whose normal function is executing code from places a
 * command-string rule cannot see (interpreters, package runners, program
 * loaders, job/process starters, PowerShell script gates). Lower-case,
 * matched against the segment's program token. A configured `allow` rule can
 * NOT override this baseline for escalation auto-approval; P1's explicit
 * `allow-escalate` action is the intended future unlock.
 */
export const HIGH_RISK_PROGRAMS = new Set([
  // shells / script hosts
  'bash', 'sh', 'zsh', 'dash', 'cmd', 'powershell', 'pwsh',
  // interpreters
  'node', 'deno', 'bun', 'python', 'python3', 'pip', 'perl', 'ruby', 'php', 'lua',
  // program loaders / runners
  'npx', 'env', 'xargs', 'awk', 'find',
  // PowerShell evaluation / process & job starters
  'iex', 'invoke-expression', 'invoke-command', 'start-process', 'start-job',
  // Windows persistence / system mutation entry points
  'schtasks', 'wmic', 'reg', 'sc', 'msiexec', 'mshta', 'rundll32', 'regsvr32', 'cscript', 'wscript',
])

/** git turned into a program loader: `-c <…>protocol…` config injection or the `ext::` transport. */
const GIT_PROTOCOL_INJECTION = /(?:^|[ \t])-c[ \t]+["']?\S*protocol/i

/**
 * High-risk baseline (P0-3): `true` when ANY segment's program is an
 * interpreter / program loader from {@link HIGH_RISK_PROGRAMS}, or a `git`
 * segment carries `ext::` / `-c <…>protocol…` injection. Program extraction
 * takes the first whitespace token (the pwsh call operator `&` is skipped),
 * strips surrounding quotes, reduces paths to their basename, and drops a
 * trailing `.exe`.
 * @param segments - segments from {@link splitCommandSegments}.
 * @returns `true` when escalation must not be auto-approved.
 */
export function hitsHighRiskBaseline(segments) {
  if (!Array.isArray(segments)) return false
  for (const segment of segments) {
    const tokens = segment.trim().split(/[ \t]+/)
    if (tokens.length === 0 || tokens[0].length === 0) continue
    let token = tokens[0]
    if (token === '&' && tokens.length > 1) token = tokens[1] // pwsh call operator
    token = token.replace(/^["']+|["']+$/g, '')
    token = (token.split(/[\\/]/).pop() ?? token).replace(/\.exe$/i, '')
    const program = token.toLowerCase()
    if (HIGH_RISK_PROGRAMS.has(program)) return true
    if (program === 'git' && (/ext::/.test(segment) || GIT_PROTOCOL_INJECTION.test(segment))) return true
  }
  return false
}
