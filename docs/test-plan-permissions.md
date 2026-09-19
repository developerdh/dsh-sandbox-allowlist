# 权限配置测试方案（dsh-sandbox-allowlist）

> **用途**：本方案供会话中的执行 agent 对插件的三类权限配置（授权目录 `allowedDirs` /
> 命令规则 `commands` / 禁读规则 `noRead`）做端到端测试验证。命令规则部分覆盖各种
> 复合、混合命令形态（`;` `&&` `&` `||` `|` 链、`$()`/反引号替换、heredoc、重定向、
> env 前缀、元程序展开、fail-closed 结构、宽规则形状等）。
>
> **适用版本**：v0.3.0-beta.2 及以上（单层 `allow` = 放行**并含沙箱升级授权**的语义；
> 规则只有 `pattern` 一种选择器）。测试实现语义请先读 `README.md` 的
> 「命令放行」与「禁读规则」章节。
>
> **如何在会话中引用**：给执行 agent 下达类似指令即可——
> 「阅读 `<repo>/docs/test-plan-permissions.md`，按方案执行权限配置测试验证，
> 测试目录使用 `<测试目录>`；先做阶段 A/B，阶段 C 需在 dsh web 运行时进行。」

**占位符约定**（执行前替换为真实值；替换后的真实路径**不得**写进任何提交的文档，
见仓库 `AGENTS.md`）：

| 占位符 | 含义 | 建议取值（示例，请替换） |
|---|---|---|
| `<repo>` | 本仓库的绝对路径（正斜杠） | 部署目录 junction 指向的仓库位置 |
| `<测试目录>` | 本次测试专用的根目录 | `%USERPROFILE%\dsh-perm-test` 之类新建目录 |
| `<DSH_HOME>` | dsh 配置目录（settings.yaml 所在处） | `$DSH_HOME` 环境变量或默认 `~/.dsh` |

---

## 0. 安全红线（执行任何测试前必读，违反任何一条立即停止）

1. **一切写操作只落在测试目录内**。被派发的 shell 命令、探针脚本、示例文件，
   其读写与执行效果只允许触及 `<测试目录>` 之下的路径；`<测试目录>` 必须是本次
   测试新建/专用的目录。
2. **禁止触碰测试目录之外的内容**：不写、不删、不移动、不重命名用户目录、系统
   目录、其他项目目录中的任何文件；`rm`/`del`/`Remove-Item`/`format` 等破坏性命令
   只允许指向 `<测试目录>` 内的一次性子目录（本方案中它们多数只被引擎判定、并不
   真执行）。
3. **配置修改只允许两处，且都可回滚**：
   - `$DSH_HOME/settings.yaml` 的 `sandbox-allowlist` 段（**改前必须备份**，见 §1.3）；
   - `<测试目录>` 内的任意文件。
   不修改 dsh profile 结构、不卸载/重装插件、不关闭沙箱、不改 git 全局配置。
4. **只读例外**（允许不经测试目录）：读取 `$DSH_HOME` 下的决策日志
   `sandbox-allowlist-decisions.jsonl` 与规则提案 `sandbox-allowlist-proposals.json`
   （验证需要）；探针脚本对 `<repo>/lib` 的模块导入（纯读取）。
5. **canary 纪律**：复合命令里的"危险 rider"一律用 `whoami` 等无害只读命令代替，
   与仓库对抗矩阵（`test/verify-command-matrix.mjs`）同一纪律；示例文件内容一律用
   `dummy` 假数据，**不放任何真实凭据/个人数据**。
6. 每个阶段结束后核对一次：测试目录之外没有产生新文件；若发现越界写入，立即
   记录并停止测试，报告给用户。

---

## 1. 测试环境准备

### 1.1 前置检查

- [ ] dsh web 已用本仓库代码启动过至少一次（工作区经 junction + `link:` 挂进
  profile，**改 `lib/*.mjs` 后必须重启**才生效；仅改设置实时生效）；
- [ ] 会话沙箱模式为 `workspace-write`（`allowedDirs` 与 noRead 在
  `danger-full-access` 下不生效，`read-only` 下全拒写）；
- [ ] `node --version` 可用（≥ 18，需 ESM 顶层 await）。

### 1.2 创建测试目录结构

在 `<测试目录>` 下创建（阶段 C 才真正用到文件；阶段 A/B 不依赖目录存在）：

```
<测试目录>/
├── ws/                  # 用作会话工作区（in-scope）
│   ├── scripts/demo.js  # C6 用：console.log('perm-test demo ok')
│   └── package.json     # C6 用：{"name":"perm-test","private":true,"scripts":{"test":"node ./scripts/demo.js"}}
├── allowed/             # 将配置为授权目录（in-scope，沙箱可直接写）
├── outside/             # 不授权（out-of-scope，越界写轨道的靶子）
└── secret/              # 禁读靶场（阶段 C 放 dummy 文件：id.pem / .env / notes.txt）
```

若阶段 C 要观察 git 类命令的真实行为，在 `ws` 内初始化一个**本地**仓库
（不配远端，不会真推送）：

```bash
cd <测试目录>/ws && git init -q
git -c user.name=tester -c user.email=test@example.com commit -q -m init --allow-empty
```

### 1.3 备份设置（阶段 C 前置）

```bash
cp <DSH_HOME>/settings.yaml <DSH_HOME>/settings.yaml.bak-permtest
```

确认备份存在后再进行 §4 的配置注入。清理时用它还原（见 §6）。

---

## 2. 阶段 A —— 仓库自检（离线，8 套件）

在 `<repo>` 下执行（自带测试自管理临时文件，无需测试目录）：

```bash
npm test && npm run test:dry-mount && npm run test:patch \
  && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client
```

**通过标准**：8 个套件全部通过；`test:matrix` 输出 `44 rows, 0 mismatches`；
`test:patch` 输出包含 `plugin is mounted in the profile (4 patches, last layer)`
（未挂载 profile 的环境输出会不同，记录即可，不算失败）。

任何套件失败 ⇒ 先修复再继续，不要带着红测试往下走。

---

## 3. 阶段 B —— 命令规则引擎探针（核心：复杂/混合命令矩阵）

### 3.1 探针说明

- **零执行风险**：探针只调用判定引擎（`lib/command-decision.mjs`）做纯字符串解析，
  不会真的运行任何被测命令、不读写任何文件（package.json 清单与禁读命中都是内存桩）。
  因此本阶段天然满足 §0 红线。
- 每行用例同时断言**两个相位**：沙箱相位（`allow/ask/deny/delegate`）与升级相位
  （`AUTO`=自动放行升级 / `manual`=弹人工审批）。
- 期望值已按当前实现逐一校准（50/50）；若你的运行结果失配，说明实现或环境与
  方案假设不一致，按 §3.3 排查，**不要改期望值凑通过**。

### 3.2 探针脚本

将下面整段保存为 `<测试目录>/probe.mjs`，把顶部 `REPO` / `T` 两个占位符替换为
真实绝对路径（正斜杠），然后 `node <测试目录>/probe.mjs`。

```js
/**
 * dsh-sandbox-allowlist 权限引擎探针 —— 复杂/混合命令判定矩阵（阶段 B）
 *
 * 零执行风险：本脚本只调用判定引擎做纯字符串解析，不会真的运行任何被测命令，
 * 也不读写任何文件（package.json 清单与禁读命中均为内存桩）。
 *
 * 使用前替换两个占位符：
 *   REPO —— 本仓库的绝对路径（正斜杠），引擎模块从这里导入；
 *   T    —— 测试目录的绝对路径（正斜杠），与测试方案 §1.2 创建的目录一致。
 * 运行：node <测试目录>/probe.mjs   （期望输出：全部通过 (50/50)）
 */
const REPO = '<repo>'
const T = '<测试目录>'

import { pathToFileURL } from 'node:url'
const { decide } = await import(pathToFileURL(`${REPO}/lib/command-decision.mjs`))
const { makeScriptExpander } = await import(pathToFileURL(`${REPO}/lib/command-expand.mjs`))

// 与测试方案 §4.1 真机配置一致的判定上下文：
//   ws = 工作区（in-scope），allowed = 授权目录（in-scope），其余一律 out-of-scope。
const context = { roots: [`${T}/ws`, `${T}/allowed`], cwd: `${T}/ws` }
// 元程序展开桩：等价于 ws 里存在这样的 package.json（真机验证见 §4 阶段 C）
const manifest = JSON.stringify({ scripts: { docs: 'git log --oneline -3', deploy: 'node ./scripts/deploy.js' } })
const expandScript = makeScriptExpander({ workspaceRoot: `${T}/ws`, readFile: () => manifest, onWarn: () => {} })
// 禁读桩：等价于 noRead 规则 `*.pem → deny`
const noRead = (path) => (path.toLowerCase().endsWith('.pem') ? { pattern: '*.pem', action: 'deny' } : null)
const CTX = { ...context, expandScript, noRead }

// 三套规则源：
//   A 窄规则（主矩阵）  B 宽规则变体（宽 pattern 的代价）  C 加了 cat * 的变体（验证 noRead 轨道不被 allow 覆盖）
const NARROW = [
  { pattern: 'pnpm test*', action: 'allow' },
  { pattern: 'git status*', action: 'allow' },
  { pattern: 'git push*', action: 'ask' },
  { pattern: 'echo *', action: 'allow' },
  { pattern: 'rm -rf *', action: 'deny' },
  { pattern: 'whoami*', action: 'deny' },
]
const SOURCES = {
  A: { rules: NARROW, default: 'delegate', escalation: 'capability', baseline: true },
  B: { rules: [...NARROW, { pattern: 'git *', action: 'allow' }, { pattern: 'pnpm *', action: 'allow' }], default: 'delegate', escalation: 'capability', baseline: true },
  C: { rules: [...NARROW, { pattern: 'cat *', action: 'allow' }], default: 'delegate', escalation: 'capability', baseline: true },
}

// 每行：[规则源, 工具, 命令, 期望沙箱判定, 期望升级自动放行, 语义点]
// 期望沙箱 ∈ allow|ask|deny|delegate；期望升级 = true(AUTO)/false(manual)
const isWin = process.platform === 'win32'
const CASES = [
  // ── G1 基础匹配 ────────────────────────────────────────────────────────
  ['A', 'bash', 'git status --porcelain', 'allow', true, '规则 git status* 命中'],
  ['A', 'bash', 'git status', 'allow', true, '零长度尾部也匹配（status* 覆盖裸 status）'],
  ['A', 'bash', 'git push origin main', 'ask', false, '规则要求审批'],
  ['A', 'bash', 'git log -5', 'allow', true, '无规则，内置基线识别只读'],
  ['A', 'bash', 'rm -rf ./junk', 'deny', false, 'deny 规则直接拦截'],
  ['A', 'bash', 'npx some-pkg', 'delegate', false, '无规则且非良性 ⇒ 维持现状'],
  ['A', 'bash', 'gitdb status', 'delegate', false, '模式锚定开头，gitdb 不是 git'],
  ['A', 'pwsh', 'GIT STATUS', isWin ? 'allow' : 'delegate', isWin, 'Windows 大小写不敏感（POSIX 敏感）'],
  ['A', 'bash', 'git branch -D feature', 'delegate', false, '大小写敏感标志 -D 判为破坏性，无规则不放行'],
  // ── G2 程序名归一化 ────────────────────────────────────────────────────
  ['A', 'pwsh', '"C:/Program Files/Git/git.exe" status', 'allow', true, '带引号全路径 + .exe 归一化为 git status'],
  ['A', 'pwsh', '& git status --porcelain', 'allow', true, 'pwsh 调用运算符 & 被跳过'],
  ['A', 'pwsh', '"C:/Program Files/Git/git.exe" status && "C:/Program Files/Git/git.exe" push', 'ask', false, '复合 + 归一化：第二段命中 ask'],
  // ── G3 复合/混合拆分 ───────────────────────────────────────────────────
  ['A', 'bash', 'git status; whoami', 'deny', false, '; 链中 deny rider 不被 allow 前缀掩盖'],
  ['A', 'bash', 'git status && whoami', 'deny', false, '&& 链'],
  ['A', 'bash', 'git status & whoami', 'deny', false, '单 & 也是分隔符'],
  ['A', 'bash', 'git status || whoami', 'deny', false, '|| 链'],
  ['A', 'bash', 'git status | whoami', 'deny', false, '管道同样分段'],
  ['A', 'bash', 'pnpm test\nwhoami', 'deny', false, '换行分隔'],
  ['A', 'bash', 'git status && git log -3', 'allow', true, '全良性/命中规则的复合整体放行'],
  ['A', 'bash', 'echo one; echo two', 'allow', true, '多段全命中 echo *'],
  ['A', 'bash', 'echo a && echo b || whoami', 'deny', false, '混合链尾部 rider'],
  ['A', 'bash', 'pnpm test & git status', 'allow', true, '后台 & + 规则段'],
  // ── G4 替换体递归判定 ──────────────────────────────────────────────────
  ['A', 'bash', 'echo $(whoami)', 'deny', false, '$() 替换体被单独判定'],
  ['A', 'bash', 'echo `whoami`', 'deny', false, '反引号等价替换'],
  ['A', 'pwsh', 'Write-Output $(whoami)', 'deny', false, 'pwsh 子表达式同待遇'],
  ['A', 'bash', 'echo $(git status --porcelain)', 'allow', true, '良性替换体不拖累整体'],
  ['A', 'bash', 'echo $(echo $(whoami))', 'deny', false, '嵌套替换最内层 deny 仍命中'],
  ['A', 'bash', 'git commit -m "$(date +%F)"', 'allow', true, '参数内替换体良性 + 工作区写'],
  ['A', 'bash', 'git commit -m $(whoami)', 'deny', false, '参数内替换体命中 deny'],
  // ── G5 fail-closed 结构 ────────────────────────────────────────────────
  ['A', 'bash', 'diff <(whoami) x', 'delegate', false, '进程替换解析不了 ⇒ 回落人工'],
  ['A', 'bash', 'pnpm test "unbalanced', 'delegate', false, '引号不配对 ⇒ 回落人工'],
  ['A', 'bash', 'echo $((1+1))', 'delegate', false, '$(( 算术展开解析不了 ⇒ 回落人工'],
  ['A', 'bash', 'echo $(echo $(echo $(whoami)))', 'deny', false, '深层嵌套仍能递归判定'],
  // ── G6 重定向 ──────────────────────────────────────────────────────────
  ['A', 'bash', 'git status > ./probe-out.txt', 'allow', true, '工作区内重定向'],
  ['A', 'bash', 'git status 2>&1', 'allow', true, 'fd 复制无害'],
  ['A', 'bash', 'git status 2> ./err.txt', 'allow', true, 'stderr 工作区内'],
  ['A', 'bash', 'echo x > ../outside/escape.txt', 'allow', false, '轨道②：沙箱内放行但升级被越界重定向拦住'],
  ['A', 'pwsh', 'pnpm test 2>&1 | Select-Object -Last 20', 'allow', true, 'pwsh 管道无需逐 cmdlet 枚举'],
  // ── G7 环境变量前缀 ────────────────────────────────────────────────────
  ['A', 'bash', 'FOO=bar git status --porcelain', 'allow', true, 'env 前缀只拦能力类兜底，不拦显式规则'],
  ['A', 'bash', 'FOO=bar npx some-pkg', 'delegate', false, 'env 前缀挡住基线 ⇒ 维持现状'],
  // ── G8 heredoc ─────────────────────────────────────────────────────────
  ['A', 'bash', 'cat <<EOF > ./note.txt\nhello\nEOF\n', 'allow', true, 'heredoc 正文按数据，重定向在工作区内'],
  // ── G9 元程序展开（package.json 桩） ───────────────────────────────────
  ['A', 'bash', 'pnpm docs', 'allow', true, '展开为 git log：按真实内容判定为良性'],
  ['A', 'bash', 'pnpm deploy', 'delegate', false, '展开为 node：不可见代码，保守拦截'],
  ['A', 'bash', 'pnpm test', 'allow', true, '规则命中容器：授权覆盖展开体'],
  ['A', 'bash', 'pnpm unknown-script', 'delegate', false, '脚本名不存在 ⇒ 保守不自动放行'],
  // ── G10 升级轨道与宽规则形状 ───────────────────────────────────────────
  ['A', 'bash', 'mkdir ../outside/x', 'delegate', false, '轨道②：越界写，无规则兜底'],
  ['A', 'bash', 'cat ../secret/id.pem', 'delegate', false, '轨道③：noRead 目标，绝不自动升级'],
  ['C', 'bash', 'cat ../secret/id.pem', 'allow', false, '方案 A：allow 规则不覆盖 noRead 轨道（升级仍 manual）'],
  ['A', 'bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', 'delegate', false, '窄规则不命中 ⇒ 协议注入无授权'],
  ['B', 'bash', 'git -c protocol.ext.allow=always ext::sh -c "whoami"', 'allow', true, '⚠️ 宽规则 git * 连协议注入一起授权（预期语义，非漏洞）'],
]

let failures = 0
for (const [group, tool, command, wantSandbox, wantEscalate, note] of CASES) {
  const source = SOURCES[group]
  const sandbox = decide({ source, tool, command, phase: 'sandbox', context: CTX })
  const escalation = decide({ source, tool, command, phase: 'escalation', context: CTX })
  const gotSandbox = sandbox.verdict
  const gotEscalate = escalation.escalate === true
  const ok = gotSandbox === wantSandbox && gotEscalate === wantEscalate
  if (!ok) failures += 1
  const label = `${tool} ${command.replace(/\n/g, '\\n')}`
  console.log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${label}`)
  if (!ok) {
    console.log(`     期望 sandbox=${wantSandbox} escalate=${wantEscalate}，实际 sandbox=${gotSandbox} escalate=${gotEscalate}`)
    console.log(`     语义点：${note}`)
    console.log(`     引擎原因：${sandbox.reason ?? ''} / ${escalation.reason ?? ''}`)
  }
}
console.log('-'.repeat(72))
if (failures > 0) {
  console.log(`探针结果：${CASES.length - failures}/${CASES.length} 通过，${failures} 处失配 —— 按上方"引擎原因"排查`)
  process.exitCode = 1
} else {
  console.log(`探针结果：全部通过 (${CASES.length}/${CASES.length})`)
}
```

### 3.3 运行、判定与排查

**通过标准**：`探针结果：全部通过 (50/50)`，退出码 0。

失配时的排查顺序：

1. 看失配行的「引擎原因」——升级相位的原因会写明是哪条轨道（越界/禁读/deny/ask）
   或哪个能力类；
2. 确认占位符替换正确（`T` 必须与规则源里的 roots 一致，否则 in/out-of-scope 全错）；
3. 确认平台：`GIT STATUS` 一行在 POSIX 上期望就是 `delegate`（脚本已按平台自适应）；
4. 全部排除后仍失配 ⇒ 实现语义发生了变化：停下，把失配清单报告给用户，
   由用户决定是改实现还是改方案。

### 3.4 用例分组与语义点速览

| 组 | 覆盖点 | 行数 |
|---|---|---|
| G1 | 基础 pattern 匹配：前缀锚定、零长尾部、ask/deny、基线只读、未知程序、大小写（按平台）、大小写敏感标志 | 9 |
| G2 | 程序名归一化：带引号全路径 + `.exe`、pwsh `&` 调用符、归一化 × 复合命令组合 | 3 |
| G3 | 复合/混合拆分：`;` `&&` `&` `||` `|` 换行；deny rider 不被 allow 前缀掩盖；全良性复合放行 | 10 |
| G4 | 替换体递归：`$()`、反引号、pwsh 子表达式、嵌套、参数内替换（良性与 deny 各一） | 7 |
| G5 | fail-closed：进程替换 `<(...)`、引号不配对、`$((`，以及深层嵌套仍可解析的对照 | 4 |
| G6 | 重定向：工作区内 `>`/`2>&1`/`2>`、**越界重定向（轨道②：沙箱放行但升级拦下）**、pwsh 管道 | 5 |
| G7 | env 前缀：只拦能力类兜底、不拦显式规则（新语义） | 2 |
| G8 | heredoc 正文按数据 + 工作区内重定向 | 1 |
| G9 | 元程序展开：良性脚本体放行、opaque 脚本体拦截、规则覆盖展开体、未知脚本保守 | 4 |
| G10 | 升级轨道与宽规则：越界写、noRead 轨道（allow 不覆盖）、git 协议注入 × 窄/宽规则对照 | 5 |

---

## 4. 阶段 C —— 真机端到端验证（需 dsh web 运行中）

> 本阶段会把 §4.1 的测试配置注入 `$DSH_HOME/settings.yaml` 并在 dsh 会话里真实
> 派发命令。**所有被派发命令的路径都必须落在 `<测试目录>` 内**（§0 红线）。
> 每条用例完成后在 §5 记录表打勾；「观察」里提到的决策日志为只读查看。

### 4.1 注入测试配置

编辑 `<DSH_HOME>/settings.yaml`，将 `sandbox-allowlist:` 段替换为（保留该段之外
的其他内容不动）：

```yaml
sandbox-allowlist:
  allowedDirs: []          # C9 会临时改成 [ '<测试目录>\allowed' ]
  commands:
    default: delegate
    escalation: capability
    baseline: true
    sessionCache: true
    rules:
      - pattern: 'git status*'
        action: allow
      - pattern: 'git push*'
        action: ask
      - pattern: 'rm -rf *'
        action: deny
      - pattern: 'whoami*'
        action: deny
      - pattern: 'pnpm test*'
        action: allow
  noRead:                  # C10 前 注入；Windows 用反斜杠（YAML 单引号内字面），POSIX 用正斜杠
    - pattern: '*.pem'
      action: deny
    - pattern: 'id_rsa*'
      action: deny
    - pattern: '.env*'
      action: deny
```

保存即实时生效，无需重启。确认 `<测试目录>\secret` 下已放好 dummy 文件
（`id.pem`、`.env`、`notes.txt`，内容均为 `dummy`）。

### 4.2 命令规则行为观察

会话工作区切到 `<测试目录>\ws`。每条用例：**操作**（让会话里的 AI 执行的命令）→
**预期观察**。

| # | 操作 | 预期观察（通过标准） |
|---|---|---|
| C1 | `git status --porcelain` | 直接执行，无审批弹窗 |
| C2 | `git push origin main` | 弹命令审批（规则 ask）；选择**拒绝**；ws 无远端，即使批准也不会真推送 |
| C3 | 先在 ws 建空目录 `junk/`，再执行 `rm -rf ./junk` | 被 deny 规则直接拦截、命令未执行（`junk/` 仍在） |
| C4 | `git status && whoami` | 整体被拦（第二段命中 `whoami*` deny），两段都未执行 |
| C5 | `git add -A` | 免询问执行（无规则命中，基线识别为工作区内写入） |
| C6 | `pnpm test` | 免询问执行、脚本输出 `perm-test demo ok`；决策日志中该命令升级相位 `escalate:true`（规则 `pnpm test*` 含升级授权） |

### 4.3 授权目录写边界

| # | 操作 | 预期观察 |
|---|---|---|
| C7 | 执行 `echo test > <测试目录>/outside/a.txt`（未授权目录） | 沙箱拒绝 → AI 自动带 sandbox_permissions 重试 → 弹**升级审批**，弹窗含 `[sandbox-allowlist]` 解释（越界写，轨道②）与建议规则；**选择拒绝** |
| C8 | 把 `allowedDirs` 临时配置为 `[ '<测试目录>\allowed' ]`，然后执行 `echo test > <测试目录>/allowed/a.txt` | 直接成功，**无任何审批**——目录授权后沙箱直接放行，根本不产生升级请求（"按路径授权优于命令规则"） |

### 4.4 禁读规则（工具层）

在配置了 §4.1 noRead 规则的前提下，让 AI 用**自带文件工具**操作 `<测试目录>\secret`：

| # | 操作 | 预期观察 |
|---|---|---|
| C9 | read 工具读 `secret/id.pem` | 直接拒绝（fs 栅栏，报 `FS_READ_DENIED` 类错误） |
| C10 | edit 工具改 `secret/.env` | 拒绝（edit 隐含先读） |
| C11 | listDir 列 `secret/` | 此前未配目录级规则 ⇒ **可以列出**（文件名级规则不拦列表）；随后在 noRead 里补一条目录级规则 `'<测试目录>\secret'`（绝对路径、无通配符）再列 ⇒ 拒绝 |
| C12 | write 工具**新建** `secret/new-dummy.txt` | 允许（禁的是读不是写） |
| C13 | read 工具读 `ws/notes.txt`（无规则命中的普通文件） | 正常读取 |
| C14 | shell 执行 `cat <测试目录>/secret/id.pem` | **拦不住**（诚实边界：shell 子进程不经工具层），能读出 `dummy`——这是记录在案的已知边界，不是漏洞 |

> C10 的升级轨道交互（命令引用禁读目标时即使有 allow 规则也不自动升级）无法在
> 真机稳定触发（读命令不会引发沙箱拒绝），由阶段 B 探针 G10 的 C 组用例覆盖。

### 4.5 会话缓存与规则提案

| # | 操作 | 预期观察 |
|---|---|---|
| C15 | 重做 C7，这次在升级弹窗**手工批准**；随后再次执行完全相同的命令 | 第二次不再弹窗（会话级缓存命中）；改一个参数（如换个文件名） ⇒ 又弹（任何参数变化都是新命令） |
| C16 | 查看（只读）`<DSH_HOME>/sandbox-allowlist-proposals.json` | 手工批准同一形状 ≥ 2 次后出现对应提案（`action` 恒为 `allow`）；同时决策日志 `<DSH_HOME>/sandbox-allowlist-decisions.jsonl` 中能找到每条判定的 reason 与逐语句能力类 |

### 4.6 设置页 UI 抽查（可选，需浏览器）

打开设置页「沙箱授权」分节：命令规则卡片应为一行一个 **命令模式输入** +
`allow/ask/deny` 三档动作分段（无「程序（可选）」输入、无 `allow↑`）；一个可见的
「允许沙箱升级自动放行」勾选框；「内置能力基线」「会话级命令缓存」收在默认折叠的
「高级」区里。改一条规则保存 ⇒ 不重启即可在 C1/C2 类用例上看到行为变化。

---

## 5. 结果记录

执行 agent 按下表汇报（每行：通过/失败/跳过 + 一句备注；失败必须附引擎原因或
弹窗原文）：

| 用例 | 结果 | 备注 |
|---|---|---|
| 阶段 A：8 套件 |  | matrix 44 行 0 失配；test:patch 输出 |
| 阶段 B：探针 50/50 |  | 失配行附「引擎原因」 |
| C1–C6 命令规则 |  | 逐条 |
| C7–C8 授权目录/升级轨道 |  |  |
| C9–C14 禁读规则 |  |  |
| C15–C16 缓存与提案 |  |  |
| C17 设置页抽查（可选） |  |  |
| 红线自查（§0.6：测试目录外无新文件） |  |  |

整体**通过标准**：阶段 A/B 全绿；C1–C16 无失败（标"跳过"的须写明环境原因，
如非 Windows 环境跳过 ACE 相关观察）。

---

## 6. 清理与恢复

1. 用 §1.3 的备份还原设置：`cp <DSH_HOME>/settings.yaml.bak-permtest <DSH_HOME>/settings.yaml`
   （若测试期间 settings.yaml 又被别处改过，改为手工移除测试注入的
   `sandbox-allowlist` 段）；
2. 重启 dsh web（让还原后的配置干净生效）；
3. 删除整个 `<测试目录>`；
4. `$DSH_HOME` 下的决策日志与提案文件不必删（可再生、自动轮转）；如确需清理，
   删除前先确认其中没有用户想留的历史。
5. 若本次会话产生任何需要入库的记录（一般不应该——测试记录直接汇报即可），
   提交前必须跑 `AGENTS.md` 的隐私扫描三连。
