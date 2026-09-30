/**
 * 设置页「沙箱授权」分节 —— 客户端插件 TS 源码（v5，对齐
 * docs/config-ui-prototype.html v5）。
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
 *
 * 数据流不变：绑定 `sandbox-allowlist` 设置 namespace → 表单编辑 →
 * scope.set('allowedDirs', [...]) / scope.set('commands', {...}) /
 * scope.set('noRead', [...]) → 写入用户设置文档（$DSH_HOME/settings.yaml）→
 * 服务端策略**实时生效**。
 *
 * 注意：组件定义在 apply 闭包内、直接订阅绑定的 scope —— 不依赖 slots
 * 系统向组件注入 props 的转换契约，任何情况下都不会因 props 缺失而崩溃。
 */

import { useEffect, useRef, useState } from 'react'
import { en, NS, zh } from './locales'

// 客户端依赖注入声明（服务名，与 lib/client.js 的 exports.inject 一致）。
// 设置源有两代：`settingsScope`（dsh 0.1.7 之前）与 `configForms`（0.1.7 起，
// 设置改由「插件 Row 自身的 Config schema」派生）。**两者都不写进静态 inject**：
// 静态 inject 里出现宿主机没有的服务名会让该 entry 永远 pending，从而拖垮
// web boot 门禁（dsh 0.1.7 上 dsh-sandbox-allowlist 正是因此启动失败），
// 所以两代都走动态 ctx.inject —— 服务缺失时回调不执行，分节仍以空列表注册。
// `locale` 是宿主自带的词典服务（dsh-client-locale），注册 zh/en 后由宿主的
// 当前语言决定渲染哪一种，插件自己不判断语言。
export const inject = ['slots', 'connection', 'locale']

export const SETTINGS_NAMESPACE = 'sandbox-allowlist'

/**
 * 设置分节的候选 namespace。dsh 0.1.7 起 Host 的 namespace 就是插件 Row 的 id
 * （dsh-settings: `ns: entry.options.id`），而该 id 由 profile 的补丁层合成
 * （本包 cordis.patch.yml 插入的 row id 为 `sandbox-allowlist-policy`），
 * 所以这里按候选名**解析**，不写死单一名字。
 */
export const SETTINGS_NAMESPACE_CANDIDATES = [
  'sandbox-allowlist-policy',
  SETTINGS_NAMESPACE,
  'dsh-sandbox-allowlist',
]

/**
 * 用户可见文案一律走词典键：模块级常量只保存**键名**，在组件里用 `t(key)`
 * 取值（`t` 在 apply 闭包内、渲染时读取宿主当前语言）。参见 locales.ts。
 */
export const CALL_WARN_DIRS_KEY = 'dirs.warn'

export const DIRS_HINT_KEY = 'dirs.hint'

export const DIRS_VALIDATE_HINT_KEY = 'dirs.validateHint'

export const COMMANDS_DEFAULT_HINT_KEY = 'cmd.defaultHint'

export const COMMANDS_HINT_KEY = 'cmds.hint'

export const COMMANDS_TAIL_HINT_KEY = 'cmds.tailHint'

export const COMMANDS_ESCALATION_HINT_KEY = 'cmds.escalationHint'

export const COMMANDS_BASELINE_HINT_KEY = 'cmds.baselineHint'

export const COMMANDS_SESSION_HINT_KEY = 'cmds.sessionHint'

export const NOREAD_HINT_KEY = 'noread.hint'

export const NOREAD_TAIL_HINT_KEY = 'noread.tailHint'

/** 工具选项（空 = 任意工具；方案 A：标签与值一致）。 */
export const TOOL_OPTIONS = [
  { value: '', labelKey: 'common.any' },
  { value: 'bash', label: 'bash' },
  { value: 'pwsh', label: 'pwsh' },
]

/** 规则动作（分段选择器，带语义色圆点类）。 */
export const ACTION_OPTIONS = [
  { value: 'allow', dot: 'sabx-dot-allow', label: 'allow', cls: 'is-allow', hintKey: 'common.allowHint' },
  { value: 'ask', dot: 'sabx-dot-ask', label: 'ask', cls: 'is-ask', hintKey: 'common.askHint' },
  { value: 'deny', dot: 'sabx-dot-deny', label: 'deny', cls: 'is-deny', hintKey: 'common.denyHint' },
]

/** 「高级」折叠区里的布尔开关（勾选框定义）。 */
export const BASELINE_OPTIONS = [
  { key: 'baseline', labelKey: 'cmds.baselineLabel', hintKey: 'cmds.baselineHint' },
  { key: 'sessionCache', labelKey: 'cmds.sessionLabel', hintKey: 'cmds.sessionHint' },
]

/** 禁读规则动作：只提供 deny / ask（allow 与默认行为无异，刻意不提供）。 */
export const NOREAD_ACTIONS = [
  { value: 'deny', dot: 'sabx-dot-deny' },
  { value: 'ask', dot: 'sabx-dot-ask' },
]

/** 从设置 scope 快照读取当前授权目录列表。 */
export function currentDirs(scope: any): string[] {
  let snapshot
  try {
    snapshot = scope.getSnapshot()
  } catch {
    return []
  }
  const value = snapshot && snapshot.value
  return Array.isArray(value && value.allowedDirs) ? value.allowedDirs : []
}

/** 从设置 scope 快照读取当前命令规则与开关。 */
export function currentCommands(scope: any): {
  default: string
  rules: any[]
  escalation: string
  baseline: boolean
  sessionCache: boolean
} {
  const fallback = { default: 'delegate', rules: [], escalation: 'capability', baseline: true, sessionCache: true }
  let snapshot
  try {
    snapshot = scope.getSnapshot()
  } catch {
    return fallback
  }
  const value = snapshot && snapshot.value
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

/** 从设置 scope 快照读取当前禁读规则（[{ pattern, action }]，动作归一为 deny/ask）。 */
export function currentNoRead(scope: any): any[] {
  let snapshot
  try {
    snapshot = scope.getSnapshot()
  } catch {
    return []
  }
  const value = snapshot && snapshot.value
  const rules = Array.isArray(value && value.noRead) ? value.noRead : []
  return rules.map((rule: any) => ({
    pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
    action: rule && rule.action === 'ask' ? 'ask' : 'deny',
  }))
}

/** 翻译函数签名（`ctx.locale.bind(NS)` 的返回值）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 动作分段选项（标签与 title 提示在渲染时按当前语言解析）。
 * @param t - 词典翻译函数。
 * @param includeDelegate - 是否在首位加上「delegate」（未命中规则的默认动作）。
 */
export function actionOptions(t: Translate, includeDelegate = false) {
  const options = ACTION_OPTIONS.map((option) => ({ ...option, hint: t(option.hintKey) }))
  return includeDelegate ? [{ value: 'delegate', dot: null as string | null }, ...options] : options
}

/** 工具下拉选项（空值 = 任意）。 */
export function toolOptions(t: Translate) {
  return TOOL_OPTIONS.map((option) => ({
    ...option,
    label: typeof option.labelKey === 'string' ? t(option.labelKey) : option.label,
  }))
}

/** 「高级」折叠区的两个布尔开关（标签与说明均为词典键）。 */
export function baselineOptions(t: Translate) {
  return BASELINE_OPTIONS.map((option) => ({
    key: option.key,
    label: t(option.labelKey),
    hint: t(option.hintKey),
  }))
}

/** 返回非法原因（词典键 + 参数），null 表示通过（浏览器侧轻量镜像 lib/patterns.mjs 的拒绝规则）。 */
export function validateDirPattern(raw: string): { key: string; params?: Record<string, string> } | null {
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
function rulesDirty(rules: any[], saved: any[]): boolean {
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
function noReadDirty(rules: any[], saved: any[]): boolean {
  if (rules.length !== saved.length) return true
  for (let i = 0; i < rules.length; i += 1) {
    const a = rules[i]
    const b = saved[i]
    if (String(a.pattern || '').trim() !== String(b.pattern || '').trim()) return true
    if ((a.action || 'deny') !== (b.action || 'deny')) return true
  }
  return false
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
          aria-label={props.ariaLabel ? `${props.ariaLabel}：${option.value}` : undefined}
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

  const t = props.t
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
  children?: any
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

/**
 * 构建「授权目录」卡片（结构化目录行 + callout 警示 + 添加/删除/保存/放弃）。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeDirsCard(scope: any, t: Translate) {
  return function DirsCard() {
    const [rows, setRows] = useState<{ value: string }[]>([])
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [invalid, setInvalid] = useState<Record<number, boolean>>({})

    useEffect(() => {
      const update = () => {
        try {
          setRows(currentDirs(scope).map((value) => ({ value })))
        } catch {
          // a stale scope must never break the section render
        }
      }
      update()
      return scope.subscribe(update)
    }, [])

    const saved = currentDirs(scope)
    const pendingCount = dirsDirtyCount(rows, saved)

    const setRow = (index: number, value: string) => {
      setError(null)
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
      setRows((previous) => [...previous, { value: '' }])
    }

    const removeRow = (index: number) => {
      setError(null)
      setRows((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      setRows(currentDirs(scope).map((value) => ({ value })))
      setError(null)
      setInvalid({})
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
        await scope.set('allowedDirs', values)
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
            <button className="sabx-field-reset" type="button" disabled={saving} onClick={restoreSaved}>
              {t('dirs.reset')}
            </button>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: t(DIRS_HINT_KEY) }} />
          <div className="sabx-dir-list">
            {rows.length === 0 ? (
              <div className="sabx-empty">{t('dirs.empty')}</div>
            ) : (
              rows.map((row, index) => (
                <div key={index} className="sabx-dir-row">
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
                    onChange={(event) => setRow(index, event.target.value)}
                  />
                  <button
                    className="sabx-icon-btn"
                    type="button"
                    aria-label={t('dirs.delete')}
                    title={t('dirs.deleteTitle')}
                    onClick={() => removeRow(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving} onClick={addRow}>
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
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? t('common.saving') : t('dirs.save')}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「命令规则」卡片（默认动作分段 + 自绘工具下拉规则表 + 添加/删除/保存/放弃）。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 * @param t - 词典翻译函数。
 */
export function makeCommandsCard(scope: any, t: Translate) {
  return function CommandsCard() {
    const [rules, setRules] = useState<any[]>([])
    const [defaultAction, setDefaultAction] = useState('delegate')
    const [escalateAuto, setEscalateAuto] = useState(true)
    const [baseline, setBaseline] = useState(true)
    const [sessionCache, setSessionCache] = useState(true)
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      const update = () => {
        try {
          const cmds = currentCommands(scope)
          setRules(cmds.rules)
          setDefaultAction(cmds.default)
          setEscalateAuto(cmds.escalation !== 'never')
          setBaseline(cmds.baseline)
          setSessionCache(cmds.sessionCache)
        } catch {
          // a stale scope must never break the section render
        }
      }
      update()
      return scope.subscribe(update)
    }, [])

    const saved = currentCommands(scope)
    const isDirty =
      defaultAction !== (saved.default || 'delegate') ||
      escalateAuto !== (saved.escalation !== 'never') ||
      baseline !== saved.baseline ||
      sessionCache !== saved.sessionCache ||
      rulesDirty(rules, saved.rules)
    const pendingCount = isDirty ? 1 : 0

    const setRule = (index: number, patch: Partial<any>) => {
      setError(null)
      setRules((previous) => previous.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
    }

    const addRule = () => {
      setError(null)
      setRules((previous) => [...previous, { tool: '', pattern: '', action: 'ask' }])
    }

    const removeRule = (index: number) => {
      setError(null)
      setRules((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      const cmds = currentCommands(scope)
      setRules(cmds.rules)
      setDefaultAction(cmds.default || 'delegate')
      setEscalateAuto(cmds.escalation !== 'never')
      setBaseline(cmds.baseline)
      setSessionCache(cmds.sessionCache)
      setError(null)
    }

    const resetDefault = () => {
      setError(null)
      setDefaultAction(saved.default || 'delegate')
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
        await scope.set('commands', {
          default: defaultAction,
          escalation: escalateAuto ? 'capability' : 'never',
          baseline,
          sessionCache,
          rules: cleanRules,
        })
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = t('cmds.count', { count: saved.rules.length })
      + (pendingCount > 0 ? t('cmds.countPending') : '')
    // 动作/工具/默认动作选项的标签在渲染时解析（t 读取宿主当前语言）。
    const actionOpts = actionOptions(t)
    const defaultOpts = actionOptions(t, true)
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
            <button className="sabx-field-reset" type="button" disabled={saving} onClick={resetDefault}>
              {t('dirs.reset')}
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
                <div key={index} className="sabx-rule-row">
                  <div className="sabx-rule-tool">
                    <ToolPicker t={t} value={rule.tool} disabled={saving} onSelect={(value) => setRule(index, { tool: value })} />
                  </div>
                  <div className="sabx-rule-pattern">
                    <input
                      className="sabx-input sabx-mono"
                      type="text"
                      spellCheck={false}
                      placeholder={t('cmds.patternPlaceholder')}
                      aria-label={t('cmds.patternAria')}
                      value={rule.pattern || ''}
                      disabled={saving}
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
                    disabled={saving}
                    onClick={() => removeRule(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving} onClick={addRule}>
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
              disabled={saving}
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
                  disabled={saving}
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
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
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
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeCommandRulesEditor(scope: any, t: Translate) {
  return makeCommandsCard(scope, t)
}

/**
 * 构建「禁读规则」卡片（pattern 输入 + 紧凑 deny/ask 分段 + 删除/添加/保存/放弃）。
 * 动作刻意只有 deny / ask：官方默认本就允许读，allow 与默认行为无异，故不提供。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 * @param t - 该词典 namespace 的翻译函数（ctx.locale.bind(NS)）。
 */
export function makeNoReadCard(scope: any, t: Translate) {
  return function NoReadCard() {
    const [rules, setRules] = useState<any[]>([])
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      const update = () => {
        try {
          setRules(currentNoRead(scope))
        } catch {
          // a stale scope must never break the section render
        }
      }
      update()
      return scope.subscribe(update)
    }, [])

    const saved = currentNoRead(scope)
    const pendingCount = noReadDirty(rules, saved) ? 1 : 0

    const setRule = (index: number, patch: Partial<any>) => {
      setError(null)
      setRules((previous) => previous.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
    }

    const addRule = () => {
      setError(null)
      setRules((previous) => [...previous, { pattern: '', action: 'deny' }])
    }

    const removeRule = (index: number) => {
      setError(null)
      setRules((previous) => previous.filter((_, i) => i !== index))
    }

    const restoreSaved = () => {
      setRules(currentNoRead(scope))
      setError(null)
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
        await scope.set('noRead', cleanRules)
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = t('noread.count', { count: saved.length })
      + (pendingCount > 0 ? t('noread.countPending') : '')
    const noreadActionOpts = NOREAD_ACTIONS

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
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: t(NOREAD_HINT_KEY) }} />
          <div className="sabx-rules-table">
            {rules.length === 0 ? (
              <div className="sabx-empty">{t('noread.empty')}</div>
            ) : (
              rules.map((rule, index) => (
                <div key={index} className="sabx-rule-row sabx-noread-row">
                  <div className="sabx-rule-pattern">
                    <input
                      className="sabx-input sabx-mono"
                      type="text"
                      spellCheck={false}
                      placeholder={t('noread.patternPlaceholder')}
                      aria-label={t('noread.patternAria')}
                      value={rule.pattern}
                      disabled={saving}
                      onChange={(event) => setRule(index, { pattern: event.target.value })}
                    />
                  </div>
                  <div className="sabx-rule-action">
                    <Seg options={noreadActionOpts} selected={rule.action} onSelect={(value) => setRule(index, { action: value })} ariaLabel={t('cmds.actionAria')} compact />
                  </div>
                  <button
                    className="sabx-icon-btn sabx-rule-remove"
                    type="button"
                    aria-label={t('cmds.removeAria')}
                    title={t('cmds.removeTitle')}
                    disabled={saving}
                    onClick={() => removeRule(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving} onClick={addRule}>
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
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? t('common.saving') : t('noread.save')}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「沙箱授权」分节组件（闭包式，直接订阅 scope）。
 * 包含「授权目录」「命令规则」「禁读规则」三张可折叠卡片，视觉对齐
 * docs/config-ui-prototype.html v5。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeAllowlistSection(scope: any, t: Translate) {
  const DirsCard = makeDirsCard(scope, t)
  const CommandsCard = makeCommandsCard(scope, t)
  const NoReadCard = makeNoReadCard(scope, t)
  return function AllowlistSection() {
    return (
      <section className="sabx-section" aria-labelledby="sabx-section-title">
        <h2 className="sabx-section-heading" id="sabx-section-title">{t('section.title')}</h2>
        <p className="sabx-section-intro">
          {t('section.intro')}
        </p>
        <DirsCard />
        <CommandsCard />
        <NoReadCard />
      </section>
    )
  }
}

/**
 * 未绑定设置 scope 时的降级控制器：分节照常渲染（空列表 + 不可保存），
 * 一旦真实 scope 经动态注入到位并调用 bindScope，订阅者会被通知重新取值。
 * 这样 0.1.7（无 settingsScope）与更早宿主（有 settingsScope）都能注册分节。
 */
function makeDetachedScope() {
  const listeners = new Set<() => void>()
  let bound: any = null
  return {
    getSnapshot: () => (bound ? bound.getSnapshot() : { value: {} }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      const off = bound && typeof bound.subscribe === 'function' ? bound.subscribe(listener) : undefined
      return () => {
        listeners.delete(listener)
        if (typeof off === 'function') off()
      }
    },
    set: (field: string, value: any) =>
      bound && typeof bound.set === 'function'
        ? bound.set(field, value)
        : Promise.reject(new Error('settings scope unavailable')),
    /** 绑定真实 scope 并通知所有订阅者重新渲染。 */
    bindScope(next: any) {
      bound = next
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // a broken subscriber must never break the section
        }
      }
    },
  }
}

/** 从 Host 已服务的 namespace 集合里解析本插件的 namespace。 */
function resolveServedNamespace(served: Iterable<string>) {
  const names = [...served]
  for (const candidate of SETTINGS_NAMESPACE_CANDIDATES) {
    if (names.includes(candidate)) return candidate
  }
  // 兜底：row id 由补丁层合成，任何带包名的 namespace 都认。
  return names.find((name) => typeof name === 'string' && name.includes('sandbox-allowlist'))
}

/**
 * 把 Host 的表单控制器接上分节的 scope 契约（getSnapshot/subscribe/set）。
 * 读取与订阅直接透传；写入把「Host 拒绝」(false) 升级为异常——否则界面会
 * 显示保存成功，而设置实际上没有落盘。
 */
function makeConfigFormScope(form: any) {
  return {
    getSnapshot: () => form.getSnapshot(),
    subscribe: (listener: () => void) => form.subscribe(listener),
    set: async (field: string, value: any) => {
      const accepted = await form.set(field, value)
      if (accepted === false) throw new Error('the host rejected the settings write')
      return accepted
    },
  }
}

/**
 * 客户端插件入口：注册设置页分节并绑定设置 namespace。
 * 注册写法与官方设置分节一致（ctx.slots.inject + register）。
 *
 * 两代设置源都**不写进静态 inject**（见文件头的 inject 说明），都走动态
 * ctx.inject —— 服务缺失时回调不执行，分节仍以空列表注册：
 *   - 0.1.7 起：`configForms`，按 Row id 取该 entry 的表单控制器，并用
 *     `whileServed` 只在 Host 真的服务该 namespace 时绑定；
 *   - 0.1.7 之前：`settingsScope.bind({ namespace })`。
 */
export function apply(ctx: any) {
  // 词典注册先于分节注册：宿主按当前语言渲染，回退链末端永远是 en。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sandbox-allowlist: dictionaries')
  // 每个 namespace 一个稳定翻译函数；渲染时读取宿主当前语言。
  const t: Translate = ctx.locale.bind(NS)
  const scope = makeDetachedScope()
  const section = makeAllowlistSection(scope, t)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sandbox-allowlist',
    order: 30,
    label: () => t('section.title'),
  }, section))
  // 同一时刻只有一个设置源绑定：先到者胜，卸载时只清自己那一次。
  let boundBy: string | null = null
  const bindScope = (source: string, next: any) => {
    if (boundBy !== null) return boundBy === source
    boundBy = source
    scope.bindScope(next)
    return true
  }
  const releaseScope = (source: string) => {
    if (boundBy !== source) return
    boundBy = null
    scope.bindScope(null)
  }
  // 0.1.7 起：设置由「插件 Row 自身的 Config schema」派生。
  ctx.inject(['configForms'], (formsCtx: any) => {
    const forms = typeof formsCtx.get === 'function' ? formsCtx.get('configForms') : formsCtx.configForms
    if (forms === undefined || forms === null || typeof forms.whileServed !== 'function') return
    const off = forms.whileServed(SETTINGS_NAMESPACE_CANDIDATES, (served: Set<string>) => {
      const namespace = resolveServedNamespace(served)
      if (namespace === undefined) return undefined
      const form = forms.get(namespace)
      if (form === undefined || form === null || typeof form.set !== 'function') return undefined
      bindScope('configForms', makeConfigFormScope(form))
      return () => {
        releaseScope('configForms')
        if (typeof form.dispose === 'function') form.dispose()
      }
    })
    return typeof off === 'function' ? off : undefined
  })
  // 0.1.7 之前：设置服务的旧名字。
  ctx.inject(['settingsScope'], (scopeCtx: any) => {
    const service = typeof scopeCtx.get === 'function' ? scopeCtx.get('settingsScope') : scopeCtx.settingsScope
    if (service === undefined || service === null || typeof service.bind !== 'function') return
    if (!bindScope('settingsScope', service.bind({ namespace: SETTINGS_NAMESPACE }))) return
    return () => releaseScope('settingsScope')
  })
}