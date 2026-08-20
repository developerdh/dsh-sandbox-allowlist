/**
 * Trusted-roots filesystem fence extension — replaces the base `fs-sandbox`
 * row (`@deepseek-ai/dsh-fs-sandbox`) so the write/edit tools honor the
 * trusted roots carried by `policy.extraRoots` (produced by policy.mjs).
 *
 * Everything else is the stock `SandboxedFileSystem`: reads pass through,
 * `read-only` denies, `danger-full-access` delegates unfenced, and the
 * workspace-write fence for workspace/temp paths is unchanged. Only the
 * denial path gains an extra containment check against the trusted roots.
 */

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'

export const name = 'dsh-sandbox-allowlist-fs'

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])
const isMissing = (error) => MISSING_CODES.has(error?.code)

async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Whether `path` is `root` or lies beneath it. Lexical fast path first
 * (case-insensitive on Windows), then a filesystem-identity walk up the
 * ancestors to recognize 8.3/casing aliases — the same two-tier strategy the
 * stock fence uses.
 */
async function isPathUnder(path, root) {
  const norm = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  if (norm(path) === norm(root)) return true
  const prefix = norm(root).endsWith(sep) ? norm(root) : norm(root) + sep
  if (norm(path).startsWith(prefix)) return true
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  for (;;) {
    const info = await statIfPresent(ancestor)
    if (info !== undefined && sameIdentity(info, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

export class AllowlistFileSystem extends SandboxedFileSystem {
  async checkedTarget(target, sandboxPolicy) {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const extra = policy.mode === 'workspace-write' && Array.isArray(policy.extraRoots)
      ? policy.extraRoots
      : []
    if (extra.length === 0) return super.checkedTarget(target, sandboxPolicy)
    try {
      return await super.checkedTarget(target, sandboxPolicy)
    } catch (error) {
      if (error?.code === 'FS_SANDBOX_DENIED') {
        // The stock fence refused: give the trusted roots a chance, but only
        // under workspace-write (trusted roots are a workspace-write feature).
        const fresh = await this.resolve(target.displayPath)
        for (const root of extra) {
          if (await isPathUnder(fresh.targetKey, root)) return fresh
        }
      }
      throw error
    }
  }
}

export default AllowlistFileSystem
