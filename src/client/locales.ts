/**
 * `dsh-sandbox-allowlist` locale namespace dictionaries (browser half).
 *
 * zh is the key-set source of truth and en mirrors it key-for-key — the typed
 * `ctx.locale.register(NS, { zh, en })` call enforces both at compile time.
 * The host's locale service resolves a key by walking the active locale's
 * fallback chain, which always ends at `en` (see @deepseek-ai/dsh-client-locale
 * `fallbackChain`), so an English string is served on any non-Chinese host
 * without the plugin choosing a language itself.
 *
 * i18n 词典来自 Bernd Weymann（GitHub: @weymann）的贡献：其将本仓库 fork 为
 * https://github.com/weymann/dsh-sandbox-allowlist 并在提交 b814e0f
 * （"dsh 0.1.7-rc.2 update"）中新增了本文件与客户端词典化改造，本仓库采纳该
 * 实现；在此基础上扩展了 0.2.0 特有界面的键（插件面板摘要、只读降级与保存
 * 失败文案、provider 平台提示、重置按钮 title），见「local extensions」分组。
 *
 * @module dsh-sandbox-allowlist/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sandbox-allowlist'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  // ── 授权目录卡片 ────────────────────────────────────────────────────────────
  'dirs.warn': '安全警示：授权目录会被沙箱内的 AI 代理<b>无审批</b>写入（工作区之外），请勿配置存储重要文件的目录。',
  'dirs.hint': '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Archive\\202?（单字符）。',
  'dirs.validateHint': '校验规则：Windows 路径或通配符；非法条目会在保存前标红提示，不会静默丢弃。',
  'dirs.name': '授权目录',
  'dirs.desc': '允许沙箱内代理直接写入的工作区外目录；仍受文件沙箱约束，写入无需审批。',
  'dirs.fieldLabel': '工作区外的受信可写目录',
  'dirs.empty': '尚未授权任何目录。点击「添加目录」新增一行。',
  'dirs.placeholder': 'D:\\Shared\\Tools',
  'dirs.rowAria': '授权目录 {index}',
  'dirs.add': '添加目录',
  'dirs.delete': '删除',
  'dirs.deleteTitle': '删除该目录',
  'dirs.save': '保存目录',
  'dirs.count': '{count} 个目录',
  'dirs.countPending': ' · {count} 处未保存',

  // ── 命令规则卡片 ────────────────────────────────────────────────────────────
  'cmd.defaultHint': 'delegate 表示维持 dsh 现有行为（按需询问）；allow / ask / deny 会覆盖未命中命令的处理。',
  'cmds.hint': '命令模式支持 <code>*</code>（任意多字符）与 <code>?</code>（单字符），如 <code>git status*</code>；'
    + '程序名自动去掉路径、引号与 <code>.exe</code> 类后缀再参与匹配。'
    + '按「每条独立命令」判定（复合命令按 <code>;</code> / <code>&amp;&amp;</code> / <code>|</code> 拆开分别匹配），最后一条命中的规则生效。<br>'
    + '动作：<code>allow</code>=放行（<b>含允许它在沙箱外运行</b>）；<code>ask</code>=弹审批；<code>deny</code>=拦截。',
  'cmds.tailHint': '空白行不会保存；工具留空（任意）时规则对所有 shell 工具生效。写工作区之外的路径请用「授权目录」，命令规则覆盖不了越界写入。',
  'cmds.escalationHint': '沙箱升级 = 命令被沙箱拒绝后，AI 带 sandbox_permissions 重试、命令将在沙箱外运行的那次审批。'
    + '开启后：命中 allow 规则的命令、以及只读/只写工作区与授权目录内路径的命令（内置能力类），升级自动放行；'
    + '关闭后：所有升级都弹审批。越界写入、禁读目标、deny/ask 命中永远不自动放行。',
  'cmds.baselineHint': '开启后，只读命令与「只写工作区/授权目录内路径」的命令无需任何规则即可识别（这是内置基线，不是放行升级）。关闭后完全按你写的规则判定。',
  'cmds.sessionHint': '开启后，你手工批准过的某条命令（完全相同的命令文本）在本会话内不再重复询问——AI 反复重试同一条命令时只问一次。',
  'cmds.name': '命令规则',
  'cmds.desc': '按「命令模式 + 动作」放行 / 询问 / 拦截 shell 命令。',
  'cmds.defaultLabel': '未命中任何规则时的默认动作',
  'cmds.defaultAria': '未命中规则时的默认动作',
  'cmds.rulesLabel': '放行规则（按顺序匹配，最后一条命中生效）',
  'cmds.empty': '尚无命令规则。点击「添加规则」新增一行。',
  'cmds.patternAria': '命令模式',
  'cmds.patternPlaceholder': 'git *',
  'cmds.add': '添加规则',
  'cmds.actionAria': '动作',
  'cmds.removeAria': '删除规则',
  'cmds.removeTitle': '删除该规则',
  'cmds.escalationLabel': '沙箱升级',
  'cmds.escalationCheck': '允许沙箱升级自动放行',
  'cmds.advanced': '高级',
  'cmds.baselineLabel': '内置能力基线',
  'cmds.sessionLabel': '会话级命令缓存',
  'cmds.save': '保存命令规则',
  'cmds.count': '{count} 条规则',
  'cmds.countPending': ' · 未保存修改',

  // ── 禁读规则卡片 ────────────────────────────────────────────────────────────
  'noread.hint': 'pattern 支持 <code>*</code>（任意多个字符）与 <code>?</code>（单个字符）。'
    + '不含路径分隔符 ⇒ 按文件名匹配任意目录深度（<code>*.pem</code>、<code>.env*</code>、<code>id_rsa*</code>）；'
    + '含分隔符 ⇒ 按完整路径匹配（<code>D:\\Vault\\**\\*.key</code> 之类）。'
    + '目录级：写绝对目录路径（如 <code>D:\\Vault</code>）或末尾加 <code>/**</code>，整棵子树（含目录列表）禁读。',
  'noread.tailHint': '空 pattern 的行不会保存。不提供 allow 动作——官方默认本就允许读；'
    + '想临时放行某个命中文件，把该条动作配成 ask（弹一次人工审批）。',
  'noread.name': '禁读规则',
  'noread.desc': '按文件名 / 路径模式限制读取：deny 直接拒绝，ask 命中时请求人工批准一次。',
  'noread.fieldLabel': '限制读取的文件模式（命中即按动作处理）',
  'noread.empty': '尚无禁读规则。点击「添加规则」新增一行。',
  'noread.patternAria': '禁读模式',
  'noread.patternPlaceholder': '*.pem',
  'noread.add': '添加规则',
  'noread.save': '保存禁读规则',
  'noread.count': '{count} 条规则',
  'noread.countPending': ' · 未保存修改',
  'noread.actionAria': '禁读动作',
  'noread.removeAria': '删除禁读规则',
  'noread.removeTitle': '删除该禁读规则',

  // ── 通用 ────────────────────────────────────────────────────────────────────
  'section.title': '沙箱授权',
  'section.intro': '配置沙箱内的目录操作、命令执行与文件读取限制，保存后立即生效。',
  'common.unsavedBadge': '未保存修改',
  'common.discard': '放弃修改',
  'common.saving': '保存中…',
  'common.any': '任意',
  'common.allowHint': 'allow：放行（含允许它在沙箱外运行）',
  'common.askHint': 'ask：弹审批',
  'common.denyHint': 'deny：拦截',

  // ── 校验与错误 ──────────────────────────────────────────────────────────────
  'validate.notString': '目录必须是字符串。',
  'validate.empty': '目录不能为空。',
  'validate.notAbsolute': '「{value}」不是绝对路径（需要盘符或根开始的路径）。',
  'validate.tooWide': '「{value}」锚定过宽（** 需要锚定至少一级具名目录）。',
  'error.validate': '校验失败：{message}',
  'error.validateMore': '（另有 {count} 处）',

  // ── local extensions（本仓库扩展：0.2.0 特有界面，上游词典没有的键）──────────
  'section.summary': '沙箱授权目录 / 命令放行 / 禁读规则 —— 与设置页「沙箱授权」分节是同一份配置。',
  'readonly.loading': '正在载入插件设置…',
  'readonly.unavailable': '宿主没有提供本插件的设置表单（条目未挂载或设置服务不可用），本页暂时只读。',
  'readonly.memory': '当前连接的配置为进程本地（memory）模式：官方写入通路只读，修改不会被写回宿主配置。请在宿主本机页面或配置文件中编辑。',
  'error.notWritable': '当前连接不可写。',
  'error.saveRejected': '保存被拒绝：配置已在别处修改（revision 冲突）或宿主未接受本次写入，请重新载入后再试。',
  'error.resetRejected': '恢复默认被拒绝：配置已在别处修改（revision 冲突）或宿主未接受本次写入，请重新载入后再试。',
  'common.resetOverrideTitle': '清除用户层覆盖，回到部署默认',
  'common.resetNotOverrideTitle': '当前未覆盖部署默认',
  'common.reset': '重置为默认',
  'provider.badge': '仅 Linux 生效',
  'provider.summary': '仅 Linux（bwrap）实际生效；Windows 空转，macOS 忽略授权目录。',
  'provider.notice': '此行是 Linux 专用扩展：只有在 Linux（bwrap 运行器）上才会把「授权目录」加入沙箱写白名单。Windows 上官方 ACL 沙箱保持原样，本行即使启用也自动空转、不产生任何效果；macOS（seatbelt）与其余运行器无法扩展，授权目录会被忽略并记录一次警告。',
}

/**
 * English dictionary (same key set as {@link zh}).
 *
 * HTML fragments (<code>/<b>) are preserved verbatim: these strings are rendered
 * with dangerouslySetInnerHTML by the cards.
 */
export const en = {
  // ── Authorized directories card ─────────────────────────────────────────────
  'dirs.warn': 'Security warning: sandboxed AI agents may write to authorized directories <b>without approval</b> (outside the workspace). Do not configure directories holding important files.',
  'dirs.hint': 'Wildcards are supported: D:\\Shared\\** (subtree), D:\\Data\\* (one level of subdirectories), D:\\Archive\\202? (single character).',
  'dirs.validateHint': 'Validation: Windows paths or wildcards; invalid entries are highlighted before saving and are never dropped silently.',
  'dirs.name': 'Authorized directories',
  'dirs.desc': 'Out-of-workspace directories the sandboxed agent may write to directly; still bounded by the file sandbox, and writes need no approval.',
  'dirs.fieldLabel': 'Trusted writable directories outside the workspace',
  'dirs.empty': 'No directory authorized yet. Click "Add directory" to create a row.',
  'dirs.placeholder': 'D:\\Shared\\Tools',
  'dirs.rowAria': 'Authorized directory {index}',
  'dirs.add': 'Add directory',
  'dirs.delete': 'Delete',
  'dirs.deleteTitle': 'Delete this directory',
  'dirs.save': 'Save directories',
  'dirs.count': '{count} directory(ies)',
  'dirs.countPending': ' · {count} unsaved',

  // ── Command rules card ──────────────────────────────────────────────────────
  'cmd.defaultHint': 'delegate keeps the current dsh behaviour (ask when needed); allow / ask / deny override how unmatched commands are handled.',
  'cmds.hint': 'Command patterns support <code>*</code> (any number of characters) and <code>?</code> (a single character), e.g. <code>git status*</code>. '
    + 'Program names are stripped of paths, quotes and <code>.exe</code>-style suffixes before matching. '
    + 'Matching is per individual command (compound commands are split on <code>;</code> / <code>&amp;&amp;</code> / <code>|</code> and matched separately), and the last matching rule wins.<br>'
    + 'Actions: <code>allow</code> = permit (<b>including running it outside the sandbox</b>); <code>ask</code> = prompt for approval; <code>deny</code> = block.',
  'cmds.tailHint': 'Blank rows are not saved; leaving the tool empty (any) makes the rule apply to every shell tool. To write outside the workspace use "Authorized directories" — command rules cannot cover out-of-bounds writes.',
  'cmds.escalationHint': 'Sandbox escalation = the approval for when a command was refused by the sandbox and the AI retries it with sandbox_permissions, which would run it outside the sandbox. '
    + 'When enabled: commands matching an allow rule, and commands that only read or only write inside the workspace and the authorized directories (built-in capability class), are escalated automatically. '
    + 'When disabled: every escalation prompts. Out-of-bounds writes, read-denied targets and deny/ask matches are never auto-approved.',
  'cmds.baselineHint': 'When enabled, read-only commands and commands that only write inside the workspace / authorized directories are recognised without any rule (this is the built-in baseline, not an escalation permit). When disabled, only the rules you wrote decide.',
  'cmds.sessionHint': 'When enabled, a command you approved by hand (the exact same command text) is not asked again in this session — the AI can retry the same command repeatedly and be asked only once.',
  'cmds.name': 'Command rules',
  'cmds.desc': 'Allow / ask / block shell commands by command pattern and action.',
  'cmds.defaultLabel': 'Default action when no rule matches',
  'cmds.defaultAria': 'Default action when no rule matches',
  'cmds.rulesLabel': 'Allow rules (matched in order; the last match wins)',
  'cmds.empty': 'No command rule yet. Click "Add rule" to create a row.',
  'cmds.patternAria': 'Command pattern',
  'cmds.patternPlaceholder': 'git *',
  'cmds.add': 'Add rule',
  'cmds.actionAria': 'Action',
  'cmds.removeAria': 'Delete rule',
  'cmds.removeTitle': 'Delete this rule',
  'cmds.escalationLabel': 'Sandbox escalation',
  'cmds.escalationCheck': 'Auto-approve sandbox escalations',
  'cmds.advanced': 'Advanced',
  'cmds.baselineLabel': 'Built-in capability baseline',
  'cmds.sessionLabel': 'Session-scoped command cache',
  'cmds.save': 'Save command rules',
  'cmds.count': '{count} rule(s)',
  'cmds.countPending': ' · unsaved changes',

  // ── Read restrictions card ──────────────────────────────────────────────────
  'noread.hint': 'Patterns support <code>*</code> (any number of characters) and <code>?</code> (a single character). '
    + 'Without a path separator ⇒ matched against the file name at any depth (<code>*.pem</code>, <code>.env*</code>, <code>id_rsa*</code>); '
    + 'with a separator ⇒ matched against the full path (such as <code>D:\\Vault\\**\\*.key</code>). '
    + 'Directory-wide: write an absolute directory path (e.g. <code>D:\\Vault</code>) or append <code>/**</code> to deny the whole subtree, listing included.',
  'noread.tailHint': 'Rows with an empty pattern are not saved. There is no allow action — reading is permitted by default upstream; '
    + 'to grant one matching file temporarily, set that row to ask (which prompts once for manual approval).',
  'noread.name': 'Read restrictions',
  'noread.desc': 'Restrict reads by file name / path pattern: deny refuses outright, ask requests manual approval when matched.',
  'noread.fieldLabel': 'File patterns to restrict reading (a match is handled by the action)',
  'noread.empty': 'No read restriction yet. Click "Add rule" to create a row.',
  'noread.patternAria': 'Read-denied pattern',
  'noread.patternPlaceholder': '*.pem',
  'noread.add': 'Add rule',
  'noread.save': 'Save read restrictions',
  'noread.count': '{count} rule(s)',
  'noread.countPending': ' · unsaved changes',
  'noread.actionAria': 'Read-restriction action',
  'noread.removeAria': 'Delete read restriction',
  'noread.removeTitle': 'Delete this read restriction',

  // ── Shared ──────────────────────────────────────────────────────────────────
  'section.title': 'Sandbox authorization',
  'section.intro': 'Configure in-sandbox directory access, command execution and file-read restrictions; changes take effect on save.',
  'common.unsavedBadge': 'Unsaved changes',
  'common.discard': 'Discard changes',
  'common.saving': 'Saving…',
  'common.any': 'Any',
  'common.allowHint': 'allow: permit (including running it outside the sandbox)',
  'common.askHint': 'ask: prompt for approval',
  'common.denyHint': 'deny: block',

  // ── Validation and errors ───────────────────────────────────────────────────
  'validate.notString': 'A directory must be a string.',
  'validate.empty': 'A directory cannot be empty.',
  'validate.notAbsolute': '"{value}" is not an absolute path (it must start with a drive letter or a root).',
  'validate.tooWide': '"{value}" is anchored too broadly (** needs at least one named directory level).',
  'error.validate': 'Validation failed: {message}',
  'error.validateMore': ' ({count} more)',

  // ── local extensions (this fork: 0.2.0-only surfaces absent upstream) ───────
  'section.summary': 'Authorized directories / command allow-list / read restrictions — the same configuration as the "Sandbox authorization" section in the settings page.',
  'readonly.loading': 'Loading plugin settings…',
  'readonly.unavailable': 'The host does not serve this plugin\'s settings form (entry not mounted or settings service unavailable); this page is read-only for now.',
  'readonly.memory': 'The current connection runs in process-local (memory) mode: the official write path is read-only and changes are not written back to the host configuration. Edit on the host\'s own page or in its configuration file.',
  'error.notWritable': 'The current connection is not writable.',
  'error.saveRejected': 'The save was rejected: the configuration changed elsewhere (revision conflict) or the host did not accept the write. Reload and try again.',
  'error.resetRejected': 'Resetting to the default was rejected: the configuration changed elsewhere (revision conflict) or the host did not accept the write. Reload and try again.',
  'common.resetOverrideTitle': 'Clear the user-layer override and return to the deployment default',
  'common.resetNotOverrideTitle': 'The deployment default is not overridden',
  'common.reset': 'Reset to default',
  'provider.badge': 'Linux only',
  'provider.summary': 'Only takes effect on Linux (bwrap); on Windows this row is inert, and macOS ignores authorized directories.',
  'provider.notice': 'This row is a Linux-only extension: only on Linux (the bwrap runner) are authorized directories added to the sandbox write allow-list. On Windows the official ACL sandbox stays as-is and this row is inert even when enabled; macOS (seatbelt) and other runners cannot be extended — authorized directories are ignored with a one-time warning.',
}

/** Every key the namespace serves; `en` is checked complete against it. */
export type LocaleKey = keyof typeof zh
