/**
 * Ad-hoc verification that the hand-written lib/client.js bundle still loads
 * and exposes a callable entry point after the command-rules editor was added:
 *   - stub `window.__ModuleLoader__.load` and `require('react')`,
 *   - run the factory, assert `inject` and `apply` are intact,
 *   - call `apply` with a stubbed ctx (slots + settingsScope) and assert the
 *     settings.section slot is registered without throwing.
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
            createElement: () => ({}),
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
    getSnapshot: () => ({ value: { allowedDirs: [], commands: { default: 'delegate', rules: [] } } }),
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
const component = captured.apply(ctx)
// The real runtime invokes the inject callback to register the slot.
ctx.slots._injected.fn()
assert.ok(registered.length === 1, 'settings.section registered')
assert.equal(registered[0].spec.id, 'sandbox-allowlist')
assert.equal(registered[0].spec.label(), '沙箱授权')
assert.equal(typeof registered[0].component, 'function', 'section component is a function')

// The bound scope must support getSnapshot/subscribe/set for both edits.
const bound = settingsScope.bind({ namespace: 'sandbox-allowlist' })
assert.equal(typeof bound.getSnapshot, 'function')
assert.equal(typeof bound.subscribe, 'function')
assert.equal(typeof bound.set, 'function')

console.log('verify-client-editor: all checks passed')
