/**
 * Meta-program expansion: turn `pnpm run <script>` into the script text it
 * actually executes.
 *
 * Finding F5 of docs/temp/设计评估-复合命令自动放行.md is the residue that
 * string matching cannot reach: `pnpm run deploy` looks like a harmless
 * package-manager call while its body can be anything. The evaluation report
 * concluded the only fixes were "baseline interception + explicit grants" —
 * but for the package-script case the body is not hidden at all: it sits in
 * the workspace's own `package.json`.
 *
 * So this module resolves the script text and hands it back to the analyzer,
 * which judges it with the same rules and the same capability classes as any
 * other statement. Consequences:
 *
 *   - a script whose body is entirely benign makes `pnpm run <script>`
 *     escalatable on its own merits, instead of being permanently stuck behind
 *     "package manager, cannot inspect";
 *   - a script that shells out (`"deploy": "sh ./deploy.sh"`) expands to an
 *     `opaque` statement, so the container is blocked exactly as before;
 *   - an unresolvable script (missing `package.json`, unknown name, unreadable
 *     file) yields `null`, which leaves the runner classified as `repo-exec`
 *     and therefore not auto-escalatable — the same fail-closed default.
 *
 * The reader is injected (`readFile`) and the manifest is cached with a short
 * TTL, so the module stays testable and never performs I/O of its own.
 *
 * @module dsh-sandbox-allowlist/command-expand
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Package managers whose bare/`run` subcommands execute a package.json script. */
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cnpm'])

/** Subcommand spellings that mean "run the named script". */
const RUN_SUBCOMMANDS = new Set(['run', 'run-script'])

/** How long a parsed manifest stays fresh. */
const DEFAULT_TTL_MS = 5000

/**
 * Extract the script name from a runner invocation.
 *
 * A bare subcommand (`pnpm lint`) counts as a script ONLY when the workspace
 * actually defines one by that name — that is what the package manager itself
 * does, and it is what lets `pnpm deploy` be judged by the deploy script's
 * body instead of by the package manager's own `deploy` subcommand.
 *
 * @param program - the package-manager program name (lower-case).
 * @param rest - the argument text after the program.
 * @param knownScript - predicate answering "does the manifest define this script?".
 * @returns the script name, or `null` when this is not a script invocation.
 */
export function scriptNameOf(program, rest, knownScript = () => false) {
  if (!SCRIPT_RUNNERS.has(program)) return null
  const tokens = String(rest ?? '').trim().split(/[ \t]+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return null
  const first = tokens[0].toLowerCase()
  if (RUN_SUBCOMMANDS.has(first)) {
    const name = tokens.slice(1).find((token) => !token.startsWith('-'))
    return name ?? null
  }
  if (tokens[0].startsWith('-')) return null
  return knownScript(tokens[0]) ? tokens[0] : null
}

/**
 * Build the `expandScript` hook consumed by the command analyzer.
 *
 * @param options - `{ workspaceRoot, readFile?, ttlMs?, onWarn? }`.
 *   `readFile` defaults to `node:fs` and is injected for tests.
 * @returns a function `(program, rest, tool) => string | null`.
 */
export function makeScriptExpander(options = {}) {
  const workspaceRoot = typeof options.workspaceRoot === 'string' ? options.workspaceRoot : process.cwd()
  const readFile = typeof options.readFile === 'function'
    ? options.readFile
    : (path) => readFileSync(path, 'utf8')
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {}
  const manifestPath = join(workspaceRoot, 'package.json')
  let cache = { at: 0, scripts: null, broken: false }

  /**
   * Read and cache the workspace manifest's `scripts` map.
   * @returns the scripts map (empty when unavailable).
   */
  const scripts = () => {
    const now = Date.now()
    if (cache.scripts !== null && now - cache.at < ttlMs) return cache.scripts
    if (cache.broken && now - cache.at < ttlMs) return {}
    try {
      const parsed = JSON.parse(readFile(manifestPath))
      const map = parsed !== null && typeof parsed.scripts === 'object' && parsed.scripts !== null
        ? parsed.scripts
        : {}
      cache = { at: now, scripts: map, broken: false }
      return map
    } catch (error) {
      // A missing/invalid manifest is normal outside a Node project: remember
      // the miss for the TTL so a burst of decisions does not re-stat it.
      cache = { at: now, scripts: null, broken: true }
      onWarn(`cannot expand package scripts (${manifestPath}): ${String(error?.message ?? error)}`)
      return {}
    }
  }

  /**
   * Resolve a runner invocation to the script text it would execute.
   * @param program - the compared program name.
   * @param rest - the argument text.
   * @returns the script text, or `null` when this is not an expandable script.
   */
  return (program, rest) => {
    const map = scripts()
    const name = scriptNameOf(program, rest, (candidate) => Object.prototype.hasOwnProperty.call(map, candidate))
    if (name === null) return null
    const body = map[name]
    if (typeof body !== 'string' || body.trim().length === 0) return null
    // npm/pnpm/yarn run the `pre`/`post` lifecycle hooks around the script, so
    // they are part of what actually executes: fold them in as separate
    // statements instead of judging the body alone. Missing hooks are skipped.
    const hooks = [`pre${name}`, name, `post${name}`]
      .map((key) => map[key])
      .filter((text) => typeof text === 'string' && text.trim().length > 0)
    return hooks.join(' ; ')
  }
}
