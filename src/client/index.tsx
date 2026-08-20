/**
 * 设置页「沙箱授权目录」分节 —— 客户端插件 TS 源码。
 *
 * 这是 lib/client.js（运行时实际加载的手写 __ModuleLoader__ bundle）的
 * 等价 TS 源码参考：在 dsh 开发工具链（tsc + tsdown）下重建时使用本文件，
 * 产物覆盖 lib/client.js。两处必须保持一致。
 *
 * 数据流：绑定 `sandbox-allowlist` 设置 namespace（服务端由 lib/policy.mjs
 * 通过 ctx.settings 注册）→ 表单编辑 → scope.set('allowedDirs', [...]) →
 * 写入用户设置文档（$DSH_HOME/settings.yaml）→ 服务端策略**实时生效，
 * 无需重启**（settings.yaml 热加载 + 策略 watch 失效缓存 + 惰性 ACE 物化）。
 *
 * 注意：组件定义在 apply 闭包内、直接订阅绑定的 scope —— 不依赖 slots
 * 系统向组件注入 props 的转换契约，任何情况下都不会因 props 缺失而崩溃。
 */

import { useEffect, useState } from 'react'

// 客户端依赖注入声明（服务名，与 lib/client.js 的 exports.inject 一致）。
export const inject = ['slots', 'connection', 'settingsScope']

export const SETTINGS_NAMESPACE = 'sandbox-allowlist'

export const WARNING = [
  '⚠️ 安全警示：以下目录是「沙箱授权目录」——沙箱内的 AI 代理被授权在这些目录（工作区之外）执行修改操作，无需审批。',
  '请只添加你完全信任的目录；目录必须已存在且归当前用户所有。',
  '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。',
  '撤销授权请删除对应条目（Windows 上旧目录的 ACE 用 scripts/revoke.mjs 清理）。',
].join(' ')

/** 从设置 scope 快照读取当前授权目录列表。 */
export function currentDirs(scope) {
  let snapshot
  try {
    snapshot = scope.getSnapshot()
  } catch {
    return []
  }
  const value = snapshot && snapshot.value
  return Array.isArray(value && value.allowedDirs) ? value.allowedDirs : []
}

/**
 * 构建「沙箱授权目录」分节组件（闭包式，直接订阅 scope）。
 * @param scope - ctx.settingsScope.bind 返回的 controller。
 */
export function makeAllowlistSection(scope) {
  return function AllowlistSection() {
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState(null)

    useEffect(() => {
      const update = () => {
        try {
          setDraft(currentDirs(scope).join('\n'))
        } catch {
          // a stale scope must never break the section render
        }
      }
      update()
      return scope.subscribe(update)
    }, [])

    const parseDraft = () => draft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    const save = async () => {
      setSaving(true)
      setError(null)
      try {
        await scope.set('allowedDirs', parseDraft())
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setSaving(false)
      }
    }

    return (
      <section style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
        <h2 style={{ margin: 0 }}>沙箱授权目录</h2>
        <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary, #c0392b)', lineHeight: 1.6, margin: 0 }}>
          {WARNING}
        </p>
        <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, lineHeight: 1.6 }}>
          当前授权 {currentDirs(scope).length} 个目录（每行一个，可编辑后保存；保存即生效，无需重启 dsh）。
        </p>
        <textarea
          aria-label="沙箱授权目录列表（每行一个）"
          rows={8}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 8, boxSizing: 'border-box' }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={'D:\\Shared\\Tools\nD:\\Shared\\**\nD:\\Data\\logs\\*'}
        />
        {error !== null && (
          <p role="alert" style={{ color: 'var(--dsw-alias-state-error-primary, #c0392b)', margin: 0 }}>
            保存失败：{error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => { setDraft(''); setError(null) }}
          >
            清空
          </button>
        </div>
      </section>
    )
  }
}

/**
 * 客户端插件入口：注册设置页分节并绑定设置 namespace。
 * 注册写法与官方设置分节一致（ctx.slots.inject + register）。
 */
export function apply(ctx) {
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
    label: () => '沙箱授权目录',
  }, section))
}
