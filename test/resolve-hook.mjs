/**
 * Dev-only module-resolution hook so the package's self-check (test.mjs) can
 * import the installed `@deepseek-ai/*` packages without a node_modules here.
 *
 * Run from this directory:
 *   node --experimental-loader ./resolve-hook.mjs test.mjs
 *
 * `DHS_INSTALL_ANCHOR` must be a file inside the dsh installation whose
 * `node_modules` contains the @deepseek-ai packages. The default below points
 * at this machine's global dsh install; point it elsewhere after a reinstall.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DHS_INSTALL_ANCHOR = process.env.DHS_INSTALL_ANCHOR
  ?? 'D:/ProgramData/nvm/v22.22.2/node_modules/@deepseek-ai/dsh/lib/noop.js'

const require = createRequire(DHS_INSTALL_ANCHOR)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
  }
  return next(specifier, context)
}
