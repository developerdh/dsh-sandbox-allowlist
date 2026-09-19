/**
 * Read-restriction ("noRead") rule engine for the model-facing filesystem
 * tools.
 *
 * Stock dsh permits reading in EVERY sandbox mode — the fs fence only
 * contains mutations ("reads pass through"). `noRead` is the orthogonal
 * counterpart: a deny/ask list that restricts READS by file name / path
 * pattern. Deny is enforced at two layers (see policy.mjs / fs.mjs /
 * read-gate.mjs):
 *
 *   1. the fs fence (`fs.mjs`) refuses every content read whose target
 *      matches a `deny` rule — readText / streamText / readBytes, editText
 *      (its read-match-write needs the old content), writeText over an
 *      EXISTING file (the stock write reads the previous content back for
 *      the diff basis and the write tool returns it as `before`), and
 *      listDir on a denied directory. Creating a brand-new file whose name
 *      matches stays allowed — only reading is restricted.
 *   2. the `tools/pre-execute` gate (read-gate.mjs) turns a match into an
 *      immediate `deny`/`ask` decision for the read / read_image / edit
 *      tools — `ask` routes through the approval service (`allowed-once`),
 *      and the fs fence does NOT double-deny an approved ask-rule read.
 *
 * Rule vocabulary (mirrors the wildcards of patterns.mjs / command-rules.mjs):
 *
 *   - no separator — matched against the FILE NAME at any depth: `*.pem` any
 *     .pem anywhere, `.env` the exact name, `.env*` also `.env.local`,
 *     `id_rsa*`.
 *   - separator with glob meta (`*` / `?`) — matched against the FULL PATH:
 *     `**` (two stars) crosses directories, a single `*` stays inside one
 *     segment — e.g. `D:\Vault\**\*.key` (any .key under the vault), or a
 *     dotfile at any depth written as two stars, a separator, then the name.
 *   - separator WITHOUT glob meta — DIRECTORY rule (auto-detected): a literal
 *     absolute directory (e.g. `D:\Vault`) or an absolute path ending in
 *     `/**` (e.g. `D:\Vault/**`) denies reading EVERYTHING under that
 *     directory — file contents, edits, overwrites and the directory listing
 *     itself. A literal absolute FILE path also lands here and simply denies
 *     that one path (files have no descendants).
 *
 * Guards (refused at compile with an issue, never silently broad):
 *   - pure-wildcard basename rules (`*`, `?`, `**`) would deny every file;
 *   - directory rules anchored at a drive or filesystem root (`D:\`, `/`)
 *     would deny the whole drive/tree;
 *   - a literal path WITH a separator must be absolute to be a directory rule
 *     (a relative literal like `sub/x` would never match canonical fs paths);
 *     relative GLOB patterns stay valid full-path rules.
 *
 * There is deliberately NO `allow` action: reading is already permitted by
 * default, so an explicit allow would be a silent no-op — a restriction rule
 * may only deny or ask. When several rules match one target, `deny` wins
 * over `ask` (same deny > ask priority as the command allow-list).
 *
 * Matching is case-insensitive on Windows, case-sensitive elsewhere (the
 * same convention as patterns.mjs).
 *
 * This module is pure and side-effect free so it can be unit-tested without
 * a running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/read-deny
 */

import { patternToRegExp } from './patterns.mjs'

/** Valid per-rule actions. `allow` is intentionally absent (see module docs). */
export const NO_READ_ACTIONS = ['deny', 'ask']

/** The model-facing tools the pre-execute gate restricts (by `file_path`). */
export const NO_READ_TOOLS = ['read', 'read_image', 'edit']

const SEP_RE = /[\\/]/u
const META_RE = /[*?]/u
const ABS_DRIVE_RE = /^[A-Za-z]:[\\/]/u
const UNC_RE = /^[\\]{2}/u
const ROOT_ONLY_RE = /^[A-Za-z]:[\\/]*$/u
const TRAILING_DSTAR_RE = /[\\/]\*\*$/u
const ACTION_SET = new Set(NO_READ_ACTIONS)
const PURE_WILDCARDS = new Set(['*', '**', '?'])

/** Whether a pattern addresses the full path (contains a path separator). */
export function hasPathSeparator(pattern) {
  return SEP_RE.test(pattern)
}

/** Last path segment of a target path, with the platform-neutral splitter. */
export function basenameOf(targetPath) {
  const parts = String(targetPath).split(SEP_RE).filter((part) => part.length > 0)
  return parts.length === 0 ? String(targetPath) : parts[parts.length - 1]
}

/** Absolute-path detection: drive letter, POSIX root, or UNC root. */
export function isAbsolutePath(path) {
  return ABS_DRIVE_RE.test(path) || path.startsWith('/') || UNC_RE.test(path)
}

function stripTrailingSeparators(value) {
  let out = value
  while (out.length > 1 && /[\\/]$/u.test(out)) out = out.slice(0, -1)
  return out
}

/**
 * Validate one noRead rule object's SHAPE (pattern non-empty; action deny or
 * ask — `allow` is rejected on purpose). Returns an issue string or `null`.
 * @param rule - a candidate rule (any shape).
 * @returns an error string, or `null` when the shape is valid.
 */
export function validateNoReadRule(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    return `noRead rule must be an object, got ${JSON.stringify(rule)}`
  }
  if (typeof rule.pattern !== 'string' || rule.pattern.trim().length === 0) {
    return `noRead rule pattern must be a non-empty string, got ${JSON.stringify(rule.pattern)}`
  }
  if (rule.action !== undefined && rule.action !== null && !ACTION_SET.has(rule.action)) {
    return `noRead rule action must be one of ${NO_READ_ACTIONS.join(', ')} (or omitted, default deny) — there is no "allow" action because reading is already permitted by default, got ${JSON.stringify(rule.action)}`
  }
  return null
}

function dirAnchorIssue(root) {
  if (root.length === 0) return 'directory rule has an empty anchor'
  if (ROOT_ONLY_RE.test(root) || root === '/') {
    return `noRead directory rule "${root}" is anchored at a drive / filesystem root and would deny reading the whole tree — add at least one named directory level`
  }
  return null
}

/**
 * Classify one rule into its matching kind. Directory semantics are
 * auto-detected: an absolute literal (no glob meta) or an absolute path whose
 * only wildcard is a trailing `/**` becomes a `dir` rule denying the anchor
 * and every descendant (including directory listings). Returns `{ issue }`
 * when the pattern is malformed or dangerously broad.
 * @param rule - a validated candidate rule (pattern non-empty, action valid).
 * @returns `{ kind, pattern, ... }` or `{ issue }`.
 */
export function classifyNoReadRule(rule) {
  const pattern = rule.pattern.trim()
  const hasSep = hasPathSeparator(pattern)
  if (!hasSep) {
    if (PURE_WILDCARDS.has(pattern)) {
      return { issue: `noRead rule "${pattern}" would match every file name — refused; use a concrete name or extension pattern such as "*.pem"` }
    }
    return { kind: 'basename', pattern, regex: patternToRegExp(pattern) }
  }
  const trailingDstar = TRAILING_DSTAR_RE.test(pattern)
  if (trailingDstar && isAbsolutePath(pattern)) {
    // `D:\Vault/**` — a trailing double-star is the explicit subtree form.
    const prefix = pattern.replace(TRAILING_DSTAR_RE, '')
    if (!META_RE.test(prefix)) {
      const root = stripTrailingSeparators(prefix)
      const issue = dirAnchorIssue(root)
      if (issue !== null) return { issue }
      return { kind: 'dir', pattern, root }
    }
    // The prefix still carries glob meta — generic full-path rule below.
  }
  if (!META_RE.test(pattern)) {
    if (!isAbsolutePath(pattern)) {
      // A relative literal with a separator never matches canonical (absolute)
      // fs targets — keep the legacy exact-path behavior only as a path rule.
      return { kind: 'path', pattern, regex: patternToRegExp(pattern) }
    }
    // Absolute literal: a directory (subtree deny, incl. the dir itself and
    // its listings) or a single file (no descendants — effectively exact).
    const root = stripTrailingSeparators(pattern)
    const issue = dirAnchorIssue(root)
    if (issue !== null) return { issue }
    return { kind: 'dir', pattern, root }
  }
  return { kind: 'path', pattern, regex: patternToRegExp(pattern) }
}

/**
 * Compile configured rules into a reusable matcher list. Malformed or
 * dangerously broad entries are skipped (see {@link noReadRuleIssues} for the
 * reasons).
 * @param rules - the raw configured rule list.
 * @returns `[{ pattern, action, kind, regex?|root? }]` in declaration order.
 */
export function compileNoReadRules(rules) {
  const compiled = []
  if (!Array.isArray(rules)) return compiled
  for (const rule of rules) {
    if (validateNoReadRule(rule) !== null) continue
    const classified = classifyNoReadRule(rule)
    if (classified.issue !== undefined) continue
    compiled.push({
      pattern: classified.pattern,
      action: rule.action === 'ask' ? 'ask' : 'deny',
      kind: classified.kind,
      ...classified.kind === 'dir' ? { root: classified.root } : { regex: classified.regex },
    })
  }
  return compiled
}

/**
 * Issues for every configured rule that is malformed or refused as too broad
 * (compile skips them silently; callers may warn/log the reasons).
 * @param rules - the raw configured rule list.
 * @returns an array of human-readable issue strings (empty when all fine).
 */
export function noReadRuleIssues(rules) {
  const issues = []
  if (!Array.isArray(rules)) return issues
  for (const rule of rules) {
    const shapeIssue = validateNoReadRule(rule)
    if (shapeIssue !== null) {
      issues.push(shapeIssue)
      continue
    }
    const classified = classifyNoReadRule(rule)
    if (classified.issue !== undefined) issues.push(classified.issue)
  }
  return issues
}

function comparable(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** Whether `target` is `root` or lies beneath it (lexical, case per platform). */
function underDirectory(root, target) {
  const r = stripTrailingSeparators(comparable(root))
  const t = comparable(String(target))
  if (t === r) return true
  return t.startsWith(`${r}\\`) || t.startsWith(`${r}/`)
}

/**
 * Resolve the winning restriction for one target path. `deny` outranks `ask`
 * when several rules match; the first `ask` match is remembered otherwise.
 * @param compiled - output of {@link compileNoReadRules}.
 * @param targetPath - the display path (absolute for fs-fence calls; raw for
 *   pre-execute gate calls — basename rules still match a relative argument).
 * @returns `{ pattern, action }` of the winning rule, or `null` when no rule
 *   matches.
 */
export function resolveNoRead(compiled, targetPath) {
  const needle = basenameOf(targetPath)
  let ask = null
  for (const rule of compiled) {
    let matches = false
    if (rule.kind === 'dir') {
      matches = underDirectory(rule.root, targetPath)
    } else if (rule.kind === 'basename') {
      matches = rule.regex.test(needle)
    } else {
      matches = rule.regex.test(String(targetPath))
    }
    if (!matches) continue
    if (rule.action === 'deny') return { pattern: rule.pattern, action: 'deny' }
    if (ask === null) ask = { pattern: rule.pattern, action: 'ask' }
  }
  return ask
}
