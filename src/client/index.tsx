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
 *     放行）+ 默认收起的「高级」区（内置能力基线）；
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
// 面板数据通道走自建 host 路由（同源 fetch），不依赖 connection——inject
// 面保持最小（dsh-jenkins 实证路径：官方 wire 域不稳，自建路由最稳）。
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

/** 「高级」折叠区的布尔开关（标签与说明均为词典键）。 */
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
} {
  const fallback = { default: 'delegate', rules: [] as SavedCommandRule[], escalation: 'capability', baseline: true }
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

/** 未保存改动计数：与已保存值逐条位置比较（比较到两列表较长一方，删除行
 * 形成的尾部差异也计入——只循环到 rows.length 会漏掉删除最后一行的情况）。 */
function dirsDirtyCount(rows: { value: string }[], saved: string[]): number {
  let count = 0
  const len = Math.max(rows.length, saved.length)
  for (let i = 0; i < len; i += 1) {
    const rowValue = i < rows.length ? String(rows[i].value || '') : ''
    const compared = i < saved.length ? String(saved[i] || '') : ''
    if (rowValue.trim() !== compared.trim()) count += 1
  }
  return count
}

/** 未保存改动计数：规则草稿与已保存值逐条位置比较（比较到两列表较长一方，
 * 删除行形成的尾部差异也计入——与 dirsDirtyCount 同语义）。 */
function rulesDirtyCount(rows: CommandRuleRow[], saved: SavedCommandRule[]): number {
  let count = 0
  const len = Math.max(rows.length, saved.length)
  for (let i = 0; i < len; i += 1) {
    const a = rows[i]
    const b = saved[i]
    if (a === undefined || b === undefined
      || (a.tool || '') !== (b.tool || '')
      || String(a.pattern || '').trim() !== String(b.pattern || '').trim()
      || (a.action || 'ask') !== (b.action || 'ask')) count += 1
  }
  return count
}

/** 未保存改动计数：禁读规则草稿与已保存值逐条位置比较（无 tool 维度）。 */
function noReadDirtyCount(rows: NoReadRuleRow[], saved: SavedNoReadRule[]): number {
  let count = 0
  const len = Math.max(rows.length, saved.length)
  for (let i = 0; i < len; i += 1) {
    const a = rows[i]
    const b = saved[i]
    if (a === undefined || b === undefined
      || String(a.pattern || '').trim() !== String(b.pattern || '').trim()
      || (a.action || 'deny') !== (b.action || 'deny')) count += 1
  }
  return count
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
    // 未保存处数 = 改动的规则行数 + 改动的开关数（默认动作/升级/基线各计 1），
    // 与授权目录卡片的「N 处未保存」同语义。
    const pendingCount =
      rulesDirtyCount(rules, saved.rules)
      + (defaultAction !== (saved.default || 'delegate') ? 1 : 0)
      + (escalateAuto !== (saved.escalation !== 'never') ? 1 : 0)
      + (baseline !== saved.baseline ? 1 : 0)
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
      + (pendingCount > 0 ? t('cmds.countPending', { count: pendingCount }) : '')

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
                  checked={baseline}
                  disabled={saving || locked}
                  onChange={(event) => setBaseline(event.target.checked)}
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
    const pendingCount = noReadDirtyCount(rules, saved)
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
      + (pendingCount > 0 ? t('noread.countPending', { count: pendingCount }) : '')

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

/* ============================================================================
 * 会话区授权状态面板（utilities 槽位弹层）。
 * 读 = 同源 fetch（认证桥自动携带 cookie，memory 模式同样可用）；
 * 写 = connection.rpc（revoke/restore，host 半件见 lib/state-routes.mjs）。
 * connection 不可达时按钮仍渲染，点开显示载入失败原因——绝不 pending、不崩。
 * ========================================================================== */

const STATE_API = '/sandbox-allowlist/api'

/**
 * 入口探测：状态路由可达 ⇒ 平台有账可查（win32），会话入口才注册。
 * host 半件在非 win32 不注册路由，因此「路由存在」本身就是平台信号。
 * 带重试（约 12s 窗口）：页面先刷新、插件后重载的版本差窗口里路由短暂
 * 404，重试让入口在服务端半件就绪后自动出现，而不是把入口掐死。
 */
function probeStateSupported(): Promise<boolean> {
  const ATTEMPT_TIMEOUT = 3000
  const ATTEMPT_GAP = 1200
  const DEADLINE = 12000
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    const attempt = (controller: AbortController) => {
      fetch(`${STATE_API}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const envelope = (await response.json()) as any
          finish(envelope !== null && typeof envelope === 'object' && envelope.ok === true
            && envelope.value !== null && typeof envelope.value === 'object')
        })
        .catch(() => {
          if (settled) return
          if (Date.now() - started >= DEADLINE) { finish(false); return }
          timer = setTimeout(() => attempt(new AbortController()), ATTEMPT_GAP)
        })
    }
    attempt(new AbortController())
  })
}

/** 统一调用：POST 自建路由，解包 { ok, value } 信封；HTTP/网络错误入信封语义。 */
async function postStateAction(method: string, payload: unknown): Promise<any> {
  const response = await fetch(`${STATE_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  let envelope: any = null
  try {
    envelope = await response.json()
  } catch {
    throw new Error(`HTTP ${response.status}（非 JSON 响应）`)
  }
  if (!response.ok || !envelope || envelope.ok !== true) {
    const reason = envelope && envelope.error ? (envelope.error.message || envelope.error.code) : `HTTP ${response.status}`
    throw new Error(String(reason))
  }
  return envelope.value
}

type StateKind = 'granted' | 'failed' | 'pending' | 'revoked'

type StateRow = {
  key: string
  path: string
  kind: StateKind
  time: string | null | undefined
  reason: string
  source: string
}

/** 三段记录 → 面板表格行（kind: granted | failed | pending | revoked）。 */
function stateRowsOf(view: any, t: Translate): StateRow[] {
  const rows: StateRow[] = []
  if (!view) return rows
  const roots = Array.isArray(view.roots) ? view.roots : []
  const pending = Array.isArray(view.pendingRevoke) ? view.pendingRevoke : []
  const history = Array.isArray(view.history) ? view.history : []
  for (const entry of roots) {
    const record = entry || {}
    const failed = record.status === 'failed'
    rows.push({
      key: `root:${record.path}`,
      path: record.path,
      kind: record.excluded ? 'pending' : (failed ? 'failed' : 'granted'),
      time: failed ? (record.errorAt || record.grantedAt) : record.grantedAt,
      // 失败原因直接进列（失败行 = error 原文；待回收行也带 error）。
      reason: failed ? String(record.error || '') : (record.excluded ? t('status.dotPending') : ''),
      source: (record.fromPatterns || []).join('  '),
    })
  }
  for (const item of pending) {
    const record = item || {}
    rows.push({
      key: `pending:${record.path}`,
      path: record.path,
      kind: 'pending',
      time: record.lastAttemptAt,
      reason: String(record.error || ''),
      source: (record.fromPatterns || []).join('  '),
    })
  }
  history.forEach((audit: any, index: number) => {
    const record = audit || {}
    rows.push({
      key: `history:${record.path}:${index}`,
      path: record.path,
      kind: 'revoked',
      time: record.revokedAt,
      reason: '',
      source: (record.fromPatterns || []).join('  '),
    })
  })
  return rows
}

const STATE_KINDS: StateKind[] = ['granted', 'failed', 'pending', 'revoked']

/** 操作 busy 层的最短展示时长：亚秒完成的操作也要让加载反馈可感知
 * （一闪而过 ≈ 没点上）。 */
const BUSY_MIN_MS = 700

/**
 * 面板组件工厂（闭包式 hooks 组件，语义同设置卡片：不依赖 slots 的 props
 * 转换契约）。打开时拉一次视图 + 手动刷新按钮，不建推送。
 * @param connection - 注入的 connection 服务（可为 null：点开只见载入失败）。
 * @param t - 词典翻译函数（ctx.locale.bind(NS)）。
 */
/** 宽松路径同判（分隔符方向与大小写不敏感）：仅用于确认 host 返回的
 * current 是否真的解析到了本会话 cwd——host 端 realpath 后盘符/分隔符形态
 * 可能与客户端拿到的 cwd 字符串不同。 */
function samePath(actual: any, expected: string): boolean {
  if (typeof actual !== 'string' || actual === '' || typeof expected !== 'string' || expected === '') return false
  return actual.replace(/[\\/]+/g, '/').toLowerCase() === expected.replace(/[\\/]+/g, '/').toLowerCase()
}

/** ISO(UTC) 时间串 → 本地时区 `YYYY-MM-DD HH:MM:SS`。清单存储保持 UTC ISO
 * （跨时区可移植、可排序），只有展示做转换：本地 getter 自动跟随机器时区，
 * 任何地区的用户看到的都是自己的墙钟时间。 */
function localTimeText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/**
 * 面板组件工厂（闭包式 hooks 组件，语义同设置卡片：不依赖 slots 的 props
 * 转换契约）。打开时拉一次视图 + 手动刷新按钮，不建推送。
 * props 按宿主契约读取（conversation.session.header.utilities 的
 * standardProps）：sessionId + useSessions 快照钩子，会话 cwd 只能经钩子
 * 读取，供 host 把「当前工作区」解析到激活会话。面板只看会话工作区：cwd
 * 未命中清单键时选中空 + 空态，绝不回退到实例根/最近使用键；工作区控件
 * 保留下拉形态但禁切换（只读指示器）。
 * 撤销/恢复走面板内确认弹层：原生 window.confirm 在本宿主（Electron）关闭
 * 后不恢复输入焦点，会话输入框会因此无法选中（electron#31917）；in-place
 * 按钮变形的误触率又高，故为 DOM 内模态弹层。操作期间显示带最短时长的
 * busy 层——亚秒完成也会被看到，避免「一闪而过 ≈ 没点上」的体验。
 * 悬停提示为自绘气泡：单例 DOM 直挂 document.body（宿主存在吞掉面板内
 * fixed 元素的裁剪容器/层叠上下文，官方 Tooltip 为此自带 portal 逃生门），
 * 事件用 ref 上的原生监听而非 React 合成 mouseover（后者在真机从未生效）。
 */
export function makeStatePanel(t: Translate) {
  return function StatePanel(props?: any) {
    const [open, setOpen] = useState(false)
    const [data, setData] = useState<{ loading: boolean; error: string | null; view: any }>({ loading: false, error: null, view: null })
    const [filter, setFilter] = useState('all')
    const [busy, setBusy] = useState(false)
    // 当前查看的工作区 = 会话工作区（host 在 sessionCwd 命中清单键时返回它）；
    // 未命中/无线索时恒为 ''——绝不回退到实例根/最近使用键。面板只看当前
    // 会话的授权，串显别的工作区的记录只会误导。
    const [ws, setWs] = useState('')
    // 撤销/恢复确认弹层（DOM 内模态）：原生 window.confirm 在本宿主（Electron）
    // 关闭后不恢复输入焦点，会话输入框会因此点不进去（electron#31917），
    // 绝不使用；in-place 按钮变形的误触率又高，故为弹层。
    const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'restore'; payload: { path: string; workspace: string } } | null>(null)
    // 操作 busy 层的最短展示封装：act 与手动刷新共用，让亚秒完成的操作也有
    // 可感知的加载反馈（一闪而过 ≈ 没点上）。
    const withBusy = async (job: () => Promise<void>) => {
      setBusy(true)
      const startedAt = Date.now()
      try {
        await job()
      } finally {
        const wait = Math.max(0, BUSY_MIN_MS - (Date.now() - startedAt))
        if (wait > 0) setTimeout(() => setBusy(false), wait)
        else setBusy(false)
      }
    }

    // 会话线索（宿主契约 standardProps）：条目收到 sessionId 与 useSessions
    // 快照钩子，cwd 只能经钩子读取（官方 open-in-app 条目同款读法）。
    // sessionId 是标识符不是路径，绝不能塞进 sessionCwd——host 会把它规范化
    // 成无效路径，current 永远回落实例工作区根。钩子存在性由宿主按槽位契约
    // 恒定提供（同一挂载期内不变），条件调用不会打乱 hooks 顺序。
    const propsAny = props || {}
    const sessionId = typeof propsAny.sessionId === 'string' ? propsAny.sessionId : ''
    const useSessions = typeof propsAny.useSessions === 'function' ? propsAny.useSessions : null
    const sessionCwd = useSessions !== null
      ? useSessions((state: any) => {
          const record = state && typeof state === 'object' && state.byId ? state.byId[sessionId] : null
          return record && typeof record.cwd === 'string' ? record.cwd : ''
        })
      : ''

    // 采纳工作区选中项：仅当会话 cwd 确实命中清单键（host 的 current 经
    // loose 同判确认）时选中它，否则置空——数据区走「当前工作区暂无授权
    // 记录」空态，绝不默认选中别的工作区。
    const adoptWorkspaces = (next: any, sessionMatched: boolean) => {
      const pool = next && next.workspaces ? next.workspaces : {}
      const current = next ? next.current : null
      setWs(sessionMatched && typeof current === 'string' && Object.prototype.hasOwnProperty.call(pool, current) ? current : '')
    }
    const load = async () => {
      setData((previous) => ({ loading: true, error: null, view: previous.view }))
      try {
        const sentCwd = sessionCwd !== ''
        const next = await postStateAction('state', sentCwd ? { sessionCwd } : {})
        setData({ loading: false, error: null, view: next })
        adoptWorkspaces(next, sentCwd && samePath(next && next.current, sessionCwd))
        setConfirm(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setData({ loading: false, error: t('status.error', { message }), view: null })
      }
    }
    const act = (endpoint: string, payload: unknown) => withBusy(async () => {
      try {
        const next = await postStateAction(endpoint, payload)
        setData({ loading: false, error: null, view: next })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setData((previous) => ({ loading: false, error: t('status.actionFailed', { message }), view: previous.view }))
      }
    })
    // 手动刷新与操作共用 busy 层（打开面板的首次载入仍走按钮内联的载入中态，
    // 不弹遮罩）。
    const refresh = () => withBusy(load)
    const closePanel = () => {
      setOpen(false)
      setConfirm(null)
    }

    // 悬停提示（自绘气泡，body 级单例 DOM）：本宿主的裁剪容器与层叠上下文会
    // 吞掉面板内 fixed 元素（官方 Tooltip 为此自带 portal 逃生门），单例直挂
    // body 彻底免疫；事件走 ref 上的原生监听，不依赖 React 合成 mouseover
    // （合成 click 一直可用，但悬浮链路在真机从未生效，原生监听消除变量）。
    // 气泡样式走 .sabx-tip（与面板模态同观感），display 由 JS 直接开关。
    const rootRef = useRef<HTMLSpanElement | null>(null)
    useEffect(() => {
      const root = rootRef.current
      if (root === null || typeof document === 'undefined' || !document.body) return undefined
      let box = document.getElementById('sabx-tip') as HTMLDivElement | null
      const created = box === null
      if (box === null) {
        box = document.createElement('div')
        box.id = 'sabx-tip'
        box.className = 'sabx-tip'
        box.setAttribute('role', 'tooltip')
        document.body.appendChild(box)
      }
      const tipBox = box
      const hide = () => { tipBox.style.display = 'none' }
      const show = (anchor: Element) => {
        const text = anchor.getAttribute('data-tip')
        if (!text) { hide(); return }
        const rect = anchor.getBoundingClientRect()
        const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
        tipBox.textContent = text
        tipBox.style.display = 'block' // 先显示才能实测宽度（display:none 时量宽为 0）
        // 实测气泡宽度后按真实半宽钳制：短文案贴着锚点正下方居中——此前用
        // 最大宽一半做保守预算，右上角的按钮会被硬生生向左推开、气泡不再
        // 对准按钮；长文案（失败原因全文）贴视口边缘时才收进来（12px 边距）。
        const half = Math.min(tipBox.offsetWidth / 2 + 12, viewportWidth / 2)
        const left = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, viewportWidth - half))
        tipBox.style.left = left + 'px'
        tipBox.style.top = rect.bottom + 8 + 'px'
      }
      const onOver = (event: Event) => {
        const target = event.target
        const anchor = target instanceof Element && typeof target.closest === 'function' ? target.closest('[data-tip]') : null
        if (anchor === null) hide()
        else show(anchor)
      }
      root.addEventListener('mouseover', onOver)
      root.addEventListener('mouseout', hide)
      // 任何点击都收起气泡：点击打开确认层/busy 层/关闭面板时，滞留的气泡
      // 会浮在这些层之上。
      root.addEventListener('click', hide, true)
      return () => {
        root.removeEventListener('mouseover', onOver)
        root.removeEventListener('mouseout', hide)
        root.removeEventListener('click', hide, true)
        if (created && tipBox.parentNode !== null) tipBox.parentNode.removeChild(tipBox)
      }
    }, [])

    // 视图 → 当前工作区切片：只认会话工作区（ws 未命中清单键即空态），
    // 绝不回退到实例根/最近使用键。
    const view = open ? data.view : null
    const workspaces = view && view.workspaces && typeof view.workspaces === 'object' ? view.workspaces : {}
    const activeWs = ws !== '' && Object.prototype.hasOwnProperty.call(workspaces, ws) ? ws : ''
    const slice = activeWs !== '' ? workspaces[activeWs] : null

    const rows = slice ? stateRowsOf(slice, t) : []
    const filtered = rows.filter((row) => filter === 'all' || row.kind === filter)
    const kindMeta: Record<StateKind, { label: string; dot: string; title: string }> = {
      granted: { label: t('status.stateGranted'), dot: 'sabx-dot-allow', title: t('status.dotGranted') },
      failed: { label: t('status.stateFailed'), dot: 'sabx-dot-deny', title: t('status.dotFailed') },
      pending: { label: t('status.statePending'), dot: 'sabx-dot-ask', title: t('status.dotPending') },
      revoked: { label: t('status.stateRevoked'), dot: 'sabx-dot-revoked', title: t('status.dotRevoked') },
    }
    const filters = [{ key: 'all', label: t('status.filterAll') }].concat(
      STATE_KINDS.map((kind) => ({ key: kind, label: kindMeta[kind].label })),
    )

    const rowNodes = filtered.map((row) => {
      const meta = kindMeta[row.kind]
      const timeText = row.time ? localTimeText(row.time) : t('status.none')
      const payload = { path: row.path, workspace: activeWs }
      let action: ReactNode = null
      if (row.kind === 'granted') {
        // 撤销是真实的 OS 状态变更：先弹确认层写明后果，确认后才发起。
        action = (
          <button key="act" className="sabx-panel-filter" type="button" disabled={busy} aria-label={t('status.actionRevokeAria')} data-tip={t('status.actionRevokeAria')} onClick={() => setConfirm({ kind: 'revoke', payload })}>
            {t('status.actionRevoke')}
          </button>
        )
      } else if (row.kind === 'revoked') {
        action = (
          <button key="act" className="sabx-panel-filter" type="button" disabled={busy} aria-label={t('status.actionRestoreAria')} data-tip={t('status.actionRestoreAria')} onClick={() => setConfirm({ kind: 'restore', payload })}>
            {t('status.actionRestore')}
          </button>
        )
      } else if (row.kind === 'failed') {
        // 手动重试物化（自动重试每次解析都会做；修复目录 ACL 后可立即重试）。
        action = (
          <button key="act" className="sabx-panel-filter" type="button" disabled={busy} aria-label={t('status.actionGrantAria')} data-tip={t('status.actionGrantAria')} onClick={() => void act('grant', payload)}>
            {t('status.actionGrant')}
          </button>
        )
      }
      // 待回收行操作列为空：重试语义在表格下方的固定脚注说明。
      return (
        <tr key={row.key}>
          <td className="sabx-panel-cellpath" data-tip={row.path}>{row.path}</td>
          <td>
            <span className="sabx-panel-status" data-tip={meta.title}>
              <span className={`sabx-dot ${meta.dot}`} aria-hidden="true" />
              {meta.label}
            </span>
          </td>
          <td className="sabx-panel-time">{timeText}</td>
          <td className="sabx-panel-reason" data-tip={row.reason || undefined}>{row.reason || t('status.none')}</td>
          <td className="sabx-panel-dim" data-tip={row.source || undefined}>{row.source || t('status.none')}</td>
          <td><span className="sabx-panel-actions">{action}</span></td>
        </tr>
      )
    })
    const headerLabels = [
      t('status.colPath'), t('status.colStatus'), t('status.colTime'), t('status.colReason'),
      t('status.colSource'), t('status.colAction'),
    ]

    if (!open) {
      return (
        <span ref={rootRef} className="sabx-panel-root">
          <button
            className="sabx-panel-btn" type="button"
            aria-label={t('status.panelAria')} data-tip={t('status.panelAria')}
            onClick={() => { setOpen(true); void load() }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5l5.5 2v4c0 3.2-2.3 5.9-5.5 7-3.2-1.1-5.5-3.8-5.5-7v-4l5.5-2z" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
              <path d="M5.6 8l1.7 1.7 3.2-3.4" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
      )
    }
    // 居中模态（对齐官方「反馈」弹窗）：遮罩 flex 居中；标题/过滤胶囊在滚动
    // 容器外天然固定；表头在滚动容器内 sticky 吸顶；只有数据区滚动。横向滚动
    // 时首列（路径）与末列（操作）吸附。悬停提示为 body 级自绘气泡单例
    //（rootRef effect：原生监听 + body 门户，见组件头部注释）。
    return (
      <span ref={rootRef} className="sabx-panel-root">
        <button
          className="sabx-panel-btn" type="button"
          aria-label={t('status.panelAria')} data-tip={t('status.panelAria')}
          onClick={closePanel}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
          </svg>
        </button>
        <div className="sabx-panel-overlay" onClick={closePanel}>
          <div className="sabx-panel" role="dialog" aria-label={t('status.panelTitle')} onClick={(event) => event.stopPropagation()}>
            <div className="sabx-panel-head">
              <span className="sabx-panel-title">{t('status.panelTitle')}</span>
              <button
                className="sabx-panel-filter" type="button" disabled={data.loading || busy}
                aria-label={t('status.refreshAria')} data-tip={t('status.refreshAria')} onClick={() => void refresh()}
              >
                {data.loading ? t('status.loading') : t('status.refresh')}
              </button>
              <button className="sabx-panel-filter" type="button" aria-label={t('status.close')} data-tip={t('status.close')} onClick={closePanel}>
                {t('status.close')}
              </button>
            </div>
            <div className="sabx-panel-ws">
              <span className="sabx-panel-ws-label">{t('status.wsLabel')}</span>
              <div className="sabx-panel-ws-picker" data-tip={activeWs || sessionCwd || t('status.none')}>
                {/* 只读指示器：面板只看会话工作区，禁切换（暂保留下拉控件形态）。
                    title 放容器上：Chrome 不显示 disabled 控件自身的 title，
                    悬停在子元素上时沿祖先链取 title，容器方案连带 chevron 生效 */}
                <button
                  className="sabx-panel-ws-trigger" type="button" disabled
                >
                  <span className="sabx-panel-ws-value">{activeWs || sessionCwd || t('status.none')}</span>
                  <svg className="sabx-panel-ws-chevron" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="sabx-panel-filters">
              {filters.map((entry) => (
                <button
                  key={entry.key} className="sabx-panel-filter" type="button"
                  data-active={filter === entry.key ? 'true' : 'false'}
                  onClick={() => { setFilter(entry.key); setConfirm(null); }}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {data.error !== null ? <p className="sabx-panel-error" role="alert">{data.error}</p> : null}
            <div className="sabx-panel-scroll">
              <table className="sabx-panel-table">
                <colgroup>
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '96px' }} />
                  <col style={{ width: '148px' }} />
                  <col style={{ width: '26%' }} />
                  <col style={{ width: '16%' }} />
                  <col style={{ width: '80px' }} />
                </colgroup>
                <thead>
                  <tr>{headerLabels.map((label) => <th key={label} scope="col">{label}</th>)}</tr>
                </thead>
                <tbody>
                  {filtered.length === 0
                    ? <tr><td colSpan={6}><div className="sabx-empty">{data.view === null ? t('status.loading') : t('status.empty')}</div></td></tr>
                    : rowNodes}
                </tbody>
              </table>
            </div>
            <p className="sabx-panel-footnote">{t('status.footnote')}</p>
            {/* 撤销/恢复确认弹层：点遮罩 = 取消；卡片内阻止冒泡避免误关整个面板 */}
            {confirm !== null ? (
              <div
                className="sabx-confirm-overlay" role="alertdialog"
                aria-label={confirm.kind === 'revoke' ? t('status.confirmTitleRevoke') : t('status.confirmTitleRestore')}
                onClick={() => setConfirm(null)}
              >
                <div className="sabx-confirm" onClick={(event) => event.stopPropagation()}>
                  <div className="sabx-confirm-title">{confirm.kind === 'revoke' ? t('status.confirmTitleRevoke') : t('status.confirmTitleRestore')}</div>
                  <p className="sabx-confirm-text">{confirm.kind === 'revoke' ? t('status.confirmRevoke') : t('status.confirmRestore')}</p>
                  <div className="sabx-confirm-actions">
                    <button
                      className="sabx-panel-filter" type="button" disabled={busy}
                      onClick={() => { const pending = confirm; setConfirm(null); void act(pending.kind, pending.payload) }}
                    >
                      {t('status.confirmOk')}
                    </button>
                    <button className="sabx-panel-filter" type="button" disabled={busy} onClick={() => setConfirm(null)}>
                      {t('status.actionCancel')}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {/* 操作 busy 层：最短展示 BUSY_MIN_MS，重试授权这类亚秒操作也有可感知的反馈 */}
            {busy ? (
              <div className="sabx-busy-overlay" role="status">
                <div className="sabx-busy">
                  <span className="sabx-busy-spin" aria-hidden="true" />
                  {t('status.busy')}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </span>
    )
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
  // 会话区授权状态面板：conversation.session.header.utilities（list/加性，
  // 官方会话日志下载按钮同款）。入口按平台注册：host 半件仅在 win32 挂状态
  // 路由，client 探测可达才注册槽位——Linux/macOS 会话头部不出现任何入口，
  // 不只是空态。探测失败/超时同样不注册；槽位不在官方 SlotMap 类型里
  // （第三方扩展槽位），类型面按口径以 as never 放宽，运行期注册失败
  // try/catch 降级 no-op，绝不阻塞其余注册或 pending。
  void probeStateSupported().then((supported) => {
    if (!supported) return
    try {
      ctx.slots.inject('conversation.session.header.utilities' as never, () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'sandbox-allowlist-panel',
        order: 90,
        label: () => t('status.panelTitle'),
      }, makeStatePanel(t)))
    } catch {
      // 老宿主无该槽位：面板不可用即可，其余功能不受影响（降级 no-op）。
    }
  }).catch(() => { /* 探测异常 = 无入口 */ })
}
