/**
 * macOS Seatbelt integration test — the only check that runs a REAL confined
 * child through `sandbox-exec` with this plugin's extended profile.
 *
 * The unit suites fake `process.platform` / `internals.platform` so the macOS
 * branch is exercised on any host; they assert argv and SBPL strings, never
 * kernel enforcement. This script creates a real workspace and trusted root,
 * wraps a command through the provider, and asserts Seatbelt actually admits
 * the trusted root while refusing every other write.
 *
 * Platform/environment behaviour:
 *   - not macOS                      → prints "skipped" and exits 0;
 *   - `sandbox-exec` missing/refuses → prints "skipped" and exits 0. Apple
 *     deprecated the tool and may remove it; a red CI for a removed system
 *     binary would be noise, not a plugin regression.
 *
 * The deny probe MUST live outside the stock writable roots (workspace, /tmp,
 * tmpdir): core puts those in every workspace-write profile by design, so a
 * deny assertion there would prove nothing. The temp directory under the home
 * directory below is intentionally outside them.
 *
 * Run from the package root: node test/verify-seatbelt.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AllowlistSandboxProvider } from '../lib/provider.mjs'

if (process.platform !== 'darwin') {
  console.log('verify-seatbelt: skipped (not macOS; the plugin uses bwrap/landlock here)')
  process.exit(0)
}

// Step 0: does this host still ship a usable sandbox-exec?
const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', '--', '/usr/bin/true'], { encoding: 'utf8' })
if (probe.error !== undefined || probe.status !== 0) {
  const detail = probe.error?.code ?? (probe.stderr ?? '').trim() ?? `exit ${probe.status}`
  console.log(`verify-seatbelt: skipped — sandbox-exec unusable on this host (${detail})`)
  process.exit(0)
}

const real = (path) => realpathSync.native(path)
const root = real(mkdtempSync(join(tmpdir(), 'dsh-seatbelt-')))
const outside = real(mkdtempSync(join(homedir(), '.dsh-seatbelt-outside-')))
const workspace = join(root, 'ws')
const trusted = join(root, 'trusted')
mkdirSync(workspace)
mkdirSync(trusted)

const warnings = []
const provider = Object.create(AllowlistSandboxProvider.prototype)
provider.internals = {}
provider.ctx = { logger: { warn: (message) => warnings.push(message) } }
provider._unsupportedWarned = false
provider._seatbeltShapeWarned = false
provider._runnerCommandWarned = false

/** Wrap one bash script through the real provider and run it under Seatbelt. */
async function run(policy, script) {
  const confined = await provider.confine(['/bin/bash', '-c', script], policy)
  const result = spawnSync(confined.argv[0], confined.argv.slice(1), { encoding: 'utf8' })
  return { status: result.status, stderr: (result.stderr ?? '').trim() }
}

try {
  const policy = { mode: 'workspace-write', workspaceRoot: workspace, extraRoots: [trusted] }

  // 1) The trusted root is writable under the extended profile.
  const trustedWrite = await run(policy, `touch ${JSON.stringify(join(trusted, 'ok'))}`)
  assert.equal(trustedWrite.status, 0, `trusted root write must succeed: ${trustedWrite.stderr}`)
  assert.ok(existsSync(join(trusted, 'ok')), 'the trusted root write landed on disk')

  // 2) The workspace itself stays writable (the stock grant is untouched).
  const workspaceWrite = await run(policy, `touch ${JSON.stringify(join(workspace, 'wsfile'))}`)
  assert.equal(workspaceWrite.status, 0, `workspace write must succeed: ${workspaceWrite.stderr}`)
  assert.ok(existsSync(join(workspace, 'wsfile')), 'the workspace write landed on disk')

  // 3) Every other write is still refused by the kernel (not merely by a tool fence).
  const outsideWrite = await run(policy, `touch ${JSON.stringify(join(outside, 'denied'))} 2>/dev/null`)
  assert.notEqual(outsideWrite.status, 0, 'a write outside the workspace and trusted roots must be denied')
  assert.ok(!existsSync(join(outside, 'denied')), 'the denied write left no file behind')

  // 4) read-only mode admits no trusted root at all.
  const readOnlyWrite = await run(
    { mode: 'read-only', workspaceRoot: workspace, extraRoots: [trusted] },
    `touch ${JSON.stringify(join(trusted, 'ro'))} 2>/dev/null`,
  )
  assert.notEqual(readOnlyWrite.status, 0, 'read-only mode must deny writes to a trusted root')
  assert.ok(!existsSync(join(trusted, 'ro')), 'the read-only write left no file behind')

  assert.deepEqual(warnings, [], 'the supported Seatbelt path logs no warning')
  console.log('verify-seatbelt: all checks passed (real sandbox-exec, extended profile)')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
