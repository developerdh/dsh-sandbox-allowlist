/**
 * Auto-review preset probe — the shared detector for "is this session on the
 * official Auto review permission preset?"
 *
 * The detection reuses the OFFICIAL source of truth, the same check the
 * auto-review layer itself performs in its own pre-execute listener:
 *
 *   permissionPresets.current(agent.session) === AUTO_PRESET   // "auto"
 *
 * "auto" is a RESERVED preset name (a user-configured preset cannot take it)
 * and only exists in the preset list once the official auto-review layer has
 * registered its contribution, so "current === auto" holds exactly when the
 * official layer is installed AND the session selected Auto.
 *
 * Degradation (every failure mode lands on "not Auto" = current behavior):
 *   - host without the `permissionPresets` service (dsh < 0.1.6)  => false
 *   - the `@deepseek-ai/dsh-permission-presets` package not installed
 *     (dynamic import fails) => the verified literal "auto" is used
 *   - probe throws / session absent => false
 *
 * @module dsh-sandbox-allowlist/preset
 */

/** The loaded presets module, or `null` when unavailable (probed once). */
let presetsModule = null
let presetsProbed = false

async function loadPresetsModule() {
  if (presetsProbed) return presetsModule
  presetsProbed = true
  try {
    presetsModule = await import('@deepseek-ai/dsh-permission-presets')
  } catch {
    presetsModule = null // not installed on this host — fallback literal below
  }
  return presetsModule
}

const loaded = await loadPresetsModule()

/**
 * The official Auto preset id. Read from the real package when resolvable;
 * otherwise the verified literal (the package ships `const AUTO_PRESET =
 * "auto"` — a plain string, stable across 0.1.6 → 0.2.0-rc.2).
 */
export const AUTO_PRESET = loaded?.AUTO_PRESET ?? 'auto'

/**
 * Whether `session` is currently on the official Auto review preset. Best
 * effort by design: any absence (no service, no session, probe error) reads
 * "not Auto", so a host without the preset layer keeps the exact current
 * behavior. The service is accessed lazily on the context (no `inject`
 * dependency) — an unstarted service simply reads `undefined`.
 * @param ctx - the cordis context the calling plugin lives on.
 * @param session - the calling session (`exec.agent?.session`), if any.
 * @returns `true` only when the official preset layer reports Auto.
 */
export function isAutoSession(ctx, session) {
  if (session === undefined || session === null) return false
  try {
    const presets = ctx?.permissionPresets
    if (presets === undefined || presets === null) return false
    if (typeof presets.current !== 'function') return false
    return presets.current(session) === AUTO_PRESET
  } catch {
    return false
  }
}
