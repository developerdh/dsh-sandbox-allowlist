/**
 * Ad-hoc empirical test: run the real windows-acl sandbox runner in
 * READ-ONLY mode from an UNCONFINED caller (like the dsh server does) and
 * answer two questions:
 *   1. can a read-only sandbox write to an ALLOWLIST directory? (expect no)
 *   2. can a read-only sandbox READ outside the workspace? (expect yes)
 * Usage: node test/readonly-probe.mjs <runnerPath>
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNNER = process.argv[2]
// Probe targets default to throwaway temp dirs so no real machine path is
// committed or required; override via DSH_TEST_WORKSPACE / DSH_TEST_PROBE_DIR
// to probe an actual deployment layout.
const WORKSPACE = process.env.DSH_TEST_WORKSPACE ?? join(tmpdir(), 'dsh-probe-ws')
const OUTSIDE = process.env.DSH_TEST_PROBE_DIR ?? join(tmpdir(), 'dsh-probe-outside')
mkdirSync(WORKSPACE, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
const OUTSIDE_LOG = join(OUTSIDE, 'test.log')
writeFileSync(OUTSIDE_LOG, 'probe target\n', 'utf8')
const PROFILE_SETTINGS = join(homedir(), '.dsh', 'settings.yaml')

function run(label, args) {
  console.log(`\n>>> ${label}`)
  const r = spawnSync(process.execPath, [RUNNER, '--workspace', WORKSPACE, '--temp', process.env.TEMP, '--mode', 'read-only', '--', ...args], { stdio: 'inherit', encoding: 'utf8' })
  console.log(`[exit=${r.status}]`)
  return r.status
}

run(`READ outside workspace (${OUTSIDE_LOG})`, ['cmd', '/c', 'type', `"${OUTSIDE_LOG}"`])
run(`READ outside workspace (user profile settings.yaml: ${PROFILE_SETTINGS})`, ['cmd', '/c', 'type', `"${PROFILE_SETTINGS}"`])
run(`WRITE outside workspace in READ-ONLY, expect FAIL (${OUTSIDE})`, ['cmd', '/c', `echo x> "${join(OUTSIDE, 'ro-write-test.txt')}"`])
run(`WRITE to workspace in READ-ONLY, expect FAIL (${WORKSPACE})`, ['cmd', '/c', `echo x> "${join(WORKSPACE, 'ro-ws-test.txt')}"`])
