/**
 * The single decision engine shared by both gates.
 *
 * Before this module the two gates judged the same command differently: the
 * pre-execute gate aggregated per-segment rule matches, while the escalation
 * gate ran a separate "shape guard + full-segment allow + high-risk baseline"
 * gauntlet whose first two clauses rejected most real commands outright
 * (docs/temp/设计评估-复合命令自动放行.md §3, findings F1–F6). Both now call
 * {@link decide} with a different `phase`, so a compound command is analyzed
 * once, by one vocabulary, and every verdict carries a trace explaining
 * itself.
 *
 * Verdict semantics:
 *
 *   - `allow` — the call proceeds without a prompt. In the sandbox phase this
 *     is the "skip the approval" disposition; in the escalation phase it is
 *     additionally gated by {@link shouldAutoEscalate}. An `allow` RULE means
 *     both: the prompt is skipped AND the escalation for that shape is
 *     auto-approved (subject to the rails below).
 *   - `ask` — prompt the user.
 *   - `deny` — block.
 *
 * Aggregation is deny > ask > allow > default, where a statement is allowed
 * when EITHER a rule selects it with `allow`, OR the baseline (enabled by
 * default) classifies it as a benign capability (`read`, or a `local-write`
 * whose targets are all in scope). Anything else falls through to the
 * configured `default`, so a command the user has not described still behaves
 * exactly as the deployment did before this plugin existed.
 *
 * Three independent safety rails are worth naming because they are easy to
 * break while editing — and because a rule cannot override them:
 *
 *   1. Nothing about the analysis can widen a grant: unresolved structures
 *      (process substitution, unbalanced quotes, recursion overflow) and
 *      unknown programs only ever produce `ask`.
 *   2. An escalation is never auto-approved for a statement that touches a
 *      path outside the workspace ∪ granted roots (redirects included). The
 *      right way to authorize such a write is the sandbox allowedDirs list,
 *      not a command rule.
 *   3. An escalation is never auto-approved for a command that references a
 *      noRead-restricted path. `danger-full-access` (the mode an escalation
 *      grants) also lifts the read fence, so without this check a read-only
 *      statement could launder itself into an unrestricted read.
 *
 * An environment-variable prefix (`FOO=bar cmd`) is deliberately NOT a rail:
 * it only withholds the capability-baseline shortcut, never a rule the user
 * wrote explicitly.
 *
 * The module is pure: every impure input (scope predicates, noRead matching,
 * script expansion) arrives through `context`.
 *
 * @module dsh-sandbox-allowlist/command-decision
 */

import {
  COMMAND_ACTIONS,
  DEFAULT_ESCALATION_MODE,
  ESCALATION_MODES,
  compileCommandRules,
  describeRule,
  normalizeCommand,
} from './command-rules.mjs'
import { AUTO_ALLOWED_IN_SANDBOX, AUTO_ESCALATABLE_CLASSES, SEGMENT_CLASSES } from './command-classes.mjs'
import { analyzeCommand } from './command-analyze.mjs'

/** The `default` sentinel meaning "hand the call to the next listener". */
export const DELEGATE = 'delegate'

/** Decision phases: inside the sandbox, or the escalation that would run outside it. */
export const PHASES = ['sandbox', 'escalation']

/** Human-facing label for a capability class, used in explanations. */
const CLASS_LABELS = {
  read: '只读',
  'local-write': '写文件（路径受限）',
  'repo-exec': '运行仓库自身工具链',
  external: '跨机器/网络边界',
  opaque: '执行不可见代码',
  destructive: '删除或不可逆覆盖',
  unknown: '未在能力表中',
}

/**
 * Normalize the effective rule source.
 * @param source - `{ rules?, default? }` or a raw settings section.
 * @returns `{ rules, defaultAction, escalation, baseline }` where
 *   `defaultAction` is one of `allow|ask|deny|delegate`.
 */
export function normalizeSource(source) {
  const rules = Array.isArray(source?.rules) ? source.rules : []
  const fallback = source?.default
  const defaultAction = COMMAND_ACTIONS.includes(fallback) || fallback === DELEGATE ? fallback : DELEGATE
  const escalation = ESCALATION_MODES.includes(source?.escalation) ? source.escalation : DEFAULT_ESCALATION_MODE
  const baseline = source?.baseline === undefined ? true : source.baseline === true
  return { rules, defaultAction, escalation, baseline }
}

/**
 * Whether the file sandbox (or a granted root) already covers a path token.
 * Relative tokens resolve against the command's working directory.
 * @param token - a path-like token from the command.
 * @param roots - canonical roots that count as in scope (workspace first).
 * @param cwd - the working directory relative tokens resolve against.
 * @returns `true` when the path stays inside one of the roots.
 */
export function makeScopePredicate(roots, cwd) {
  const cleaned = (roots ?? [])
    .filter((root) => typeof root === 'string' && root.length > 0)
    .map((root) => root.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase())
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  return (token) => {
    if (typeof token !== 'string' || token.length === 0) return true
    let value = token.replace(/^["']+|["']+$/g, '').replace(/\\/g, '/')
    if (value.startsWith('~')) return false // a home-relative path leaves the workspace
    if (/^[A-Za-z]:\//.test(value)) {
      // absolute (drive-qualified)
    } else if (value.startsWith('/')) {
      return false // POSIX absolute path: no mount mapping is known here
    } else {
      if (base.length === 0) return true
      value = `${base}/${value}`
    }
    const rooted = value.startsWith('/')
    const segments = []
    for (const part of value.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') segments.pop()
      else segments.push(part)
    }
    // Keep the leading separator: dropping it would make `/repo/x` compare as
    // `repo/x` and never match the `/repo` root.
    const resolved = `${rooted ? '/' : ''}${segments.join('/')}`.toLowerCase()
    return cleaned.some((root) => resolved === root || resolved.startsWith(`${root}/`))
  }
}

/**
 * Candidate rule that would make this statement decidable, rendered the way
 * the settings page stores it. Used by the approval prompt so the user can
 * turn an interruption into a rule in one copy-paste.
 * @param statement - one analyzed statement.
 * @param action - the action to suggest.
 * @returns a one-line rule description such as `{ pattern: "node scripts/*", action: "allow" }`.
 */
export function suggestRule(statement, action = 'allow') {
  const program = statement?.program ?? ''
  if (program.length === 0) return null
  const rest = statement.rest ?? ''
  const firstArg = rest.split(' ')[0] ?? ''
  const pattern = firstArg.length > 0 && !firstArg.startsWith('-') ? `${program} ${firstArg}*` : `${program}*`
  return `{ pattern: "${pattern}", action: "${action}" }`
}

/**
 * Build a compact human explanation of a per-statement verdict.
 * @param statement - one analyzed statement.
 * @param action - the rule action that matched, or `null`.
 * @param allowedByBaseline - whether the baseline classified it as benign.
 * @returns a one-line string.
 */
function statementNote(statement, action, allowedByBaseline) {
  const kind = statement.kind ?? 'unknown'
  const label = CLASS_LABELS[kind] ?? kind
  if (action !== null) return `${statement.text} → 规则 ${action}`
  if (allowedByBaseline) return `${statement.text} → 基线放行（${label}）`
  return `${statement.text} → 未放行（${label}：${statement.why ?? ''}）`
}

/**
 * Decide what to do with one shell call.
 *
 * @param options - the decision input.
 * @param options.source - the effective rule source (see {@link normalizeSource}).
 * @param options.tool - the shell tool name (`bash`, `pwsh`).
 * @param options.command - the raw command string.
 * @param options.phase - `sandbox` (pre-execute) or `escalation`.
 * @param [options.context] - resolution context:
 *   `{ roots?: string[], cwd?: string, noRead?: (path) => (null|{action,pattern}),
 *      expandScript?: (program, rest, tool) => string|null, maxDepth?: number,
 *      sessionId?: string }`.
 * @returns `{ verdict, escalate, reason, trace }` — `verdict` is
 *   `allow|ask|deny|delegate`, `escalate` answers the escalation question
 *   (always `false` in the sandbox phase).
 */
export function decide(options) {
  const { source, tool, command, phase = 'sandbox', context = {} } = options ?? {}
  const { rules, defaultAction, escalation, baseline } = normalizeSource(source)
  const resolve = compileCommandRules(rules)
  const inScope = typeof context.inScope === 'function'
    ? context.inScope
    : makeScopePredicate(context.roots ?? [], context.cwd)
  const analysis = analyzeCommand(command, tool, {
    inScope,
    expandScript: context.expandScript,
    maxDepth: context.maxDepth,
  })

  const trace = {
    phase,
    tool,
    command: typeof command === 'string' ? command : '',
    statements: [],
    redirects: analysis.redirects,
    unresolved: analysis.unresolved,
    notes: [],
    suggestions: [],
    escalationMode: escalation,
    baseline,
  }

  const deny = (reason) => ({ verdict: 'deny', escalate: false, reason, trace })
  const ask = (reason) => ({ verdict: 'ask', escalate: false, reason, trace })
  const allow = (reason) => ({ verdict: 'allow', escalate: false, reason, trace })
  const delegate = (reason) => ({ verdict: DELEGATE, escalate: false, reason, trace })

  if (analysis.unresolved.length > 0) {
    const kinds = [...new Set(analysis.unresolved.map((item) => item.kind))]
    trace.notes.push(`无法解析的结构：${kinds.join(', ')}`)
    const reason = `存在无法解析的命令结构（${kinds.join(', ')}），需人工确认`
    return phase === 'escalation'
      ? { verdict: DELEGATE, escalate: false, reason, trace }
      : delegate(reason)
  }
  if (analysis.statements.length === 0) {
    return phase === 'escalation'
      ? { verdict: DELEGATE, escalate: false, reason: '命令为空，无法自动放行', trace }
      : delegate('空命令')
  }

  // ---- per-statement rule resolution
  //
  // A CONTAINER statement (`pnpm test` whose body was resolved from
  // package.json) is judged by the statements it expands to, not by its own
  // program name: that is the whole point of meta-program expansion. It is
  // therefore skipped in the aggregation unless it carries an explicit rule of
  // its own, in which case the rule also covers the body it expands to (the
  // user granted the intent, not the spelling) — while an explicit `deny`/`ask`
  // on a body statement still wins, because a more specific rule must never be
  // silently overridden.
  const own = new Map()
  for (const statement of analysis.statements) {
    own.set(statement, resolve(tool, statement))
  }
  const inheritedAction = new Map()
  for (const statement of analysis.statements) {
    if (statement.container !== true) continue
    const action = own.get(statement)
    if (action !== 'allow') continue
    for (let i = statement.childrenStart; i < statement.childrenEnd; i += 1) {
      const child = analysis.statements[i]
      if (own.get(child) === null) inheritedAction.set(child, action)
    }
  }

  // A container's effective capability is the WORST of the statements it
  // expands to: `pnpm docs` is as safe as its body, `pnpm deploy` is as unsafe
  // as its body. Without this the container's own class (repo-exec) would
  // permanently mask a benign script body.
  const effectiveCache = new Map()
  const effectiveOf = (statement) => {
    const cached = effectiveCache.get(statement)
    if (cached !== undefined) return cached
    // A container's own class describes the RUNNER, not what runs; the body
    // defines the effective capability, so the container starts from the least
    // severe class and takes the worst of its children.
    let kind = statement.container === true ? SEGMENT_CLASSES[0] : statement.kind
    let outside = statement.outside ?? []
    let envPrefix = statement.envPrefix ?? null
    if (statement.container === true) {
      for (let i = statement.childrenStart; i < statement.childrenEnd; i += 1) {
        const child = effectiveOf(analysis.statements[i])
        if (SEGMENT_CLASSES.indexOf(child.kind) > SEGMENT_CLASSES.indexOf(kind)) kind = child.kind
        if (child.outside.length > 0) outside = outside.concat(child.outside)
        if (envPrefix === null) envPrefix = child.envPrefix
      }
    }
    const value = { kind, outside, envPrefix }
    effectiveCache.set(statement, value)
    return value
  }

  const denied = []
  const asked = []
  const unmatched = []
  for (const statement of analysis.statements) {
    if (statement.container === true && own.get(statement) === null) continue // judged through its body
    const action = own.get(statement) ?? inheritedAction.get(statement) ?? null
    const effective = effectiveOf(statement)
    const benignClass = AUTO_ALLOWED_IN_SANDBOX.has(effective.kind) && effective.outside.length === 0
    const baselineAllows = baseline && benignClass && effective.envPrefix === null
    const entry = {
      text: statement.text,
      program: statement.program,
      rest: statement.rest,
      kind: effective.kind,
      ownKind: statement.kind,
      action,
      baseline: baselineAllows,
      why: statement.why,
      envPrefix: effective.envPrefix,
      outside: effective.outside,
      source: statement.source,
      inherited: inheritedAction.has(statement),
      expandsTo: statement.container === true
        ? analysis.statements.slice(statement.childrenStart, statement.childrenEnd).map((child) => child.text)
        : undefined,
    }
    if (action === 'deny') denied.push(entry)
    else if (action === 'ask') asked.push(entry)
    else if (action === null && !baselineAllows) unmatched.push(entry)
    trace.statements.push({ ...entry, note: statementNote(statement, action, baselineAllows) })
  }

  // ---- sandbox phase: skip-the-prompt disposition
  if (phase !== 'escalation') {
    if (denied.length > 0) {
      return deny(`命令被 deny 规则拦截：${denied.map((entry) => entry.text).join(' ; ')}`)
    }
    if (asked.length > 0) {
      const first = asked[0]
      const suggestion = suggestRule(first, 'allow')
      if (suggestion !== null) trace.suggestions.push(suggestion)
      return ask(`规则要求审批：${asked.map((entry) => entry.text).join(' ; ')}`)
    }
    if (unmatched.length === 0) {
      return allow('全部语句均已放行（规则命中或基线能力类）')
    }
    if (defaultAction === 'deny') return deny('存在未匹配规则的语句，default=deny')
    if (defaultAction === 'ask') return ask(`存在未匹配规则的语句：${unmatched.map((entry) => entry.text).join(' ; ')}`)
    if (defaultAction === 'allow') return allow('default=allow')
    return delegate(`未匹配规则的语句：${unmatched.map((entry) => entry.text).join(' ; ')}`)
  }

  // ---- escalation phase: may this run OUTSIDE the sandbox?
  const refusal = shouldAutoEscalate({
    mode: escalation,
    baseline,
    denied,
    asked,
    statements: trace.statements,
    redirects: analysis.redirects,
    paths: analysis.paths,
    context,
  })
  if (refusal !== null) {
    trace.notes.push(refusal)
    for (const entry of trace.statements) {
      if (entry.escalatable === false) {
        const suggestion = suggestRule(entry, 'allow')
        if (suggestion !== null && !trace.suggestions.includes(suggestion)) trace.suggestions.push(suggestion)
      }
    }
    return { verdict: DELEGATE, escalate: false, reason: refusal, trace }
  }
  return { verdict: 'allow', escalate: true, reason: '全部语句均命中 allow 规则（含沙箱升级授权）或为良性能力类', trace }
}

/**
 * The escalation-specific gate: may this command be auto-approved to run with
 * a wider mode (i.e. outside the file/process sandbox)?
 *
 * The order below IS the semantics — rails come before rules:
 *
 *   1. `escalation: never` disables auto-approval entirely;
 *   2. any deny/ask rule hit blocks it (the stricter rule wins);
 *   3. any statement or out-direction redirect naming a path outside the
 *      workspace ∪ granted roots blocks it (authorize the DIRECTORY instead);
 *   4. any statement referencing a noRead target blocks it (the wider mode
 *      would lift the read fence);
 *   5. per statement: a rule `allow` ⇒ escalatable (the rule includes the
 *      escalation grant); otherwise the capability baseline (a benign class
 *      with no env prefix) ⇒ escalatable; otherwise not.
 *
 * @param input - `{ mode, baseline?, denied, asked, statements, redirects, paths, context }`.
 *   `baseline` (default true) enables the capability-class shortcut; with it
 *   off, only explicit `allow` rules can auto-approve.
 * @returns a refusal reason, or `null` when the escalation may be auto-approved.
 */
export function shouldAutoEscalate(input) {
  const { mode, denied, asked, statements, redirects, paths, context } = input
  const baseline = input.baseline !== false
  if (mode === 'never') return '升级自动放行已关闭（escalation: never）'
  if (denied.length > 0) return `deny 规则命中，不得自动放行升级：${denied.map((entry) => entry.text).join(' ; ')}`
  if (asked.length > 0) return `ask 规则命中，需人工确认：${asked.map((entry) => entry.text).join(' ; ')}`

  const outOfScopeRedirect = (redirects ?? []).find((item) => item.harmless !== true && item.direction === 'out' && item.inScope === false)
  if (outOfScopeRedirect !== undefined) {
    return `重定向目标落在工作区与授权目录之外（${outOfScopeRedirect.target}），不自动放行升级`
  }

  if (typeof context?.noRead === 'function') {
    const hits = []
    for (const path of new Set(paths ?? [])) {
      const hit = context.noRead(path)
      if (hit !== null && hit !== undefined) hits.push(`${path}${hit.pattern !== undefined ? ` (禁读规则 ${hit.pattern})` : ''}`)
    }
    if (hits.length > 0) return `命令引用了禁读目标，升级会解除读取限制，不自动放行：${hits.join(' ; ')}`
  }

  const blocked = []
  for (const statement of statements ?? []) {
    // rail: out-of-scope paths override any rule — the way to authorize a
    // write outside the workspace is the sandbox allowedDirs list, which makes
    // the command legal inside the sandbox in the first place.
    if (statement.outside !== undefined && statement.outside.length > 0) {
      markEscalatable(statement, false, `引用了工作区与授权目录之外的路径（${statement.outside[0]}）`)
      blocked.push(statement)
      continue
    }
    if (statement.action === 'allow') {
      markEscalatable(statement, true, '规则 allow（含沙箱升级授权）')
      continue
    }
    const benign = baseline
      && AUTO_ESCALATABLE_CLASSES.has(statement.kind)
      && (statement.envPrefix === null || statement.envPrefix === undefined)
    markEscalatable(statement, benign, benign ? '良性能力类' : `能力类 ${statement.kind} 未命中 allow 规则`)
    if (!benign) blocked.push(statement)
  }
  if (blocked.length > 0) {
    const first = blocked[0]
    const label = CLASS_LABELS[first.kind] ?? first.kind
    const rule = suggestRule(first, 'allow')
    const outOfScope = typeof first.escalateWhy === 'string' && first.escalateWhy.includes('越界')
    return `语句「${first.text}」不可自动升级（${first.escalateWhy ?? label}）`
      // A path that the file sandbox already governs is a better thing to
      // authorize than a command shape — granting the directory means the
      // command never gets denied, so no escalation is ever requested.
      + (outOfScope && first.outside?.length > 0
        ? `；若该目录可信，更推荐把它加入「沙箱授权 → 授权目录」（${first.outside[0]}），这样命令根本不会被沙箱拒绝`
        : '')
      + (rule !== null ? `；如确认可信，也可添加规则 ${rule}（allow 会允许该命令在沙箱外运行）` : '')
  }
  return null
}

/**
 * Record why one statement is or is not escalatable (for the trace).
 * @param statement - the trace entry.
 * @param escalatable - the verdict.
 * @param why - the explanation.
 */
function markEscalatable(statement, escalatable, why) {
  statement.escalatable = escalatable
  statement.escalateWhy = why
}

/**
 * Whether an action means "do not prompt for this statement".
 * @param action - a rule action.
 * @returns `true` for `allow`.
 */
export function isAllowAction(action) {
  return action === 'allow'
}

/**
 * Canonical form of a command, used as the session-cache key: whitespace
 * collapsed, case folded where the platform folds program names, and quote
 * style normalized so that `git  status` and `git status` share one entry.
 * @param command - the raw command string.
 * @returns the canonical key (or `''`).
 */
export function canonicalCommandKey(command) {
  return normalizeCommand(command).replace(/["']/g, '')
}

/** Re-exported so callers do not need to import the rules module directly. */
export { SEGMENT_CLASSES, describeRule }
