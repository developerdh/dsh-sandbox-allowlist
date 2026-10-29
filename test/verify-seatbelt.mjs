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
 * Both the trusted root and the deny probe MUST live outside the stock
 * writable roots (workspace, /tmp, tmpdir): core puts those in every
 * workspace-write profile by design, so an allow assertion there would pass
 * with this plugin removed entirely, and a deny assertion would prove nothing.
 * Both directories are created under the home directory for that reason, and
 * case 1b) re-runs case 1) with the stock runner — which must deny.
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
const workspace = join(root, 'ws')
mkdirSync(workspace)

// Both extra directories live under the home directory on purpose — OUTSIDE
// the stock writable roots (workspace, /tmp, tmpdir). Core admits those in
// every workspace-write profile, so a trusted root created under tmpdir would
// be writable with the plugin removed entirely and the assertions below would
// pass vacuously.
const made = []
const makeHomeDir = (prefix) => {
  const path = real(mkdtempSync(join(homedir(), prefix)))
  made.push(path)
  return path
}
let trusted
let outside
try {
  trusted = makeHomeDir('.dsh-seatbelt-trusted-')
  outside = makeHomeDir('.dsh-seatbelt-outside-')
} catch (error) {
  for (const path of [root, ...made]) rmSync(path, { recursive: true, force: true })
  console.log(`verify-seatbelt: skipped — cannot create probe directories under ${homedir()} (${error?.code ?? error})`)
  process.exit(0)
}

const warnings = []
const provider = Object.create(AllowlistSandboxProvider.prototype)
provider.internals = {}
provider.ctx = { logger: { warn: (message) => warnings.push(message) } }
provider._unsupportedWarned = false
provider._seatbeltShapeWarned = false
provider._runnerCommandWarned = false
provider._filesystemRootWarned = false

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

  // 1b) Control: with the STOCK runnerArgv (this plugin's append bypassed), the
  //     same trusted root must be denied. This is what makes 1) a statement
  //     about the append rather than about a path Seatbelt already admits.
  provider.runnerArgv = Object.getPrototypeOf(AllowlistSandboxProvider.prototype).runnerArgv
  try {
    const control = await run(policy, `touch ${JSON.stringify(join(trusted, 'control'))} 2>/dev/null`)
    assert.notEqual(control.status, 0, 'control: the stock profile must deny the trusted root')
    assert.ok(!existsSync(join(trusted, 'control')), 'the control write left no file behind')
  } finally {
    delete provider.runnerArgv
  }
  // The sentinel reports the missing append exactly once; reset it so the
  // no-warning assertion at the end still describes the supported path.
  assert.equal(warnings.length, 1, 'the sentinel warns once when the profile lost the trusted roots')
  assert.match(warnings[0], /did not land/)
  warnings.length = 0

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
  for (const path of made) rmSync(path, { recursive: true, force: true })
}
