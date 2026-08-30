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
 *      documents. Grants are STANDING and tracked in a durable manifest
 *      (grant-manifest.mjs); removing a directory from the allowlist
 *      triggers an automatic reconcile that reclaims (removes) the ACE it
 *      previously materialized — Windows revocation is therefore complete
 *      and needs no manual cleanup (acl-revoke.mjs).
 *   4. A model-facing prompt context section so the agent knows which
 *      out-of-workspace roots are writable.
 *
 * The fs fence (`fs.mjs`) and the Linux provider (`provider.mjs`) consume the
 * same `policy.extraRoots`, so the CLI and the write/edit tools never drift.
 *
 * Linux/macOS: ACE materialization and reclamation are no-ops (guarded by a
 * conditional dynamic import, so the win32/koffi module is never loaded
 * there); the bwrap/landlock/seatbelt extension lives in provider.mjs.
 */

import z from '@deepseek-ai/schemastery'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandTrustedRoots } from './patterns.mjs'
import { COMMAND_ACTIONS, SHELL_TOOLS } from './command-rules.mjs'
import { apply as applyCommandGate } from './command-gate.mjs'
import { apply as applyApprovalGate } from './command-approval-gate.mjs'
import {
  manifestPath,
  loadManifest,
  saveManifest,
  workspaceGrants,
  setWorkspaceGrants,
  diffGranted,
} from './grant-manifest.mjs'
import { revokeWriteAces } from './acl-revoke.mjs'

export const name = 'dsh-sandbox-allowlist-policy'

/** Win32 case-insensitive, both separators: is `path` `root` or under it? */
function isPathUnderRoot(root, path) {
  if (process.platform === 'win32') {
    const r = root.toLowerCase().replace(/[\\/]+$/, '')
    const p = path.toLowerCase()
    return p === r || p.startsWith(`${r}\\`) || p.startsWith(`${r}/`)
  }
  const r = root.replace(/\/+$/, '')
  return path === r || path.startsWith(`${r}/`)
}

/** Settings namespace this plugin registers (`sandbox-allowlist`). */
export const SETTINGS_NAMESPACE = 'sandbox-allowlist'

/** Warning copy shown in the settings UI (carried by the schema descriptions). */
export const WARNING_COPY = [
  '⚠️ 安全警示：以下目录是「沙箱授权目录」——沙箱内的 AI 代理被授权在这些目录'
  + '（工作区之外）执行修改操作，无需审批。',
  '请只添加你完全信任的目录；目录必须已存在且归当前用户所有。',
  '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。',
  '撤销授权请删除对应条目（Windows 上此前授予目录的写权限会在撤销时自动回收，无需手工清理）。',
].join(' ')

/**
 * One command allow-list rule: an optional shell tool, a command pattern, and
 * an action. Matched against the normalized command string with `*` / `?`
 * wildcards (see command-rules.mjs); the LAST matching rule wins.
 */
export const CommandRuleSchema = z.object({
  tool: z.union([...SHELL_TOOLS]).required(false)
    .description('Shell tool this rule applies to (bash, pwsh). Omitted ⇒ applies to every shell tool.'),
  pattern: z.string().required()
    .description('Command pattern to match, e.g. `git *` (ignores the arguments after `git`), `git status?`, `rm -rf *`. Supports `*` (any run of characters) and `?` (exactly one character).'),
  action: z.union([...COMMAND_ACTIONS]).required()
    .description('allow: run without an approval prompt; ask: prompt for approval; deny: block the command.'),
})

/**
 * The `commands` section of the `sandbox-allowlist` settings: a rule list plus
 * the action used when no rule matches.
 */
export const CommandSettingsSchema = z.object({
  default: z.union([...COMMAND_ACTIONS, 'delegate']).required(false)
    .description('Action when no rule matches. `delegate` (default) keeps the current downstream behavior (stock approval/ask); allow/ask/deny override it.'),
  rules: z.array(CommandRuleSchema).default([])
    .description('Command allow-list rules. Evaluated in order; the last matching rule wins.'),
})

/**
 * Schema for the `sandbox-allowlist` user-settings namespace. The settings
 * page renders this generically; descriptions carry the warning copy.
 */
export const AllowlistSettingsSchema = z.object({
  allowedDirs: z.array(z.string()).default([])
    .description(WARNING_COPY),
  commands: CommandSettingsSchema.default({})
    .description('命令放行规则：配置哪些命令无需询问即可运行（或应被拦截）。参考 opencode / Claude Code 的权限规则设计：按工具 + 命令模式匹配，支持 `*`/`?` 通配符以忽略参数。'),
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
    /**
     * Command allow-list rules and fallback action (open/Claude-Code style).
     * This is the composition `base` layer of the `sandbox-allowlist` settings
     * namespace; users normally edit it through the settings page instead.
     */
    commands: CommandSettingsSchema.default({}),
    /** How long an expansion snapshot stays fresh before re-walking. */
    expandTtlMs: z.natural().default(5000),
    /** Fail hard (throw) on pattern expansion problems instead of warn+skip. */
    strict: z.boolean().default(false),
  })

  constructor(ctx, config) {
    super(ctx, config)
    this.patterns = config.allowedDirs ?? []
    this.commands = config.commands ?? {}
    this.expandTtlMs = config.expandTtlMs ?? 5000
    this.strict = config.strict === true
    /** The workspace root this policy instance holds ACEs for. */
    this._workspaceRoot = config.workspaceRoot
    /** { at: number, roots: string[] } — TTL-cached expansion snapshot. */
    this._cache = { at: 0, roots: [] }
    /** workspaceRoot -> AclWriteGrant (win32 only). */
    this._grants = new Map()
    /** workspaceRoot -> Set<root> — roots whose ACE is materialized and
     * recorded in the durable manifest (the runtime mirror of the file). */
    this._granted = new Map()
    /** Path of the durable grants manifest (next to the settings document). */
    this._manifestFile = manifestPath(this._storeDir())
    /** Lazily loaded manifest: { workspaces: { [workspaceRoot]: string[] } }. */
    this._manifest = null
    /** One-shot startup reconcile for settings-absent deployments. */
    this._startupReconciled = false
    /** The registered settings scope, once the settings service is available. */
    this._settingsScope = undefined
    /** callId -> { tool, command } — shared with the command gate for the
     * escalation auto-approval gate (command-approval-gate.mjs). */
    this._callStore = new Map()
    ctx.effect(() => () => this._disposeGrants())
    this._registerTrustedRootsContext(ctx)
    this._registerSettingsNamespace(ctx)
    this._registerCommandGate(ctx)
  }

  /** Composition patterns, overridden by the user-settings namespace when present. */
  _currentPatterns() {
    if (this._settingsScope !== undefined) {
      const section = this._settingsScope.get()
      if (Array.isArray(section?.allowedDirs)) return section.allowedDirs
    }
    return this.patterns
  }

  /** Effective command rule source, overridden by the user-settings namespace when present. */
  _currentCommands() {
    if (this._settingsScope !== undefined) {
      const section = this._settingsScope.get()
      if (section?.commands !== undefined && section.commands !== null) return section.commands
    }
    return this.commands
  }

  /** Directory holding the derived-state manifest (DSH home, else ~/.dsh). */
  _storeDir() {
    return process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
  }

  /**
   * Manifest roots recorded for a workspace, hydrating the runtime
   * skip-set so grants and revokes stay consistent with the file.
   */
  _manifestFor(workspaceRoot) {
    if (this._manifest === null) this._manifest = loadManifest(this._manifestFile)
    const roots = workspaceGrants(this._manifest, workspaceRoot)
    if (!this._granted.has(workspaceRoot)) this._granted.set(workspaceRoot, new Set(roots))
    return roots
  }

  /**
   * Reconcile the materialized OS state with the current allowlist: grant
   * roots that were added and reclaim (remove) ACEs on roots that were
   * removed — revocation is therefore complete (the ACL mirrors the config).
   * Runs when the settings change and once the settings scope binds at
   * startup, so offline edits and crashes are repaired too (the manifest is
   * the durable memory). Idempotent and cheap when nothing changed: no
   * syscall, no process spawn. Roots that exist but cannot be reclaimed
   * (e.g. no longer owner-writable) stay in the manifest and are retried on
   * the next reconcile; roots that no longer exist are dropped (no ACE there).
   */
  _reconcile(workspaceRoot) {
    if (acl === null) return // non-Windows: nothing is materialized
    const wanted = this.expandRoots()
    const granted = this._manifestFor(workspaceRoot)
    const { toAdd, toRemove } = diffGranted(granted, wanted)
    const grantSet = this._granted.get(workspaceRoot)
    if (toRemove.length > 0) {
      const sid = acl.workspaceWriteSid(canonicalPath(workspaceRoot))
      const result = revokeWriteAces(toRemove, sid)
      const failedRoots = new Set()
      for (const item of result.failed) {
        for (const root of toRemove) {
          if (isPathUnderRoot(root, item.path)) failedRoots.add(root)
        }
      }
      for (const root of toRemove) {
        if (failedRoots.has(root)) {
          const detail = result.failed.find((item) => isPathUnderRoot(root, item.path))
          this._warn(`reclaim of "${root}" deferred (retry on next reconcile): ${detail?.error ?? 'unknown'}`)
        } else {
          grantSet.delete(root)
        }
      }
    }
    if (toAdd.length > 0) this._ensureGrants(workspaceRoot, toAdd)
    if (toAdd.length > 0 || toRemove.length > 0) {
      setWorkspaceGrants(this._manifest, workspaceRoot, [...grantSet])
      try {
        saveManifest(this._manifestFile, this._manifest)
      } catch (error) {
        this._warn(`cannot persist grants manifest (${this._manifestFile}): ${String(error?.message ?? error)}`)
      }
    }
  }

  /**
   * Register the command allow-list gate (`tools/pre-execute` listener) and
   * the escalation auto-approval gate (`approval/request` answerer). Rules are
   * read live from {@link _currentCommands}, so edits via the settings page
   * take effect immediately. Registration is deferred until `ctx.tools` is
   * available (dependency-driven, like the settings namespace).
   */
  _registerCommandGate(ctx) {
    try {
      ctx.inject(['tools'], () => {
        const getRuleSource = () => this._currentCommands()
        applyCommandGate(ctx, { getRuleSource, callStore: this._callStore })
        applyApprovalGate(ctx, { getRuleSource, callStore: this._callStore })
      })
    } catch (error) {
      this._warn(`command gate registration skipped: ${String(error)}`)
    }
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
    // Settings-absent deployments (no settings service): the composition
    // config is authoritative, so run the startup reconcile once against it.
    if (acl !== null && !this._startupReconciled && this._settingsScope === undefined) {
      this._startupReconciled = true
      this._reconcile(policy.workspaceRoot)
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
          base: {
            allowedDirs: this.patterns,
            commands: this.commands && typeof this.commands === 'object' ? this.commands : {},
          },
        })
        this._settingsScope = owner
        // A settings edit invalidates the TTL cache and reconciles the
        // materialized grants: new roots are granted, removed roots are
        // reclaimed. Both take effect immediately on save.
        this._settingsDisposer = owner.watch(() => {
          this._cache = { at: 0, roots: [] }
          this._reconcile(this._workspaceRoot)
        })
        // Startup reconciliation: repairs any state left by edits made while
        // the server was down, or by a crash between a config change and the
        // previous reconcile. Invalidate the expansion cache first — a stale
        // pre-bind snapshot (base patterns) must not drive this reconcile.
        this._cache = { at: 0, roots: [] }
        this._reconcile(this._workspaceRoot)
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
