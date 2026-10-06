/**
 * Session-facing authorization state — the host half of the session panel
 * (M1-05). Data channel: the self-built host route with the unified envelope
 * (the dsh-jenkins-proven path — knowledge note「Host↔Client 数据通道」§2:
 * the official wire domains are unstable; a prefix route over plain POST +
 * `{ ok, value }` JSON, HTTP always 200, is the stable contract).
 *
 *   - POST /sandbox-allowlist/api/state    → full view
 *     `{ supported, current, workspaces: { [root]: { sid, updatedAt,
 *     roots[], pendingRevoke[], history[] } } }`; `current` resolves the
 *     caller's session workspace when the client could see one (optional
 *     `sessionCwd` in the body), so the panel defaults to the workspace the
 *     user is actually in.
 *   - POST /sandbox-allowlist/api/revoke   { path, workspace? } — exclude →
 *     the reconcile strips the ACE (success → history, failure →
 *     pendingRevoke).
 *   - POST /sandbox-allowlist/api/restore  { path, workspace? } — include
 *     again → re-materialize (fresh grantedAt).
 *   - POST /sandbox-allowlist/api/grant    { path, workspace? } — manual
 *     re-grant of a failed root (the panel's 重试授权 action).
 *   Actions return the refreshed full view so the panel re-renders without a
 *   second round trip. `workspace` defaults to the caller's session workspace
 *   (resolved as above), then this instance's workspace root.
 *
 * Platform gate: routes exist only on win32 — the state they serve is the
 * Windows ACE manifest; on Linux/macOS grants live inside per-command bwrap
 * namespaces and die with the process. Not registering here is also the
 * CLIENT's entry signal: the browser half probes this route once before
 * registering the session-panel slot, so a non-win32 host leaves no entry.
 *
 * Degradation: `ctx.webServer` is a composition fact — absent (headless) the
 * registration is skipped with a one-time warn; never left pending. The
 * registration runs through `ctx.effect` so a reload disposes the previous
 * round instead of failing the next activation with duplicates. Runtime data
 * never enters Config; the exclusion flag lives in the manifest sidecar.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { comparablePath } from './patterns.mjs'

/** The route prefix (self-built API namespace, plugin-prefixed). */
export const STATE_API_PREFIX = '/sandbox-allowlist/api'

const MAX_BODY_BYTES = 1024 * 1024
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/

/** Canonical form of a filesystem path (realpath when it exists). */
function canonical(path) {
  try {
    return resolve(realpathSync.native(path))
  } catch {
    return resolve(path)
  }
}

/**
 * Wire the state API routes for one policy instance.
 *
 * `webServer` is accessed through `ctx.inject` (lazy wait), NOT by declaring
 * it in the row's inject list: the policy row is core sandbox infra and must
 * never stay pending on a web-only service in headless compositions. When
 * the service never arrives (headless), the callback simply never fires.
 * @param ctx - the plugin's cordis context.
 * @param policy - the AllowlistPolicyService instance (view source + action
 *   target: {@link manifestSliceAll}/{@link setRootExcluded}/{@link retryGrant}).
 */
export function applyStateRoutes(ctx, policy) {
  if (process.platform !== 'win32') return // no manifest on this platform — no routes, no panel entry
  try {
    ctx.inject(['webServer'], (scope) => {
      // The catch must live INSIDE the callback: a throw here escapes
      // ctx.inject and would abort the constructor, leaving the plugin
      // pending — degrade to a warning instead.
      try {
        scope.effect(() => scope.webServer.register({
          kind: 'prefix',
          path: STATE_API_PREFIX,
          handler: (req, res) => handleRequest(policy, req, res),
        }), 'sandbox-allowlist: api routes')
      } catch (error) {
        policy._warn(`state panel registration skipped: ${String(error)}`)
      }
    })
  } catch (error) {
    policy._warn(`state panel registration skipped: ${String(error)}`)
  }
}

/**
 * The method dispatch table, exposed separately from the HTTP adapter so
 * tests (dry-mount) drive it without fake req/res streams.
 * @param policy - the policy instance backing the views/actions.
 * @returns `async (method, body) => envelope` — `{ ok, value }` or
 *   `{ ok: false, error: { code, message, details } }`.
 */
export function createApiHandler(policy) {
  return async function dispatch(method, body) {
    if (typeof method !== 'string' || !ENDPOINT_RE.test(method)) {
      return errorEnvelope('bad-method', `method must match ${ENDPOINT_RE.source}`, { method })
    }
    if (method === 'state') {
      return okEnvelope(collectViews(policy, body ?? {}))
    }
    const path = body?.path
    if (typeof path !== 'string' || path.length === 0) {
      return errorEnvelope('bad-payload', 'body.path must be a non-empty string', { path })
    }
    const all = policy.manifestSliceAll()
    const workspaceRoot = resolveWorkspaceArg(all, body)
    if (!Object.prototype.hasOwnProperty.call(all.workspaces, workspaceRoot)) {
      return errorEnvelope('unknown-workspace', `"${workspaceRoot}" has no recorded grants manifest`, { workspace: workspaceRoot })
    }
    // The path must hit the workspace's manifest — the panel only ever offers
    // records from the view, so a foreign path is a caller bug, not a revoke.
    const slice = all.workspaces[workspaceRoot]
    const key = comparablePath(path)
    const known = [...slice.roots, ...slice.pendingRevoke, ...slice.history]
      .some((entry) => comparablePath(entry.path) === key)
    if (!known) {
      return errorEnvelope('unknown-path', `"${path}" is not a recorded root of workspace "${workspaceRoot}"`, { path, workspace: workspaceRoot })
    }
    let result
    if (method === 'revoke') result = policy.setRootExcluded(workspaceRoot, path, true)
    else if (method === 'restore') result = policy.setRootExcluded(workspaceRoot, path, false)
    else if (method === 'grant') result = policy.retryGrant(workspaceRoot, path)
    else return errorEnvelope('bad-method', `unknown method "${method}" (state | revoke | restore | grant)`, { method })
    if (!result.ok) {
      return errorEnvelope('not-found', result.error ?? 'no manifest record for this path', { path, workspace: workspaceRoot })
    }
    try {
      if (result.done) await result.done // the exclusion reconcile (strip / re-materialize) settled
    } catch (error) {
      return errorEnvelope('reconcile-failed', String(error?.message ?? error), { path, workspace: workspaceRoot })
    }
    return okEnvelope(collectViews(policy, body))
  }
}

/** HTTP adapter: prefix route handler over raw req/res (jenkins-proven shape). */
async function handleRequest(policy, req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = url.pathname.slice(STATE_API_PREFIX.length).replace(/^\/+|\/+$/g, '')
    if (req.method !== 'POST') {
      writeJson(res, errorEnvelope('bad-method', `only POST is supported (got ${req.method ?? '?'})`, { method: req.method }))
      return
    }
    const body = await readJsonBody(req)
    const envelope = await createApiHandler(policy)(method, body)
    writeJson(res, envelope)
  } catch (error) {
    writeJson(res, errorEnvelope('internal', String(error?.message ?? error)))
  }
}

function writeJson(res, payload) {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Resolve the workspace argument: explicit → sessionCwd match → instance root. */
function resolveWorkspaceArg(all, body) {
  if (typeof body?.workspace === 'string' && body.workspace.length > 0) return body.workspace
  return resolveCurrentRoot(all, body)
}

/** `current`: the caller's session workspace when it matches a manifest key,
 * else this instance's workspace root (the client falls back to a
 * most-recently-updated heuristic when this one is not the session's). */
function resolveCurrentRoot(all, body) {
  if (typeof body?.sessionCwd === 'string' && body.sessionCwd.length > 0) {
    const key = comparablePath(canonical(body.sessionCwd))
    const match = Object.keys(all.workspaces).find((root) => comparablePath(root) === key)
    if (match !== undefined) return match
  }
  return all.current
}

/** The full view: every workspace's slice with live fromPatterns merged. */
function collectViews(policy, body) {
  const all = policy.manifestSliceAll()
  const patternRoots = policy._patternRoots()
  const covering = (path) => {
    const key = comparablePath(path)
    return patternRoots
      .filter(({ roots }) => roots.some((root) => comparablePath(root) === key))
      .map(({ pattern }) => pattern)
  }
  for (const slice of Object.values(all.workspaces)) {
    for (const entry of slice.roots) entry.fromPatterns = covering(entry.path)
    for (const entry of slice.pendingRevoke) entry.fromPatterns = covering(entry.path)
  }
  return { supported: true, current: resolveCurrentRoot(all, body), workspaces: all.workspaces }
}

const okEnvelope = (value) => ({ ok: true, value })
const errorEnvelope = (code, message, details) => ({ ok: false, error: { code, message, details } })
