/**
 * Dev-only module-resolution hook so the package's self-check (test.mjs) can
 * import the installed `@deepseek-ai/*` packages without a node_modules here.
 *
 * Run from this directory:
 *   node --experimental-loader ./resolve-hook.mjs test.mjs
 *
 * `DHS_INSTALL_ANCHOR` must be a file inside the dsh installation whose
 * `node_modules` contains the @deepseek-ai packages. By default the hook
 * resolves through this repo's own node_modules (the local deps fallback
 * junction); set the env var to target an installed dsh instead.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DHS_INSTALL_ANCHOR = process.env.DHS_INSTALL_ANCHOR
  ?? join(import.meta.dirname, '..', 'package.json')

const require = createRequire(DHS_INSTALL_ANCHOR)

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
  }
  return next(specifier, context)
}
