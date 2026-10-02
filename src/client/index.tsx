/**
 * 设置页「沙箱授权」分节 —— 客户端插件 TS 源码（v5，对齐
 * docs/internal/config-ui-prototype.html v5）。
 *
 * 这是 lib/client.js（运行时实际加载的手写 __ModuleLoader__ bundle）的
 * 等价 TS 源码参考：在 dsh 开发工具链（tsc + tsdown）下重建时使用本文件，
 * 产物覆盖 lib/client.js。两处必须保持一致。
 *
 * 重构要点（与原型一致）：
 *   - 分节 = 标题 + 导语 + 三个可折叠配置卡片（授权目录 / 命令规则 / 禁读规则）；
 *   - 卡片**默认全部收起**，点击标题展开；收起态主体真正隐藏，头部计数与
 *     「未保存修改」徽章保留；
 *   - 授权目录：结构化目录行，新增行 = 绿色「＋」圆形徽章；焦点只高亮输入框
 *     （行边框不高亮）；非法条目标红输入框；
 *   - 命令规则：默认动作分段选择（选中项 = 语义色浅底 + 语义色文字 + 粗体 +
 *     内描边）；规则行 = 自绘工具下拉 + 命令模式输入 + 紧凑 allow/ask/deny
 *     分段 + 小 ✕ 图标按钮；三个开关收敛为一个可见勾选框（允许沙箱升级自动
 *     放行）+ 默认收起的「高级」区（内置能力基线 / 会话级命令缓存）；
 *   - 禁读规则：与命令规则同款规则表，但动作只提供 deny/ask 两档（官方默认
 *     本就允许读，不提供 allow），pattern 输入 + 紧凑 deny/ask 分段 + 小 ✕；
 *   - 工具下拉为自绘组件（原生 <select> 展开态无法定制样式）；选项仅
 *     bash / pwsh / 任意（dsh 只有这两个 shell 工具，其它值会被服务端校验拒绝）；
 *   - 样式由 lib/client.js 注入作用域化 <style>（.sabx-* 前缀），全部使用
 *     dsw 运行时令牌（--dsw-alias-* / --dsw-specific-*，带十六进制 fallback）。
 *   - i18n：全部用户可见文案走宿主词典服务（`locale` 是宿主自带的
 *     dsh-client-locale），词典在 ./locales（zh 真源 + en 镜像，回退链末端
 *     en）。词典化改造来自 Bernd Weymann（GitHub: @weymann）在其 fork
 *     https://github.com/weymann/dsh-sandbox-allowlist 提交 b814e0f
 *     （"dsh 0.1.7-rc.2 update"）中的贡献，本仓库采纳并扩展了 0.2.0 特有键。
 *
 * 数据流（dsh 0.2.0）：`ctx.configForms.get(<loader entry id>)` 取本插件条目的
 * 配置表单 → 表单编辑 → `form.set('allowedDirs' | 'commands' | 'noRead', …)`
 * 原子写回宿主 profile → 宿主 reconcile → 插件重载并带上合并后的 Config →
 * 服务端策略即时生效。整组字段用 `unset(field)` 恢复组合默认值（「重置为默认」），
 * 覆盖标记按快照 `user` 的键存在性判断，不比较值。
 *
 * 降级契约（官方 `ConfigFormSnapshot`）：`status` 为 `loading` 时只读占位，
 * `unavailable`（宿主未提供该 namespace）或 `writable === false`（memory 模式，
 * 远端连接偏好进程本地）时整节只读并说明原因——绝不假装保存成功。
 *
 * 注意：组件定义在 apply 闭包内、直接订阅表单 controller —— 不依赖 slots
 * 系统向组件注入 props 的转换契约，任何情况下都不会因 props 缺失而崩溃。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { en, NS, zh } from './locales'

// 客户端依赖注入声明（服务名，与 lib/client.js 的 exports.inject 一致）。
// `locale` 是宿主自带的词典服务：注册 zh/en 后由宿主按当前语言解析键。
// 不声明 `connection`：本分节不消费连接服务，多声明会无谓收紧宿主兼容面。
export const inject = ['slots', 'configForms', 'locale']

/**
 * 本插件在 profile 中的 Loader 条目 id（cordis.patch.yml 的
 * `sandbox-allowlist-policy` 行）。dsh 0.2.0 按条目 id 索引设置表单，
 * 表单 schema 由该行的 `static Config` 投影而来。
 */
export const SETTINGS_ENTRY_ID = 'sandbox-allowlist-policy'

/** 插件面板（Plugins 页）注册键：bundle.config 按包名，row.config 按「包名#行id」。 */
const BUNDLE_CONFIG_KEY = 'dsh-sandbox-allowlist'
const ROW_CONFIG_KEY = 'dsh-sandbox-allowlist#sandbox-allowlist-policy'
const PROVIDER_ROW_ID = 'sandbox-allowlist-provider'
const PROVIDER_ROW_CONFIG_KEY = 'dsh-sandbox-allowlist#sandbox-allowlist-provider'

/** 翻译函数签名（`ctx.locale.bind(NS)` 的返回值）。 */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** 用户可见文案一律走词典键：这里只保存键名，渲染时用 t(key) 取值。 */
const CALL_WARN_DIRS_KEY = 'dirs.warn'
const DIRS_HINT_KEY = 'dirs.hint'
const DIRS_VALIDATE_HINT_KEY = 'dirs.validateHint'

const COMMANDS_DEFAULT_HINT_KEY = 'cmd.defaultHint'
const COMMANDS_HINT_KEY = 'cmds.hint'
const COMMANDS_TAIL_HINT_KEY = 'cmds.tailHint'
const COMMANDS_ESCALATION_HINT_KEY = 'cmds.escalationHint'

const NOREAD_HINT_KEY = 'noread.hint'
const NOREAD_TAIL_HINT_KEY = 'noread.tailHint'

/** 工具选项（空 = 任意工具；方案 A：标签与值一致）。 */
const TOOL_OPTIONS: { value: string; label?: string; labelKey?: string }[] = [
  { value: '', labelKey: 'common.any' },
  { value: 'bash', label: 'bash' },
  { value: 'pwsh', label: 'pwsh' },
]

/** 规则动作（分段选择器，带语义色圆点类）。 */
const ACTION_OPTIONS = [
  { value: 'allow', dot: 'sabx-dot-allow', label: 'allow', cls: 'is-allow', hintKey: 'common.allowHint' },
  { value: 'ask', dot: 'sabx-dot-ask', label: 'ask', cls: 'is-ask', hintKey: 'common.askHint' },
  { value: 'deny', dot: 'sabx-dot-deny', label: 'deny', cls: 'is-deny', hintKey: 'common.denyHint' },
]

/** 「高级」折叠区里的布尔开关（勾选框定义）。 */
const BASELINE_OPTIONS = [
  { key: 'baseline', labelKey: 'cmds.baselineLabel', hintKey: 'cmds.baselineHint' },
  { key: 'sessionCache', labelKey: 'cmds.sessionLabel', hintKey: 'cmds.sessionHint' },
]

/** 禁读规则动作：只提供 deny / ask（allow 与默认行为无异，刻意不提供）。 */
const NOREAD_ACTIONS = [
  { value: 'deny', dot: 'sabx-dot-deny' },
  { value: 'ask', dot: 'sabx-dot-ask' },
]

/** 动作分段选项（标签与 title 提示在渲染时按当前语言解析）。 */
function actionOptions(t: Translate, includeDelegate?: boolean) {
  const options = ACTION_OPTIONS.map((option) => ({ ...option, hint: t(option.hintKey) }))
  return includeDelegate ? [{ value: 'delegate', dot: null }, ...options] : options
}

/** 工具下拉选项（空值 = 任意）。 */
function toolOptions(t: Translate) {
  return TOOL_OPTIONS.map((option) => ({
    ...option,
    label: option.labelKey !== undefined ? t(option.labelKey) : option.label ?? option.value,
  }))
}

/** 「高级」折叠区的两个布尔开关（标签与说明均为词典键）。 */
function baselineOptions(t: Translate) {
  return BASELINE_OPTIONS.map((option) => ({ key: option.key, label: t(option.labelKey), hint: t(option.hintKey) }))
}

/** 表单快照的客户端视图（结构对齐官方 `ConfigFormSnapshot`）。 */
export type FormSnapshotView = {
  status: 'loading' | 'ready' | 'unavailable'
  // 官方快照的 value/user 由服务端 schema 投影而来，形状随配置字段演进，
  // 客户端不重建静态类型（重建即多一处漂移点）；所有消费点都做运行时收窄。
  value: any
  user: any
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/**
 * 配置表单 controller 的最小结构（官方 ConfigForm controller 的子集，
 * 全部可选：任何缺失都按「表单不可用」降级，绝不抛错）。快照字段保持
 * unknown：形状由服务端 schema 决定，消费点逐一收窄。
 */
export type FormController = {
  getSnapshot?: () => Record<string, unknown> | null | undefined
  subscribe?: (listener: () => void) => (() => void) | undefined
  set?: (field: string, value: unknown) => Promise<boolean>
  unset?: (field: string) => Promise<boolean>
}

/**
 * 客户端插件入口收到的宿主上下文的最小结构（apply 只用这些成员；
 * 用结构类型替代 `any`，调用点的存在性仍逐一防御）。
 */
export type ClientContext = {
  effect: (factory: () => unknown, name?: string) => unknown
  slots: {
    inject: (name: string, register: () => unknown) => unknown
    register: (definition: Record<string, unknown>, component: unknown) => unknown
  }
  configForms: { get: (entryId: string) => FormController | null }
  locale: {
    register: (ns: string, dictionaries: Record<string, Record<string, string>>) => unknown
    bind: (ns: string) => Translate
  }
}

/**
 * 表单不可用时的降级快照（服务缺失 / 条目未挂载）：只读、无值。
 */
export const UNAVAILABLE_SNAPSHOT: FormSnapshotView = {
  status: 'unavailable',
  value: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

/**
 * 读取一次配置表单快照，并把任何异常/缺失收敛为 {@link UNAVAILABLE_SNAPSHOT}：
 * 设置页永远不能因表单服务不可用而崩溃。
 * @param form - `ctx.configForms.get(entryId)` 返回的 controller（可为 null）。
 */
export function formSnapshot(form: FormController | null): FormSnapshotView {
  try {
    if (!form || typeof form.getSnapshot !== 'function') return UNAVAILABLE_SNAPSHOT
    const snapshot = form.getSnapshot()
    if (!snapshot || typeof snapshot !== 'object') return UNAVAILABLE_SNAPSHOT
    const rawStatus = snapshot.status
    const status = rawStatus === 'ready' || rawStatus === 'loading' ? rawStatus : 'unavailable'
    return {
      status,
      value: snapshot.value,
      user: snapshot.user,
      revision: typeof snapshot.revision === 'number' ? snapshot.revision : undefined,
      writable: snapshot.writable === true,
      mode: snapshot.mode === 'host' ? 'host' : 'memory',
    }
  } catch {
    return UNAVAILABLE_SNAPSHOT
  }
}

/** 订阅快照替换；表单不可用时返回空 disposer（不抛、不崩）。 */
export function subscribeForm(form: FormController | null, listener: () => void): () => void {
  try {
    if (form && typeof form.subscribe === 'function') {
      const dispose = form.subscribe(listener)
      if (typeof dispose === 'function') return dispose
    }
  } catch {
    // 订阅失败按不可用处理
  }
  return () => {}
}

/**
 * 表单当前是否可写。官方契约：memory 模式（远端连接的偏好进程本地）永不
 * 接受写入，`status !== 'ready'` 时也没有可用的原生通路。
 */
export function isWritable(form: FormController | null): boolean {
  const snapshot = formSnapshot(form)
  return snapshot.status === 'ready' && snapshot.writable === true
}

/**
 * 只读原因（词典键翻译后的文案，供页面说明），可写时为 null。
 */
export function readOnlyReason(form: FormController | null, t: Translate): string | null {
  const snapshot = formSnapshot(form)
  if (snapshot.status === 'loading') return t('readonly.loading')
  if (snapshot.status === 'unavailable') {
    return t('readonly.unavailable')
  }
  if (snapshot.writable !== true) {
    return t('readonly.memory')
  }
  return null
}

/**
 * 该字段是否被用户层覆盖。官方语义：快照 `user` 里**键在场**即覆盖——即使值
 * 恰好等于组合默认值也仍是覆盖，比较值看不出来。
 */
export function fieldOverridden(form: FormController | null, field: string): boolean {
  const user = formSnapshot(form).user
  return user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
}

/**
 * 原子写回一个字段。`set` 返回 `false` 表示被拒（revision 冲突 / 不可写），
 * 必须当作失败处理；传输层异常则直接抛出。
 */
export async function saveField(form: FormController | null, field: string, value: any, t: Translate): Promise<void> {
  if (!isWritable(form)) throw new Error(readOnlyReason(form, t) ?? t('error.notWritable'))
  const accepted = await form?.set?.(field, value)
  if (accepted !== true) {
    throw new Error(t('error.saveRejected'))
  }
}

/** 清除用户层覆盖，让字段回退到组合默认值（「重置为默认」）。 */
export async function resetField(form: FormController | null, field: string, t: Translate): Promise<void> {
  if (!isWritable(form)) throw new Error(readOnlyReason(form, t) ?? t('error.notWritable'))
  const accepted = await form?.unset?.(field)
  if (accepted !== true) {
    throw new Error(t('error.resetRejected'))
  }
}

/** 从表单快照读取当前授权目录列表。 */
export function currentDirs(form: FormController | null): string[] {
  const value = formSnapshot(form).value
  return Array.isArray(value && value.allowedDirs) ? value.allowedDirs : []
}

/** 从表单快照读取当前命令规则与开关。 */
export function currentCommands(form: FormController | null): {
  default: string
  rules: SavedCommandRule[]
  escalation: string
  baseline: boolean
  sessionCache: boolean
} {
  const fallback = { default: 'delegate', rules: [] as SavedCommandRule[], escalation: 'capability', baseline: true, sessionCache: true }
  const value = formSnapshot(form).value
  const commands = value && value.commands
  if (!commands) return fallback
  const rules = Array.isArray(commands.rules)
    ? commands.rules.map((rule: any) => ({
        tool: rule && rule.tool ? rule.tool : '',
        pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
        action: rule && rule.action ? rule.action : 'ask',
      }))
    : []
  return {
    default: commands.default !== undefined ? commands.default : 'delegate',
    rules,
    escalation: commands.escalation !== undefined ? commands.escalation : 'capability',
    baseline: commands.baseline !== false,
    sessionCache: commands.sessionCache !== false,
  }
}

/** 从表单快照读取当前禁读规则（[{ pattern, action }]，动作归一为 deny/ask）。 */
export function currentNoRead(form: FormController | null): SavedNoReadRule[] {
  const value = formSnapshot(form).value
  const rules = Array.isArray(value && value.noRead) ? value.noRead : []
  return rules.map((rule: any) => ({
    pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
    action: rule && rule.action === 'ask' ? 'ask' : 'deny',
  }))
}

/**
 * 返回非法原因（词典键 + 参数），null 表示通过（浏览器侧轻量镜像
 * lib/patterns.mjs 的拒绝规则）。
 */
export function validateDirPattern(raw: string): { key: string; params?: Record<string, string | number> } | null {
  if (typeof raw !== 'string') return { key: 'validate.notString' }
  const value = raw.trim()
  if (value.length === 0) return { key: 'validate.empty' }
  const isAbsolute = /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]/u.test(value)
  if (!isAbsolute) return { key: 'validate.notAbsolute', params: { value } }
  if (value.includes('**')) {
    let staticLevels = 0
    const segments = value.split(/[\\/]/u).filter((s) => s.length > 0)
    for (const segment of segments) {
      if (/[*?]/u.test(segment)) break
      staticLevels += 1
    }
    if (staticLevels <= 1) return { key: 'validate.tooWide', params: { value } }
  }
  return null
}

/** 已保存的一条命令规则（快照形状，无客户端行标识）。 */
export type SavedCommandRule = { tool: string; pattern: string; action: string }

/** 已保存的一条禁读规则（快照形状）。 */
export type SavedNoReadRule = { pattern: string; action: string }

/** 规则表一行的草稿：`id` 是客户端生成的行标识（React key 用），绝不写回快照。 */
export type CommandRuleRow = SavedCommandRule & { id: number }

/** 禁读规则表一行的草稿。 */
export type NoReadRuleRow = SavedNoReadRule & { id: number }

/** 未保存改动计数：与已保存值逐条位置比较。 */
function dirsDirtyCount(rows: { value: string }[], saved: string[]): number {
  let count = 0
  for (let i = 0; i < rows.length; i += 1) {
    const compared = i < saved.length ? String(saved[i] || '') : ''
    if (String(rows[i].value || '').trim() !== compared.trim()) count += 1
  }
  return count
}

/** 命令规则草稿与已保存值是否不同。 */
function rulesDirty(rules: CommandRuleRow[], saved: SavedCommandRule[]): boolean {
  if (rules.length !== saved.length) return true
  for (let i = 0; i < rules.length; i += 1) {
    const a = rules[i]
    const b = saved[i]
    if ((a.tool || '') !== (b.tool || '')) return true
    if (String(a.pattern || '').trim() !== String(b.pattern || '').trim()) return true
    if ((a.action || 'ask') !== (b.action || 'ask')) return true
  }
  return false
}

/** 禁读规则草稿与已保存值是否不同（无 tool 维度）。 */
function noReadDirty(rules: NoReadRuleRow[], saved: SavedNoReadRule[]): boolean {
  if (rules.length !== saved.length) return true
  for (let i = 0; i < rules.length; i += 1) {
    const a = rules[i]
    const b = saved[i]
    if (String(a.pattern || '').trim() !== String(b.pattern || '').trim()) return true
    if ((a.action || 'deny') !== (b.action || 'deny')) return true
  }
  return false
}

/**
 * 纯文本提示的 HTML 转义（与 lib/client.js 中 dirs.hint 的内联转义一致）：
 * 词典里刻意携带标记的键（dirs.warn / cmds.hint / noread.hint）直接以 HTML
 * 注入，纯文本键必须先转义，两处产物的渲染行为才不会分叉。
 */
function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** 小 ✕ 图标（删除按钮）。 */
export function XIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  )
}

/** 分段选择器（原始按钮组，data-active 由 CSS 驱动）。 */
export function Seg(props: {
  options: { value: string; dot?: string | null; label?: string; cls?: string; hint?: string }[]
  selected: string
  onSelect: (value: string) => void
  ariaLabel?: string
  compact?: boolean
}) {
  return (
    <div className={['sabx-seg', props.compact ? 'sabx-seg--compact' : ''].join(' ')} role="group">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={['sabx-seg-item', option.cls || (option.value !== 'delegate' ? `is-${option.value}` : '')].join(' ')}
          data-active={option.value === props.selected ? 'true' : 'false'}
          aria-label={props.ariaLabel ? `${props.ariaLabel}: ${option.value}` : undefined}
          title={option.hint}
          onClick={() => props.onSelect(option.value)}
        >
          {option.dot ? <span className={`sabx-dot ${option.dot}`} aria-hidden="true" /> : null}
          {option.label || option.value}
        </button>
      ))}
    </div>
  )
}

/** 工具自绘下拉（原生 select 展开态无法定制，故自绘菜单；展开/选中完全可控）。 */
export function ToolPicker(props: { t: Translate; value: string; disabled?: boolean; onSelect: (value: string) => void }) {
  const t = props.t
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(event: MouseEvent) {
      const target = event.target as Node
      if (
        (triggerRef.current && triggerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return
      }
      setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const value = props.value || ''
  const label = value || t('common.any')
  const optionNodes = toolOptions(t).map((option) => {
    const selected = option.value === value
    return (
      <button
        key={option.value}
        type="button"
        className={['sabx-tool-option', selected ? 'is-selected' : ''].join(' ')}
        role="option"
        aria-selected={selected ? 'true' : 'false'}
        onClick={() => {
          props.onSelect(option.value)
          setOpen(false)
        }}
      >
        {option.label}
        <svg className="sabx-tool-check" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    )
  })

  return (
    <div className={['sabx-tool-picker', open ? 'is-open' : ''].join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        className={['sabx-tool-trigger', value ? '' : 'is-any'].join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="sabx-tool-value">{label}</span>
        <svg className="sabx-tool-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div ref={menuRef} className="sabx-tool-menu" role="listbox">
          {optionNodes}
        </div>
      ) : null}
    </div>
  )
}

function Chevron() {
  return (
    <svg className="sabx-card-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 可折叠卡片外壳（收起态主体由 CSS :not(.is-open) 隐藏）。 */
function Card(props: {
  id: string
  name: string
  count?: string
  desc: string
  pendingCount: number
  open: boolean
  onToggle: () => void
  t: Translate
  children?: ReactNode
}) {
  const classes = ['sabx-card-openable']
  if (props.open) classes.push('is-open')
  if (props.pendingCount > 0) classes.push('has-pending')
  return (
    <article className={classes.join(' ')} id={props.id}>
      <button className="sabx-card-header" type="button" onClick={props.onToggle} aria-expanded={props.open}>
        <span className="sabx-card-head-text">
          <span className="sabx-card-name">
            {props.name}
            {props.count ? <span className="sabx-count">{props.count}</span> : null}
          </span>
          <span className="sabx-card-desc">{props.desc}</span>
        </span>
        <span className="sabx-pending">{props.t('common.unsavedBadge')}</span>
        <Chevron />
      </button>
      {props.children ? <div className="sabx-card-body">{props.children}</div> : null}
    </article>
  )
}

/** 重置按钮的 title 与标签（三张卡片同款；标签用通用的 common.reset 键）。 */
function resetButtonProps(overridden: boolean, t: Translate) {
  return {
    title: overridden ? t('common.resetOverrideTitle') : t('common.resetNotOverrideTitle'),
    label: t('common.reset'),
  }
}

/**
 * 构建「授权目录」卡片（结构化目录行 + callout 警示 + 添加/删除/保存/放弃）。
 * @param form - `ctx.configForms.get(SETTINGS_ENTRY_ID)` 返回的表单 controller。
 * @param t - 词典翻译函数（`ctx.locale.bind(NS)`）。
 */
export function makeDirsCard(form: FormController | null, t: Translate) {
  return function DirsCard() {
    const [rows, setRows] = useState<{ id: number; value: string }[]>([])
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [invalid, setInvalid] = useState<Record<number, boolean>>({})
    // 行标识发生器：key 用稳定 id 而非数组下标，删除行后焦点/临时 UI 状态
    // 不会落到平移后的相邻行上。
    const nextId = useRef(1)
    // 草稿保护：存在未保存编辑时，外部快照更新（如另一客户端保存）不再
    // 静默覆盖本地草稿；「放弃修改」或保存成功后复位，外部变更才重新落地。
    const dirtyRef = useRef(false)

    useEffect(() => {
      const update = () => {
        try {
          if (dirtyRef.current) return // 有未保存草稿，不覆盖
          setRows(currentDirs(form).map((value) => ({ id: nextId.current++, value })))
        } catch {
          // a stale form must never break the section render
        }
      }
      update()
      return subscribeForm(form, update)
    }, [])

    const locked = !isWritable(form)
    const overridden = fieldOverridden(form, 'allowedDirs')
    const saved = currentDirs(form)
    const pendingCount = dirsDirtyCount(rows, saved)
    const resetProps = resetButtonProps(overridden, t)

    const setRow = (index: number, value: string) => {
      setError(null)
      dirtyRef.current = true
      setInvalid((previous) => {
        if (!Object.prototype.hasOwnProperty.call(previous, index)) return previous
        const next: Record<number, boolean> = {}
        for (const key of Object.keys(previous)) {
          if (Number(key) !== index) next[Number(key)] = previous[Number(key)]
        }
        return next
      })
      setRows((previous) => previous.map((row, i) => (i === index ? { ...row, value } : row)))
    }

    const addRow = () => {
      setError(null)
      dirtyRef.current = true
      setRows((previous) => [...previous, { id: nextId.current++, value: '' }])
    }

    const removeRow = (index: number) => {
      setError(null)
      dirtyRef.current = true
      // 删除行后其上方的非法标记索引整体前移一位，标红不跟错行。
      setInvalid((previous) => {
        const next: Record<number, boolean> = {}
        for (const key of Object.keys(previous)) {
          const i = Number(key)
          if (i === index) continue
          next[i > index ? i - 1 : i] = previous[i]
        }
        return next
      })
      setRows((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      setRows(currentDirs(form).map((value) => ({ id: nextId.current++, value })))
      setError(null)
      setInvalid({})
      dirtyRef.current = false
    }

    /** 清除用户层覆盖，回到组合（部署）默认值。 */
    const resetDefault = async () => {
      setError(null)
      try {
        setSaving(true)
        await resetField(form, 'allowedDirs', t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const save = async () => {
      setError(null)
      const values: string[] = []
      const problems: { index: number; message: string }[] = []
      rows.forEach((row, index) => {
        const value = String(row.value || '').trim()
        if (value.length === 0) return // 空行直接丢弃，不视为错误
        const issue = validateDirPattern(value)
        if (issue !== null) problems.push({ index, message: t(issue.key, issue.params) })
        else values.push(value)
      })
      if (problems.length > 0) {
        const flags: Record<number, boolean> = {}
        problems.forEach((p) => { flags[p.index] = true })
        setInvalid(flags)
        setError(t('error.validate', { message: problems[0].message })
          + (problems.length > 1 ? t('error.validateMore', { count: problems.length - 1 }) : ''))
        return
      }
      try {
        setSaving(true)
        await saveField(form, 'allowedDirs', values, t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = t('dirs.count', { count: saved.length })
      + (pendingCount > 0 ? t('dirs.countPending', { count: pendingCount }) : '')

    return (
      <Card
        id="sabx-card-dirs"
        name={t('dirs.name')}
        count={countText}
        desc={t('dirs.desc')}
        pendingCount={pendingCount}
        open={open}
        onToggle={() => setOpen(!open)}
        t={t}
      >
        <div className="sabx-callout-warn" role="note">
          <span className="sabx-dot sabx-dot-warn" />
          <span dangerouslySetInnerHTML={{ __html: t(CALL_WARN_DIRS_KEY) }} />
        </div>
        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">{t('dirs.fieldLabel')}</span>
            <button
              className="sabx-field-reset"
              type="button"
              disabled={saving || locked || !overridden}
              title={resetProps.title}
              onClick={() => void resetDefault()}
            >
              {resetProps.label}
            </button>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: escapeHtml(t(DIRS_HINT_KEY)) }} />
          <div className="sabx-dir-list">
            {rows.length === 0 ? (
              <div className="sabx-empty">{t('dirs.empty')}</div>
            ) : (
              rows.map((row, index) => (
                <div key={row.id} className="sabx-dir-row">
                  {index >= saved.length ? (
                    <span className="sabx-dir-icon is-new" aria-hidden="true">＋</span>
                  ) : (
                    <span className="sabx-dir-icon" aria-hidden="true">📁</span>
                  )}
                  <input
                    className={['sabx-input sabx-mono', invalid[index] ? 'is-invalid' : ''].join(' ')}
                    type="text"
                    spellCheck={false}
                    value={row.value}
                    aria-label={t('dirs.rowAria', { index: index + 1 })}
                    placeholder={t('dirs.placeholder')}
                    disabled={locked}
                    onChange={(event) => setRow(index, event.target.value)}
                  />
                  <button
                    className="sabx-icon-btn"
                    type="button"
                    aria-label={t('dirs.delete')}
                    title={t('dirs.deleteTitle')}
                    disabled={locked}
                    onClick={() => removeRow(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving || locked} onClick={addRow}>
            <span aria-hidden="true">＋</span> {t('dirs.add')}
          </button>
          <p className="sabx-dir-hint-inline">{t(DIRS_VALIDATE_HINT_KEY)}</p>
        </div>
        <div className="sabx-card-footer">
          {error !== null ? (
            <p className="sabx-card-error" role="alert">{error}</p>
          ) : null}
          <button className="sabx-btn sabx-btn-ghost" type="button" disabled={saving || pendingCount === 0} onClick={restoreSaved}>
            {t('common.discard')}
          </button>
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving || locked} onClick={() => void save()}>
            {saving ? t('common.saving') : t('dirs.save')}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「命令规则」卡片（默认动作分段 + 自绘工具下拉规则表 + 添加/删除/保存/放弃）。
 * @param form - `ctx.configForms.get(SETTINGS_ENTRY_ID)` 返回的表单 controller。
 * @param t - 词典翻译函数（`ctx.locale.bind(NS)`）。
 */
export function makeCommandsCard(form: FormController | null, t: Translate) {
  return function CommandsCard() {
    const [rules, setRules] = useState<CommandRuleRow[]>([])
    const [defaultAction, setDefaultAction] = useState('delegate')
    const [escalateAuto, setEscalateAuto] = useState(true)
    const [baseline, setBaseline] = useState(true)
    const [sessionCache, setSessionCache] = useState(true)
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // 行标识发生器与草稿保护标记（语义同授权目录卡片）。
    const nextId = useRef(1)
    const dirtyRef = useRef(false)

    useEffect(() => {
      const update = () => {
        try {
          if (dirtyRef.current) return // 有未保存草稿，不覆盖
          const cmds = currentCommands(form)
          setRules(cmds.rules.map((rule) => ({ ...rule, id: nextId.current++ })))
          setDefaultAction(cmds.default)
          setEscalateAuto(cmds.escalation !== 'never')
          setBaseline(cmds.baseline)
          setSessionCache(cmds.sessionCache)
        } catch {
          // a stale form must never break the section render
        }
      }
      update()
      return subscribeForm(form, update)
    }, [])

    const locked = !isWritable(form)
    const overridden = fieldOverridden(form, 'commands')
    const saved = currentCommands(form)
    const isDirty =
      defaultAction !== (saved.default || 'delegate') ||
      escalateAuto !== (saved.escalation !== 'never') ||
      baseline !== saved.baseline ||
      sessionCache !== saved.sessionCache ||
      rulesDirty(rules, saved.rules)
    const pendingCount = isDirty ? 1 : 0
    const resetProps = resetButtonProps(overridden, t)
    const actionOpts = actionOptions(t)
    const defaultOpts = actionOptions(t, true)

    const setRule = (index: number, patch: Partial<CommandRuleRow>) => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => previous.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
    }

    const addRule = () => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => [...previous, { id: nextId.current++, tool: '', pattern: '', action: 'ask' }])
    }

    const removeRule = (index: number) => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      const cmds = currentCommands(form)
      setRules(cmds.rules.map((rule) => ({ ...rule, id: nextId.current++ })))
      setDefaultAction(cmds.default || 'delegate')
      setEscalateAuto(cmds.escalation !== 'never')
      setBaseline(cmds.baseline)
      setSessionCache(cmds.sessionCache)
      setError(null)
      dirtyRef.current = false
    }

    /** 清除用户层覆盖，回到组合（部署）默认值。 */
    const resetDefault = async () => {
      setError(null)
      try {
        setSaving(true)
        await resetField(form, 'commands', t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const save = async () => {
      setError(null)
      // 空 pattern 的行不保存；历史 program/args 写法不再被 schema 接受。
      const cleanRules = rules
        .filter((rule) => rule && String(rule.pattern || '').trim().length > 0)
        .map((rule) => {
          const clean: { pattern: string; action: string; tool?: string } = {
            pattern: String(rule.pattern || '').trim(),
            action: rule.action || 'ask',
          }
          if (rule.tool) clean.tool = rule.tool
          return clean
        })
      try {
        setSaving(true)
        await saveField(form, 'commands', {
          default: defaultAction,
          escalation: escalateAuto ? 'capability' : 'never',
          baseline,
          sessionCache,
          rules: cleanRules,
        }, t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = t('cmds.count', { count: saved.rules.length })
      + (pendingCount > 0 ? t('cmds.countPending') : '')

    return (
      <Card
        id="sabx-card-cmds"
        name={t('cmds.name')}
        count={countText}
        desc={t('cmds.desc')}
        pendingCount={pendingCount}
        open={open}
        onToggle={() => setOpen(!open)}
        t={t}
      >
        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">{t('cmds.defaultLabel')}</span>
            <button
              className="sabx-field-reset"
              type="button"
              disabled={saving || locked || !overridden}
              title={resetProps.title}
              onClick={() => void resetDefault()}
            >
              {resetProps.label}
            </button>
          </div>
          <p className="sabx-field-hint">{t(COMMANDS_DEFAULT_HINT_KEY)}</p>
          <Seg options={defaultOpts} selected={defaultAction} onSelect={setDefaultAction} ariaLabel={t('cmds.defaultAria')} />
        </div>

        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">{t('cmds.rulesLabel')}</span>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: t(COMMANDS_HINT_KEY) }} />
          <div className="sabx-rules-table">
            {rules.length === 0 ? (
              <div className="sabx-empty">{t('cmds.empty')}</div>
            ) : (
              rules.map((rule, index) => (
                <div key={rule.id} className="sabx-rule-row">
                  <div className="sabx-rule-tool">
                    <ToolPicker t={t} value={rule.tool} disabled={saving || locked} onSelect={(value) => setRule(index, { tool: value })} />
                  </div>
                  <div className="sabx-rule-pattern">
                    <input
                      className="sabx-input sabx-mono"
                      type="text"
                      spellCheck={false}
                      placeholder={t('cmds.patternPlaceholder')}
                      aria-label={t('cmds.patternAria')}
                      value={rule.pattern || ''}
                      disabled={saving || locked}
                      onChange={(event) => setRule(index, { pattern: event.target.value })}
                    />
                  </div>
                  <div className="sabx-rule-action">
                    <Seg options={actionOpts} selected={rule.action} onSelect={(value) => setRule(index, { action: value })} ariaLabel={t('cmds.actionAria')} compact />
                  </div>
                  <button
                    className="sabx-icon-btn sabx-rule-remove"
                    type="button"
                    aria-label={t('cmds.removeAria')}
                    title={t('cmds.removeTitle')}
                    disabled={saving || locked}
                    onClick={() => removeRule(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving || locked} onClick={addRule}>
            <span aria-hidden="true">＋</span> {t('cmds.add')}
          </button>
          <p className="sabx-dir-hint-inline" style={{ marginTop: 4 }}>{t(COMMANDS_TAIL_HINT_KEY)}</p>
        </div>

        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">{t('cmds.escalationLabel')}</span>
          </div>
          <label className="sabx-check">
            <input
              type="checkbox"
              checked={escalateAuto}
              disabled={saving || locked}
              onChange={(event) => setEscalateAuto(event.target.checked)}
            />
            <span>{t('cmds.escalationCheck')}</span>
          </label>
          <p className="sabx-field-hint">{t(COMMANDS_ESCALATION_HINT_KEY)}</p>
        </div>

        <details className="sabx-advanced">
          <summary>{t('cmds.advanced')}</summary>
          {baselineOptions(t).map((option) => (
            <div key={option.key} className="sabx-advanced-item">
              <label className="sabx-check">
                <input
                  type="checkbox"
                  checked={option.key === 'baseline' ? baseline : sessionCache}
                  disabled={saving || locked}
                  onChange={(event) =>
                    (option.key === 'baseline' ? setBaseline : setSessionCache)(event.target.checked)
                  }
                />
                <span>{option.label}</span>
              </label>
              <p className="sabx-field-hint">{option.hint}</p>
            </div>
          ))}
        </details>

        <div className="sabx-card-footer">
          {error !== null ? (
            <p className="sabx-card-error" role="alert">{error}</p>
          ) : null}
          <button className="sabx-btn sabx-btn-ghost" type="button" disabled={saving || pendingCount === 0} onClick={restoreSaved}>
            {t('common.discard')}
          </button>
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving || locked} onClick={() => void save()}>
            {saving ? t('common.saving') : t('cmds.save')}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「命令规则」可视化编辑器（与授权目录编辑器并列）。保留原导出名，
 * 返回独立卡片组件。
 * @param form - `ctx.configForms.get(SETTINGS_ENTRY_ID)` 返回的表单 controller。
 * @param t - 词典翻译函数（`ctx.locale.bind(NS)`）。
 */
export function makeCommandRulesEditor(form: FormController | null, t: Translate) {
  return makeCommandsCard(form, t)
}

/**
 * 构建「禁读规则」卡片（pattern 输入 + 紧凑 deny/ask 分段 + 删除/添加/保存/放弃）。
 * 动作刻意只有 deny / ask：官方默认本就允许读，allow 与默认行为无异，故不提供。
 * @param form - `ctx.configForms.get(SETTINGS_ENTRY_ID)` 返回的表单 controller。
 * @param t - 词典翻译函数（`ctx.locale.bind(NS)`）。
 */
export function makeNoReadCard(form: FormController | null, t: Translate) {
  return function NoReadCard() {
    const [rules, setRules] = useState<NoReadRuleRow[]>([])
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // 行标识发生器与草稿保护标记（语义同授权目录卡片）。
    const nextId = useRef(1)
    const dirtyRef = useRef(false)

    useEffect(() => {
      const update = () => {
        try {
          if (dirtyRef.current) return // 有未保存草稿，不覆盖
          setRules(currentNoRead(form).map((rule) => ({ ...rule, id: nextId.current++ })))
        } catch {
          // a stale form must never break the section render
        }
      }
      update()
      return subscribeForm(form, update)
    }, [])

    const locked = !isWritable(form)
    const overridden = fieldOverridden(form, 'noRead')
    const saved = currentNoRead(form)
    const pendingCount = noReadDirty(rules, saved) ? 1 : 0
    const resetProps = resetButtonProps(overridden, t)

    const setRule = (index: number, patch: Partial<NoReadRuleRow>) => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => previous.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
    }

    const addRule = () => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => [...previous, { id: nextId.current++, pattern: '', action: 'deny' }])
    }

    const removeRule = (index: number) => {
      setError(null)
      dirtyRef.current = true
      setRules((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      setRules(currentNoRead(form).map((rule) => ({ ...rule, id: nextId.current++ })))
      setError(null)
      dirtyRef.current = false
    }

    /** 清除用户层覆盖，回到组合（部署）默认值。 */
    const resetDefault = async () => {
      setError(null)
      try {
        setSaving(true)
        await resetField(form, 'noRead', t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const save = async () => {
      setError(null)
      // 空 pattern 的行不保存；action 归一为 deny/ask（服务端 schema 同样拒绝 allow）。
      const cleanRules = rules
        .filter((rule) => rule && rule.pattern && String(rule.pattern).trim().length > 0)
        .map((rule) => ({
          pattern: String(rule.pattern).trim(),
          action: rule.action === 'ask' ? 'ask' : 'deny',
        }))
      try {
        setSaving(true)
        await saveField(form, 'noRead', cleanRules, t)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = t('noread.count', { count: saved.length })
      + (pendingCount > 0 ? t('noread.countPending') : '')

    return (
      <Card
        id="sabx-card-noread"
        name={t('noread.name')}
        count={countText}
        desc={t('noread.desc')}
        pendingCount={pendingCount}
        open={open}
        onToggle={() => setOpen(!open)}
        t={t}
      >
        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">{t('noread.fieldLabel')}</span>
            <button
              className="sabx-field-reset"
              type="button"
              disabled={saving || locked || !overridden}
              title={resetProps.title}
              onClick={() => void resetDefault()}
            >
              {resetProps.label}
            </button>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: t(NOREAD_HINT_KEY) }} />
          <div className="sabx-rules-table">
            {rules.length === 0 ? (
              <div className="sabx-empty">{t('noread.empty')}</div>
            ) : (
              rules.map((rule, index) => (
                <div key={rule.id} className="sabx-rule-row sabx-noread-row">
                  <div className="sabx-rule-pattern">
                    <input
                      className="sabx-input sabx-mono"
                      type="text"
                      spellCheck={false}
                      placeholder={t('noread.patternPlaceholder')}
                      aria-label={t('noread.patternAria')}
                      value={rule.pattern}
                      disabled={saving || locked}
                      onChange={(event) => setRule(index, { pattern: event.target.value })}
                    />
                  </div>
                  <div className="sabx-rule-action">
                    <Seg options={NOREAD_ACTIONS} selected={rule.action} onSelect={(value) => setRule(index, { action: value })} ariaLabel={t('noread.actionAria')} compact />
                  </div>
                  <button
                    className="sabx-icon-btn sabx-rule-remove"
                    type="button"
                    aria-label={t('noread.removeAria')}
                    title={t('noread.removeTitle')}
                    disabled={saving || locked}
                    onClick={() => removeRule(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving || locked} onClick={addRule}>
            <span aria-hidden="true">＋</span> {t('noread.add')}
          </button>
          <p className="sabx-dir-hint-inline" style={{ marginTop: 4 }}>{t(NOREAD_TAIL_HINT_KEY)}</p>
        </div>

        <div className="sabx-card-footer">
          {error !== null ? (
            <p className="sabx-card-error" role="alert">{error}</p>
          ) : null}
          <button className="sabx-btn sabx-btn-ghost" type="button" disabled={saving || pendingCount === 0} onClick={restoreSaved}>
            {t('common.discard')}
          </button>
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving || locked} onClick={() => void save()}>
            {saving ? t('common.saving') : t('noread.save')}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「沙箱授权」分节组件（闭包式，直接订阅配置表单 controller）。
 * 包含「授权目录」「命令规则」「禁读规则」三张可折叠卡片，视觉对齐
 * docs/internal/config-ui-prototype.html v5。
 * @param form - `ctx.configForms.get(SETTINGS_ENTRY_ID)` 返回的表单 controller（可为 null）。
 * @param t - 词典翻译函数（`ctx.locale.bind(NS)`）。
 */
export function makeAllowlistSection(form: FormController | null, t: Translate) {
  const DirsCard = makeDirsCard(form, t)
  const CommandsCard = makeCommandsCard(form, t)
  const NoReadCard = makeNoReadCard(form, t)
  return function AllowlistSection() {
    const reason = readOnlyReason(form, t)
    return (
      <section className="sabx-section" aria-labelledby="sabx-section-title">
        <h2 className="sabx-section-heading" id="sabx-section-title">{t('section.title')}</h2>
        <p className="sabx-section-intro">
          {t('section.intro')}
        </p>
        {reason !== null ? (
          <div className="sabx-callout-note" role="status">{reason}</div>
        ) : null}
        <DirsCard />
        <CommandsCard />
        <NoReadCard />
      </section>
    )
  }
}

/**
 * provider 行详情页标题旁的徽标。client 半件运行在浏览器侧拿不到宿主平台，
 * 文案用中性表述——具体平台行为由说明页与 provider.mjs 的宿主日志交代。
 * （与 lib/client.js 的 makeProviderPlatformBadge 保持一致。）
 */
function makeProviderPlatformBadge(t: Translate) {
  return function ProviderPlatformBadge(props: { subject?: { kind?: string; row?: { rowId?: string } } }) {
    const subject = props && props.subject
    if (!subject || subject.kind !== 'row' || !subject.row || subject.row.rowId !== PROVIDER_ROW_ID) return null
    return <span className="sabx-badge">{t('provider.badge')}</span>
  }
}

/**
 * provider 行说明页（行详情页经 row.config 槽位打开）：用一段人话交代平台
 * 边界，代替异常或沉默。Windows 上本行启用时宿主侧自动空转并记一次性日志
 * （见 lib/provider.mjs 的 InertProvider），界面可见的提示就在这里。
 */
function makeProviderPlatformNotice(t: Translate) {
  return function ProviderPlatformNotice(props: { view?: string }) {
    if (props && props.view === 'summary') {
      return t('provider.summary')
    }
    return <div className="sabx-callout-note" role="note">{t('provider.notice')}</div>
  }
}

/**
 * 客户端插件入口：注册设置页分节、插件面板配置界面，并取本插件条目的配置表单。
 * 注册写法与官方设置分节一致（ctx.slots.inject + register）。
 */
export function apply(ctx: ClientContext) {
  // 词典注册先于分节注册：宿主按当前语言渲染，回退链末端永远是 en。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sandbox-allowlist: dictionaries')
  // 每个 namespace 一个稳定翻译函数；渲染时读取宿主当前语言。
  const t: Translate = ctx.locale.bind(NS)
  let form: FormController | null = null
  try {
    form = ctx.configForms.get(SETTINGS_ENTRY_ID)
  } catch {
    // 表单不可用（服务缺失 / 条目未挂载）不能阻止分节注册 —— 组件退化为只读空列表。
    form = null
  }
  const section = makeAllowlistSection(form, t)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sandbox-allowlist',
    order: 30,
    label: () => t('section.title'),
  }, section))
  // 插件面板（Plugins 页）的配置界面：同一份三卡片分节挂到插件详情页。
  //   - plugins.bundle.config（key=包名）：包详情页在描述与行列表之间渲染；
  //   - plugins.row.config（key=「包名#行id」）：策略行获得「配置」入口，行详情页
  //     渲染（props.form 与本闭包的 form 是同一份 controller，忽略 props）。
  // 两个槽位由 Plugins 页主注册声明，ctx.slots.inject 会等待声明出现；页面离开
  // 后声明塌缩、注册随之下线，回到页面时随声明自动重挂。summary 视图给一行说明。
  const bundleConfig = function BundleConfig(props: { view?: string }) {
    if (props && props.view === 'summary') return t('section.summary')
    const Section = section
    return <Section />
  }
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    id: 'sandbox-allowlist-config',
    key: BUNDLE_CONFIG_KEY,
  }, bundleConfig))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    id: 'sandbox-allowlist-policy-config',
    key: ROW_CONFIG_KEY,
  }, bundleConfig))
  // provider 行的平台提示：详情页标题旁的「仅 Linux 生效」徽标 + 行说明页。
  // 行页的存在本身由这条 row.config 注册打开（没有配置页的行不生成详情页），
  // 页面里渲染平台边界说明——Windows 上即使启用也只是空转（见 provider.mjs）。
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'sandbox-allowlist-platform-badge',
  }, makeProviderPlatformBadge(t)))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    id: 'sandbox-allowlist-provider-config',
    key: PROVIDER_ROW_CONFIG_KEY,
  }, makeProviderPlatformNotice(t)))
}
