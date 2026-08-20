/**
 * Ad-hoc empirical test: run the real windows-acl sandbox runner in
 * READ-ONLY mode from an UNCONFINED caller (like the dsh server does) and
 * answer two questions:
 *   1. can a read-only sandbox write to an ALLOWLIST directory? (expect no)
 *   2. can a read-only sandbox READ outside the workspace? (expect yes)
 * Usage: node test/readonly-probe.mjs <runnerPath>
 */
import { spawnSync } from 'node:child_process'

const RUNNER = process.argv[2]
const WORKSPACE = 'D:/Work/ProductCode/Devops/AI'

function run(label, args) {
  console.log(`\n>>> ${label}`)
  const r = spawnSync(process.execPath, [RUNNER, '--workspace', WORKSPACE, '--temp', process.env.TEMP, '--mode', 'read-only', '--', ...args], { stdio: 'inherit', encoding: 'utf8' })
  console.log(`[exit=${r.status}]`)
  return r.status
}

run('READ outside workspace (ALLOWLIST dir D:\\Work\\TestData\\test.log)', ['cmd', '/c', 'type', 'D:\\Work\\TestData\\test.log'])
run('READ outside workspace (non-allowlist C:\\Users\\IDEA\\.dsh\\settings.yaml)', ['cmd', '/c', 'type', 'C:\\Users\\IDEA\\.dsh\\settings.yaml'])
run('WRITE to ALLOWLIST dir D:\\Work\\TestData in READ-ONLY (expect FAIL)', ['cmd', '/c', 'echo x> D:\\Work\\TestData\\ro-write-test.txt'])
run('WRITE to workspace in READ-ONLY (expect FAIL)', ['cmd', '/c', 'echo x> D:\\Work\\ProductCode\\Devops\\AI\\ro-ws-test.txt'])
