/**
 * Sandbox-allowlist policy extension — replaces the base `sandbox-policy`
 * row (`@deepseek-ai/dsh-sandbox-policy`).
 *
 * What it adds on top of the stock `SandboxPolicyService`:
 *   1. An `allowedDirs` setting (wildcard patterns, see patterns.mjs) that
 *      expands to concrete canonical roots on each `resolve()` (TTL cached),
 *      carried as `policy.extraRoots`. These are the directories whose
 *      modification the sandbox authorizes OUTSIDE the workspace.
 *   2. A `sandbox-allowlist` user-settings namespace (`ctx.settings`): the
 *      dsh settings page renders a form for it (the 沙箱授权目录 section,
 *      warning copy carried in the schema descriptions); edits persist to the
 *      user settings document and take effect live. The composition config is
 *      the namespace's `base` layer.
 *   3. Windows ACL materialization: for every workspace root, the workspace
 *      write SID's inheritable Write ACE is added to each allowed root's
 *      DACL, so confined CLI children (which carry that SID in their
 *      WRITE_RESTRICTED token) can write there without escalation. This is
 *      the "caller-owned DACL / grant reuse" pattern the sandbox seam
 *      documents; ACEs are standing (never auto-revoked) — see
 *      scripts/revoke.mjs.
 *   4. A model-facing prompt context section so the agent knows which
 *      out-of-workspace roots are writable.
 *
 * The fs fence (`fs.mjs`) and the Linux provider (`provider.mjs`) consume the
 * same `policy.extraRoots`, so the CLI and the write/edit tools never drift.
 *
 * Linux/macOS: ACE materialization is a no-op (guarded by a conditional
 * dynamic import, so the win32/koffi module is never loaded there); the
 * bwrap/landlock/seatbelt extension lives in provider.mjs.
 */

import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { expandTrustedRoots } from './patterns.mjs'

export const name = 'dsh-sandbox-allowlist-policy'

/** Settings namespace this plugin registers (`sandbox-allowlist`). */
export const SETTINGS_NAMESPACE = 'sandbox-allowlist'

/** Warning copy shown in the settings UI (carried by the schema descriptions). */
export const WARNING_COPY = [
  '⚠️ 安全警示：以下目录是「沙箱授权目录」——沙箱内的 AI 代理被授权在这些目录'
  + '（工作区之外）执行修改操作，无需审批。',
  '请只添加你完全信任的目录；目录必须已存在且归当前用户所有。',
  '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。',
  '撤销授权请删除对应条目（Windows 上旧目录的 ACE 用 scripts/revoke.mjs 清理）。',
].join(' ')

/**
 * Schema for the `sandbox-allowlist` user-settings namespace. The settings
 * page renders this generically; descriptions carry the warning copy.
 */
export const AllowlistSettingsSchema = z.object({
  allowedDirs: z.array(z.string()).default([])
    .description(WARNING_COPY),
})

// Windows-only: the ACL grant seam. Conditional top-level await keeps the
// module loadable on every platform — koffi/win32 bindings are only
// evaluated when this branch runs.
const acl = process.platform === 'win32' ? await import('@deepseek-ai/dsh-sandbox-windows-acl') : null

export class AllowlistPolicyService extends SandboxPolicyService {
  static Config = z.object({
    mode: z.union([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]).default('read-only'),
    workspaceRoot: z.string(),
    /**
     * Authorized out-of-workspace writable roots (wildcard patterns). This is
     * the composition `base` layer of the `sandbox-allowlist` settings
     * namespace: users normally edit the list through the settings page
     * instead.
     */
    allowedDirs: z.array(z.string()).default([]),
    /** How long an expansion snapshot stays fresh before re-walking. */
    expandTtlMs: z.natural().default(5000),
    /** Fail hard (throw) on pattern expansion problems instead of warn+skip. */
    strict: z.boolean().default(false),
  })

  constructor(ctx, config) {
    super(ctx, config)
    this.patterns = config.allowedDirs ?? []
    this.expandTtlMs = config.expandTtlMs ?? 5000
    this.strict = config.strict === true
    /** { at: number, roots: string[] } — TTL-cached expansion snapshot. */
    this._cache = { at: 0, roots: [] }
    /** workspaceRoot -> AclWriteGrant (win32 only). */
    this._grants = new Map()
    /** workspaceRoot -> Set<root> — roots whose ACE is already materialized. */
    this._granted = new Map()
    /** The registered settings scope, once the settings service is available. */
    this._settingsScope = undefined
    ctx.effect(() => () => this._disposeGrants())
    this._registerTrustedRootsContext(ctx)
    this._registerSettingsNamespace(ctx)
  }

  /** Composition patterns, overridden by the user-settings namespace when present. */
  _currentPatterns() {
    if (this._settingsScope !== undefined) {
      const section = this._settingsScope.get()
      if (Array.isArray(section?.allowedDirs)) return section.allowedDirs
    }
    return this.patterns
  }

  /** Expand the configured patterns into concrete canonical writable roots. */
  expandRoots() {
    const now = Date.now()
    if (now - this._cache.at < this.expandTtlMs) return this._cache.roots
    const patterns = this._currentPatterns()
    const roots = []
    const problems = []
    for (const pattern of patterns) {
      try {
        roots.push(...expandTrustedRoots(pattern))
      } catch (error) {
        problems.push(`${pattern}: ${String(error?.message ?? error)}`)
      }
    }
    if (problems.length > 0) {
      const message = `sandbox-allowlist: pattern expansion failed: ${problems.join('; ')}`
      if (this.strict) throw new Error(message)
      this._warn(message)
    }
    const unique = [...new Set(roots)]
    this._cache = { at: now, roots: unique }
    return unique
  }

  resolve(request = {}) {
    const policy = super.resolve(request)
    if (policy.mode === 'workspace-write' && this._currentPatterns().length > 0) {
      const roots = this.expandRoots()
      if (roots.length > 0) {
        policy.extraRoots = roots
        if (acl !== null) this._ensureGrants(policy.workspaceRoot, roots)
      }
    }
    return policy
  }

  /**
   * Register the `sandbox-allowlist` settings namespace so the dsh settings
   * page renders the 沙箱授权目录 form. The composition `base` is this row's
   * own `allowedDirs`, so the settings page shows the deployment default and
   * users' edits (persisted to the user settings document) override it.
   */
  _registerSettingsNamespace(ctx) {
    try {
      ctx.inject(['settings'], (scope) => {
        const owner = scope.settings.register(SETTINGS_NAMESPACE, AllowlistSettingsSchema, {
          base: { allowedDirs: this.patterns },
        })
        this._settingsScope = owner
        // A settings edit must invalidate the TTL cache so it takes effect live.
        this._settingsDisposer = owner.watch(() => {
          this._cache = { at: 0, roots: [] }
        })
      })
    } catch (error) {
      this._warn(`settings namespace registration skipped: ${String(error)}`)
    }
  }

  /** Materialize the workspace write SID's ACE on every allowed root (win32). */
  _ensureGrants(workspaceRoot, roots) {
    let grant = this._grants.get(workspaceRoot)
    if (grant === undefined) {
      const sid = acl.workspaceWriteSid(canonicalPath(workspaceRoot))
      grant = acl.AclWriteGrant.create(sid)
      this._grants.set(workspaceRoot, grant)
    }
    let granted = this._granted.get(workspaceRoot)
    if (granted === undefined) {
      granted = new Set()
      this._granted.set(workspaceRoot, granted)
    }
    for (const root of roots) {
      if (granted.has(root)) continue // exact-ACE skip without the syscall
      try {
        grant.add(root, true) // standing — the cross-session reuse cache
        granted.add(root)
      } catch (error) {
        this._warn(`cannot grant write on "${root}": ${String(error?.message ?? error)}`)
      }
    }
  }

  _disposeGrants() {
    for (const grant of this._grants.values()) {
      try {
        grant.dispose() // standing ACEs stay; SID allocations are freed
      } catch (error) {
        this._warn(`grant cleanup failed: ${String(error?.message ?? error)}`)
      }
    }
    this._grants.clear()
    this._granted.clear()
  }

  /** Extra model-facing context so the agent knows allowed roots are writable. */
  _registerTrustedRootsContext(ctx) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'sandbox:allowlist',
          order: 111,
          text: (context) => {
            const session = context.agent?.session
            if (session === undefined) return ''
            const roots = this.expandRoots()
            if (roots.length === 0) return ''
            return `Sandbox-authorized writable roots (allowed under workspace-write, outside the session workspace): ${JSON.stringify(roots)}.`
          },
        })
      })
    } catch (error) {
      this._warn(`system-prompt context registration skipped: ${String(error)}`)
    }
  }

  _warn(message) {
    try {
      this.ctx.logger?.warn?.(`sandbox-allowlist: ${message}`)
    } catch {
      // logger unavailable — a broken logger must never break the sandbox
    }
  }
}

export default AllowlistPolicyService
