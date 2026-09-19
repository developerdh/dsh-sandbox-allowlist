/**
 * Observability and learning for the command gates — the "layer 0" work that
 * makes the allow-list debuggable instead of a black box.
 *
 * Three facilities, all deliberately bounded and side-effect-light:
 *
 *   - {@link CommandAudit} — records every decision (verdict, reason,
 *     per-statement trace) in a small ring buffer for `explain()`/UI use, and
 *     optionally appends one JSON line per decision to an audit file. Before
 *     this existed an auto-approved escalation left no trace at all (finding
 *     F8 of docs/temp/设计评估-复合命令自动放行.md): the user could neither
 *     see why a prompt appeared nor what had been waved through.
 *
 *   - {@link SessionDecisionCache} — remembers commands the USER approved by
 *     hand during this session, keyed by the canonical command text. An agent
 *     that retries the same failing command (the common case: a denied write,
 *     an approved escalation, a second failed run) stops re-prompting. Scoped
 *     to the exact canonical text and to one session on purpose — it is a
 *     de-duplication of identical interruptions, not a standing grant.
 *
 *   - {@link ProposalStore} — counts the commands the user keeps approving by
 *     hand and, once one repeats, proposes the rule that would have avoided
 *     the prompt. This is the only mechanism here that lets the rule set grow
 *     from observed behaviour instead of from the user's foresight; the
 *     proposal is surfaced (log, file, model context) and NEVER applied
 *     automatically.
 *
 * Everything is injectable and in-memory by default so the module can be unit
 * tested without touching the filesystem.
 *
 * @module dsh-sandbox-allowlist/command-audit
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalCommandKey } from './command-decision.mjs'

/** How many decisions the in-memory ring keeps for `explain`. */
export const DEFAULT_RING_CAP = 200

/** How many manually approved commands a session cache remembers. */
export const DEFAULT_CACHE_CAP = 128

/** Audit sink size before rotation (2 MiB ≈ tens of thousands of decisions). */
export const DEFAULT_AUDIT_MAX_BYTES = 2 * 1024 * 1024

/** Rotated audit files kept alongside the live one. */
export const DEFAULT_AUDIT_MAX_FILES = 3

/** How many times a command must be approved by hand before a rule is proposed. */
export const DEFAULT_PROPOSAL_THRESHOLD = 2

/**
 * Render a decision trace as human-readable lines: what the command resolved
 * to, what each statement was classified as, which rule matched, and — when
 * the answer was "ask" — what would have made it automatic.
 * @param decision - a result from `decide()` (or a recorded audit entry).
 * @returns a multi-line string (never empty).
 */
export function explainDecision(decision) {
  const trace = decision?.trace ?? {}
  const lines = []
  const verdict = decision?.verdict ?? 'unknown'
  lines.push(`判定：${verdict}${decision?.escalate === true ? '（并自动放行沙箱升级）' : ''}`)
  if (typeof decision?.reason === 'string' && decision.reason.length > 0) lines.push(`原因：${decision.reason}`)
  if (Array.isArray(trace.statements) && trace.statements.length > 0) {
    lines.push('语句分解：')
    for (const statement of trace.statements) {
      const action = statement.action !== null && statement.action !== undefined ? `规则=${statement.action}` : '无规则'
      const escalatable = statement.escalatable === undefined
        ? ''
        : `，升级=${statement.escalatable ? '可自动' : `不可（${statement.escalateWhy ?? ''}）`}`
      lines.push(`  · ${statement.text} → 能力类=${statement.kind}，${action}${escalatable}`)
      if (typeof statement.why === 'string' && statement.why.length > 0) lines.push(`      ${statement.why}`)
    }
  }
  if (Array.isArray(trace.redirects) && trace.redirects.length > 0) {
    const redirected = trace.redirects.filter((item) => item.harmless !== true)
    if (redirected.length > 0) {
      lines.push('重定向：')
      for (const redirect of redirected) {
        lines.push(`  · ${redirect.operator} ${redirect.target}（${redirect.inScope ? '在授权范围内' : '越界'}）`)
      }
    }
  }
  if (Array.isArray(trace.unresolved) && trace.unresolved.length > 0) {
    lines.push(`无法解析：${trace.unresolved.map((item) => `${item.kind}(${item.text})`).join(', ')}`)
  }
  if (Array.isArray(trace.suggestions) && trace.suggestions.length > 0) {
    lines.push('可加入设置页的规则：')
    for (const suggestion of trace.suggestions) lines.push(`  · ${suggestion}`)
  }
  return lines.join('\n')
}

/**
 * Bounded decision log.
 */
export class CommandAudit {
  /**
   * @param options - `{ cap?, file?, maxBytes?, maxFiles?, logger? }`. `file`
   *   enables the JSONL append (best effort: an unwritable path never breaks a
   *   decision); `maxBytes`/`maxFiles` bound how much history the sink keeps.
   */
  constructor(options = {}) {
    this.cap = Number.isInteger(options.cap) ? options.cap : DEFAULT_RING_CAP
    this.file = typeof options.file === 'string' && options.file.length > 0 ? options.file : null
    this.maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_AUDIT_MAX_BYTES
    this.maxFiles = Number.isInteger(options.maxFiles) ? options.maxFiles : DEFAULT_AUDIT_MAX_FILES
    this.logger = options.logger ?? null
    this.entries = []
    this.fileBroken = false
    /** Bytes appended since construction, seeded from the existing file. */
    this.bytes = this.#currentSize()
  }

  /**
   * Record one decision.
   * @param entry - `{ phase, tool, command, verdict, escalate, reason, trace, at? }`.
   * @returns the stored entry.
   */
  record(entry) {
    const stored = { at: entry.at ?? new Date().toISOString(), ...entry }
    this.entries.push(stored)
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap)
    this.#append(stored)
    return stored
  }

  /**
   * Size of the audit file, or 0 when it does not exist / cannot be stat'ed.
   * @returns the byte count.
   */
  #currentSize() {
    if (this.file === null) return 0
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }

  /**
   * Rotate the audit file when it has grown past `maxBytes`: `x.jsonl` →
   * `x.jsonl.1` → `x.jsonl.2` … dropping the oldest beyond `maxFiles`. The
   * decision log is append-only and would otherwise grow without bound for the
   * lifetime of the installation.
   */
  #rotateIfNeeded() {
    if (this.file === null || this.bytes < this.maxBytes) return
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.file : `${this.file}.${index - 1}`
      const to = `${this.file}.${index}`
      if (existsSync(from)) renameSync(from, to)
    }
    this.bytes = 0
  }

  /**
   * Append one JSON line to the audit file, tolerating a broken/unwritable
   * sink (the decision itself must never depend on logging).
   * @param stored - the recorded entry.
   */
  #append(stored) {
    if (this.file === null || this.fileBroken) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.#rotateIfNeeded()
      const line = `${JSON.stringify({
        at: stored.at,
        phase: stored.phase,
        tool: stored.tool,
        command: stored.command,
        verdict: stored.verdict,
        escalate: stored.escalate === true,
        reason: stored.reason,
        statements: (stored.trace?.statements ?? []).map((statement) => ({
          text: statement.text,
          kind: statement.kind,
          action: statement.action,
          escalatable: statement.escalatable,
        })),
      })}\n`
      appendFileSync(this.file, line, 'utf8')
      this.bytes += Buffer.byteLength(line, 'utf8')
    } catch (error) {
      this.fileBroken = true
      this.logger?.warn?.(`sandbox-allowlist: decision audit disabled (${String(error?.message ?? error)})`)
    }
  }

  /**
   * The most recent entries, newest last.
   * @param limit - how many to return.
   * @returns the recorded entries.
   */
  recent(limit = 20) {
    return this.entries.slice(Math.max(0, this.entries.length - limit))
  }

  /** Drop every entry (used by tests and by settings reloads). */
  clear() {
    this.entries = []
  }
}

/**
 * Session-scoped memory of commands the user approved by hand.
 *
 * Deliberately narrow: the key is the canonical command text (whitespace
 * collapsed, case folded, quotes removed), so `git  push origin main` and
 * `git push origin main` share one entry while any edit to the arguments is a
 * different command. Nothing here survives the session.
 */
export class SessionDecisionCache {
  /**
   * @param options - `{ cap?, enabled? }`.
   */
  constructor(options = {}) {
    this.cap = Number.isInteger(options.cap) ? options.cap : DEFAULT_CACHE_CAP
    this.enabled = options.enabled !== false
    this.map = new Map()
  }

  /**
   * Cache key for one call.
   * @param tool - the shell tool.
   * @param command - the raw command string.
   * @returns the key, or `null` when the command has no canonical form.
   */
  static key(tool, command) {
    const canonical = canonicalCommandKey(command)
    return canonical.length === 0 ? null : `${tool}\u0000${canonical}`
  }

  /**
   * Remember that the user approved this exact command for this session.
   * @param tool - the shell tool.
   * @param command - the raw command string.
   * @param note - `{ phase, reason }` for diagnostics.
   * @returns `true` when the entry was stored.
   */
  remember(tool, command, note = {}) {
    if (!this.enabled) return false
    const key = SessionDecisionCache.key(tool, command)
    if (key === null) return false
    if (this.map.size >= this.cap && !this.map.has(key)) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { at: Date.now(), ...note })
    return true
  }

  /**
   * Whether the user already approved this exact command in this session.
   * @param tool - the shell tool.
   * @param command - the raw command string.
   * @returns the stored note, or `null`.
   */
  lookup(tool, command) {
    if (!this.enabled) return null
    const key = SessionDecisionCache.key(tool, command)
    return key === null ? null : (this.map.get(key) ?? null)
  }

  /** Forget everything (settings change, session end). */
  clear() {
    this.map.clear()
  }

  /** Number of remembered approvals. */
  get size() {
    return this.map.size
  }
}

/**
 * Counts hand-approved commands and turns the repeats into rule proposals.
 *
 * A proposal is data, never an action: the store only reports "this shape was
 * approved N times; the rule that would avoid the prompt is X". Applying it
 * stays a human decision in the settings page.
 */
export class ProposalStore {
  /**
   * @param options - `{ threshold?, cap?, file?, logger? }`.
   */
  constructor(options = {}) {
    this.threshold = Number.isInteger(options.threshold) ? options.threshold : DEFAULT_PROPOSAL_THRESHOLD
    this.cap = Number.isInteger(options.cap) ? options.cap : 64
    this.file = typeof options.file === 'string' && options.file.length > 0 ? options.file : null
    this.logger = options.logger ?? null
    this.counts = new Map()
  }

  /**
   * Note one manual approval of one analyzed statement.
   * @param input - `{ tool, program, rest, kind, phase, command }`.
   * @returns the proposal for this shape when it just crossed the threshold.
   */
  note(input) {
    const program = typeof input.program === 'string' ? input.program : ''
    if (program.length === 0) return null
    const firstArg = String(input.rest ?? '').split(' ')[0] ?? ''
    const args = firstArg.length > 0 && !firstArg.startsWith('-') ? [`${firstArg}*`] : []
    const key = `${input.tool}\u0000${program}\u0000${args.join(',')}`
    const entry = this.counts.get(key) ?? {
      tool: input.tool,
      program,
      args,
      kind: input.kind,
      phase: input.phase,
      command: input.command,
      count: 0,
      proposed: false,
    }
    entry.count += 1
    entry.command = input.command
    this.counts.set(key, entry)
    if (this.counts.size > this.cap) {
      const oldest = this.counts.keys().next().value
      if (oldest !== undefined) this.counts.delete(oldest)
    }
    if (!entry.proposed && entry.count >= this.threshold) {
      entry.proposed = true
      this.#persist()
      return this.#toProposal(entry)
    }
    return null
  }

  /**
   * Every shape that reached the proposal threshold.
   * @returns an array of `{ tool, program, args, action, count, kind }`.
   */
  proposals() {
    return [...this.counts.values()]
      .filter((entry) => entry.proposed)
      .map((entry) => this.#toProposal(entry))
  }

  /**
   * Rules equivalent to the current proposals, ready to paste into the
   * `sandbox-allowlist.commands.rules` list.
   * @returns an array of pattern-form rule objects.
   */
  proposedRules() {
    return this.proposals().map((proposal) => {
      const pattern = Array.isArray(proposal.args) && proposal.args.length > 0
        ? `${proposal.program} ${proposal.args[0]}`
        : `${proposal.program}*`
      const rule = { pattern, action: proposal.action }
      if (proposal.tool !== undefined) rule.tool = proposal.tool
      return rule
    })
  }

  /**
   * Build the proposal object for one counted shape.
   * @param entry - the counted entry.
   * @returns the proposal.
   */
  #toProposal(entry) {
    return {
      tool: entry.tool,
      program: entry.program,
      args: entry.args,
      action: 'allow',
      count: entry.count,
      kind: entry.kind,
    }
  }

  /** Persist the counters (best effort, single JSON document). */
  #persist() {
    if (this.file === null) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify({ version: 1, proposals: this.proposals() }, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.logger?.warn?.(`sandbox-allowlist: proposal persistence skipped (${String(error?.message ?? error)})`)
    }
  }

  /** Forget every counter. */
  clear() {
    this.counts.clear()
  }
}

/**
 * One-line summary of a proposal, for logs and for the model-facing prompt
 * context ("these commands keep being approved by hand; suggest the rule").
 * @param proposal - an entry from {@link ProposalStore#proposals}.
 * @returns a readable string.
 */
export function describeProposal(proposal) {
  const args = Array.isArray(proposal.args) && proposal.args.length > 0 ? ` ${proposal.args.join('|')}` : ''
  return `${proposal.tool ?? 'any'} ${proposal.program}${args} ×${proposal.count}`
}
