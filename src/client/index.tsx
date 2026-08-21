/**
 * 设置页「沙箱授权」分节 —— 客户端插件 TS 源码（v5，对齐
 * docs/config-ui-prototype.html v5）。
 *
 * 这是 lib/client.js（运行时实际加载的手写 __ModuleLoader__ bundle）的
 * 等价 TS 源码参考：在 dsh 开发工具链（tsc + tsdown）下重建时使用本文件，
 * 产物覆盖 lib/client.js。两处必须保持一致。
 *
 * 重构要点（与原型一致）：
 *   - 分节 = 标题 + 导语 + 两个可折叠配置卡片（授权目录 / 命令规则）；
 *   - 卡片收起态主体真正隐藏，头部计数与「未保存修改」徽章保留；
 *   - 授权目录：结构化目录行，新增行 = 绿色「＋」圆形徽章；焦点只高亮输入框
 *     （行边框不高亮）；非法条目标红输入框；
 *   - 命令规则：默认动作分段选择（选中项 = 语义色浅底 + 语义色文字 + 粗体 +
 *     内描边）；规则行 = 自绘工具下拉 + 命令模式输入 + 紧凑 allow/ask/deny
 *     分段 + 小 ✕ 图标按钮；
 *   - 工具下拉为自绘组件（原生 <select> 展开态无法定制样式）；选项仅
 *     bash / pwsh / 任意（dsh 只有这两个 shell 工具，其它值会被服务端校验拒绝）；
 *   - 样式由 lib/client.js 注入作用域化 <style>（.sabx-* 前缀），全部使用
 *     dsw 运行时令牌（--dsw-alias-* / --dsw-specific-*，带十六进制 fallback）。
 *
 * 数据流不变：绑定 `sandbox-allowlist` 设置 namespace → 表单编辑 →
 * scope.set('allowedDirs', [...]) / scope.set('commands', {...}) →
 * 写入用户设置文档（$DSH_HOME/settings.yaml）→ 服务端策略**实时生效**。
 *
 * 注意：组件定义在 apply 闭包内、直接订阅绑定的 scope —— 不依赖 slots
 * 系统向组件注入 props 的转换契约，任何情况下都不会因 props 缺失而崩溃。
 */

import { useEffect, useRef, useState } from 'react'

// 客户端依赖注入声明（服务名，与 lib/client.js 的 exports.inject 一致）。
export const inject = ['slots', 'connection', 'settingsScope']

export const SETTINGS_NAMESPACE = 'sandbox-allowlist'

/** 卡片 A 里的克制式安全警示 callout（承载粗体「无审批」）。 */
export const CALL_WARN_DIRS =
  '安全警示：授权目录会被沙箱内的 AI 代理<b>无审批</b>写入（工作区之外）。这放宽了沙箱边界——' +
  '只添加完全信任、已存在且归当前用户所有的目录，别把非受信位置加进来。'

export const DIRS_HINT =
  '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。' +
  '只添加完全信任、已存在且归当前用户所有的目录。'

export const DIRS_VALIDATE_HINT = '校验规则：Windows 路径或通配符；非法条目会在保存前标红提示，不会静默丢弃。'

export const COMMANDS_DEFAULT_HINT =
  'delegate 表示维持 dsh 现有行为（按需询问）；allow / ask / deny 会覆盖未命中命令的处理。'

export const COMMANDS_HINT =
  'pattern 支持 <code>*</code>（任意多个字符）与 <code>?</code>（单个字符）；' +
  '<code>git *</code> 忽略 <code>git</code> 后任意参数。allow=免询问（仍受文件沙箱约束）、ask=弹审批、deny=拦截。'

export const COMMANDS_TAIL_HINT = '空 pattern 的行不会保存；工具留空（任意）时规则对所有 shell 工具生效。'

/** 工具选项（空 = 任意工具；方案 A：标签与值一致）。 */
export const TOOL_OPTIONS = [
  { value: '', label: '任意' },
  { value: 'bash', label: 'bash' },
  { value: 'pwsh', label: 'pwsh' },
]

/** 规则动作（分段选择器，带语义色圆点类）。 */
export const ACTION_OPTIONS = [
  { value: 'allow', dot: 'sabx-dot-allow' },
  { value: 'ask', dot: 'sabx-dot-ask' },
  { value: 'deny', dot: 'sabx-dot-deny' },
]

/** 未命中规则时的默认动作（delegate 无圆点）。 */
export const DEFAULT_OPTIONS = [
  { value: 'delegate', dot: null },
  ...ACTION_OPTIONS,
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

/** 从设置 scope 快照读取当前命令规则（{ default, rules }）。 */
export function currentCommands(scope: any): { default: string; rules: any[] } {
  let snapshot
  try {
    snapshot = scope.getSnapshot()
  } catch {
    return { default: 'delegate', rules: [] }
  }
  const value = snapshot && snapshot.value
  const commands = value && value.commands
  const defaultValue = commands && commands.default !== undefined ? commands.default : 'delegate'
  const rules = Array.isArray(commands && commands.rules)
    ? commands.rules.map((rule: any) => ({
        tool: rule && rule.tool ? rule.tool : '',
        pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
        action: rule && rule.action ? rule.action : 'ask',
      }))
    : []
  return { default: defaultValue, rules }
}

/** 返回非法原因，null 表示通过（浏览器侧轻量镜像 lib/patterns.mjs 的拒绝规则）。 */
export function validateDirPattern(raw: string): string | null {
  if (typeof raw !== 'string') return '目录必须是字符串。'
  const value = raw.trim()
  if (value.length === 0) return '目录不能为空。'
  const isAbsolute = /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]/u.test(value)
  if (!isAbsolute) return `「${value}」不是绝对路径（需要盘符或根开始的路径）。`
  if (value.includes('**')) {
    let staticLevels = 0
    const segments = value.split(/[\\/]/u).filter((s) => s.length > 0)
    for (const segment of segments) {
      if (/[*?]/u.test(segment)) break
      staticLevels += 1
    }
    if (staticLevels <= 1) return `「${value}」锚定过宽（** 需要锚定至少一级具名目录）。`
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
  options: { value: string; dot?: string | null }[]
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
          className={['sabx-seg-item', option.value !== 'delegate' ? `is-${option.value}` : ''].join(' ')}
          data-active={option.value === props.selected ? 'true' : 'false'}
          aria-label={props.ariaLabel ? `${props.ariaLabel}：${option.value}` : undefined}
          onClick={() => props.onSelect(option.value)}
        >
          {option.dot ? <span className={`sabx-dot ${option.dot}`} aria-hidden="true" /> : null}
          {option.value}
        </button>
      ))}
    </div>
  )
}

/** 工具自绘下拉（原生 select 展开态无法定制，故自绘菜单；展开/选中完全可控）。 */
export function ToolPicker(props: { value: string; disabled?: boolean; onSelect: (value: string) => void }) {
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
  const label = value || '任意'
  const optionNodes = TOOL_OPTIONS.map((option) => {
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
        <span className="sabx-pending">未保存修改</span>
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
export function makeDirsCard(scope: any) {
  return function DirsCard() {
    const [rows, setRows] = useState<{ value: string }[]>([])
    const [open, setOpen] = useState(true)
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
        if (issue !== null) problems.push({ index, message: issue })
        else values.push(value)
      })
      if (problems.length > 0) {
        const flags: Record<number, boolean> = {}
        problems.forEach((p) => { flags[p.index] = true })
        setInvalid(flags)
        setError(`校验失败：${problems[0].message}${problems.length > 1 ? `（另有 ${problems.length - 1} 处）` : ''}`)
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

    const countText = `${saved.length} 个目录${pendingCount > 0 ? ` · ${pendingCount} 处未保存` : ''}`

    return (
      <Card
        id="sabx-card-dirs"
        name="授权目录"
        count={countText}
        desc="允许沙箱内代理直接写入的工作区外目录；仍受文件沙箱约束，写入无需审批。"
        pendingCount={pendingCount}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <div className="sabx-callout-warn" role="note">
          <span className="sabx-dot sabx-dot-warn" />
          <span dangerouslySetInnerHTML={{ __html: CALL_WARN_DIRS }} />
        </div>
        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">工作区外的受信可写目录</span>
            <button className="sabx-field-reset" type="button" disabled={saving} onClick={restoreSaved}>
              重置为默认
            </button>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: DIRS_HINT }} />
          <div className="sabx-dir-list">
            {rows.length === 0 ? (
              <div className="sabx-empty">尚未授权任何目录。点击「添加目录」新增一行。</div>
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
                    aria-label={`授权目录 ${index + 1}`}
                    placeholder="D:\Shared\Tools"
                    onChange={(event) => setRow(index, event.target.value)}
                  />
                  <button
                    className="sabx-icon-btn"
                    type="button"
                    aria-label="删除"
                    title="删除该目录"
                    onClick={() => removeRow(index)}
                  >
                    <XIcon />
                  </button>
                </div>
              ))
            )}
          </div>
          <button className="sabx-add-row" type="button" disabled={saving} onClick={addRow}>
            <span aria-hidden="true">＋</span> 添加目录
          </button>
          <p className="sabx-dir-hint-inline">{DIRS_VALIDATE_HINT}</p>
        </div>
        <div className="sabx-card-footer">
          {error !== null ? (
            <p className="sabx-card-error" role="alert">{error}</p>
          ) : null}
          <button className="sabx-btn sabx-btn-ghost" type="button" disabled={saving || pendingCount === 0} onClick={restoreSaved}>
            放弃修改
          </button>
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存目录'}
          </button>
        </div>
      </Card>
    )
  }
}

/**
 * 构建「命令规则」卡片（默认动作分段 + 自绘工具下拉规则表 + 添加/删除/保存/放弃）。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeCommandsCard(scope: any) {
  return function CommandsCard() {
    const [rules, setRules] = useState<any[]>([])
    const [defaultAction, setDefaultAction] = useState('delegate')
    const [open, setOpen] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
      const update = () => {
        try {
          const cmds = currentCommands(scope)
          setRules(cmds.rules)
          setDefaultAction(cmds.default)
        } catch {
          // a stale scope must never break the section render
        }
      }
      update()
      return scope.subscribe(update)
    }, [])

    const saved = currentCommands(scope)
    const isDirty = defaultAction !== (saved.default || 'delegate') || rulesDirty(rules, saved.rules)
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
      setError(null)
    }

    const resetDefault = () => {
      setError(null)
      setDefaultAction(saved.default || 'delegate')
    }

    const save = async () => {
      setError(null)
      // 空 pattern 的行不保存；tool 为空时不写 tool 字段（= 任意工具）。
      const cleanRules = rules
        .filter((rule) => rule && rule.pattern && String(rule.pattern).trim().length > 0)
        .map((rule) => {
          const clean: { pattern: string; action: string; tool?: string } = {
            pattern: String(rule.pattern).trim(),
            action: rule.action || 'ask',
          }
          if (rule.tool) clean.tool = rule.tool
          return clean
        })
      try {
        setSaving(true)
        await scope.set('commands', { default: defaultAction, rules: cleanRules })
        restoreSaved()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    const countText = `${saved.rules.length} 条规则${pendingCount > 0 ? ' · 未保存修改' : ''}`

    return (
      <Card
        id="sabx-card-cmds"
        name="命令规则"
        count={countText}
        desc="按「命令模式 + 动作」放行 / 询问 / 拦截 shell 命令。"
        pendingCount={pendingCount}
        open={open}
        onToggle={() => setOpen(!open)}
      >
        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">未命中任何规则时的默认动作</span>
            <button className="sabx-field-reset" type="button" disabled={saving} onClick={resetDefault}>
              重置为默认
            </button>
          </div>
          <p className="sabx-field-hint">{COMMANDS_DEFAULT_HINT}</p>
          <Seg options={DEFAULT_OPTIONS} selected={defaultAction} onSelect={setDefaultAction} ariaLabel="未命中规则时的默认动作" />
        </div>

        <div className="sabx-field">
          <div className="sabx-field-head">
            <span className="sabx-field-label">放行规则（按顺序匹配，最后一条命中生效）</span>
          </div>
          <p className="sabx-field-hint" dangerouslySetInnerHTML={{ __html: COMMANDS_HINT }} />
          <div className="sabx-rules-table">
            {rules.length === 0 ? (
              <div className="sabx-empty">尚无命令规则。点击「添加规则」新增一行。</div>
            ) : (
              rules.map((rule, index) => (
                <div key={index} className="sabx-rule-row">
                  <div className="sabx-rule-tool">
                    <ToolPicker value={rule.tool} disabled={saving} onSelect={(value) => setRule(index, { tool: value })} />
                  </div>
                  <div className="sabx-rule-pattern">
                    <input
                      className="sabx-input sabx-mono"
                      type="text"
                      spellCheck={false}
                      placeholder="git *"
                      aria-label="命令模式"
                      value={rule.pattern}
                      disabled={saving}
                      onChange={(event) => setRule(index, { pattern: event.target.value })}
                    />
                  </div>
                  <div className="sabx-rule-action">
                    <Seg options={ACTION_OPTIONS} selected={rule.action} onSelect={(value) => setRule(index, { action: value })} ariaLabel="动作" compact />
                  </div>
                  <button
                    className="sabx-icon-btn sabx-rule-remove"
                    type="button"
                    aria-label="删除规则"
                    title="删除该规则"
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
            <span aria-hidden="true">＋</span> 添加规则
          </button>
          <p className="sabx-dir-hint-inline" style={{ marginTop: 4 }}>{COMMANDS_TAIL_HINT}</p>
        </div>

        <div className="sabx-card-footer">
          {error !== null ? (
            <p className="sabx-card-error" role="alert">{error}</p>
          ) : null}
          <button className="sabx-btn sabx-btn-ghost" type="button" disabled={saving || pendingCount === 0} onClick={restoreSaved}>
            放弃修改
          </button>
          <button className="sabx-btn sabx-btn-primary" type="button" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存命令规则'}
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
export function makeCommandRulesEditor(scope: any) {
  return makeCommandsCard(scope)
}

/**
 * 构建「沙箱授权」分节组件（闭包式，直接订阅 scope）。
 * 包含「授权目录」与「命令规则」两张可折叠卡片，视觉对齐
 * docs/config-ui-prototype.html v5。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeAllowlistSection(scope: any) {
  const DirsCard = makeDirsCard(scope)
  const CommandsCard = makeCommandsCard(scope)
  return function AllowlistSection() {
    return (
      <section className="sabx-section" aria-labelledby="sabx-section-title">
        <h2 className="sabx-section-heading" id="sabx-section-title">沙箱授权</h2>
        <p className="sabx-section-intro">
          配置哪些目录与命令可在工作区之外被沙箱内的 AI 代理放行。页面所作修改在
          <b>保存</b>后立即生效（设置文档热加载），无需重启 dsh。
        </p>
        <DirsCard />
        <CommandsCard />
        <p className="sabx-prose-sm">
          提示：撤销授权后，已物化到目录 DACL 的 ACE 不会被自动移除（Windows）；如需清理请用
          <span className="sabx-kbd">scripts/revoke.mjs</span>。注意不要在本分节内使用
          <span className="sabx-kbd">pnpm install</span>全局重装 web profile（github git+ssh 依赖会失败）。
        </p>
      </section>
    )
  }
}

/**
 * 客户端插件入口：注册设置页分节并绑定设置 namespace。
 * 注册写法与官方设置分节一致（ctx.slots.inject + register）。
 */
export function apply(ctx: any) {
  let scope
  try {
    scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
  } catch {
    // bind 失败（如设置服务缺失）不能阻止分节注册 —— 组件退化为空列表编辑。
    scope = {
      getSnapshot: () => ({ value: {} }),
      subscribe: () => () => {},
      set: () => Promise.reject(new Error('settings scope unavailable')),
    }
  }
  const section = makeAllowlistSection(scope)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'sandbox-allowlist',
    order: 30,
    label: () => '沙箱授权',
  }, section))
}