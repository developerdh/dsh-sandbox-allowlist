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

    // The runner is identified by basename: a host that resolves bwrap to an
    // absolute path must still be recognized as the extendable backend.
    const runner = String(result.argv[0] ?? '').split(/[\\/]/).pop() ?? ''
    if (runner === 'bwrap') {
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
    const name = String(runner ?? '').split(/[\\/]/).pop() ?? ''
    try {
      this.ctx.logger?.warn?.(`sandbox-allowlist: the "${name}" sandbox rung cannot extend its write allow-list from outside the provider; trusted roots are ignored on this backend (prefer bwrap, or use danger-full-access for those commands)`)
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
