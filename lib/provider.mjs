/**
 * Trusted-roots sandbox provider extension — replaces the base `sandbox` row
 * (`@deepseek-ai/dsh-sandbox-local`) on Linux/macOS so confined CLI children
 * can write the trusted roots carried by `policy.extraRoots`.
 *
 * Windows needs no provider change: the ACL restricted token's write
 * allow-list is "everywhere the workspace write SID has a Write ACE", and
 * policy.mjs materializes those ACEs directly. On Linux/macOS the allow-list
 * lives in the runner profile, which is provider-owned, so this subclass
 * extends it:
 *   - bwrap (preferred Linux runner): appends `--bind <root> <root>` for each
 *     trusted root — full support.
 *   - seatbelt (macOS runner): appends `(allow file-write* (subpath "<root>"))`
 *     to the SBPL profile passed through `-p` — full support. The profile is a
 *     plain argv string and SBPL applies the LAST matching rule, so an allow
 *     appended at the end reopens exactly those subpaths while the stock deny
 *     stays in force everywhere else.
 *   - landlock: its profile builder is module-private and cannot be extended
 *     from outside; a one-time warning is logged and the command runs under
 *     the stock profile (trusted roots ignored there).
 *
 * Mount this row ONLY on Linux/macOS; keep the stock `sandbox` row on Windows.
 */

import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

export const name = 'dsh-sandbox-allowlist-provider'

const SEATBELT_RUNNER = 'sandbox-exec'

/** Runner identity: a host that resolves the runner to an absolute path still matches. */
function runnerBasename(program) {
  return String(program ?? '').split(/[\\/]/).pop() ?? ''
}

/** Quote one path as an SBPL string literal, escaping exactly like the core builder. */
function sbplString(path) {
  return `"${String(path).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Append trusted roots to the Seatbelt profile already wrapped into `argv`.
 *
 * Contract: the core provider wraps a command as
 * `[sandbox-exec, '-p', <SBPL profile>, '--', ...userArgv]`. The roots must
 * already be canonical (`policy.mjs` resolves them through `realpath`):
 * Seatbelt matches resolved paths, and `/tmp` IS `/private/tmp` on darwin.
 *
 * Defensive by design: the `-p` search stops at the `--` separator, so a
 * `-p` belonging to the user command can never be mistaken for the profile.
 * When the shape is not recognized the argv comes back untouched — a core
 * change must degrade to the stock profile, never to a broken one.
 *
 * @param argv - the runner invocation returned by the core provider.
 * @param roots - canonical trusted roots to admit.
 * @returns a new argv with the extended profile, or `argv` itself when the
 *   runner shape is not recognized.
 */
export function appendSeatbeltRoots(argv, roots) {
  if (!Array.isArray(argv) || !Array.isArray(roots) || roots.length === 0) return argv
  const separator = argv.indexOf('--')
  if (separator === -1) return argv
  const profileAt = argv.indexOf('-p')
  // The profile token must sit between `-p` and the separator.
  if (profileAt === -1 || profileAt + 1 >= separator) return argv
  const profile = argv[profileAt + 1]
  if (typeof profile !== 'string' || profile.length === 0) return argv
  const allows = roots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`).join(' ')
  const extended = argv.slice()
  extended[profileAt + 1] = `${profile} ${allows}`
  return extended
}

export class AllowlistSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config)
    this._unsupportedWarned = false
    this._seatbeltShapeWarned = false
  }


  async confine(argv, policy, signal) {
    const result = await super.confine(argv, policy, signal)
    if (process.platform === 'win32' || policy.mode !== 'workspace-write') return result
    const extra = Array.isArray(policy.extraRoots) ? policy.extraRoots : []
    if (extra.length === 0) return result

    // The runner is identified by basename: a host that resolves a runner to
    // an absolute path must still be recognized as the extendable backend.
    const runner = runnerBasename(result.argv[0])
    if (runner === 'bwrap') {
      // bwrap profile: [bwrap, ...profileArgs, '--', ...userArgv]; extra binds
      // must go before the '--' separator.
      const separator = result.argv.indexOf('--')
      const insertAt = separator === -1 ? result.argv.length : separator
      const binds = []
      for (const root of extra) binds.push('--bind', root, root)
      return { ...result, argv: [...result.argv.slice(0, insertAt), ...binds, ...result.argv.slice(insertAt)] }
    }

    if (runner === SEATBELT_RUNNER) {
      // Depends on the core contract "the SBPL profile rides `-p`". A core that
      // switches profile transport is a compat break, not a user error: keep
      // the stock profile and say so once, instead of silently ignoring roots.
      const extended = appendSeatbeltRoots(result.argv, extra)
      if (extended === result.argv) {
        this._warnSeatbeltShape()
        return result
      }
      return { ...result, argv: extended }
    }

    this._warnUnsupported(result.argv[0])
    return result
  }

  _warnSeatbeltShape() {
    if (this._seatbeltShapeWarned) return
    this._seatbeltShapeWarned = true
    try {
      this.ctx.logger?.warn?.('sandbox-allowlist: unrecognized "sandbox-exec" invocation (no -p profile before the -- separator); trusted roots are ignored on this backend — this plugin may need an update for the current dsh core')
    } catch {
      // logger unavailable — never break the sandbox over a warning
    }
  }

  _warnUnsupported(runner) {
    if (this._unsupportedWarned) return
    this._unsupportedWarned = true
    const name = runnerBasename(runner)
    try {
      this.ctx.logger?.warn?.(`sandbox-allowlist: the "${name}" sandbox rung cannot extend its write allow-list from outside the provider; trusted roots are ignored on this backend (use danger-full-access for those commands)`)
    } catch {
      // logger unavailable — never break the sandbox over a warning
    }
  }
}

// The patch layer gates this row per platform, but a user-level patch override
// (the plugin manager writes `disabled: false` when a row is toggled on)
// applies AFTER the package layer and can force the row on anywhere. On win32
// the stock `sandbox` row stays active, so providing "sandbox" here would fail
// the whole boot with a duplicate-service error — and instantiating a second
// LocalSandboxProvider would double-register its ACL diagnosis skill and grant
// revocation. Stay inert instead: activate as a plain plugin that provides
// nothing and log once why.
class InertProvider {
  constructor(ctx) {
    try {
      ctx.logger?.warn?.('sandbox-allowlist: the provider row has no effect on win32 (the stock ACL sandbox stays active); the user patch layer force-enabled it')
    } catch {
      // logger unavailable — never break activation over a warning
    }
  }
}

export default process.platform === 'win32' ? InertProvider : AllowlistSandboxProvider
