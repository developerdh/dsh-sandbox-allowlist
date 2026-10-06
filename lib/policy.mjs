/**
 * Sandbox-allowlist policy extension — replaces the base `sandbox-policy`
 * row (`@deepseek-ai/dsh-sandbox-policy`).
 *
 * What it adds on top of the stock `SandboxPolicyService`:
 *   1. An `allowedDirs` setting (wildcard patterns, see patterns.mjs) that
 *      expands to concrete canonical roots on each `resolve()` (TTL cached),
 *      carried as `policy.extraRoots`. These are the directories whose
 *      modification the sandbox authorizes OUTSIDE the workspace.
 *   2. The rules come from this row's `Config` alone: `static Config` is the
 *      Schemastery schema the settings page projects its form from (the
 *      namespace is the Loader entry id, the field descriptions carry the
 *      warning copy). Saving the form makes the Loader reconcile the entry
 *      and re-apply this plugin with the merged config, so every rule read is
 *      a plain `this.*` read — there is no namespace registration and no live
 *      watch of our own.
 *      Every registration this plugin makes (prompt contexts, the two
 *      `tools/pre-execute` gates, the `approval/request` gate, the settings
 *      presentation policy) goes through `ctx.effect`, so the reload disposes
 *      the previous round instead of failing the next activation with a
 *      duplicate registration.
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
 *   5. A `noRead` read-restriction list (file-name/full-path patterns with
 *      `deny`/`ask` actions): the compiled rules ride `policy.noReadRules`,
 *      the fs fence (fs.mjs) hard-enforces `deny` on every content read, the
 *      pre-execute gate (read-gate.mjs) decides deny/ask for the read /
 *      read_image / edit tools, and a second prompt context section tells the
 *      agent which reads are restricted. There is no `allow` action — stock
 *      dsh already permits reading, so an explicit allow would be a no-op.
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
import { comparablePath, expandTrustedRoots, pathUnderDirectory } from './patterns.mjs'
import { COMMAND_ACTIONS, DEFAULT_ESCALATION_MODE, ESCALATION_MODES, SHELL_TOOLS } from './command-rules.mjs'
import { apply as applyCommandGate } from './command-gate.mjs'
import { apply as applyApprovalGate } from './command-approval-gate.mjs'
import { CommandAudit, ProposalStore, SessionDecisionCache, describeProposal } from './command-audit.mjs'
import { makeScriptExpander } from './command-expand.mjs'
import { isAutoSession } from './preset.mjs'
import { NO_READ_ACTIONS, compileNoReadRules, noReadRuleIssues, resolveNoRead } from './read-deny.mjs'
import { apply as applyReadGate } from './read-gate.mjs'
import {
  manifestPath,
  loadManifest,
  saveManifest,
  workspaceRecord,
  rootEntryAt,
  ensureRootEntry,
  removeRootEntry,
  activeEntries,
  isExcludedPath,
  diffGrantedV2,
  refreshFromPatterns,
  moveRootToHistory,
  pushHistory,
  enterPendingRevoke,
  dropPendingRevoke,
} from './grant-manifest.mjs'
import { revokeWriteAces } from './acl-revoke.mjs'
import { applyStateRoutes } from './state-routes.mjs'

export const name = 'dsh-sandbox-allowlist-policy'

/**
 * Prompt-context order for this plugin's two context sections, derived from
 * the official `SANDBOX_POLICY` placement constant (dsh ≥ 0.1.5 exposes
 * `systemPrompt.getContextOrder`) plus an offset. Deriving instead of
 * hard-coding 111/112 keeps the sections pinned next to the sandbox-policy
 * block even if the official order table shifts. Hosts older than 0.1.5 lack
 * the accessor; they fall back to the 0.1.1 `SANDBOX_POLICY` value (110).
 * @param systemPrompt - the injected `systemPrompt` service scope.
 * @param offset - 1 for the writable-roots section, 2 for the noRead section.
 * @returns the numeric order to pass to `context()`.
 */
function contextOrderFor(systemPrompt, offset) {
  const base = typeof systemPrompt?.getContextOrder === 'function'
    ? systemPrompt.getContextOrder('SANDBOX_POLICY')
    : undefined
  return (Number.isFinite(base) ? base : 110) + offset
}

/**
 * Loader entry id of this plugin's row (`cordis.patch.yml`). It is also the
 * settings namespace the form lives under: dsh 0.2.0 keys settings forms by
 * profile entry id, and the schema comes from this row's `static Config`.
 */
export const SETTINGS_ENTRY_ID = 'sandbox-allowlist-policy'

/** Warning copy shown in the settings UI (carried by the schema descriptions). */
export const WARNING_COPY = [
  '⚠️ 安全警示：以下目录是「沙箱授权目录」——沙箱内的 AI 代理被授权在这些目录'
  + '（工作区之外）执行修改操作，无需审批。',
  '请只添加你完全信任的目录；目录必须已存在且归当前用户所有。',
  '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Archive\\202?（单字符）。',
  '撤销授权请删除对应条目（Windows 上此前授予目录的写权限会在撤销时自动回收，无需手工清理）。',
].join(' ')

/**
 * One command allow-list rule: a whole-command `pattern` glob (opencode /
 * Claude-Code style) plus an action. A compound command is judged per
 * statement, so `git status*` allows `git status && git log` only for the
 * first half. The LAST matching rule wins.
 */
export const CommandRuleSchema = z.object({
  tool: z.union([...SHELL_TOOLS]).required(false)
    .description('Shell tool this rule applies to (bash, pwsh). Omitted ⇒ applies to every shell tool.'),
  pattern: z.string().required()
    .description('Whole-command pattern, e.g. `git *`, `git status*`, `rm -rf *`. Supports `*` (any run of characters) and `?` (exactly one). The program token is matched after normalizing (path, quotes and `.exe`-style suffixes stripped), so `git *` also matches a quoted full path to git.exe. Program names match case-insensitively; argument case is significant, so `git branch -d *` does NOT match `git branch -D`.'),
  action: z.union([...COMMAND_ACTIONS]).required()
    .description('allow: run without an approval prompt, AND a sandbox escalation for this shape is auto-approved too (the command may run OUTSIDE the sandbox); ask: prompt; deny: block.'),
})

/**
 * The `commands` section of the `sandbox-allowlist` settings: a rule list,
 * the action used when no rule matches, and the escalation/baseline knobs.
 */
export const CommandSettingsSchema = z.object({
  default: z.union([...COMMAND_ACTIONS, 'delegate']).required(false)
    .description('Action when no rule matches. `delegate` (default) keeps the current downstream behavior (stock approval/ask); allow/ask/deny override it.'),
  rules: z.array(CommandRuleSchema).default([])
    .description('Command allow-list rules. Evaluated in order; the last matching rule wins. Commands are split into statements and each is judged on its own, so a narrow pattern like `git status*` can allow `git status` while `git push*` asks.'),
  escalation: z.union([...ESCALATION_MODES]).required(false)
    .description(`How a sandbox ESCALATION (the retry that runs the command outside the sandbox) may be auto-approved. \`${DEFAULT_ESCALATION_MODE}\` (default): a statement covered by an \`allow\` rule (which includes the escalation grant), or one whose every statement is a benign capability class — read-only, or a write whose targets stay inside the workspace and the authorized directories — is auto-approved; anything else (interpreters, network, package managers, unknown programs, unresolved structures) needs the user's approval. \`never\`: never auto-approve.`),
  baseline: z.boolean().required(false)
    .description('Built-in capability baseline (default true). Commands whose statements are all read-only, or write only inside the workspace/authorized directories, are recognized without any rule. Turn off to judge by your rules alone (everything unmatched then falls back to `default`).'),
  sessionCache: z.boolean().required(false)
    .description('Session-scoped memory (default true): once you approve an ESCALATION for an exact command by hand, the same command is not asked about again for the rest of the session. The key is the exact canonical command text, so any change to the arguments is a new decision.'),
})

/** Warning copy shown for the 禁读 (noRead) rules in the settings UI. */
export const NO_READ_COPY = [
  '⚠️ 禁读规则：命中清单的文件将被限制读取——read / read_image / edit 直接拒绝，'
  + 'write 覆盖已存在文件（需先读旧内容）也被拒绝，新建同名文件仍允许。',
  '每条规则 action 只提供 deny / ask，不提供 allow：官方默认本就允许读，显式 allow 是无意义的空操作。',
  '三种模式：① 不含路径分隔符 ⇒ 按文件名匹配任意目录深度：`*.pem`、`.env*`、`id_rsa*`；'
  + '② 含分隔符与通配符 ⇒ 按完整路径匹配：`D:\\Vault\\**\\*.key`；'
  + '③ 含分隔符但无通配符的绝对路径（如 `D:\\Vault` 或 `D:\\Vault/**`）⇒ 目录级：整棵子树禁读，含目录列表（listDir）。',
  '目录级规则不得锚定在盘符/根（`D:\\`、`/`），纯通配 `*`/`**`/`?` 会被拒绝——避免误伤整盘。',
  'deny：直接拒绝读取（默认，由文件系统栅栏强制执行）；ask：命中时弹一次人工审批，批准后本次放行。',
  '注意：只约束 dsh 自带读文件工具与经 ctx.fs 的读取——shell 命令（cat/type）与 grep 工具无法按文件名/扩展名强制拦截，目录级禁读也只覆盖工具层（进程级需 ACL/bwrap，见文档）。',
].join(' ')

/**
 * One noRead rule: a file-name/full-path pattern and a deny/ask action. There
 * is deliberately no `allow` action (reading is permitted by default — an
 * allow would be a silent no-op).
 */
export const ReadRuleSchema = z.object({
  pattern: z.string().required()
    .description('File name or path pattern to restrict. Three forms: (1) no path separator ⇒ matches the file name at any depth (`*.pem`, `.env*`, `id_rsa*`); (2) separator + glob meta ⇒ matches the full path (`D:\\Vault\\**\\*.key`); (3) separator, NO glob meta, absolute ⇒ DIRECTORY rule: a literal directory (`D:\\Vault`) or a subtree form (`D:\\Vault/**`) denies the whole tree, including directory listings. Root-anchored directory rules (`D:\\`, `/`) and pure wildcards (`*`, `**`, `?`) are refused as too broad.'),
  action: z.union([...NO_READ_ACTIONS]).default('deny')
    .description('deny: block the read outright (default, enforced by the filesystem fence). ask: prompt the user for a one-time approval before reading (approved reads are not re-refused by the fence).'),
})

/**
 * The three rule fields as a standalone section schema. The settings form no
 * longer comes from here: dsh 0.2.0 projects it from this row's
 * `AllowlistPolicyService.Config` (see the class below), which carries the
 * same three fields plus the deployment-only ones. This object stays exported
 * as the reusable section contract for callers that validate or hand a
 * rule section around without the deployment fields.
 */
export const AllowlistSettingsSchema = z.object({
  allowedDirs: z.array(z.string()).default([])
    .description(WARNING_COPY),
  commands: CommandSettingsSchema.default({})
    .description('命令放行规则：配置哪些命令无需询问即可运行（或应被拦截）。参考 opencode / Claude Code 的权限规则设计：按工具 + 命令模式匹配，支持 `*`/`?` 通配符以忽略参数。'),
  noRead: z.array(ReadRuleSchema).default([])
    .description(NO_READ_COPY),
})

// Windows-only: the ACL grant seam. Conditional top-level await keeps the
// module loadable on every platform — koffi/win32 bindings are only
// evaluated when this branch runs.
const acl = process.platform === 'win32' ? await import('@deepseek-ai/dsh-sandbox-windows-acl') : null

/**
 * Read through a live config reference. Fields marked `.volatile()` in the
 * Config schema arrive from the loader as a stable reference object with a
 * `get()` accessor (cosmokit `Volatile<T>`): the host updates its value in
 * place on every settings save, so the plugin sees edits without a remount.
 * Ordinary (non-volatile) config values pass through unchanged — tests and
 * callers may hand either shape.
 */
function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.get === 'function'
    ? value.get()
    : value
}

export class AllowlistPolicyService extends SandboxPolicyService {
  /**
   * The settings form's projection source. dsh 0.2.0 builds the form for a
   * Loader entry from that entry's `Config` schema and keys it by the entry id
   * ({@link SETTINGS_ENTRY_ID}), so the descriptions below are the form copy
   * and the resolved `Config` is the only rule source this service reads. The
   * composition layer is the form's `base`; the user's saves are its `user`
   * layer, merged by the Loader before this plugin is re-applied.
   */
  static Config = z.object({
    mode: z.union([
      'read-only',
      'workspace-write',
      'danger-full-access',
    ]).default('read-only'),
    workspaceRoot: z.string(),
    /** Authorized out-of-workspace writable roots (wildcard patterns). The
     * description IS the form's copy, so it carries the security warning.
     * `.volatile()` marks the field live-editable: the host projects ONLY
     * volatile fields into the settings form (`volatileForm` in dsh-settings)
     * and drops entries without any — without the marker the client's
     * configForms.get() sees no served namespace and the settings page is
     * stuck read-only. */
    allowedDirs: z.array(z.string()).default([])
      .description(WARNING_COPY)
      .volatile(),
    /** Command allow-list rules and fallback action (open/Claude-Code style). */
    commands: CommandSettingsSchema.default({})
      .description('命令放行规则：配置哪些命令无需询问即可运行（或应被拦截）。参考 opencode / Claude Code 的权限规则设计：按工具 + 命令模式匹配，支持 `*`/`?` 通配符以忽略参数。')
      .volatile(),
    /** Read-restriction rules (`noRead`): file-name/full-path patterns whose
     * reads are denied or gated behind an approval prompt. */
    noRead: z.array(ReadRuleSchema).default([])
      .description(NO_READ_COPY)
      .volatile(),
    /** How long an expansion snapshot stays fresh before re-walking. */
    expandTtlMs: z.natural().default(5000),
    /** Fail hard (throw) on pattern expansion problems instead of warn+skip. */
    strict: z.boolean().default(false),
  })

  constructor(ctx, config) {
    super(ctx, config)
    // The three rule fields are `.volatile()`: whatever arrives here may be a
    // live reference — keep it raw and read through `_current*()` on every use
    // so settings saves take effect without a reload.
    this.patterns = config.allowedDirs ?? []
    this.commands = config.commands ?? {}
    this.noRead = config.noRead ?? []
    this.expandTtlMs = config.expandTtlMs ?? 5000
    this.strict = config.strict === true
    /** The workspace root this policy instance holds ACEs for. */
    this._workspaceRoot = config.workspaceRoot
    /** { at: number, roots: string[] } — TTL-cached expansion snapshot. */
    this._cache = { at: 0, roots: [] }
    /** { key: string, compiled: [] } — compiled noRead rules keyed by raw JSON
     * (settings edits rebuild automatically on the next resolve). */
    this._noReadCache = { key: null, compiled: [] }
    /** workspaceRoot -> AclWriteGrant (win32 only). */
    this._grants = new Map()
    /** workspaceRoot -> Set<root> — roots whose ACE is materialized and
     * recorded in the durable manifest (the runtime mirror of the file). */
    this._granted = new Map()
    /** Path of the durable grants manifest (next to the settings document). */
    this._manifestFile = manifestPath(this._storeDir())
    /** Lazily loaded manifest: { version, workspaces } (v2 records, see
     * grant-manifest.mjs for the record contract). */
    this._manifest = null
    /** ACE reclamation primitive — an injection point so tests can fake the
     * PowerShell-backed strip and exercise the manifest accounting around it. */
    this._revokeAces = revokeWriteAces
    /** Reconcile serialization: the startup pass and rpc-driven exclusion
     * revokes/restores must never interleave (shared record + PS spawns). */
    this._reconcileTail = Promise.resolve()
    /** One-shot reconcile at construction: the Config is the only rule
     * source, so the first resolve() already reflects the current rules. */
    this._startupReconciled = false
    /** callId -> { tool, command } — shared with the command gate for the
     * escalation auto-approval gate (command-approval-gate.mjs). */
    this._callStore = new Map()
    /** Decision log: ring buffer + optional JSONL audit sink (layer 0). */
    this._audit = new CommandAudit({
      file: join(this._storeDir(), 'sandbox-allowlist-decisions.jsonl'),
      logger: { warn: (message) => this._warn(message) },
    })
    /** Session-scoped memory of hand-approved commands. */
    this._sessionCache = new SessionDecisionCache({
      enabled: this._currentCommands().sessionCache !== false,
    })
    /** Repeating hand approvals -> candidate rules (never applied automatically). */
    this._proposals = new ProposalStore({
      file: join(this._storeDir(), 'sandbox-allowlist-proposals.json'),
      logger: { warn: (message) => this._warn(message) },
    })
    /** Resolves `pnpm run <script>` to the script text it executes. */
    this._scriptExpander = makeScriptExpander({
      workspaceRoot: config.workspaceRoot,
      onWarn: (message) => this._warn(message),
    })
    ctx.effect(() => () => this._disposeGrants())
    this._registerTrustedRootsContext(ctx)
    this._registerNoReadContext(ctx)
    this._registerProposalContext(ctx)
    this._registerSettingsPresentation(ctx)
    this._registerCommandGate(ctx)
    this._registerReadGate(ctx)
    this._registerStateRoutes(ctx)
  }

  /** Authorized writable-root patterns (this row's `Config`, nothing else). */
  _currentPatterns() {
    const value = unwrapVolatile(this.patterns)
    return Array.isArray(value) ? value : []
  }

  /** Effective command rule source (this row's `Config`, nothing else). */
  _currentCommands() {
    const value = unwrapVolatile(this.commands)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }

  /** Effective noRead rule source (this row's `Config`, nothing else). */
  _currentNoRead() {
    const value = unwrapVolatile(this.noRead)
    return Array.isArray(value) ? value : []
  }

  /**
   * Compiled noRead rules ({@link compileNoReadRules}), cached against the raw
   * rules JSON so a reload (new Config → new instance) rebuilds them without
   * any explicit invalidation bookkeeping.
   */
  _noReadCompiled() {
    const raw = this._currentNoRead()
    const key = JSON.stringify(raw)
    if (this._noReadCache.key !== key) {
      for (const issue of noReadRuleIssues(raw)) this._warn(`noRead rule ignored (${issue})`)
      this._noReadCache = { key, compiled: compileNoReadRules(raw) }
    }
    return this._noReadCache.compiled
  }

  /** Directory holding the derived-state manifest (DSH home, else ~/.dsh). */
  _storeDir() {
    return process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
  }

  /**
   * Manifest record for a workspace, hydrating the runtime skip-set so grants
   * and revokes stay consistent with the file. Believed-to-carry-ACE =
   * `status: 'granted'` and not excluded; failed roots stay out of the
   * skip-set and are therefore retried on every resolve().
   */
  _manifestFor(workspaceRoot) {
    if (this._manifest === null) this._manifest = loadManifest(this._manifestFile)
    const record = workspaceRecord(this._manifest, workspaceRoot)
    if (!this._granted.has(workspaceRoot)) {
      this._granted.set(workspaceRoot, new Set(activeEntries(record).map((entry) => entry.path)))
    }
    return record
  }

  /**
   * Serialize reconcile runs: runs execute in submission order and an earlier
   * failure does not cancel later ones.
   */
  _reconcile(workspaceRoot) {
    const run = () => this._reconcileNow(workspaceRoot)
    this._reconcileTail = this._reconcileTail.then(run, run)
    return this._reconcileTail
  }

  /**
   * Reconcile the materialized OS state with the current allowlist: grant
   * roots that were added and reclaim (remove) ACEs on roots that were
   * removed — revocation is therefore complete (the ACL mirrors the config).
   * Runs once per instance at the first resolve() (one-shot startup guard),
   * plus on every exclusion change. Async and fire-and-forget: ACE
   * reclamation spawns PowerShell, which must not stall resolve(). Idempotent
   * and cheap when nothing changed: no syscall, no process spawn.
   *
   * Roots that exist but cannot be reclaimed (e.g. no longer owner-writable)
   * move to `pendingRevoke` and are retried on the next reconcile; roots that
   * no longer exist are dropped from the accounting (no ACE there). After a
   * successful reclaim the surviving grants are RE-APPLIED: stripping a
   * revoked root also removes the inherited ACE copies that still-granted
   * ancestors had contributed to its subtree, and Windows re-propagates an
   * inheritable ACE only when the granting directory's DACL is rewritten.
   * @param workspaceRoot - the canonical workspace root the ACEs belong to.
   */
  async _reconcileNow(workspaceRoot) {
    if (acl === null) return // non-Windows: nothing is materialized
    const record = this._manifestFor(workspaceRoot)
    const sid = acl.workspaceWriteSid(canonicalPath(workspaceRoot))
    record.sid = sid
    const grantSet = this._granted.get(workspaceRoot)
    const stamp = new Date().toISOString()
    let dirty = this._manifest.needsWriteBack === true // v1 file migrated on load

    // 0) Exclusion sweep: an excluded entry that never carried the ACE
    //    (status failed) has nothing to strip — it is audit-complete.
    for (const entry of [...record.roots]) {
      if (entry.excluded && entry.status !== 'granted') {
        moveRootToHistory(record, entry.path, 'excluded', stamp)
        dirty = true
      }
    }

    const wanted = this.expandRoots()
    const wantedKeys = new Set(wanted.map(comparablePath))

    // 1) Cancel obsolete pending revokes: the config re-covered the path and
    //    the exclusion is lifted — the standing ACE is wanted again.
    for (const entry of [...record.pendingRevoke]) {
      const stillExcluded = entry.origin === 'excluded'
        || rootEntryAt(record, entry.path)?.excluded === true
      if (wantedKeys.has(comparablePath(entry.path)) && !stillExcluded) {
        dropPendingRevoke(record, entry.path)
        const restored = ensureRootEntry(record, entry.path)
        restored.status = 'granted' // believed to still carry the ACE (the strip never succeeded)
        restored.excluded = false
        grantSet.add(entry.path)
        dirty = true
      }
    }

    // 2) Retry pending revocations (one batched PowerShell pass).
    if (record.pendingRevoke.length > 0) {
      const paths = record.pendingRevoke.map((entry) => entry.path)
      const result = await this._revokeAces(paths, sid)
      for (const entry of [...record.pendingRevoke]) {
        const failure = result.failed.find((item) => pathUnderDirectory(entry.path, item.path))
        const missing = result.missing.some((item) => comparablePath(item) === comparablePath(entry.path))
        if (missing) {
          dropPendingRevoke(record, entry.path) // dir gone — no ACE survives it; drop from accounting
        } else if (failure) {
          entry.attempts += 1
          entry.lastAttemptAt = stamp
          entry.error = failure.error ?? 'unknown'
        } else {
          dropPendingRevoke(record, entry.path)
          pushHistory(record, { path: entry.path, revokedAt: stamp, origin: entry.origin, fromPatterns: entry.fromPatterns })
        }
        dirty = true
      }
    }

    // 3) Refresh the audit mirror of which patterns currently cover each root.
    refreshFromPatterns(record, this._patternRoots())

    // v2 之前物化的根没有 grantedAt（迁移不伪造未知时间）；首次被 v2 对账确认
    // 仍被当前配置覆盖时补记确认时间，面板时间列不再长期显示「—」。
    for (const entry of record.roots) {
      if (entry.status === 'granted' && !entry.excluded && entry.grantedAt === null
        && wantedKeys.has(comparablePath(entry.path))) {
        entry.grantedAt = stamp
        dirty = true
      }
    }

    const { toAdd, toRemove } = diffGrantedV2(record, wanted)
    if (toRemove.length > 0) {
      const result = await this._revokeAces(toRemove, sid)
      for (const root of toRemove) {
        const entry = rootEntryAt(record, root)
        const failure = result.failed.find((item) => pathUnderDirectory(root, item.path))
        const missing = result.missing.some((item) => comparablePath(item) === comparablePath(root))
        grantSet.delete(root)
        if (failure) {
          enterPendingRevoke(record, {
            path: root,
            fromPatterns: entry?.fromPatterns ?? [],
            origin: entry?.excluded ? 'excluded' : 'config-removed',
            error: failure.error ?? 'unknown',
            attempts: 1,
            lastAttemptAt: stamp,
          })
          removeRootEntry(record, root) // 无处挂靠：记录离开 roots，由下次对账重试
          this._warn(`reclaim of "${root}" deferred (recorded in pendingRevoke, retry on next reconcile): ${failure.error ?? 'unknown'}`)
        } else if (missing) {
          removeRootEntry(record, root) // 目录已不存在——按既有语义从记账剔除
        } else {
          moveRootToHistory(record, root, entry?.excluded ? 'excluded' : 'config-removed', stamp)
        }
        dirty = true
      }
      const survivors = wanted.filter((root) => grantSet.has(root))
      if (survivors.length > 0) this._ensureGrants(workspaceRoot, survivors, { force: true })
    }
    if (toAdd.length > 0) this._ensureGrants(workspaceRoot, toAdd)
    // Persist the reconciled state (additions from `_ensureGrants` above,
    // removals/history moves from this pass, and any v1→v2 migration from
    // load) so the manifest always mirrors the actual OS ACE state —
    // including a pure-revocation pass where no grant ran.
    if (dirty) this._persistGranted(workspaceRoot)
  }

  /**
   * Register the command allow-list gate (`tools/pre-execute` listener) and
   * the escalation auto-approval gate (`approval/request` answerer). Rules are
   * read live from {@link _currentCommands} — this row's Config — so a
   * settings save reaches them through the Loader's reconcile → re-apply path.
   * Registration waits for `ctx.tools`, then belongs to the injected child
   * fiber through `scope.effect`, so a reload disposes the previous listeners
   * instead of stacking a duplicate (a duplicate would fail the activation).
   */
  _registerCommandGate(ctx) {
    try {
      ctx.inject(['tools'], (scope) => {
        // The catch must live INSIDE the callback: a throw here escapes
        // ctx.inject (the outer try/catch never sees it) and would abort the
        // constructor, leaving the plugin pending — degrade to a warning.
        try {
          const getRuleSource = () => this._currentCommands()
          const getContext = () => this._commandContext()
          const shared = {
            getRuleSource,
            getContext,
            callStore: this._callStore,
            audit: this._audit,
            sessionCache: this._sessionCache,
            // Official Auto review sessions delegate the whole command decision
            // to the official per-call LLM reviewer (preset.mjs probe; absent
            // service or probe failure = not Auto = exact current behavior).
            isAutoSession: (session) => isAutoSession(ctx, session),
          }
          // An array of disposers (an iterable effect) keeps the arrow's lexical
          // `this`: a generator body would run with cordis's fiber as `this`.
          scope.effect(() => [
            applyCommandGate(scope, shared),
            applyApprovalGate(scope, { ...shared, proposals: this._proposals }),
          ], 'sandbox:allowlist-gates')
        } catch (error) {
          this._warn(`command gate registration skipped: ${String(error)}`)
        }
      })
    } catch (error) {
      this._warn(`command gate registration skipped: ${String(error)}`)
    }
  }

  /**
   * Resolution context handed to the decision engine: which roots count as
   * "inside" for path arguments, the compiled noRead rules (so a command that
   * references a protected path is never auto-escalated — the wider mode also
   * lifts the read fence), and the package-script expander.
   * @returns the context object (see command-decision.mjs).
   */
  _commandContext() {
    return {
      roots: [this._workspaceRoot, ...this._effectiveRoots()],
      cwd: this._workspaceRoot,
      noRead: (path) => this._noReadHit(path),
      expandScript: this._scriptExpander,
    }
  }

  /**
   * Winning noRead restriction for one path, or `null`. Mirrors the read
   * gate's enablement: under `danger-full-access` the rules are dropped from
   * the resolved policy, so they must not influence the escalation decision
   * either.
   * @param path - a path-like token from a command.
   * @returns `{ pattern, action }` or `null`.
   */
  _noReadHit(path) {
    if (this.defaultMode === 'danger-full-access') return null
    const compiled = this._noReadCompiled()
    if (compiled.length === 0) return null
    return resolveNoRead(compiled, path)
  }

  /**
   * Model-facing context listing the rules the user keeps approving by hand,
   * so the agent can offer to add them instead of re-triggering the same
   * prompt. Rendered only when at least one proposal exists. Registered as an
   * effect (see {@link _registerTrustedRootsContext}).
   */
  _registerProposalContext(ctx) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        // inner catch: a throw here escapes ctx.inject and would leave the plugin pending
        try {
          scope.effect(() => scope.systemPrompt.context({
            name: 'sandbox:allowlistProposals',
            order: contextOrderFor(scope.systemPrompt, 3),
            text: () => {
              const proposals = this._proposals.proposals()
              if (proposals.length === 0) return ''
              return `sandbox-allowlist rule proposals (commands the user keeps approving by hand; suggest adding these in 设置 → 沙箱授权 → 命令规则, do not assume they are allowed): ${proposals.map((proposal) => describeProposal(proposal)).join('; ')}.`
            },
          }), 'sandbox:allowlist-proposals-context')
        } catch (error) {
          this._warn(`proposal context registration skipped: ${String(error)}`)
        }
      })
    } catch (error) {
      this._warn(`proposal context registration skipped: ${String(error)}`)
    }
  }

  /**
   * Register the read-restriction gate (`tools/pre-execute` deny/ask for the
   * read / read_image / edit tools). Rules are read live from
   * {@link _currentNoRead}; the gate is inert while the deployment default
   * mode is `danger-full-access` (the "trust everything" escape hatch).
   */
  _registerReadGate(ctx) {
    try {
      ctx.inject(['tools'], (scope) => {
        // inner catch: a throw here escapes ctx.inject and would leave the plugin pending
        try {
          scope.effect(
            () => applyReadGate(scope, {
              getRules: () => this._currentNoRead(),
              isEnabled: () => this.defaultMode !== 'danger-full-access',
            }),
            'sandbox:allowlist-read-gate',
          )
        } catch (error) {
          this._warn(`read gate registration skipped: ${String(error)}`)
        }
      })
    } catch (error) {
      this._warn(`read gate registration skipped: ${String(error)}`)
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

  /**
   * Roots that are BOTH covered by the current Config patterns AND not excluded
   * by the runtime revocation list — the single computation point every
   * enforcement consumer must use. Exclusion outranks pattern coverage: a
   * revoked root keeps its config pattern (the settings page and the panel's
   * `_patternRoots` audit mirror still show it — restore depends on that) but
   * stops being writable through the resolved policy, mirroring how
   * `_ensureGrants` already skips excluded roots on the ACL side. Without this
   * filter a panel revoke would gate sandboxed child processes (ACL) while the
   * built-in write/edit tools rode `extraRoots` past the fence.
   *
   * Read-only on the manifest (no `workspaceRecord` insert): this runs on every
   * resolve() and prompt rebuild, and a `_manifestFor` call here would create
   * empty records for arbitrary session workspaces — throwaway keys that would
   * leak into the panel's workspace dropdown.
   * @param workspaceRoot - the workspace key whose exclusion registry applies
   *   (the session-resolved root on the resolve path; the instance root for
   *   the command gate and the model-facing context).
   * @returns canonical config-covered roots minus the excluded ones.
   */
  _effectiveRoots(workspaceRoot = this._workspaceRoot) {
    const roots = this.expandRoots()
    if (this._manifest === null) this._manifest = loadManifest(this._manifestFile)
    const record = this._manifest.workspaces[workspaceRoot]
    if (!record || typeof record !== 'object') return roots
    return roots.filter((root) => !isExcludedPath(record, root))
  }

  resolve(request = {}) {
    const policy = super.resolve(request)
    if (policy.mode === 'workspace-write' && this._currentPatterns().length > 0) {
      // Exclusion-filtered: a panel-revoked root must not ride the fence
      // (parity with the ACL side, which `_ensureGrants` already enforces).
      const roots = this._effectiveRoots(policy.workspaceRoot)
      if (roots.length > 0) {
        policy.extraRoots = roots
        if (acl !== null) this._ensureGrants(policy.workspaceRoot, roots)
      }
    }
    // noRead rules ride the resolved policy so every enforcing consumer (the
    // fs fence in fs.mjs, the pre-execute gate) reads the SAME current list.
    // danger-full-access is the explicit "trust everything" escape hatch and
    // opts the call out of the read restriction, mirroring the mutation fence.
    if (policy.mode !== 'danger-full-access') {
      const rules = this._noReadCompiled()
      if (rules.length > 0) policy.noReadRules = rules
    }
    // The Config is the only rule source, so the first resolve() already
    // carries the effective rules: run the startup reconcile once against
    // them. It repairs state left by a crash between a config change and the
    // previous reconcile, and it is also the path that materializes/recovers
    // ACEs after the Loader re-applied this plugin with a merged config.
    if (acl !== null && !this._startupReconciled) {
      this._startupReconciled = true
      // One-shot and fire-and-forget: the reclaim path spawns PowerShell
      // (seconds on large subtrees) and must not stall resolve(). The
      // instance reconciles exactly once, so no second run can race this one.
      this._reconcile(policy.workspaceRoot).catch((error) => {
        this._warn(`startup reconcile failed: ${String(error?.message ?? error)}`)
      })
    }
    return policy
  }

  /**
   * Suppress the host's auto-generated page for this entry: the package ships
   * its own client section (lib/client.js), so an automatic page would render
   * the same three fields twice. `auto` defaults to true, so a deployment
   * without a client half keeps the generated page.
   */
  _registerSettingsPresentation(ctx) {
    try {
      ctx.inject(['settings'], (scope) => {
        // inner catch: a throw here escapes ctx.inject and would leave the plugin pending
        try {
          scope.effect(
            () => scope.settings.configure({ auto: false }),
            'sandbox:allowlist-settings-presentation',
          )
        } catch (error) {
          this._warn(`settings presentation skipped: ${String(error)}`)
        }
      })
    } catch (error) {
      this._warn(`settings presentation skipped: ${String(error)}`)
    }
  }

  /**
   * Register the session-facing state routes (read view + revoke/restore rpc,
   * see state-routes.mjs). Thin wiring only: the module owns the degradation
   * contract (connection-free compositions degrade to no-op) and every
   * registration is an effect, so a reload disposes the previous round.
   */
  _registerStateRoutes(ctx) {
    try {
      applyStateRoutes(ctx, this)
    } catch (error) {
      this._warn(`state routes registration skipped: ${String(error)}`)
    }
  }

  /**
   * Materialize the workspace write SID's ACE on every allowed root (win32).
   * @param workspaceRoot - the canonical workspace root.
   * @param roots - the directories to grant.
   * @param options - `{ force?: boolean }` — re-apply even when the runtime
   *   set already lists the root. A DACL rewrite is what makes Windows
   *   re-propagate the inheritable ACE to the existing subtree (used by the
   *   reconcile after a revoke restored stale inherited copies).
   */
  _ensureGrants(workspaceRoot, roots, { force = false } = {}) {
    const record = this._manifestFor(workspaceRoot)
    let grant = this._grants.get(workspaceRoot)
    if (grant === undefined) {
      const sid = acl.workspaceWriteSid(canonicalPath(workspaceRoot))
      grant = acl.AclWriteGrant.create(sid)
      this._grants.set(workspaceRoot, grant)
    }
    const granted = this._granted.get(workspaceRoot)
    let persisted = false
    for (const root of roots) {
      // 排除优先于覆盖关系：无论几条 pattern 覆盖都不授权、不建条目（含撤销
      // 成功后仅在 history 留排除记录的路径——否则会重新物化、排除失效）。
      if (isExcludedPath(record, root)) continue
      const entry = ensureRootEntry(record, root)
      if (entry.excluded) continue
      if (!force && granted.has(root)) continue // exact-ACE skip without the syscall
      try {
        grant.add(root, true) // standing → persist with the cross-session reuse cache
        granted.add(root)
        entry.status = 'granted'
        entry.grantedAt = new Date().toISOString()
        entry.error = null
        entry.errorAt = null
        entry.attempts = 0
        persisted = true
      } catch (error) {
        const message = String(error?.message ?? error)
        // The dominant failure (Win32 5, ERROR_ACCESS_DENIED) means the current
        // token cannot rewrite the directory's DACL — typically a directory
        // whose DACL only carries inherited Authenticated-Users Modify ACEs
        // (no explicit Full control for the user, no owner-rights path). The
        // ACE and the manifest entry never materialize, so SAY SO with the
        // exact repair instead of a bare error the user cannot act on.
        // 告警只在状态/原因变化时打一次：failed 根不在 skip-set 内、每次 resolve
        // 都会重试，逐次告警只会刷屏（告警去重）。首次失败（或原因变化）也落盘。
        const firstOrChanged = entry.status !== 'failed' || entry.error !== message
        entry.status = 'failed'
        entry.error = message
        entry.errorAt = new Date().toISOString()
        entry.attempts += 1
        if (firstOrChanged) {
          persisted = true
          this._warn(
            `cannot grant write on "${root}": ${message} — `
            + `the directory's DACL is not writable by the current token, so the workspace write SID was NOT materialized `
            + `and this entry stays inert. Fix once (elevated terminal, inherits to the whole subtree): `
            + `icacls "${root}" /grant "%USERNAME%:(OI)(CI)F" /T — then re-save the settings or restart.`,
          )
        }
      }
    }
    // A runtime grant must be reflected in the durable manifest immediately,
    // not only on the one-shot startup reconcile — otherwise grants.json lags
    // the actual OS ACE state until the next restart/reload, and a revoke
    // of a never-recorded root cannot be reclaimed on the next reconcile.
    if (persisted) this._persistGranted(workspaceRoot)
  }

  /**
   * Persist the workspace record to the durable manifest (the atomic save
   * under the same guard as the reconcile's). The runtime state is the single
   * source of truth for what actually happened, so writing it out after every
   * change keeps grants.json in lockstep with the OS state instead of
   * deferring to the next instance restart. Best-effort: a failed sidecar
   * write must never block the sandbox (warn only; the next reconcile
   * rewrites it).
   * @param workspaceRoot - the canonical workspace root whose record to save.
   */
  _persistGranted(workspaceRoot) {
    if (this._manifest === null) this._manifest = loadManifest(this._manifestFile)
    const record = workspaceRecord(this._manifest, workspaceRoot)
    if (record.roots.length === 0 && record.pendingRevoke.length === 0 && record.history.length === 0) {
      delete this._manifest.workspaces[workspaceRoot]
    } else {
      if (acl !== null) record.sid = acl.workspaceWriteSid(canonicalPath(workspaceRoot))
      record.updatedAt = new Date().toISOString()
    }
    try {
      saveManifest(this._manifestFile, this._manifest)
    } catch (error) {
      this._warn(`cannot persist grants manifest (${this._manifestFile}): ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Per-pattern live expansion (the `fromPatterns` audit mirror's source). A
   * malformed or too-broad pattern contributes nothing — expandRoots already
   * reports it on the resolve path.
   */
  _patternRoots() {
    const list = []
    for (const pattern of this._currentPatterns()) {
      try {
        list.push({ pattern, roots: expandTrustedRoots(pattern) })
      } catch {
        // no coverage contribution from a pattern that cannot expand
      }
    }
    return list
  }

  /**
   * Exclude / re-include one root — the runtime revocation list. Deliberately
   * NOT a Config field: exclusion is derived runtime state that lives only in
   * the manifest sidecar (the settings page stays the only config surface).
   * `true` triggers the reconcile that strips the ACE (success → history,
   * failure → pendingRevoke, retry next reconcile); `false` lifts the
   * exclusion so the next covered reconcile re-materializes the root (fresh
   * grantedAt).
   * @returns `{ ok: true, done }` with the reconcile tail promise, or
   *   `{ ok: false, error }` when no manifest record matches.
   */
  setRootExcluded(workspaceRoot, rootPath, excluded) {
    const record = this._manifestFor(workspaceRoot)
    const kick = () => this._reconcile(workspaceRoot).catch((error) => {
      this._warn(`exclusion reconcile failed: ${String(error?.message ?? error)}`)
    })
    const entry = rootEntryAt(record, rootPath)
    if (entry !== undefined) {
      entry.excluded = excluded === true
      return { ok: true, done: kick() }
    }
    if (excluded !== true) {
      // The record left `roots` when the revocation completed or failed:
      // restore acts on the pendingRevoke / history copies instead.
      const key = comparablePath(rootPath)
      const pending = record.pendingRevoke.find((item) => comparablePath(item.path) === key)
      if (pending !== undefined && pending.origin === 'excluded') {
        pending.origin = 'config-removed' // exclusion lifted; the strip continues only while uncovered
        return { ok: true, done: kick() }
      }
      const historyIndex = record.history.findLastIndex((item) => item.origin === 'excluded' && comparablePath(item.path) === key)
      if (historyIndex >= 0) {
        const covered = this.expandRoots().some((root) => comparablePath(root) === key)
        if (!covered) return { ok: false, error: `no current pattern covers "${rootPath}" — nothing to re-materialize` }
        record.history.splice(historyIndex, 1) // restore consumes the exclusion record
        return { ok: true, done: kick() }
      }
    }
    return { ok: false, error: `no manifest record for "${rootPath}"` }
  }

  /**
   * The view data contract slice for one workspace ({ sid, roots[],
   * pendingRevoke[], history[] }) as a deep copy of the LIVE record — the
   * panel reads current accounting, not the last file flush. Routing and
   * live-expansion merging live in the state-routes consumer, not here.
   */
  manifestSlice(workspaceRoot) {
    const record = this._manifestFor(workspaceRoot)
    return JSON.parse(JSON.stringify({
      sid: record.sid,
      roots: record.roots,
      pendingRevoke: record.pendingRevoke,
      history: record.history,
    }))
  }

  /**
   * 全量视图形态：所有工作区的切片 + 本实例的工作区根。运行期记账按工作区
   * 分键（各工作区 SID 独立、撤销史互不相干），面板据此提供工作区切换，
   * 不再固定展示本实例配置的那个工作区。
   */
  manifestSliceAll() {
    if (this._manifest === null) this._manifest = loadManifest(this._manifestFile)
    const workspaces = {}
    for (const [root, record] of Object.entries(this._manifest.workspaces)) {
      workspaces[root] = JSON.parse(JSON.stringify({
        sid: record.sid,
        updatedAt: record.updatedAt,
        roots: record.roots,
        pendingRevoke: record.pendingRevoke,
        history: record.history,
      }))
    }
    if (!workspaces[this._workspaceRoot]) {
      workspaces[this._workspaceRoot] = { sid: null, updatedAt: null, roots: [], pendingRevoke: [], history: [] }
    }
    return { current: this._workspaceRoot, workspaces }
  }

  /**
   * Manual re-grant of one root (the panel's 重试授权 action for failed
   * rows): the automatic grant failed (typically ERROR_ACCESS_DENIED on the
   * directory's DACL), the user repaired the ACL out of band, and this
   * retries the materialization immediately instead of waiting for the next
   * resolve. Guarded: the path must be covered by the current patterns
   * (granting outside the config would be revoked by the next reconcile).
   * @returns `{ ok: true, status, error }` — status/error read back from the
   *   record after the attempt ('granted' or 'failed' + the failure reason).
   */
  retryGrant(workspaceRoot, rootPath) {
    if (acl === null) return { ok: false, error: 'ACE materialization applies to Windows only' }
    const covered = this.expandRoots().some((root) => comparablePath(root) === comparablePath(rootPath))
    if (!covered) return { ok: false, error: `no current pattern covers "${rootPath}"` }
    const record = this._manifestFor(workspaceRoot)
    if (isExcludedPath(record, rootPath)) return { ok: false, error: `"${rootPath}" is excluded — restore it first` }
    ensureRootEntry(record, rootPath)
    this._ensureGrants(workspaceRoot, [rootPath], { force: true })
    const entry = rootEntryAt(record, rootPath)
    return { ok: true, status: entry?.status ?? null, error: entry?.error ?? null }
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

  /** Extra model-facing context so the agent knows allowed roots are writable.
   * `context()` hands back the disposer that removes the section, so it is
   * registered as an effect: a reload must not leave the old section behind
   * (a duplicate name would fail the next activation). */
  _registerTrustedRootsContext(ctx) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        // inner catch: a throw here escapes ctx.inject and would leave the plugin pending
        try {
          scope.effect(() => scope.systemPrompt.context({
            name: 'sandbox:allowlist',
            order: contextOrderFor(scope.systemPrompt, 1),
            text: (context) => {
              const session = context.agent?.session
              if (session === undefined) return ''
              const roots = this._effectiveRoots()
              if (roots.length === 0) return ''
              return `Sandbox-authorized writable roots (allowed under workspace-write, outside the session workspace): ${JSON.stringify(roots)}.`
                + ' Commands that write only inside these roots (or inside the workspace) need no approval; a command that would write anywhere else is denied by the sandbox, and the retry with sandbox_permissions needs the user\'s approval.'
            },
          }), 'sandbox:allowlist-roots-context')
        } catch (error) {
          this._warn(`trusted-roots context registration skipped: ${String(error)}`)
        }
      })
    } catch (error) {
      this._warn(`system-prompt context registration skipped: ${String(error)}`)
    }
  }

  /** Extra model-facing context telling the agent which reads are restricted,
   * so it does not thrash on denied files and knows ask-rule reads need the
   * user's approval. Registered as an effect (see
   * {@link _registerTrustedRootsContext}). */
  _registerNoReadContext(ctx) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        // inner catch: a throw here escapes ctx.inject and would leave the plugin pending
        try {
          scope.effect(() => scope.systemPrompt.context({
            name: 'sandbox:noRead',
            order: contextOrderFor(scope.systemPrompt, 2),
            text: (context) => {
              const session = context.agent?.session
              if (session === undefined) return ''
              const rules = this._noReadCompiled()
              if (rules.length === 0) return ''
              const deny = rules.filter((rule) => rule.action === 'deny').map((rule) => rule.pattern)
              const ask = rules.filter((rule) => rule.action === 'ask').map((rule) => rule.pattern)
              const parts = []
              if (deny.length > 0) {
                parts.push(`file reads are DENIED for names matching ${JSON.stringify(deny)} — do not attempt them; tell the user instead`)
              }
              if (ask.length > 0) {
                parts.push(`file reads for names matching ${JSON.stringify(ask)} require the user's approval (ask — reading them without approval will be refused)`)
              }
              return `sandbox-allowlist read restrictions: ${parts.join('; ')}.`
            },
          }), 'sandbox:allowlist-noread-context')
        } catch (error) {
          this._warn(`noRead context registration skipped: ${String(error)}`)
        }
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
