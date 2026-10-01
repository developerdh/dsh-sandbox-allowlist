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
    currentHooks.cursor += 1
    if (currentHooks.hooks.length <= slot) currentHooks.hooks[slot] = typeof init === 'function' ? init() : init
    const set = (value) => {
      currentHooks.hooks[slot] = typeof value === 'function' ? value(currentHooks.hooks[slot]) : value
    }
    return [currentHooks.hooks[slot], set]
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
assert.deepEqual(captured.inject, ['slots', 'connection', 'configForms'], 'inject list intact')
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
    sessionCache: true,
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
const ctx = {
  configForms: { get: (id) => (id === 'sandbox-allowlist-policy' ? formController : null) },
  slots: {
    inject(name, fn) { injected.push({ name, fn }) },
    register(spec, component) { registered.push({ spec, component }); return { spec, component } },
  },
}
captured.apply(ctx)
// The real runtime invokes each inject callback to register its slot; apply()
// registers the settings section plus the Plugins-page config slots.
injected.forEach(({ fn }) => fn())
assert.ok(registered.length === 5, 'five slots registered (settings.section + Plugins-page config/badge)')
assert.equal(registered[0].spec.name, 'settings.section')
assert.equal(registered[0].spec.id, 'sandbox-allowlist')
assert.equal(registered[0].spec.label(), '沙箱授权')
assert.equal(typeof registered[0].component, 'function', 'section component is a function')

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
// switch, the collapsed 「高级」 zone with the other two booleans, and the
// per-row pattern input.
assert.ok(hasText('允许沙箱升级自动放行'), 'the escalation switch renders')
assert.ok(hasText('高级'), 'the advanced collapsible renders')
assert.ok(hasText('内置能力基线'), 'the baseline knob renders')
assert.ok(hasText('会话级命令缓存'), 'the session-cache knob renders')
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
assert.equal(checkboxes.length, 3, 'the escalation switch plus the two advanced checkboxes render as plain checkboxes')

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
// step with src/client/index.tsx (the maintenance notes call this out). Every
// user-visible marker of the command-surface UI has to exist in BOTH files.
const tsx = readFileSync(join(here, '..', 'src', 'client', 'index.tsx'), 'utf8')
for (const marker of [
  '沙箱升级自动放行',
  '内置能力基线',
  '会话级命令缓存',
  'BASELINE_OPTIONS',
]) {
  assert.ok(source.includes(marker), `lib/client.js carries the marker: ${marker}`)
  assert.ok(tsx.includes(marker), `src/client/index.tsx carries the marker: ${marker}`)
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
    slots: {
      inject(name, fn) { failedInjected.push(fn) },
      register(spec, component) { failedRegistered.push({ spec, component }); return { spec, component } },
    },
  }
  captured.apply(failedCtx)
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

console.log('verify-client-editor: all checks passed')
