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
 *   - landlock / seatbelt: their profile builders are module-private and
 *     cannot be extended from outside; a one-time warning is logged and the
 *     command runs under the stock profile (trusted roots ignored there).
 *
 * Mount this row ONLY on Linux/macOS; keep the stock `sandbox` row on Windows.
 */

import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

export const name = 'dsh-sandbox-allowlist-provider'

export class AllowlistSandboxProvider extends LocalSandboxProvider {
  constructor(ctx, config) {
    super(ctx, config)
    this._unsupportedWarned = false
  }

  confine(argv, policy) {
    const result = super.confine(argv, policy)
    if (process.platform === 'win32' || policy.mode !== 'workspace-write') return result
    const extra = Array.isArray(policy.extraRoots) ? policy.extraRoots : []
    if (extra.length === 0) return result

    if (result.argv[0] === 'bwrap') {
      // bwrap profile: [bwrap, ...profileArgs, '--', ...userArgv]; extra binds
      // must go before the '--' separator.
      const separator = result.argv.indexOf('--')
      const insertAt = separator === -1 ? result.argv.length : separator
      const binds = []
      for (const root of extra) binds.push('--bind', root, root)
      return { ...result, argv: [...result.argv.slice(0, insertAt), ...binds, ...result.argv.slice(insertAt)] }
    }

    this._warnUnsupported(result.argv[0])
    return result
  }

  _warnUnsupported(runner) {
    if (this._unsupportedWarned) return
    this._unsupportedWarned = true
    try {
      this.ctx.logger?.warn?.(`sandbox-allowlist: the "${runner}" sandbox rung cannot extend its write allow-list from outside the provider; trusted roots are ignored on this backend (prefer bwrap, or use danger-full-access for those commands)`)
    } catch {
      // logger unavailable — never break the sandbox over a warning
    }
  }
}

export default AllowlistSandboxProvider
