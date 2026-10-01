/**
 * Trusted-roots filesystem fence extension — replaces the base `fs-sandbox`
 * row (`@deepseek-ai/dsh-fs-sandbox`) so the write/edit tools honor the
 * trusted roots carried by `policy.extraRoots` (produced by policy.mjs).
 *
 * Everything else is the stock `SandboxedFileSystem`: reads pass through,
 * `read-only` denies, `danger-full-access` delegates unfenced, and the
 * workspace-write fence for workspace/temp paths is unchanged. Only the
 * denial path gains an extra containment check against the trusted roots.
 *
 * On top of that, this class also enforces the `noRead` read restriction
 * (policy.mjs): every content read whose target matches a `deny` rule is
 * refused with `FS_READ_DENIED` BEFORE any I/O —
 *
 *   - readText / streamText / readBytes (the `read` and `read_image` tools,
 *     and any future ctx.fs consumer);
 *   - editText — edit is a read-match-write whose old content is returned to
 *     the model, so a restricted file cannot be edited;
 *   - listDir — a DIRECTORY-level deny rule (a literal absolute directory or
 *     an absolute path ending in a double-star subtree, see read-deny.mjs)
 *     also refuses listing the denied directory and everything beneath it;
 *   - writeText over an EXISTING file — the stock write reads the previous
 *     content back for the diff basis and the write tool returns it as
 *     `before`, so overwriting a restricted file is refused too. Creating a
 *     brand-new file whose name matches a rule stays allowed (only reading is
 *     restricted).
 *
 * `ask` rules are NOT enforced here: they live at the pre-execute gate
 * (read-gate.mjs) where an approval can be granted; refusing again in the
 * fence would defeat the `allowed-once` approval.
 */

import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import { stat } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import { resolveNoRead } from './read-deny.mjs'

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

/**
 * KI-1 compat shim (docs/issues/ki-1-session-controller-reload-race.md).
 *
 * Swapping the `fs` provider (installing, uninstalling, or toggling this
 * bundle while the client is running) makes cordis restart every surviving
 * entry that injects `fs` — `session-controller` among them. Its replacement
 * registers an Agent resolver on the long-lived `fileUploads` service right
 * from its constructor, and that registration can run before the dying
 * fiber's disposer cleared the previous resolver, so the stock registration
 * throws "file-upload: Agent resolver is already registered" and the whole
 * reload fails (ui-deliverables pends in its wake).
 *
 * Wrapping `registerAgentResolver` to drop the stale slot first makes the
 * registration idempotent: with the slot free the stock path runs unchanged;
 * when a dying registrar's disposer has not caught up, the stale entry is
 * cleared and the stock registration proceeds — that disposer is
 * identity-checked, so it neutralizes itself once the slot moves on.
 *
 * Deliberately NEVER unwrapped: disable/uninstall swap `fs` back to the
 * stock row and re-run the same race after this fiber is gone, and the
 * wrapper is semantics-preserving, so it can safely outlive the plugin.
 */
const AGENT_RESOLVER_SHIMMED = Symbol('dsh-sandbox-allowlist.agent-resolver-shim')

export function installAgentResolverShim(fileUploads) {
  if (!fileUploads || typeof fileUploads.registerAgentResolver !== 'function') return false
  if (fileUploads[AGENT_RESOLVER_SHIMMED]) return false
  const stockRegister = fileUploads.registerAgentResolver
  fileUploads[AGENT_RESOLVER_SHIMMED] = true
  fileUploads.registerAgentResolver = function (resolve) {
    if (this.agentResolver !== void 0) this.agentResolver = void 0
    return stockRegister.call(this, resolve)
  }
  return true
}

export class AllowlistFileSystem extends SandboxedFileSystem {
  // Declaring `fileUploads` injected guarantees its instance is resolved by
  // the time the constructor installs the resolver shim below — and this row
  // is the incoming `fs` provider, so cordis always activates it before
  // restarting the fs consumers (the restart the shim exists for). Nothing in
  // file-upload's own dependency chain injects `fs`, so the extra dependency
  // cannot form an activation cycle.
  static inject = [...SandboxedFileSystem.inject, 'fileUploads']

  constructor(ctx, config) {
    super(ctx, config)
    installAgentResolverShim(ctx.fileUploads)
  }

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

  /**
   * First `deny` noRead rule matching `target` (fs layer enforces deny rules
   * only — see the module docs), or `undefined`. Rules ride the resolved
   * sandbox policy (`policy.noReadRules`, attached by policy.mjs).
   */
  _noReadDeny(target) {
    if (target === null || target === undefined) return undefined
    const policy = this.ctx.sandboxPolicy.resolve()
    const rules = Array.isArray(policy?.noReadRules) ? policy.noReadRules : []
    if (rules.length === 0) return undefined
    const label = typeof target === 'string' ? target : (target?.displayPath ?? target?.targetKey ?? '')
    const hit = resolveNoRead(rules, label)
    return hit !== undefined && hit !== null && hit.action === 'deny' ? hit : undefined
  }

  /** Refuse the operation when a deny rule matches (throws FS_READ_DENIED). */
  _assertReadAllowed(target, operation) {
    const hit = this._noReadDeny(target)
    if (hit !== undefined) {
      throw new FsError(
        `cannot ${operation} "${target.displayPath}": file access denied by the sandbox-allowlist noRead rule "${hit.pattern}"`,
        'FS_READ_DENIED',
      )
    }
  }

  async readText(target, signal) {
    this._assertReadAllowed(target, 'read')
    return super.readText(target, signal)
  }

  streamText(target, signal) {
    this._assertReadAllowed(target, 'read')
    return super.streamText(target, signal)
  }

  async readBytes(target, signal, maxBytes) {
    this._assertReadAllowed(target, 'read')
    return super.readBytes(target, signal, maxBytes)
  }

  async listDir(target, signal) {
    // Directory-level deny rules refuse listing the directory itself and any
    // directory beneath a denied anchor.
    this._assertReadAllowed(target, 'list')
    return super.listDir(target, signal)
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    // Edit is a read-match-write that returns the old content — a restricted
    // file must not be editable. The write fence still applies via super.
    this._assertReadAllowed(target, 'edit')
    return super.editText(target, edit, expected, signal, sandboxPolicy)
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    const hit = this._noReadDeny(target)
    if (hit !== undefined) {
      // Refuse only when the target already exists: the stock write would
      // read its previous content back for the diff basis (the write tool
      // returns it as `before`). A brand-new file of a restricted format may
      // still be created — only reading is restricted.
      const info = await statIfPresent(target.targetKey)
      if (info !== undefined) {
        throw new FsError(
          `cannot write "${target.displayPath}": its existing content is protected by the sandbox-allowlist noRead rule "${hit.pattern}" (overwriting requires reading it first)`,
          'FS_READ_DENIED',
        )
      }
    }
    return super.writeText(target, content, expected, signal, sandboxPolicy)
  }
}

export default AllowlistFileSystem
