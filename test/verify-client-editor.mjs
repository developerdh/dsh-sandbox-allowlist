/**
 * Verification that the hand-written lib/client.js bundle still loads and its
 * settings.section renders the full 沙箱授权 section (授权目录 / 命令规则 /
 * 禁读规则 cards):
 *   - stub `window.__ModuleLoader__.load` and `require('react')` with a
 *     lightweight element-tree createElement + hooks,
 *   - run the factory, assert `inject` and `apply` are intact,
 *   - call `apply` with a stubbed ctx (slots + settingsScope), register the
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
assert.deepEqual(captured.inject, ['slots', 'connection', 'settingsScope'], 'inject list intact')
assert.equal(typeof captured.apply, 'function', 'apply exported')

// Call apply() with a stubbed cordis ctx (slots + settingsScope) like the real
// client runtime does. Must register the settings.section slot without throwing.
const registered = []
const settingsScope = {
  bind: () => ({
    getSnapshot: () => ({
      value: {
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
      },
    }),
    subscribe: () => () => {},
    set: async () => {},
  }),
}
const ctx = {
  settingsScope,
  slots: {
    inject(name, fn) { this._injected = { name, fn } },
    register(spec, component) { registered.push({ spec, component }); return { spec, component } },
  },
}
captured.apply(ctx)
// The real runtime invokes the inject callback to register the slot.
ctx.slots._injected.fn()
assert.ok(registered.length === 1, 'settings.section registered')
assert.equal(registered[0].spec.id, 'sandbox-allowlist')
assert.equal(registered[0].spec.label(), '沙箱授权')
assert.equal(typeof registered[0].component, 'function', 'section component is a function')

// The bound scope must support getSnapshot/subscribe/set for all three edits.
const bound = settingsScope.bind({ namespace: 'sandbox-allowlist' })
assert.equal(typeof bound.getSnapshot, 'function')
assert.equal(typeof bound.subscribe, 'function')
assert.equal(typeof bound.set, 'function')

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

console.log('verify-client-editor: all checks passed')
