/**
 * Verification that the hand-written lib/client.js bundle still loads and its
 * settings.section renders the full 沙箱授权 section (授权目录 / 命令规则 /
 * 禁读规则 cards):
 *   - stub `window.__ModuleLoader__.load` and `require('react')` with a
 *     lightweight element-tree createElement + hooks,
 *   - run the factory, assert `inject` and `apply` are intact,
 *   - call `apply` with a stubbed ctx (slots + configForms), register the
 *     slot, then RENDER the registered component recursively and assert the
 *     three card articles (incl. the noRead card) appear with their copy.
 *
 * Run from the package root:
 *   node test/verify-client-editor.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let captured = null
// Minimal hooks runtime: state lives per component type, effects run
// immediately, and the tree is rendered twice so a card that seeds its state
// from the settings scope actually shows its rows on the second pass (without
// it the rule editor renders empty and the assertions below would be vacuous).
const hooksByType = new Map()
let currentHooks = null
const reactStub = {
  useState: (init) => {
    const slot = currentHooks.cursor
    const hooks = currentHooks // setter 绑定创建时的组件槽位：异步续体（fetch
    // 往返之后）里 setState 也必须落回原组件——与真实 React 语义一致。
    currentHooks.cursor += 1
    if (hooks.hooks.length <= slot) hooks.hooks[slot] = typeof init === 'function' ? init() : init
    const set = (value) => {
      hooks.hooks[slot] = typeof value === 'function' ? value(hooks.hooks[slot]) : value
    }
    return [hooks.hooks[slot], set]
  },
  useRef: (init) => {
    const slot = currentHooks.cursor
    currentHooks.cursor += 1
    if (currentHooks.hooks.length <= slot) currentHooks.hooks[slot] = { current: init }
    return currentHooks.hooks[slot]
  },
  useEffect: (fn) => {
    const slot = currentHooks.cursor
    currentHooks.cursor += 1
    if (currentHooks.hooks.length <= slot) currentHooks.hooks[slot] = true
    const result = fn()
    if (typeof result === 'function') result()
  },
  // Element-tree stub: createElement(type, props, ...children).
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
}
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const fakeRequire = (id) => {
        if (id === 'react') return reactStub
        throw new Error(`unexpected require: ${id}`)
      }
      captured = spec.factory(fakeRequire)
      return captured
    },
  },
}

new Function(source)() // eslint-disable-line no-new-func

assert.ok(captured, 'exports captured')
// 会话入口探测桩：模拟 win32 宿主（状态路由可达）。Node 22 自带全局 fetch，
// 不打桩探测会真的请求相对路径并失败 ⇒ 入口不注册 ⇒ 断言落空。
// 数据通道为自建路由 + 统一信封（POST /sandbox-allowlist/api/*，dsh-jenkins
// 实证路径）——探测收 { ok: true, value } 信封即认为宿主在位。
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { supported: true, current: '', workspaces: {} } }) })
// 注册现在先探测后挂槽（异步）：每个 apply 之后 flush 一次事件循环再收注册。
const flushRegistration = () => new Promise((resolve) => setTimeout(resolve, 20))
// The static inject list may only name services the host always provides:
// `locale` (dsh-client-locale) carries the dictionaries and `configForms` is
// the 0.2.0 settings source. The authorization panel's data channel is the
// plugin's own host route (same-origin POST), deliberately NOT connection —
// the self-built envelope path is the dsh-jenkins-proven contract and keeps
// the inject face minimal.
assert.deepEqual(captured.inject, ['slots', 'configForms', 'locale'], 'inject list intact')
assert.equal(typeof captured.apply, 'function', 'apply exported')

// Call apply() with a stubbed cordis ctx (slots + configForms) like the real
// client runtime does. Must register the settings.section slot without throwing.
//
// dsh 0.2.0 contract: `ctx.configForms.get(<loader entry id>)` returns a form
// controller whose snapshot carries { status, value, user, revision, writable,
// mode }. We hand the component a ready/host/writable form so every card is
// interactive (the read-only path is exercised by the unavailable-form case
// asserted further down).
const registered = []
const injected = []
const formValue = {
  allowedDirs: [],
  commands: {
    default: 'delegate',
    escalation: 'capability',
    baseline: true,
    // Two pattern rules, so the rows (and their inputs) render.
    rules: [
      { pattern: 'git status*', action: 'allow' },
      { pattern: 'pnpm *', action: 'allow' },
    ],
  },
  noRead: [],
}
const formController = {
  getSnapshot: () => ({
    status: 'ready',
    value: formValue,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }),
  subscribe: () => () => {},
  set: async () => true,
  unset: async () => true,
}
// Locale stub: records the registered dictionaries and serves one active
// locale with the host's fallback chain (active locale, then `en`, then the
// key itself) — mirroring dsh-client-locale's contract.
const dictionaries = {}
let activeLocale = 'zh'
const locale = {
  register(ns, pair) {
    dictionaries[ns] = { ...(dictionaries[ns] || {}), ...pair }
    return () => {}
  },
  bind(ns) {
    return (key, params) => {
      const table = dictionaries[ns] || {}
      const template = table[activeLocale]?.[key] ?? table.en?.[key] ?? key
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }
  },
}
const effectStub = (fn) => {
  const dispose = fn()
  return typeof dispose === 'function' ? dispose : () => {}
}

const ctx = {
  configForms: { get: (id) => (id === 'sandbox-allowlist-policy' ? formController : null) },
  locale,
  effect: effectStub,
  slots: {
    inject(name, fn) { injected.push({ name, fn }) },
    register(spec, component) { registered.push({ spec, component }); return { spec, component } },
  },
}
captured.apply(ctx)
// Dictionaries must be registered during apply(), before the section is used.
const ns = dictionaries['sandbox-allowlist']
assert.ok(ns, 'locale namespace registered')
assert.ok(ns.zh && ns.en, 'both zh and en dictionaries registered')
const zhKeys = Object.keys(ns.zh)
assert.ok(zhKeys.length > 50, `dictionary covers the surface (${zhKeys.length} keys)`)
assert.deepEqual(
  zhKeys.filter((k) => !(k in ns.en)),
  [],
  'en covers every zh key',
)
assert.deepEqual(
  Object.keys(ns.en).filter((k) => !(k in ns.zh)),
  [],
  'zh covers every en key',
)
// The static fallback in the host is `en`; every key must resolve in English.
const unresolved = zhKeys.filter((k) => typeof ns.en[k] !== 'string' || ns.en[k].length === 0)
assert.deepEqual(unresolved, [], 'no English value is missing or empty')
const asEnglish = (key) => ns.en[key]
assert.notEqual(asEnglish('section.title'), 'section.title', 'keys resolve, not echoed')
assert.equal(
  asEnglish('validate.notAbsolute').includes('{value}'),
  true,
  'placeholder keys keep their placeholders',
)
// The real runtime invokes each inject callback to register its slot; apply()
// registers the settings section, the Plugins-page config/badge slots, and —
// once the state-route probe confirms a win32 host — the session utilities panel.
await flushRegistration()
injected.forEach(({ fn }) => fn())
assert.ok(registered.length === 6, 'six slots registered (settings.section + Plugins-page config/badge + session utilities panel)')
assert.equal(registered[0].spec.name, 'settings.section')
assert.equal(registered[0].spec.id, 'sandbox-allowlist')
assert.equal(registered[0].spec.label(), '沙箱授权')
assert.equal(typeof registered[0].component, 'function', 'section component is a function')

// 会话区授权状态面板槽位：id 前缀隔离、label 走词典、组件（未打开时）渲染
// 一个带 aria-label 的图标按钮——缺 connection 也一样渲染（点开才失败可见）。
const panelSlot = registered.find((r) => r.spec.name === 'conversation.session.header.utilities')
assert.ok(panelSlot, 'session utilities panel registered')
assert.equal(panelSlot.spec.id, 'sandbox-allowlist-panel', 'panel slot id is plugin-prefixed')
assert.equal(panelSlot.spec.label(), '授权状态', 'panel slot label resolves from the dictionary')
// 组件是 hooks 组件：必须作为「节点」交给 render()（它按类型挂 hooks 槽位后
// 再调用组件函数），直接调用会在 hooks 运行时之外执行 useState。
const panelRoot = render({ type: panelSlot.component, props: {} })
assert.ok(panelRoot && Array.isArray(panelRoot.children) && panelRoot.children.length >= 1, 'panel renders its root')
const panelButton = panelRoot.children.find((el) => el && el.type === 'button' && el.props && el.props['aria-label'] === '查看沙箱授权状态')
assert.ok(panelButton, 'the closed panel renders the icon button with its aria-label')

// ── 会话 cwd 线索（宿主契约 standardProps：sessionId + useSessions）──────────
// sessionId 是标识符不是路径，绝不能当作 sessionCwd 发送——host 会把它规范化
// 成无效路径，current 永远回落实例工作区根（真机事故根因：面板打不开会话
// 所在工作区）。cwd 必须经 useSessions 快照钩子读取（官方 open-in-app 同款）。
const SESSION_CWD = 'D:\\Demo\\Workspace'
const fetchCalls = []
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), body: options && typeof options.body === 'string' ? options.body : '' })
  return { ok: true, json: async () => ({ ok: true, value: { supported: true, current: '', workspaces: {} } }) }
}
// window.confirm 探针：确认交互必须留在 DOM 内（Electron 原生 confirm 关闭后
// 不恢复输入焦点，会话输入框会点不进去——electron#31917），任何路径都不得调用。
let nativeConfirmCalls = 0
globalThis.window.confirm = () => { nativeConfirmCalls += 1; return false }
const panelType = panelSlot.component
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
// ① 有 cwd 的会话：打开面板，state 请求体必须携带 sessionCwd=<会话 cwd>。
const sessionProps = (cwd) => ({
  sessionId: 'sess-demo',
  useSessions: (selector) => selector({ byId: { 'sess-demo': { cwd } } }),
})
const findButtonByAria = (node, aria) => {
  if (Array.isArray(node)) { for (const child of node) { const hit = findButtonByAria(child, aria); if (hit) return hit } return null }
  if (node === null || typeof node !== 'object') return null
  if (node.type === 'button' && node.props && node.props['aria-label'] === aria) return node
  return findButtonByAria(node.children || [], aria)
}
const findButtonByText = (node, text) => {
  if (Array.isArray(node)) { for (const child of node) { const hit = findButtonByText(child, text); if (hit) return hit } return null }
  if (node === null || typeof node !== 'object') return null
  if (node.type === 'button' && node.props && Array.isArray(node.children)
    && node.children.every((ch) => typeof ch === 'string') && node.children.includes(text)) return node
  return findButtonByText(node.children || [], text)
}
const findByClass = (node, cls) => {
  let hit = null
  const walk = (n) => {
    if (hit || n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes(cls)) { hit = n; return }
    walk(n.children || [])
  }
  walk(node)
  return hit
}
const hasTextIn = (nodes, text) => nodes.some((n) => n.text !== undefined && n.text.includes(text))
const cwdPanel = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const cwdIcon = cwdPanel.children.find((el) => el && el.type === 'button' && el.props && el.props['aria-label'] === '查看沙箱授权状态')
assert.ok(cwdIcon, 'panel with session props still renders the closed icon button')
cwdIcon.props.onClick()
await settle()
const stateCall = fetchCalls.find((call) => call.url.endsWith('/api/state'))
assert.ok(stateCall, 'opening the panel fetches the state view')
assert.deepEqual(JSON.parse(stateCall.body), { sessionCwd: SESSION_CWD }, 'state request carries the session cwd from useSessions')
// ② 无 cwd 的会话：请求体必须是空对象（而非 sessionId 冒充路径）。
fetchCalls.length = 0
const noCwdPanel = render({ type: panelType, props: sessionProps('') })
const refreshButton = findButtonByAria(noCwdPanel, '刷新授权状态')
assert.ok(refreshButton, 'the open panel offers its refresh button')
refreshButton.props.onClick()
await settle()
const bareCall = fetchCalls.find((call) => call.url.endsWith('/api/state'))
assert.ok(bareCall, 'refresh re-fetches the state view')
assert.deepEqual(JSON.parse(bareCall.body), {}, 'a session without cwd sends an empty body, never the session id')

// ③④⑤ 面板交互契约：撤销/恢复走 DOM 内确认弹层（绝不碰原生 confirm），
// 操作带最短展示的 busy 层，工作区只读跟随会话（未命中清单键 = 空选中 +
// 空态，绝不串显别键），失败原因列悬浮可见完整错误。
const grantView = {
  supported: true,
  current: SESSION_CWD,
  workspaces: {
    [SESSION_CWD]: {
      sid: 'S-1-5-DEMO', updatedAt: '2026-10-05T00:00:00.000Z',
      roots: [
        { path: 'D:\\Demo\\Out', status: 'granted', grantedAt: '2026-10-05T00:00:00.000Z', excluded: false, fromPatterns: ['D:\\Demo\\Out'] },
        { path: 'D:\\Demo\\Dead', status: 'failed', grantedAt: null, excluded: false, error: 'SetNamedSecurityInfoW failed (Win32 5)', errorAt: '2026-10-05T00:00:00.000Z', fromPatterns: ['D:\\Demo\\Dead'] },
      ],
      pendingRevoke: [],
      history: [{ path: 'D:\\Demo\\Gone', revokedAt: '2026-10-05T00:00:00.000Z', origin: 'excluded', fromPatterns: ['D:\\Demo\\Gone'] }],
    },
  },
}
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), body: options && typeof options.body === 'string' ? options.body : '' })
  return { ok: true, json: async () => ({ ok: true, value: grantView }) }
}
fetchCalls.length = 0
const dataPanel = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const dataRefresh = findButtonByAria(dataPanel, '刷新授权状态')
assert.ok(dataRefresh, 'the populated panel offers its refresh button')
dataRefresh.props.onClick()
await settle()
// 手动刷新与操作共用 busy 层：fetch 立即返回后仍至少展示 BUSY_MIN_MS。
const refreshBusyView = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.ok(hasTextIn(collect(refreshBusyView, []), '正在执行'), 'manual refresh shows the busy layer (min duration)')
const dataView = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const dataNodes = collect(dataView, [])
// 工作区控件 = 只读指示器：禁切换、显示会话工作区。
const wsTrigger = findByClass(dataView, 'sabx-panel-ws-trigger')
assert.ok(wsTrigger, 'the workspace picker renders')
assert.equal(wsTrigger.props.disabled, true, 'workspace switching is disabled (display-only picker)')
const wsValue = findByClass(dataView, 'sabx-panel-ws-value')
assert.deepEqual(wsValue.children, [SESSION_CWD], 'the picker displays the session workspace')
// 失败原因列悬浮可见完整信息（data-tip 承载未截断的 error 原文）。
const reasonTip = dataNodes.some((n) => n.element && n.element.type === 'td'
  && n.element.props && typeof n.element.props['data-tip'] === 'string'
  && n.element.props['data-tip'].includes('SetNamedSecurityInfoW'))
assert.ok(reasonTip, 'the failure reason cell exposes the full error via data-tip')
// 工作区容器的 data-tip（disabled 触发器的提示由容器承担）。
const pickerBox = findByClass(dataView, 'sabx-panel-ws-picker')
assert.ok(pickerBox && pickerBox.props['data-tip'] === SESSION_CWD, 'the workspace picker carries a data-tip on its container')
// 授权时间按本地时区渲染：存储保持 UTC ISO，展示用本地 getter 转换——旧实现
// 直接截取 UTC 串，北京时间的机器会显示慢 8 小时的时间。
const localTime = (iso) => {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
const timeCell = dataNodes.find((n) => n.element && n.element.type === 'td'
  && n.element.props && n.element.props.className === 'sabx-panel-time')
assert.ok(timeCell, 'the time cell renders')
assert.deepEqual(timeCell.element.children, [localTime('2026-10-05T00:00:00.000Z')], 'grantedAt renders in the local timezone, not the raw UTC string')
// ③ 撤销 → 确认弹层 → 确认后才发 revoke；全程零原生 confirm；busy 可感知。
const revokeButton = findButtonByAria(dataView, '撤销该目录的写授权')
assert.ok(revokeButton, 'the granted row offers the revoke action')
revokeButton.props.onClick()
const confirmView = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const confirmNodes = collect(confirmView, [])
assert.ok(findByClass(confirmView, 'sabx-confirm-overlay'), 'the revoke confirm opens as a layer, not in-place buttons')
assert.ok(hasTextIn(confirmNodes, '撤销授权'), 'the revoke confirm layer opens with its title')
assert.ok(hasTextIn(confirmNodes, '对应的磁盘访问授权将被回收'), 'the revoke confirm layer spells out the consequence')
assert.ok(hasTextIn(confirmNodes, '取消'), 'the confirm layer offers a cancel action')
assert.equal(nativeConfirmCalls, 0, 'entering the revoke confirm never calls the native confirm')
const confirmOk = findButtonByText(confirmView, '确认')
assert.ok(confirmOk, 'the confirm layer offers the confirm action')
fetchCalls.length = 0
confirmOk.props.onClick()
await settle()
const revokeCall = fetchCalls.find((call) => call.url.endsWith('/api/revoke'))
assert.ok(revokeCall, 'confirming issues the revoke request')
assert.deepEqual(JSON.parse(revokeCall.body), { path: 'D:\\Demo\\Out', workspace: SESSION_CWD }, 'the revoke targets the viewed workspace slice')
assert.equal(nativeConfirmCalls, 0, 'the whole revoke flow never calls the native confirm')
const busyView = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.ok(hasTextIn(collect(busyView, []), '正在执行'), 'the busy layer stays visible after the fetch settles (min duration)')
// ④ 恢复同样走确认弹层，确认后才发 restore。
await new Promise((resolve) => setTimeout(resolve, 800)) // let the busy min-window elapse
const restoredView = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const restoreButton = findButtonByAria(restoredView, '恢复该目录的写授权')
assert.ok(restoreButton, 'the revoked row offers the restore action')
restoreButton.props.onClick()
const restoreConfirm = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.ok(hasTextIn(collect(restoreConfirm, []), '恢复授权'), 'the restore confirm layer opens with its title')
const restoreOk = findButtonByText(restoreConfirm, '确认')
assert.ok(restoreOk, 'the restore confirm layer offers the confirm action')
fetchCalls.length = 0
restoreOk.props.onClick()
await settle()
const restoreCall = fetchCalls.find((call) => call.url.endsWith('/api/restore'))
assert.ok(restoreCall, 'confirming issues the restore request')
assert.deepEqual(JSON.parse(restoreCall.body), { path: 'D:\\Demo\\Gone', workspace: SESSION_CWD }, 'the restore targets the viewed workspace slice')
// ⑤ 会话 cwd 未命中任何清单键：选中空 + 空态，绝不默认展示别的工作区。
const foreignView = {
  supported: true,
  current: 'D:\\Other\\Workspace',
  workspaces: {
    'D:\\Other\\Workspace': {
      sid: null, updatedAt: null,
      roots: [{ path: 'D:\\Other\\Stale', status: 'granted', grantedAt: '2026-10-05T00:00:00.000Z', excluded: false, fromPatterns: [] }],
      pendingRevoke: [], history: [],
    },
  },
}
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url: String(url), body: options && typeof options.body === 'string' ? options.body : '' })
  return { ok: true, json: async () => ({ ok: true, value: foreignView }) }
}
fetchCalls.length = 0
const foreignPanel = render({ type: panelType, props: sessionProps('D:\\Demo\\B') })
const foreignRefresh = findButtonByAria(foreignPanel, '刷新授权状态')
assert.ok(foreignRefresh, 'the foreign-cwd panel offers its refresh button')
foreignRefresh.props.onClick()
await settle()
const foreignView2 = render({ type: panelType, props: sessionProps('D:\\Demo\\B') })
const foreignNodes = collect(foreignView2, [])
assert.ok(hasTextIn(foreignNodes, '当前工作区暂无授权记录'), 'an unmatched session cwd shows the empty state')
assert.ok(!hasTextIn(foreignNodes, 'D:\\Other\\Stale'), 'no foreign workspace rows leak into the panel')
assert.equal(findButtonByAria(foreignView2, '撤销该目录的写授权'), null, 'no actions are offered without rows')
const foreignTrigger = findByClass(foreignView2, 'sabx-panel-ws-trigger')
assert.equal(foreignTrigger.props.disabled, true, 'the picker stays disabled on the empty selection')
const foreignValue = findByClass(foreignView2, 'sabx-panel-ws-value')
assert.deepEqual(foreignValue.children, ['D:\\Demo\\B'], 'the empty panel still shows which workspace it is looking at')

// ── L4-01…L4-05: 坏数据渲染矩阵 / 空错态 / 确认弹层流 / 状态过滤器 / 选中语义 ──
// 两条节奏坑（用例规格 §4）：busy 最短展示 BUSY_MIN_MS=700ms（断言前等 800ms）、
// hooks 状态跨阶段残留（换 stub 后必须「渲染 + 刷新」重新 load 才吃到新数据）。
const waitBusy = () => new Promise((resolve) => setTimeout(resolve, 800))
const textOf = (node) => collect(node, []).filter((n) => n.text !== undefined).map((n) => n.text).join('')
const findRowByPath = (rootNode, pathText) => {
  let hit = null
  const walk = (n) => {
    if (hit || n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'tr' && Array.isArray(n.children) && n.children.length > 0) {
      const first = n.children[0]
      if (first && first.type === 'td' && textOf(first) === pathText) { hit = n; return }
    }
    walk(n.children || [])
  }
  walk(rootNode)
  return hit
}
const cellPathsOf = (rootNode) => {
  const paths = []
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'td' && String(n.props.className || '').includes('sabx-panel-cellpath')) paths.push(textOf(n))
    walk(n.children || [])
  }
  walk(rootNode)
  return paths
}
const stubView = (view) => {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), body: options && typeof options.body === 'string' ? options.body : '' })
    return { ok: true, json: async () => ({ ok: true, value: view }) }
  }
}

// L4-01: 坏数据渲染矩阵——五类行 × 各列契约（时间「—」/失败点/原因原文/
// 待回收无操作/已撤销可恢复/已授权可撤销）。
const matrixView = {
  supported: true,
  current: SESSION_CWD,
  workspaces: {
    [SESSION_CWD]: {
      sid: 'S-1-5-DEMO', updatedAt: '2026-10-05T00:00:00.000Z',
      roots: [
        { path: 'D:\\Demo\\Null', status: 'granted', grantedAt: null, excluded: false, fromPatterns: ['D:\\Demo\\Null'] },
        { path: 'D:\\Demo\\Dead', status: 'failed', grantedAt: null, error: 'SetNamedSecurityInfoW failed (Win32 5)', errorAt: '2026-10-05T01:00:00.000Z', excluded: false, fromPatterns: ['D:\\Demo\\Dead'] },
        { path: 'D:\\Demo\\Live', status: 'granted', grantedAt: '2026-10-05T02:00:00.000Z', excluded: true, fromPatterns: ['D:\\Demo\\Live'] },
      ],
      pendingRevoke: [
        { path: 'D:\\Demo\\Stuck', origin: 'excluded', error: 'strip failed: no PowerShell host', attempts: 2, lastAttemptAt: '2026-10-05T03:00:00.000Z', fromPatterns: [] },
      ],
      history: [
        { path: 'D:\\Demo\\Gone', revokedAt: '2026-10-05T04:00:00.000Z', origin: 'excluded', fromPatterns: [] },
      ],
    },
  },
}
stubView(matrixView)
fetchCalls.length = 0
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '刷新授权状态').props.onClick()
await settle()
await waitBusy()
const matrixShown = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.deepEqual(cellPathsOf(matrixShown).sort(), [
  'D:\\Demo\\Dead', 'D:\\Demo\\Gone', 'D:\\Demo\\Live', 'D:\\Demo\\Null', 'D:\\Demo\\Stuck',
].sort(), 'the matrix renders all five rows under 「全部」')
// granted 行（grantedAt:null → 时间列「—」；操作列「撤销」）
const nullRow = findRowByPath(matrixShown, 'D:\\Demo\\Null')
assert.ok(nullRow, 'the granted row renders')
assert.deepEqual(nullRow.children[2].children, ['—'], 'a granted row with grantedAt:null renders 「—」 in the time column')
assert.ok(findButtonByAria(nullRow, '撤销该目录的写授权'), 'the granted row offers the revoke action')
// failed 行（失败点 errorAt + 原因列 error 原文 + 重试授权）
const failedRow = findRowByPath(matrixShown, 'D:\\Demo\\Dead')
assert.ok(failedRow, 'the failed row renders')
assert.ok(textOf(failedRow.children[1]).includes('授权失败'), 'the failed row shows the failed state')
assert.equal(textOf(failedRow.children[3]), 'SetNamedSecurityInfoW failed (Win32 5)', 'the reason column carries the raw error')
assert.equal(failedRow.children[3].props['data-tip'], 'SetNamedSecurityInfoW failed (Win32 5)', 'the reason cell exposes the full error via data-tip')
assert.deepEqual(failedRow.children[2].children, [localTime('2026-10-05T01:00:00.000Z')], 'the failed row times from errorAt')
assert.ok(findButtonByAria(failedRow, '手动重试该目录的写授权物化'), 'the failed row offers the retry-grant action')
// roots 内 excluded 行 → 待回收 + 固定待回收文案 + 操作列空
const liveRow = findRowByPath(matrixShown, 'D:\\Demo\\Live')
assert.ok(liveRow, 'the roots-excluded row renders')
assert.ok(textOf(liveRow.children[1]).includes('待回收'), 'a roots-excluded row shows the pending state')
assert.ok(textOf(liveRow.children[3]).includes('撤销中'), 'the pending row spells the pending reason')
assert.equal(findButtonByAria(liveRow, '撤销该目录的写授权'), null)
assert.equal(findButtonByAria(liveRow, '恢复该目录的写授权'), null)
assert.equal(findButtonByAria(liveRow, '手动重试该目录的写授权物化'), null, 'pending rows offer no action button')
// pendingRevoke 行（待回收 + error 原文 + lastAttemptAt 时间）
const stuckRow = findRowByPath(matrixShown, 'D:\\Demo\\Stuck')
assert.ok(stuckRow, 'the pendingRevoke row renders')
assert.ok(textOf(stuckRow.children[1]).includes('待回收'), 'the pendingRevoke row shows the pending state')
assert.equal(textOf(stuckRow.children[3]), 'strip failed: no PowerShell host', 'the pendingRevoke row carries its error verbatim')
assert.deepEqual(stuckRow.children[2].children, [localTime('2026-10-05T03:00:00.000Z')], 'the pendingRevoke row times from lastAttemptAt')
// history(origin=excluded) 行 → 已撤销 + 「恢复」
const goneRow = findRowByPath(matrixShown, 'D:\\Demo\\Gone')
assert.ok(goneRow, 'the revoked row renders')
assert.ok(textOf(goneRow.children[1]).includes('已撤销'), 'the revoked row shows the revoked state')
assert.ok(findButtonByAria(goneRow, '恢复该目录的写授权'), 'the revoked row offers the restore action')

// L4-02: 空态与错误态——空清单空态；fetch reject → role=alert + 错误文案，面板不崩；恢复后错误行消失。
stubView({ supported: true, current: '', workspaces: {} })
fetchCalls.length = 0
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '刷新授权状态').props.onClick()
await settle()
await waitBusy()
const emptyShown = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.ok(hasTextIn(collect(emptyShown, []), '当前工作区暂无授权记录'), 'an empty manifest shows the empty state')
assert.equal(cellPathsOf(emptyShown).length, 0, 'no rows render in the empty state')

globalThis.fetch = async () => { throw new Error('boom') }
fetchCalls.length = 0
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '刷新授权状态').props.onClick()
await settle()
const errorShown = render({ type: panelType, props: sessionProps(SESSION_CWD) })
const errorNodes = collect(errorShown, [])
assert.ok(errorNodes.some((n) => n.element && n.element.type === 'p' && n.element.props && n.element.props.role === 'alert'),
  'the fetch failure renders a role=alert error line')
assert.ok(hasTextIn(errorNodes, '载入失败') && hasTextIn(errorNodes, 'boom'), 'the error line spells the failure message')
assert.ok(findButtonByAria(errorShown, '刷新授权状态'), 'the panel survives the fetch failure (refresh still offered)')
stubView(matrixView)
fetchCalls.length = 0
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '刷新授权状态').props.onClick()
await settle()
await waitBusy()
const recoveryShown = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.equal(collect(recoveryShown, []).some((n) => n.element && n.element.type === 'p' && n.element.props && n.element.props.role === 'alert'),
  false, 'a successful refresh clears the error line')
assert.equal(cellPathsOf(recoveryShown).length, 5, 'rows render again after recovery')

// L4-03: 确认弹层取消路径（遮罩 / 取消按钮 → 零请求）与确认恰一次；恢复对称。
const postCount = (endpoint) => fetchCalls.filter((call) => call.url.endsWith(`/api/${endpoint}`)).length
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '撤销该目录的写授权').props.onClick()
const overlayNode = findByClass(render({ type: panelType, props: sessionProps(SESSION_CWD) }), 'sabx-confirm-overlay')
assert.ok(overlayNode, 'the revoke confirm opens as a layer')
fetchCalls.length = 0
overlayNode.props.onClick() // 点遮罩 = 取消
await settle()
assert.equal(postCount('revoke'), 0, 'clicking the overlay cancels: no revoke request')
assert.equal(findByClass(render({ type: panelType, props: sessionProps(SESSION_CWD) }), 'sabx-confirm-overlay'), null,
  'the overlay closes on the backdrop click')
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '撤销该目录的写授权').props.onClick()
const cancelButton = findButtonByText(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '取消')
assert.ok(cancelButton, 'the confirm offers the cancel button')
fetchCalls.length = 0
cancelButton.props.onClick()
await settle()
assert.equal(postCount('revoke'), 0, 'the cancel button cancels: no revoke request')
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '撤销该目录的写授权').props.onClick()
const confirmPanelL3 = render({ type: panelType, props: sessionProps(SESSION_CWD) })
fetchCalls.length = 0
findButtonByText(confirmPanelL3, '确认').props.onClick()
await settle()
assert.equal(postCount('revoke'), 1, 'confirming issues exactly one revoke request')
assert.deepEqual(JSON.parse(fetchCalls.find((call) => call.url.endsWith('/api/revoke')).body),
  { path: 'D:\\Demo\\Null', workspace: SESSION_CWD }, 'the revoke targets the granted row of the viewed workspace')
await waitBusy()
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '恢复该目录的写授权').props.onClick()
fetchCalls.length = 0
findButtonByText(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '取消').props.onClick()
await settle()
assert.equal(postCount('restore'), 0, 'the restore cancel path sends no request')
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '恢复该目录的写授权').props.onClick()
const restoreConfirmPanel = render({ type: panelType, props: sessionProps(SESSION_CWD) })
fetchCalls.length = 0
findButtonByText(restoreConfirmPanel, '确认').props.onClick()
await settle()
assert.equal(postCount('restore'), 1, 'confirming issues exactly one restore request')
assert.deepEqual(JSON.parse(fetchCalls.find((call) => call.url.endsWith('/api/restore')).body),
  { path: 'D:\\Demo\\Gone', workspace: SESSION_CWD }, 'the restore targets the revoked row')
await waitBusy()

// L4-04: 状态过滤器——四态 + 全部，各过滤下行集合与 data-active 选中态。
const ALL_PATHS = ['D:\\Demo\\Dead', 'D:\\Demo\\Gone', 'D:\\Demo\\Live', 'D:\\Demo\\Null', 'D:\\Demo\\Stuck']
const filterButtonsOf = (panelNode) => {
  const box = findByClass(panelNode, 'sabx-panel-filters')
  assert.ok(box, 'the filter bar renders')
  // children 可能嵌套数组（JSX map 作为单参传入 createElement），递归收集按钮
  const buttons = []
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.type === 'button') { buttons.push(n); return }
    walk(n.children || [])
  }
  walk(box.children || [])
  return buttons
}
const applyFilter = async (label, expectedPaths) => {
  const panelNode = render({ type: panelType, props: sessionProps(SESSION_CWD) })
  const button = filterButtonsOf(panelNode).find((b) => textOf(b) === label)
  assert.ok(button, `the 「${label}」 filter renders`)
  button.props.onClick()
  const after = render({ type: panelType, props: sessionProps(SESSION_CWD) })
  assert.deepEqual(cellPathsOf(after).sort(), [...expectedPaths].sort(), `the 「${label}」 filter shows exactly its rows`)
  for (const b of filterButtonsOf(after)) {
    assert.equal(b.props['data-active'], textOf(b) === label ? 'true' : 'false', `data-active tracks 「${label}」`)
  }
}
assert.equal(filterButtonsOf(render({ type: panelType, props: sessionProps(SESSION_CWD) })).length, 5, 'all + four state filters render')
await applyFilter('已授权', ['D:\\Demo\\Null'])
await applyFilter('授权失败', ['D:\\Demo\\Dead'])
await applyFilter('待回收', ['D:\\Demo\\Live', 'D:\\Demo\\Stuck'])
await applyFilter('已撤销', ['D:\\Demo\\Gone'])
await applyFilter('全部', ALL_PATHS)
// DEF-1 修复回归（曾为 lib/client.js:2276 的 setConfirmKey ReferenceError 锚点）：
// 切换过滤器必须（a）不再抛错、（b）关闭已打开的确认弹层。若崩溃回归，此处的
// onClick 调用会直接以未捕获异常使本套件变红。
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '撤销该目录的写授权').props.onClick()
assert.ok(findByClass(render({ type: panelType, props: sessionProps(SESSION_CWD) }), 'sabx-confirm-overlay'),
  'precondition: the confirm layer is open')
filterButtonsOf(render({ type: panelType, props: sessionProps(SESSION_CWD) })).find((b) => textOf(b) === '已撤销').props.onClick()
assert.equal(findByClass(render({ type: panelType, props: sessionProps(SESSION_CWD) }), 'sabx-confirm-overlay'), null,
  'switching filters closes the open confirm layer (DEF-1 fix)')
filterButtonsOf(render({ type: panelType, props: sessionProps(SESSION_CWD) })).find((b) => textOf(b) === '全部').props.onClick()
assert.equal(findByClass(render({ type: panelType, props: sessionProps(SESSION_CWD) }), 'sabx-confirm-overlay'), null,
  'the filter state resets to 「全部」 for the following stages')

// L4-05: 会话工作区选中语义——host 宽松同判命中（cwd 拼写变体 → 采纳精确清单键）、
// current 命中但清单无此键（防御空态）；「不命中恒空态不回退」由现有 ⑤ 覆盖。
const looseView = {
  supported: true,
  current: SESSION_CWD,
  workspaces: {
    [SESSION_CWD]: {
      sid: null, updatedAt: null,
      roots: [{ path: 'D:\\Demo\\Null', status: 'granted', grantedAt: '2026-10-05T00:00:00.000Z', excluded: false, fromPatterns: [] }],
      pendingRevoke: [], history: [],
    },
  },
}
stubView(looseView)
fetchCalls.length = 0
const looseCwd = 'd:\\demo\\workspace'
findButtonByAria(render({ type: panelType, props: sessionProps(looseCwd) }), '刷新授权状态').props.onClick()
await settle()
await waitBusy()
assert.equal(JSON.parse(fetchCalls[0].body).sessionCwd, looseCwd, 'the raw session cwd is sent for the host to resolve loosely')
const looseShown = render({ type: panelType, props: sessionProps(looseCwd) })
assert.deepEqual(findByClass(looseShown, 'sabx-panel-ws-value').children, [SESSION_CWD],
  'a loosely matched cwd adopts the exact manifest key')
assert.ok(findButtonByAria(looseShown, '撤销该目录的写授权'), 'rows render under the adopted key')
stubView({ supported: true, current: SESSION_CWD, workspaces: {} })
fetchCalls.length = 0
findButtonByAria(render({ type: panelType, props: sessionProps(SESSION_CWD) }), '刷新授权状态').props.onClick()
await settle()
await waitBusy()
const ghostShown = render({ type: panelType, props: sessionProps(SESSION_CWD) })
assert.ok(hasTextIn(collect(ghostShown, []), '当前工作区暂无授权记录'), 'a current without a manifest key stays on the empty state')

// Plugins 页配置界面：bundle.config 按包名作 key，row.config 按「包名#行id」。
// page 视图渲染与设置页同一份分节；summary 视图给一行说明文字。
const bundleConfig = registered.find((r) => r.spec.name === 'plugins.bundle.config')
assert.ok(bundleConfig, 'plugins.bundle.config registered')
assert.equal(bundleConfig.spec.key, 'dsh-sandbox-allowlist', 'bundle.config keyed by package name')
const rowConfig = registered.find((r) => r.spec.name === 'plugins.row.config' && r.spec.key === 'dsh-sandbox-allowlist#sandbox-allowlist-policy')
assert.ok(rowConfig, 'plugins.row.config registered for the policy row')
const pageElement = bundleConfig.component({ view: 'page' })
assert.equal(pageElement.type, registered[0].component, 'page view renders the shared section component')
assert.equal(typeof bundleConfig.component({ view: 'summary' }), 'string', 'summary view renders a text line')

// provider 行的平台提示：详情页徽标只认 provider 行，行说明页代替异常/沉默。
const badge = registered.find((r) => r.spec.name === 'plugins.detail.badge')
assert.ok(badge, 'plugins.detail.badge registered')
const badgeElement = badge.component({ subject: { kind: 'row', row: { rowId: 'sandbox-allowlist-provider' } } })
assert.equal(badgeElement.type, 'span', 'badge renders a span tag for the provider row')
assert.equal(badgeElement.props.className, 'sabx-badge', 'badge uses the scoped badge style')
assert.equal(badge.component({ subject: { kind: 'row', row: { rowId: 'sandbox-allowlist-fs' } } }), null, 'badge skips other rows')
assert.equal(badge.component({ subject: { kind: 'bundle', pkg: { name: 'dsh-sandbox-allowlist' } } }), null, 'badge skips bundle subjects')
const providerRow = registered.find((r) => r.spec.name === 'plugins.row.config' && r.spec.key === 'dsh-sandbox-allowlist#sandbox-allowlist-provider')
assert.ok(providerRow, 'plugins.row.config registered for the provider row (opens the explanation page)')
assert.equal(typeof providerRow.component({ view: 'summary' }), 'string', 'provider summary is a text line')
const providerNotice = providerRow.component({ view: 'page' })
assert.equal(providerNotice.type, 'div', 'provider page view renders the notice block')
assert.equal(providerNotice.props.className, 'sabx-callout-note', 'provider notice uses the callout style')

// The form controller must support getSnapshot/subscribe/set/unset for all
// three edits (save + reset-to-default).
assert.equal(typeof formController.getSnapshot, 'function')
assert.equal(typeof formController.subscribe, 'function')
assert.equal(typeof formController.set, 'function')
assert.equal(typeof formController.unset, 'function')

// Recursively render the component tree (function types are component calls)
// and collect every element node plus every text leaf.
function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    if (!hooksByType.has(node.type)) hooksByType.set(node.type, { hooks: [], cursor: 0 })
    const previous = currentHooks
    currentHooks = hooksByType.get(node.type)
    currentHooks.cursor = 0
    try {
      // React passes props as the first argument — the tool picker relies on it.
      return render(node.type(node.props))
    } finally {
      currentHooks = previous
    }
  }
  return {
    type: node.type,
    props: node.props,
    children: (node.children || []).map(render),
  }
}
function collect(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return out }
  if (typeof node === 'string') { out.push({ text: node }); return out }
  if (node !== null && typeof node === 'object') {
    out.push({ element: node })
    if (node.props && typeof node.props.dangerouslySetInnerHTML === 'object') {
      out.push({ html: String(node.props.dangerouslySetInnerHTML.__html || '') })
    }
    collect(node.children || [], out)
  }
  return out
}

// Two passes: the first runs the effects that seed card state from the
// settings scope, the second renders the populated rows.
render(registered[0].component())
const root = render(registered[0].component())
const nodes = collect(root, [])
const elements = nodes.filter((n) => n.element).map((n) => n.element)
const hasArticleId = (id) => elements.some((el) => el.type === 'article' && el.props && el.props.id === id)
const hasText = (text) => nodes.some((n) => n.text !== undefined && n.text.includes(text))
const hasHtml = (text) => nodes.some((n) => n.html !== undefined && n.html.includes(text))

assert.ok(hasArticleId('sabx-card-dirs'), '授权目录 card renders')
assert.ok(hasArticleId('sabx-card-cmds'), '命令规则 card renders')
assert.ok(hasArticleId('sabx-card-noread'), '禁读规则 card renders')
assert.ok(hasText('授权目录') && hasText('命令规则') && hasText('禁读规则'), 'card titles render')
assert.ok(hasText('保存目录') && hasText('保存命令规则') && hasText('保存禁读规则'), 'per-card save buttons render')
assert.ok(hasText('尚无禁读规则'), 'noRead empty state renders')
assert.ok(hasText('不提供 allow 动作'), 'noRead no-allow guidance renders')
assert.ok(hasHtml('*.pem'), 'noRead wildcard hint renders (deny example)')
assert.ok(hasText('沙箱授权'), 'section title renders')

// The command-surface knobs must be reachable from the settings page (a
// config-only feature is half-delivered): the single visible escalation
// switch, the collapsed 「高级」 zone with the baseline boolean, and the
// per-row pattern input.
assert.ok(hasText('允许自动批准沙箱升级'), 'the escalation switch renders')
assert.ok(hasText('高级'), 'the advanced collapsible renders')
assert.ok(hasText('内置能力基线'), 'the baseline knob renders')
assert.ok(hasText('会话级命令缓存') === false, 'the removed session-cache knob stays removed')
assert.ok(hasText('程序（可选）') === false, 'placeholder text is a prop, not a child')
assert.ok(
  nodes.some((n) => n.element && n.element.type === 'input' && n.element.props && n.element.props['aria-label'] === '命令模式'),
  'the whole-command pattern input renders',
)
assert.ok(
  nodes.every((n) => !(n.element && n.element.type === 'input' && n.element.props && n.element.props['aria-label'] === '程序')),
  'the removed argv-level program input stays removed',
)
const checkboxes = elements.filter((el) => el.type === 'input' && el.props && el.props.type === 'checkbox')
assert.equal(checkboxes.length, 2, 'the escalation switch plus the baseline advanced checkbox render as plain checkboxes')

// Switching the host locale must switch the copy: `t` reads the active locale
// at call time, so re-rendering under `en` yields the English surface.
activeLocale = 'en'
const enRoot = render(registered[0].component())
const enNodes = collect(enRoot, [])
const enText = (text) => enNodes.some((n) => n.text !== undefined && n.text.includes(text))
assert.equal(registered[0].spec.label(), 'Sandbox authorization', 'slot label switches to English')
assert.ok(enText('Authorized directories'), 'English card title renders')
assert.ok(enText('Command rules') && enText('Read restrictions'), 'English card titles render')
assert.ok(enText('Save directories') && enText('Save command rules') && enText('Save read restrictions'), 'English save buttons render')
assert.ok(enText('Advanced'), 'English advanced collapsible renders')
assert.ok(enText('Auto-approve sandbox escalations'), 'English escalation switch renders')
assert.equal(enText('授权目录'), false, 'no Chinese card title leaks into the English surface')
activeLocale = 'zh'

// All three cards default to COLLAPSED: article carries no `is-open` class,
// so the CSS rule `.sabx-card-openable:not(.is-open) .sabx-card-body` hides the
// body until the header is clicked.
for (const id of ['sabx-card-dirs', 'sabx-card-cmds', 'sabx-card-noread']) {
  const article = elements.find((el) => el.type === 'article' && el.props && el.props.id === id)
  assert.ok(article, `${id} article present`)
  assert.ok(!String(article.props.className || '').includes('is-open'), `${id} defaults collapsed`)
  assert.equal(article.props['aria-expanded'], undefined, `${id} carries no open aria state`)
}

// The header button inside each collapsed card declares aria-expanded=false.
for (const id of ['sabx-card-dirs', 'sabx-card-cmds', 'sabx-card-noread']) {
  const article = elements.find((el) => el.type === 'article' && el.props && el.props.id === id)
  const header = article && article.children.find((el) => el && el.type === 'button' && el.props && el.props['aria-expanded'] !== undefined)
  assert.ok(header, `${id} header present`)
  assert.equal(header.props['aria-expanded'], 'false', `${id} header announces collapsed`)
}

// Anti-drift guard: lib/client.js is a hand-written bundle that must stay in
// step with src/client/index.tsx (the maintenance notes call this out). Both
// carry the same i18n keys, and the dictionary must resolve to real copy in
// the locales module as well.
const tsx = readFileSync(join(here, '..', 'src', 'client', 'index.tsx'), 'utf8')
const localesTs = readFileSync(join(here, '..', 'src', 'client', 'locales.ts'), 'utf8')
for (const marker of [
  'cmds.escalationCheck',
  'cmds.baselineLabel',
  'baselineOptions',
  // 会话 cwd 契约读法、DOM 内确认弹层/busy 层、本地时间渲染与 body 级自绘
  // 悬浮气泡（两个文件必须同步演进）。
  'useSessions',
  'sabx-confirm-overlay',
  'sabx-busy-spin',
  'localTimeText',
  'sabx-tip',
]) {
  assert.ok(source.includes(marker), `lib/client.js carries the marker: ${marker}`)
  assert.ok(tsx.includes(marker), `src/client/index.tsx carries the marker: ${marker}`)
}
// Every key the bundle serves must exist in the TS dictionary too.
for (const key of zhKeys) {
  assert.ok(localesTs.includes(`'${key}'`), `src/client/locales.ts declares the key: ${key}`)
}
// No user-visible prose may remain hardcoded in the RENDER code — it belongs to
// the dictionaries. The bundle's inlined dictionary block is excluded because it
// legitimately carries the very same copy; the TSX is checked for `t(...)`
// resolution instead, since its header comment still quotes the copy.
// Keys are resolved either directly (`t('key')`) or through an option table
// (`labelKey` / `hintKey`), which the helpers resolve with `t(option.*)`.
const dictEnd = source.indexOf('    };', source.indexOf('const en = {'))
assert.ok(dictEnd > 0, 'bundle dictionary block located')
const renderCode = source.slice(dictEnd)
const resolvesKey = (text, key) =>
  text.includes(`t('${key}')`)
  || text.includes(`t("${key}")`)
  || text.includes(`labelKey: '${key}'`)
  || text.includes(`hintKey: '${key}'`)
for (const key of ['cmds.escalationCheck', 'cmds.baselineLabel']) {
  assert.ok(
    resolvesKey(renderCode, key),
    `lib/client.js render code resolves the key: ${key}`,
  )
  assert.ok(
    resolvesKey(tsx, key),
    `src/client/index.tsx resolves the key: ${key}`,
  )
}
// The copy itself must live in the dictionary module.
for (const prose of ['允许自动批准沙箱升级', '内置能力基线', '实验性功能']) {
  assert.ok(localesTs.includes(prose), `src/client/locales.ts carries the copy: ${prose}`)
}

// Degradation guard (dsh 0.2.0): when configForms is missing, throws, or has
// no entry for this plugin, apply() must still register the section and the
// component must render read-only without throwing.
for (const [label, configForms] of [
  ['configForms absent', undefined],
  ['get() throws', { get() { throw new Error('no form service') } }],
  ['entry not mounted', { get: () => null }],
]) {
  const failedRegistered = []
  const failedInjected = []
  const failedCtx = {
    configForms,
    locale,
    effect: effectStub,
    slots: {
      inject(name, fn) { failedInjected.push(fn) },
      register(spec, component) { failedRegistered.push({ spec, component }); return { spec, component } },
    },
  }
  captured.apply(failedCtx)
  await flushRegistration()
  failedInjected.forEach((fn) => fn())
  assert.ok(failedRegistered.length >= 1, `${label}: section still registers`)
  const sectionEntry = failedRegistered.find((r) => r.spec.name === 'settings.section')
  assert.ok(sectionEntry, `${label}: settings.section present`)
  const degraded = render(sectionEntry.component())
  const degradedNodes = collect(degraded, [])
  assert.ok(
    degradedNodes.some((n) => n.text !== undefined && n.text.includes('只读')),
    `${label}: renders the read-only notice`,
  )
}

// 入口按平台注册：host 半件不在非 win32 挂状态路由（探测 404 / 非 JSON）⇒
// 会话入口完全不注册，其余槽位不受影响——这是「Windows 才有入口」的契约本体。
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => { throw new Error('not json') } })
const linuxRegistered = []
const linuxInjected = []
captured.apply({
  configForms: { get: () => null },
  locale,
  effect: effectStub,
  slots: {
    inject(name, fn) { linuxInjected.push(fn) },
    register(spec, component) { linuxRegistered.push({ spec, component }); return { spec, component } },
  },
  connection: undefined,
})
await flushRegistration()
linuxInjected.forEach((fn) => fn())
assert.equal(
  linuxRegistered.find((r) => r.spec.name === 'conversation.session.header.utilities'),
  undefined,
  'no session entry registers on a host without the state route',
)
assert.ok(linuxRegistered.some((r) => r.spec.name === 'settings.section'), 'settings section still registers without the panel')

// ── Regression: deleting a configured directory row must raise the unsaved badge ──
// dirsDirtyCount used to compare positions only up to rows.length, so removing
// the LAST configured row (the single-directory case most users have) counted
// zero differences: no has-pending class, no 「· N 处未保存」 suffix and the
// 放弃修改 button stayed disabled — while both rule cards flag any deletion via
// their length check. Deleting a middle row shifted positions and masked this.
{
  const findArticle = (rootNode, id) => {
    const hit = collect(rootNode, []).find((n) => n.element && n.element.type === 'article' && n.element.props && n.element.props.id === id)
    return hit && hit.element
  }
  const findButtonWithText = (node, text) =>
    collect(node, []).find((n) => n.element && n.element.type === 'button'
      && collect(n.element, []).some((inner) => inner.text === text))

  // Seed one configured directory, then render twice (first pass runs the
  // seeding effect, second pass shows the row) — the harness's usual rhythm.
  formValue.allowedDirs = ['D:\\Shared\\Tools']
  render(registered[0].component())
  const seededRoot = render(registered[0].component())
  const seededArticle = findArticle(seededRoot, 'sabx-card-dirs')
  assert.ok(
    collect(seededRoot, []).some((n) => n.element && n.element.type === 'button' && n.element.props && n.element.props['aria-label'] === '删除'),
    'precondition: the configured directory row renders with its delete button',
  )
  const discardBefore = findButtonWithText(seededArticle, '放弃修改')
  assert.ok(discardBefore && discardBefore.element.props.disabled === true, 'precondition: 放弃修改 starts disabled (nothing unsaved)')

  // Click the row's ✕: the deletion is an unsaved change and must be flagged.
  const deleteBtn = collect(seededRoot, []).find((n) => n.element && n.element.type === 'button' && n.element.props && n.element.props['aria-label'] === '删除')
  deleteBtn.element.props.onClick()
  const afterRoot = render(registered[0].component())
  const afterArticle = findArticle(afterRoot, 'sabx-card-dirs')
  assert.ok(String(afterArticle.props.className || '').includes('has-pending'), 'deleting the last configured row raises the unsaved badge')
  assert.ok(
    collect(afterRoot, []).some((n) => n.text !== undefined && n.text.includes('处未保存')),
    'the header count carries the pending suffix after the deletion',
  )
  const discardAfter = findButtonWithText(afterArticle, '放弃修改')
  assert.ok(discardAfter && discardAfter.element.props.disabled === false, '放弃修改 becomes available so the deletion can be undone')

  // The rule cards use the same 「· N 处未保存」 count semantics now.
  const cmdArticleBefore = findArticle(seededRoot, 'sabx-card-cmds')
  assert.ok(!String(cmdArticleBefore.props.className || '').includes('has-pending'), 'precondition: commands card starts clean')
  const ruleDelete = collect(seededRoot, []).find((n) => n.element && n.element.type === 'button'
    && n.element.props && n.element.props['aria-label'] === '删除规则')
  assert.ok(ruleDelete, 'precondition: a command rule row renders with its delete button')
  ruleDelete.element.props.onClick()
  const afterCmdRoot = render(registered[0].component())
  const cmdArticle = findArticle(afterCmdRoot, 'sabx-card-cmds')
  assert.ok(String(cmdArticle.props.className || '').includes('has-pending'), 'deleting a rule row raises the commands badge')
  assert.ok(
    collect(afterCmdRoot, []).some((n) => n.text !== undefined && n.text.includes('处未保存')),
    'the commands header carries the count suffix too',
  )

  // A toggled switch counts as one more 处: flip the baseline checkbox.
  let baselineInput = null
  const walk = (node, visit) => {
    if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return }
    if (node === null || node === undefined) return
    visit(node)
    if (typeof node === 'object') walk(node.children, visit)
  }
  walk(afterCmdRoot, (el) => {
    if (el.type === 'label' && baselineInput === null) {
      let labeled = false
      walk(el.children, (n) => { if (typeof n === 'string' && n.includes('内置能力基线')) labeled = true })
      if (labeled) {
        walk(el.children, (n) => {
          if (baselineInput === null && n.type === 'input' && n.props && n.props.type === 'checkbox') baselineInput = n
        })
      }
    }
  })
  assert.ok(baselineInput, 'the baseline checkbox renders inside its label')
  baselineInput.props.onChange({ target: { checked: false } })
  const afterToggleRoot = render(registered[0].component())
  const toggleArticle = findArticle(afterToggleRoot, 'sabx-card-cmds')
  assert.ok(String(toggleArticle.props.className || '').includes('has-pending'), 'the toggle change keeps the badge on')
  assert.ok(
    collect(afterToggleRoot, []).some((n) => n.text !== undefined && n.text.includes('· 3 处未保存')),
    'the header counts the rule deletion plus the toggled switch (3 处)',
  )
}

console.log('verify-client-editor: all checks passed')
