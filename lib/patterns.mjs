/**
 * Wildcard pattern matching and filesystem expansion for DSH trusted writable
 * roots (`allowedDirs`, see policy.mjs).
 *
 * Pattern vocabulary (platform-independent; both `\` and `/` are separators):
 *   - `D:\Shared\Tools`   — that exact directory (and its whole subtree)
 *   - `D:\Shared\**`      — the subtree rooted at `D:\Shared`; the root itself
 *                           is included, so future top-level children are
 *                           covered by one inherited grant
 *   - `D:\Data\logs\*`    — every existing immediate child directory of
 *                           `D:\Data\logs`
 *   - `D:\Work\202?`      — `?` matches exactly one non-separator character
 *   - `D:\**\cache`       — any `cache` directory anywhere under `D:\`
 *
 * Expansion is an on-demand snapshot: at each expansion pass, existing
 * directories matching the pattern are collected, canonicalized (symlinks
 * resolved) and deduplicated. Non-existent literal paths yield nothing.
 * Patterns anchored at a drive root / filesystem root that use `**` are
 * refused — expanding them would walk the whole drive.
 *
 * @module dsh-sandbox-allowlist/patterns
 */

import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'

const SEP_RE = /[\\/]/u
const META_RE = /[*?]/u

/** Whether a pattern contains glob metacharacters. */
export function hasMeta(pattern) {
  return META_RE.test(pattern)
}

/** Translate one pattern into a full-path regular expression. */
export function patternToRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*' // `**` crosses segment boundaries
        i += 1
      } else {
        source += '[^\\\\/]*' // `*` stays inside one segment
      }
    } else if (ch === '?') {
      source += '[^\\\\/]'
    } else if (ch === '\\' || ch === '/') {
      source += '[\\\\/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'iu' : 'u')
}

/** The longest leading path portion that contains no glob metacharacters. */
export function staticPrefix(pattern) {
  const segments = pattern.split(SEP_RE).filter((part) => part.length > 0)
  const prefixSegments = []
  for (const segment of segments) {
    if (META_RE.test(segment)) break
    prefixSegments.push(segment)
  }
  if (prefixSegments.length === 0) return null
  const joined = prefixSegments.join(sep)
  if (!isAbsolute(pattern)) return joined
  return prefixSegments[0].includes(':') ? joined : sep + joined
}

/** `realpathSync.native(path)` or null when the path does not exist. */
export function canonicalOrNull(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

export const DEFAULT_MAX_DEPTH = 16
export const DEFAULT_MAX_MATCHES = 1024

/**
 * Expand one trusted-root pattern into concrete canonical directory paths.
 * @param pattern - absolute path pattern (literal, `**`, `*`, `?`).
 * @param options - `maxDepth` and `maxMatches` walk guards.
 * @returns canonical existing directories matching the pattern, deduplicated.
 * @throws on malformed, relative, or dangerously broad patterns.
 */
export function expandTrustedRoots(pattern, options = {}) {
  const { maxDepth = DEFAULT_MAX_DEPTH, maxMatches = DEFAULT_MAX_MATCHES } = options
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new TypeError(`trusted root pattern must be a non-empty string, got ${JSON.stringify(pattern)}`)
  }
  if (!isAbsolute(pattern)) {
    throw new Error(`trusted root pattern must be absolute: "${pattern}"`)
  }
  if (!hasMeta(pattern)) {
    const canonical = canonicalOrNull(pattern)
    return canonical === null ? [] : [canonical]
  }

  const prefix = staticPrefix(pattern)
  if (prefix === null) {
    throw new Error(`trusted root pattern must anchor at least one directory level: "${pattern}"`)
  }
  const prefixParts = prefix.split(SEP_RE).filter((part) => part.length > 0)
  if (prefixParts.length <= 1 && pattern.includes('**')) {
    throw new Error(
      `trusted root pattern "${pattern}" is anchored too broadly (would walk ${prefix}); `
      + 'anchor at least one named directory level',
    )
  }

  // If the static prefix does not exist, no path can ever match (every match
  // must start with the prefix), so bail out instead of walking an ancestor —
  // otherwise `D:\Shared\*` with a missing `D:\Shared` would walk all of `D:\`.
  const anchor = canonicalOrNull(prefix)
  if (anchor === null) return []
  const regex = patternToRegExp(pattern)
  const matches = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth || matches.size >= maxMatches) return
    if (dir !== anchor && regex.test(dir)) {
      const canonical = canonicalOrNull(dir)
      if (canonical !== null) matches.add(canonical)
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory — skip its subtree
    }
    for (const entry of entries) {
      // Directories only; never follow symlinks/junctions (loop safety).
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(anchor, 0)

  // A trailing `**` names the anchor directory itself, so the whole subtree
  // (including future top-level children) is covered by one inherited grant
  // instead of only the current descendants.
  if (pattern.endsWith('**')) matches.add(anchor)

  return [...matches]
}
