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
 *   - bwrap (preferred Linux runner): `confine()` inserts `--bind <root> <root>`
 *     for each trusted root before the `--` separator — full support.
 *   - seatbelt (macOS runner): `runnerArgv()` appends
 *     `(allow file-write* (subpath "<root>"))` to the SBPL profile — full
 *     support. Core builds the invocation as `[sandbox-exec, '-p', <profile>]`
 *     and overrides flow through `runnerArgv(runner, policy)`, where `runner`
 *     is the backend NAME (`'seatbelt'`), not a binary path: recognition
 *     survives an overridden `internals.seatbeltExec`, and an operator-declared
 *     `runnerCommand` never reaches this hook (core returns before it). The
 *     profile is a plain string and SBPL applies the LAST matching rule, so an
 *     allow appended at the end reopens exactly those subpaths while the stock
 *     deny stays in force everywhere else.
 *   - landlock: its profile builder is module-private and cannot be extended
 *     from outside; a one-time warning is logged and the command runs under
 *     the stock profile (trusted roots ignored there).
 *
 * Because the macOS append happens in `runnerArgv()`, `confine()` carries a
 * sentinel: the profile in the final argv must contain the first trusted
 * root's `(subpath ...)` form. A core that stops calling the hook (or moves
 * the profile off `-p`) would otherwise drop trusted roots silently; the
 * sentinel warns once instead. Its runner test accepts EITHER the
 * `sandbox-exec` basename or core's cached `selectedRunner` verdict, so an
 * overridden `internals.seatbeltExec` binary name cannot turn a successful
 * append into a false "cannot extend this backend" warning.
 *
 * Mount this row ONLY on Linux/macOS; keep the stock `sandbox` row on Windows.
 */

import { parse } from 'node:path'

import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

export const name = 'dsh-sandbox-allowlist-provider'

/** Backend name core passes to `runnerArgv()` — the hook's identity. */
const SEATBELT_BACKEND = 'seatbelt'
/** The binary that backend wraps; the basename `confine()` sees as `argv[0]`. */
const SEATBELT_BINARY = 'sandbox-exec'

/** Runner identity: a host that resolves the runner to an absolute path still matches. */
function runnerBasename(program) {
  return String(program ?? '').split(/[\\/]/).pop() ?? ''
}

/** Quote one path as an SBPL string literal, escaping exactly like the core builder. */
function sbplString(path) {
  return `"${String(path).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Append trusted roots to one Seatbelt profile string.
 *
 * The roots must already be canonical (`policy.mjs` resolves them through
 * `realpath`): Seatbelt matches resolved paths, and `/tmp` IS `/private/tmp`
 * on darwin. SBPL applies the last matching rule, so the appended allow
 * reopens exactly these subpaths.
 *
 * @param profile - the SBPL profile the core provider built.
 * @param roots - canonical trusted roots to admit.
 * @returns the extended profile, or `profile` itself when there is nothing to add.
 */
export function appendSeatbeltRoots(profile, roots) {
  if (typeof profile !== 'string' || profile.length === 0) return profile
  if (!Array.isArray(roots) || roots.length === 0) return profile
  const allows = roots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`).join(' ')
  return `${profile} ${allows}`
}

export class AllowlistSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config)
    this._unsupportedWarned = false
    this._seatbeltShapeWarned = false
    this._runnerCommandWarned = false
    this._filesystemRootWarned = false
  }

  /**
   * macOS hook: extend the Seatbelt profile before core joins it with the
   * trailing `-- ...userArgv`. The runner identity is the backend name core
   * passes, so an overridden `internals.seatbeltExec` binary name cannot
   * defeat recognition, and `runnerCommand` runs never reach this method.
   *
   * Defensive by design: when the invocation does not look like
   * `[exec, '-p', <profile>]` the argv comes back untouched — a core change
   * must degrade to the stock profile, never to a broken one.
   */
  runnerArgv(runner, policy) {
    const argv = super.runnerArgv(runner, policy)
    if (runner !== SEATBELT_BACKEND || policy?.mode !== 'workspace-write') return argv
    const extra = this._extraRoots(policy)
    if (extra.length === 0) return argv

    // Contract (core 0.2.0-rc.x): [exec, '-p', <profile>]. No user argv exists
    // yet, so this search cannot meet a `-p` belonging to the command.
    const profileAt = argv.indexOf('-p')
    const profile = profileAt === -1 ? undefined : argv[profileAt + 1]
    if (typeof profile !== 'string' || profile.length === 0) {
      this._warnSeatbeltShape()
      return argv
    }
    const extended = argv.slice()
    extended[profileAt + 1] = appendSeatbeltRoots(profile, extra)
    return extended
  }

  async confine(argv, policy, signal) {
    const result = await super.confine(argv, policy, signal)
    if (process.platform === 'win32' || policy.mode !== 'workspace-write') return result
    const extra = this._extraRoots(policy)
    if (extra.length === 0) return result

    // The runner is identified by basename: a host that resolves a runner to
    // an absolute path must still be recognized as the extendable backend.
    // `selectedRunner` (core's cached chain verdict) closes the last gap: an
    // overridden `internals.seatbeltExec` changes the binary NAME, so the argv
    // alone would miss the backend and fall through to the "cannot extend"
    // warning even though runnerArgv() already extended the profile.
    const runner = runnerBasename(result.argv[0])
    const seatbelt = runner === SEATBELT_BINARY || this.selectedRunner?.runner === SEATBELT_BACKEND
    if (runner === 'bwrap') {
      // bwrap profile: [bwrap, ...profileArgs, '--', ...userArgv]; extra binds
      // must go before the '--' separator.
      const separator = result.argv.indexOf('--')
      const insertAt = separator === -1 ? result.argv.length : separator
      const binds = []
      for (const root of extra) binds.push('--bind', root, root)
      return { ...result, argv: [...result.argv.slice(0, insertAt), ...binds, ...result.argv.slice(insertAt)] }
    }

    if (seatbelt) {
      // runnerArgv() owns the append; confine() only proves it landed.
      this._verifySeatbeltSentinel(result.argv, extra)
      return result
    }

    this._warnUnsupported(result.argv[0])
    return result
  }

  /**
   * The policy's usable trusted roots.
   *
   * A filesystem root (`/`, `D:\`) is dropped: seeding it would admit every
   * path on the volume — the Seatbelt `(subpath "/")` form makes the stock
   * `(deny file-write*)` unreachable (last match wins), and bwrap would bind
   * the whole tree read-write. Core's own allow-list never contains one, so
   * this only fires for a misconfigured `allowedDirs`/`trustedRoots`; warn once
   * and keep the stock profile rather than fail the command.
   *
   * @param policy - the resolved per-call policy (roots already canonical).
   * @returns the roots this backend may extend the profile with.
   */
  _extraRoots(policy) {
    const extra = Array.isArray(policy?.extraRoots) ? policy.extraRoots : []
    if (extra.length === 0) return extra
    return extra.filter((root) => {
      if (!this._isFilesystemRoot(root)) return true
      this._warnFilesystemRoot(root)
      return false
    })
  }

  /** Whether a canonical path IS a volume/filesystem root rather than a directory under one. */
  _isFilesystemRoot(root) {
    return typeof root === 'string' && root.length > 0 && parse(root).root === root
  }

  /**
   * Sentinel: the append happens in runnerArgv(), so a core that stops calling
   * that hook (or moves the profile off `-p`) would silently drop trusted
   * roots. Verify the final argv still carries the first root, warn once.
   */
  _verifySeatbeltSentinel(argv, extra) {
    if (this.runnerCommand !== undefined) {
      // The operator declared the runner invocation; core never calls
      // runnerArgv() on that path, and rewriting their explicit profile is not
      // this plugin's call.
      this._warnRunnerCommand()
      return
    }
    const separator = argv.indexOf('--')
    const end = separator === -1 ? argv.length : separator
    const profileAt = argv.indexOf('-p')
    const profile = profileAt !== -1 && profileAt + 1 < end ? argv[profileAt + 1] : null
    if (typeof profile === 'string' && profile.includes(`(subpath ${sbplString(extra[0])})`)) return
    this._warnSeatbeltShape()
  }

  _warnSeatbeltShape() {
    if (this._seatbeltShapeWarned) return
    this._seatbeltShapeWarned = true
    try {
      this.ctx.logger?.warn?.('sandbox-allowlist: trusted roots did not land in the sandbox-exec profile — the installed dsh core no longer passes the Seatbelt profile through runnerArgv as "-p <profile>"; trusted roots are ignored on this backend and this plugin may need an update')
    } catch {
      // logger unavailable — never break the sandbox over a warning
    }
  }

  _warnRunnerCommand() {
    if (this._runnerCommandWarned) return
    this._runnerCommandWarned = true
    try {
      this.ctx.logger?.warn?.('sandbox-allowlist: runnerCommand declares its own sandbox-exec invocation; that profile is left untouched and trusted roots are not added on this backend')
    } catch {
      // logger unavailable — never break the sandbox over a warning
    }
  }

  _warnFilesystemRoot(root) {
    if (this._filesystemRootWarned) return
    this._filesystemRootWarned = true
    try {
      this.ctx.logger?.warn?.(`sandbox-allowlist: ignoring the filesystem root "${root}" as a trusted root — admitting it would make every path on the volume writable; narrow the pattern to a real directory`)
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
