/**
 * Capability classification for one shell statement.
 *
 * The allow-list's original vocabulary was "whole-string pattern → action",
 * which forces the user to enumerate every command the agent might ever emit
 * (and PowerShell pipelines made that hopeless: `Tee-Object`, `Where-Object`,
 * `ConvertFrom-Json` …). This module replaces the enumeration with a
 * classification of what an invocation *does*:
 *
 *   - `read`        — observes state; no writes, no process spawning.
 *   - `local-write` — writes, but only through its path arguments; harmless
 *                     when every target stays inside the workspace ∪ granted
 *                     roots (the file sandbox governs exactly that boundary).
 *   - `repo-exec`   — runs the repository's own tooling (test runners, build
 *                     tools, package-script runners). Executes workspace code,
 *                     so it is NOT auto-escalatable unless an `allow` rule
 *                     covers it — see finding F5 in
 *                     docs/temp/设计评估-复合命令自动放行.md.
 *   - `external`    — leaves the machine/session boundary: network, registry
 *                     publish, cluster/cloud mutation.
 *   - `opaque`      — its real behaviour is code this engine cannot see
 *                     (interpreters, `env`, `xargs`, `Invoke-Expression`, …).
 *   - `destructive` — removes or irreversibly overwrites.
 *   - `unknown`     — not in any table. ALWAYS treated as the most restrictive
 *                     outcome: never auto-approved, and it is what the
 *                     "unknown ⇒ ask" rule is built on.
 *
 * Two deliberate properties keep this table from becoming a liability:
 *
 *   1. It is small and conservative. Only programs that are argument-independent
 *      readers live in the `read` table; every dual-personality program
 *      (`sed -i`, `find -exec`, `sort -o`, `git branch -D`) carries an explicit
 *      guard. A coarse entry silently widens the sandbox, so when in doubt the
 *      entry is left out and the program stays `unknown`.
 *   2. `unknown` is not "deny" — it falls back to a human prompt with a reason,
 *      so a missing entry costs one approval, never a silent grant.
 *
 * The `get-*` PowerShell verb is accepted as `read` on the strength of
 * PowerShell's approved-verb convention. That is a documented convention-based
 * bet, not a proof; it is safe here only because the escalation decision judges
 * EVERY statement of a compound command, so `Import-Module ./x.psm1; Get-Evil`
 * cannot ride on the second statement (the first one is `unknown`).
 *
 * This module is pure and side-effect free so it can be unit-tested without a
 * running dsh / cordis context.
 *
 * @module dsh-sandbox-allowlist/command-classes
 */

/** Statement capability classes, least to most dangerous. */
export const SEGMENT_CLASSES = [
  'read',
  'local-write',
  'repo-exec',
  'external',
  'opaque',
  'destructive',
  'unknown',
]

/**
 * Classes whose statements may be auto-approved while still inside the
 * sandbox (no rule needed): observing state, or writing through arguments the
 * file sandbox already governs.
 */
export const AUTO_ALLOWED_IN_SANDBOX = new Set(['read', 'local-write'])

/**
 * Classes that may be auto-approved for a sandbox ESCALATION (the command
 * would run outside the sandbox). `local-write` qualifies only when every
 * target is in scope — the decision engine enforces that.
 */
export const AUTO_ESCALATABLE_CLASSES = new Set(['read', 'local-write'])

// ---------------------------------------------------------------- read table

/**
 * Programs that only observe state. Argument-independent by construction:
 * anything with a write/exec mode lives in {@link GUARDED_PROGRAMS} instead and
 * is deliberately NOT repeated here — one fact, one place, so the two tables
 * can never drift into disagreeing about the same program.
 */
const READ_PROGRAMS = new Set([
  // POSIX / coreutils readers
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'cut', 'tr', 'uniq',
  'grep', 'rg', 'jq', 'basename', 'dirname', 'realpath', 'readlink',
  'stat', 'file', 'du', 'df', 'tree', 'which', 'where', 'whoami', 'hostname',
  'id', 'groups', 'printenv', 'true', 'false', 'test', 'seq', 'nl', 'od',
  'strings', 'sha256sum', 'md5sum', 'cksum', 'date', 'cal', 'uname',
  // stdout-only writers
  'echo', 'printf', 'write-output', 'write-host', 'out-string',
  // PowerShell observers
  'get-childitem', 'get-content', 'get-item', 'get-itemproperty', 'get-command',
  'get-member', 'get-date', 'get-location', 'get-help', 'get-history',
  'get-variable', 'get-process', 'get-service', 'get-module', 'get-alias',
  'get-host', 'get-psprovider', 'get-culture', 'get-random', 'get-filehash',
  'test-path', 'resolve-path', 'join-path', 'split-path', 'convert-path',
  'convertfrom-json', 'convertfrom-csv', 'convertfrom-xml', 'convertfrom-string',
  'convertto-json', 'convertto-csv', 'convertto-xml', 'convertto-html',
  'compare-object', 'measure-object', 'group-object', 'sort-object',
  'select-object', 'select-string', 'where-object', 'format-table',
  'format-list', 'format-wide', 'format-custom', 'out-host', 'out-default',
  'get-acl', 'show-markdown',
])

/**
 * Dual-personality programs: a reader unless a specific flag turns it into a
 * writer or an executor. `deny` wins over the base class; `readOnly` (a
 * positive allow-list of argument forms) narrows a program further.
 *
 * `sed` is deliberately NOT here: a sed script can execute a command (`e`) and
 * write files (`w`/`r`), and telling those apart requires parsing the script —
 * exactly the "false confidence" this table must avoid. It lives in
 * {@link OPAQUE_PROGRAMS} instead, so a sed pipeline costs one approval
 * (or an `allow` rule) rather than riding a `read` label.
 */
const GUARDED_PROGRAMS = new Map([
  ['find', { base: 'read', deny: /(^|[ \t])-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/ }],
  ['sort', { base: 'read', deny: /(^|[ \t])-o([ \t]|$)/ }],
  ['yq', { base: 'read', deny: /(^|[ \t])(-i|--inplace|--in-place)([ \t]|$)/ }],
  ['tee', { base: 'local-write' }],
  ['xargs', { base: 'opaque' }],
  ['awk', { base: 'opaque' }],
  ['gawk', { base: 'opaque' }],
  ['node', { base: 'opaque', readOnly: /^([ \t]*)(--version|-v|--help|-h)[ \t]*$/ }],
  ['nodejs', { base: 'opaque', readOnly: /^([ \t]*)(--version|-v|--help|-h)[ \t]*$/ }],
  ['python', { base: 'opaque', readOnly: /^([ \t]*)(--version|-V|--help|-h)[ \t]*$/ }],
  ['python3', { base: 'opaque', readOnly: /^([ \t]*)(--version|-V|--help|-h)[ \t]*$/ }],
  ['dotnet', { base: 'repo-exec', readOnly: /^([ \t]*)(--version|--info|--list-sdks)[ \t]*$/ }],
  ['docker', { base: 'external', readOnly: /^([ \t]*)(ps|images|version|info)([ \t]|$)/ }],
  ['kubectl', { base: 'external', readOnly: /^([ \t]*)(get|describe|logs|version|config[ \t]+view)([ \t]|$)/ }],
])

// -------------------------------------------------------- local-write table

/** Programs that write through their path arguments only. */
const LOCAL_WRITE_PROGRAMS = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'install', 'ln', 'chmod', 'chown',
  'new-item', 'set-content', 'add-content', 'out-file', 'copy-item',
  'move-item', 'rename-item', 'new-itemproperty', 'set-itemproperty',
  'set-item', 'tee-object', 'export-csv', 'export-clixml', 'start-transcript',
  'set-acl', 'new-smbshare',
])

/** Programs that remove or irreversibly overwrite. */
const DESTRUCTIVE_PROGRAMS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'remove-item', 'clear-content', 'truncate',
  'shred', 'dd', 'format', 'diskpart', 'shutdown', 'restart-computer',
  'stop-computer', 'stop-process', 'stop-service', 'kill', 'killall',
  'remove-itemproperty', 'unlink',
])

/**
 * Programs that run the repository's own tooling: test runners, bundlers,
 * linters, generators. They execute workspace code, so they are NOT
 * auto-escalatable on their own — but when reached THROUGH a resolved package
 * script (see command-expand.mjs) the script body is judged instead, which is
 * how `pnpm test` becomes decidable on its merits.
 */
const REPO_EXEC_PROGRAMS = new Set([
  'vitest', 'jest', 'mocha', 'ava', 'tap', 'node-test', 'karma', 'jasmine',
  'tsc', 'eslint', 'prettier', 'stylelint', 'oxlint', 'biome',
  'vite', 'webpack', 'rollup', 'esbuild', 'tsdown', 'tsup', 'parcel', 'rspack',
  'rimraf', 'cross-env', 'concurrently', 'nodemon', 'pm2', 'serve', 'http-server',
  'next', 'nuxt', 'astro', 'svelte-kit', 'remix', 'gatsby',
  'playwright', 'cypress', 'puppeteer', 'storybook', 'lerna', 'nx', 'turbo',
  'husky', 'lint-staged', 'semantic-release', 'commitlint', 'changeset',
  'nest', 'ng', 'vue-cli-service', 'react-scripts', 'electron-builder',
])

/** Programs whose real behaviour is code from somewhere this engine cannot see. */
const OPAQUE_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh',
  'wsl', 'env', 'nohup', 'time', 'eval', 'exec', 'source',
  'iex', 'invoke-expression', 'invoke-command', 'start-process', 'start-job',
  'start-threadjob', 'foreach-object', 'invoke-item', 'call', '&',
  'perl', 'ruby', 'php', 'lua', 'rscript', 'groovy', 'sed',
  'deno', 'bun', 'tsx', 'ts-node',
  'npx', 'bunx', 'pnpx', 'pipx', 'uvx',
  'make', 'nmake', 'gradle', 'gradlew', 'mvn', 'mvnw', 'ant', 'cmake',
  'cargo', 'rustc', 'go', 'javac', 'java', 'msbuild', 'msiexec', 'mshta',
  'rundll32', 'regsvr32', 'cscript', 'wscript', 'schtasks', 'wmic', 'reg',
  'sc', 'netsh', 'import-module', 'add-type', 'new-object',
])

/**
 * Programs that leave the machine / session boundary. Package managers
 * (`npm`/`pnpm`/`yarn`) and the programs with a read-only form
 * (`docker`/`kubectl`) are NOT listed here: they are dispatched earlier by
 * {@link PACKAGE_MANAGERS} / {@link GUARDED_PROGRAMS}, and duplicating them
 * would let the two tables drift apart. `capabilityTables()` plus the
 * single-source-of-truth assertion in `test/test.mjs` pins that.
 */
const EXTERNAL_PROGRAMS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'ncat',
  'invoke-webrequest', 'invoke-restmethod', 'invoke-sshcommand',
  'docker-compose', 'podman', 'helm', 'terraform', 'tofu', 'ansible',
  'ansible-playbook', 'aws', 'gcloud', 'az', 'gh', 'glab', 'heroku',
  'serverless', 'sam', 'pulumi', 'vault', 'consul',
])

/**
 * Package managers: the subcommand decides. Local build/test subcommands are
 * `repo-exec` (they run the repository's own tooling); anything that installs,
 * publishes or otherwise reaches the network is `external`.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'uv', 'poetry', 'nuget', 'choco', 'scoop', 'winget', 'apt', 'apt-get', 'brew'])

/** Package-manager subcommands that only consult the local install/registry metadata. */
const PM_READ_SUBCOMMANDS = new Set(['ls', 'list', 'why', 'view', 'info', 'outdated', 'root', 'bin', 'help', '--version', '-v'])

/** Package-manager subcommands that run the local project's tooling. */
const PM_LOCAL_SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'lint', 'typecheck', 'build', 'exec', 'start', 'serve', 'dev', 'format', 'check', 'coverage', 'bench'])

/** Package-manager subcommands that install/publish/otherwise touch the network. */
const PM_EXTERNAL_SUBCOMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'publish', 'audit', 'create', 'init', 'link', 'dedupe', 'prune', 'sync', 'dlx', 'download', 'deploy'])

/** git subcommands that only read. */
const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'describe',
  'blame', 'ls-files', 'ls-tree', 'shortlog', 'whatchanged', 'grep',
  'cat-file', 'show-ref', 'symbolic-ref', 'for-each-ref', 'merge-base',
  'check-ignore', 'check-attr', 'count-objects', 'verify-pack', 'name-rev',
  'var', 'help', 'version',
])

/** git subcommands that mutate only the local repository (workspace-scoped). */
const GIT_LOCAL_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'stash', 'tag', 'init',
  'mv', 'rm', 'cherry-pick', 'merge', 'rebase', 'revert', 'apply', 'am',
  'update-ref', 'update-index', 'notes', 'worktree', 'submodule', 'sparse-checkout',
  'gc', 'prune', 'repack', 'fsck', 'maintenance', 'rerere', 'commit-tree',
])

/** git subcommands that reach the network or rewrite published history. */
const GIT_EXTERNAL_SUBCOMMANDS = new Set([
  'push', 'pull', 'fetch', 'clone', 'remote', 'submodule-remote', 'ls-remote',
  'request-pull', 'send-email', 'archive',
])

/** git subcommand flags/forms that make an otherwise-local subcommand destructive. */
const GIT_DESTRUCTIVE_PATTERN = /(^|[ \t])(--hard|--force([ \t]|$)|-f([ \t]|$)|-D([ \t]|$)|--delete([ \t]|$)|clean[ \t]+-[a-z]*[fdx]|reset[ \t]+--hard)/

/** git turned into a program loader: `-c <…>protocol…` config injection or the `ext::` transport. */
const GIT_PROTOCOL_INJECTION = /(^|[ \t])-c[ \t]+["']?\S*protocol/i

// ------------------------------------------------------------- path handling

/** Token shapes that look like a filesystem path (used for scope checks). */
const PATHISH = /^(["']?)([A-Za-z]:[\\/]|[\\/~]|\.{1,2}[\\/])/

/**
 * Extract the path-like tokens of an argument string, unquoting them.
 * @param rest - the argument text of a statement.
 * @returns the path-like tokens (possibly empty).
 */
export function pathTokens(rest) {
  if (typeof rest !== 'string' || rest.length === 0) return []
  const tokens = rest.split(/[ \t]+/)
  const found = []
  for (let token of tokens) {
    if (token.length === 0) continue
    // `--out=path` / `--file:path` style flags carry the path after a separator.
    const separator = token.indexOf('=')
    if (token.startsWith('-') && separator > 0) token = token.slice(separator + 1)
    else if (token.startsWith('-')) continue
    const unquoted = token.replace(/^["']+|["']+$/g, '')
    if (unquoted.length === 0) continue
    if (PATHISH.test(unquoted) || unquoted.includes('/') || unquoted.includes('\\')) found.push(unquoted)
  }
  return found
}

// --------------------------------------------------------------- classifier

/**
 * The raw classification tables.
 *
 * Exported so the regression suite can assert the single-source-of-truth
 * invariant — every program lives in exactly one place — instead of trusting
 * review. A duplicate entry whose two tables disagree is exactly how a
 * "read-only" label ends up on something that writes (the `sed` entry this
 * refactor removed lived in two tables with different classes).
 *
 * @returns `{ read, localWrite, destructive, opaque, external, repoExec,
 *   guarded, packageManagers, repoExecPrograms }` as plain arrays.
 */
export function capabilityTables() {
  return {
    read: [...READ_PROGRAMS],
    localWrite: [...LOCAL_WRITE_PROGRAMS],
    destructive: [...DESTRUCTIVE_PROGRAMS],
    opaque: [...OPAQUE_PROGRAMS],
    external: [...EXTERNAL_PROGRAMS],
    repoExec: [...REPO_EXEC_PROGRAMS],
    guarded: [...GUARDED_PROGRAMS.entries()].map(([program, spec]) => ({ program, base: spec.base })),
    packageManagers: [...PACKAGE_MANAGERS],
  }
}

/**
 * Classify one statement.
 * @param descriptor - the statement descriptor (`{ program, rest, normalized }`).
 * @param options - `{ inScope?: (token: string) => boolean }`; when omitted,
 *   every path is treated as in scope (used by callers that only need the
 *   coarse class).
 * @returns `{ kind, why, outside }` — the capability class, a human-readable
 *   justification for the decision trace, and the out-of-scope path tokens
 *   found (empty for non-writing statements).
 */
export function classifyStatement(descriptor, options = {}) {
  const program = descriptor?.program ?? ''
  const rest = descriptor?.rest ?? ''
  const inScope = typeof options.inScope === 'function' ? options.inScope : () => true
  if (program.length === 0) {
    return { kind: 'unknown', why: 'the statement has no program token', outside: [] }
  }

  const guarded = GUARDED_PROGRAMS.get(program)
  if (guarded !== undefined) {
    if (guarded.readOnly !== undefined && guarded.readOnly.test(rest)) {
      return { kind: 'read', why: `${program} is invoked in a read-only form`, outside: [] }
    }
    if (guarded.deny !== undefined && guarded.deny.test(rest)) {
      const kind = guarded.base === 'read' ? 'local-write' : guarded.base
      return { kind, why: `${program} with a mutating/executing flag`, outside: scopeCheck(rest, inScope) }
    }
    return { kind: guarded.base, why: `${program} classified as ${guarded.base}`, outside: scopeCheck(rest, inScope) }
  }

  if (program === 'git') return classifyGit(rest, inScope)
  if (PACKAGE_MANAGERS.has(program)) return classifyPackageManager(program, rest, inScope)
  if (program.startsWith('get-')) {
    return { kind: 'read', why: `${program} uses the PowerShell approved Get verb (read-only by convention)`, outside: [] }
  }
  if (DESTRUCTIVE_PROGRAMS.has(program)) {
    return { kind: 'destructive', why: `${program} removes or irreversibly overwrites data`, outside: scopeCheck(rest, inScope) }
  }
  if (OPAQUE_PROGRAMS.has(program)) {
    return { kind: 'opaque', why: `${program} executes code this engine cannot inspect`, outside: [] }
  }
  if (EXTERNAL_PROGRAMS.has(program)) {
    return { kind: 'external', why: `${program} reaches outside the machine/session boundary`, outside: [] }
  }
  if (LOCAL_WRITE_PROGRAMS.has(program)) {
    return { kind: 'local-write', why: `${program} writes through its path arguments`, outside: scopeCheck(rest, inScope) }
  }
  if (REPO_EXEC_PROGRAMS.has(program)) {
    return { kind: 'repo-exec', why: `${program} runs the repository's own tooling`, outside: [] }
  }
  if (READ_PROGRAMS.has(program)) {
    // A "read" that NAMES a path outside the workspace is still scope-checked:
    // several readers have an output/argument position (`uniq in out`,
    // `tree -o file`, `git log --output=…`) and cannot be told apart from a
    // plain read without per-program argument parsing. Reporting the path lets
    // the escalation gate refuse it (and keeps the sandbox baseline off it),
    // at the cost of one approval in the rare case the path was only an input.
    return { kind: 'read', why: `${program} only reads`, outside: scopeCheck(rest, inScope) }
  }
  return { kind: 'unknown', why: `${program} is not in any capability table`, outside: [] }
}

/**
 * Out-of-scope path tokens of a writing statement.
 * @param rest - the argument text.
 * @param inScope - the scope predicate.
 * @returns the tokens that resolve outside the workspace ∪ granted roots.
 */
function scopeCheck(rest, inScope) {
  const outside = []
  for (const token of pathTokens(rest)) {
    if (!inScope(token)) outside.push(token)
  }
  return outside
}

/**
 * git: the subcommand decides, then the flags can escalate the class.
 * @param rest - the argument text after `git`.
 * @param inScope - the scope predicate for path arguments.
 * @returns `{ kind, why, outside }`.
 */
function classifyGit(rest, inScope) {
  const subcommand = rest.trim().split(/[ \t]+/)[0]?.toLowerCase() ?? ''
  if (subcommand.length === 0) return { kind: 'read', why: 'git with no subcommand prints usage', outside: [] }
  if (GIT_PROTOCOL_INJECTION.test(rest) || /ext::/.test(rest)) {
    // `git -c protocol.<x>.allow=always ext::sh -c …` turns git into a program
    // loader (finding F5 of the evaluation report): the program token says
    // "git", but the executed code comes from the injected transport.
    return { kind: 'opaque', why: 'git is configured to run an external transport (protocol injection / ext::)', outside: [] }
  }
  if (GIT_DESTRUCTIVE_PATTERN.test(rest)) {
    return { kind: 'destructive', why: `git ${subcommand} with a destructive flag`, outside: [] }
  }
  if (subcommand === 'config') {
    const global = /(^|[ \t])(--global|--system)([ \t]|$)/.test(rest)
    const reads = /(^|[ \t])(--get|--get-all|--list|-l|--get-regexp)([ \t]|$)/.test(rest)
    if (global) {
      return { kind: 'local-write', why: 'git config --global writes a config file outside the workspace', outside: [`~/.gitconfig`] }
    }
    if (reads) return { kind: 'read', why: 'git config reads configuration', outside: [] }
    return { kind: 'local-write', why: 'git config writes the repository configuration', outside: [] }
  }
  if (subcommand === 'branch' || subcommand === 'tag') {
    const tail = rest.replace(new RegExp(`^${subcommand}`), '').trim()
    const listing = tail.length === 0 || /^(-[a-zA-Z]+|--[a-z-]+)([ \t]+(-[a-zA-Z]+|--[a-z-]+))*$/.test(tail)
    if (listing) return { kind: 'read', why: `git ${subcommand} lists refs`, outside: [] }
    return { kind: 'local-write', why: `git ${subcommand} creates or moves a ref`, outside: [] }
  }
  if (subcommand === 'stash') {
    const tail = rest.replace(/^stash/, '').trim()
    if (tail.length === 0 || /^(list|show)([ \t]|$)/.test(tail)) return { kind: 'read', why: 'git stash lists entries', outside: [] }
    return { kind: 'local-write', why: 'git stash mutates the local repository', outside: [] }
  }
  if (subcommand === 'remote' && /^remote([ \t]+(-v|--verbose))?[ \t]*$/.test(rest)) {
    return { kind: 'read', why: 'git remote lists remotes', outside: [] }
  }
  if (GIT_EXTERNAL_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'external', why: `git ${subcommand} reaches the network or published history`, outside: [] }
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    // `git log --output=<file>` and friends name a path even though the
    // subcommand reads: report it so the escalation gate can refuse.
    return { kind: 'read', why: `git ${subcommand} reads`, outside: scopeCheck(rest, inScope) }
  }
  if (GIT_LOCAL_WRITE_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'local-write', why: `git ${subcommand} mutates the local repository`, outside: scopeCheck(rest, inScope) }
  }
  return { kind: 'unknown', why: `git ${subcommand} is neither a known read nor a known local mutation`, outside: [] }
}

/**
 * Package managers: classify by subcommand. Unknown subcommands stay `unknown`
 * so a new package-manager feature can never be auto-approved by accident.
 * @param program - the package-manager program name.
 * @param rest - the argument text after the program.
 * @returns `{ kind, why, outside }`.
 */
function classifyPackageManager(program, rest, inScope) {
  const subcommand = rest.trim().split(/[ \t]+/)[0]?.toLowerCase() ?? ''
  if (subcommand.length === 0) return { kind: 'read', why: `${program} with no subcommand prints usage`, outside: [] }
  if (PM_READ_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'read', why: `${program} ${subcommand} only reads`, outside: scopeCheck(rest, inScope) }
  }
  if (PM_LOCAL_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'repo-exec', why: `${program} ${subcommand} runs the repository's own tooling`, outside: [] }
  }
  if (PM_EXTERNAL_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'external', why: `${program} ${subcommand} installs, publishes or otherwise reaches the network`, outside: [] }
  }
  return { kind: 'unknown', why: `${program} ${subcommand} is not a known subcommand`, outside: [] }
}
