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
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      const fakeRequire = (id) => {
        if (id === 'react') {
          return {
            useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
            useEffect: () => {},
            // Element-tree stub: createElement(type, props, ...children).
            createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
          }
        }
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
    getSnapshot: () => ({ value: { allowedDirs: [], commands: { default: 'delegate', rules: [] }, noRead: [] } }),
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
  if (typeof node.type === 'function') return render(node.type())
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

console.log('verify-client-editor: all checks passed')
