# dsh-sandbox-allowlist

DSH（DeepSeek Harness）沙箱扩展插件：为官方默认沙箱增加**可配置的可信可写目录**，
让沙箱内的 CLI 命令与 write/edit 文件工具都能写工作区之外的「沙箱授权目录」——
**不需要每次审批、不需要关闭沙箱**。

- ✅ 通过官方插件机制安装：`dsh plugin --profile <name> add dsh-sandbox-allowlist`
- ✅ 配置支持多个目录、**通配符**（`**` 子树、`*` 一级子目录、`?` 单字符）
- ✅ 覆盖 **Windows（ACL 沙箱）与 Linux（bwrap）**
- ✅ **命令白名单**：配置哪些命令无需询问即可运行（`allow`）/必须询问（`ask`）/被拦截
  （`deny`），参考 opencode / Claude Code 的权限规则设计，通配符忽略参数
- ✅ **禁读规则（noRead）**：按文件名/路径模式限制读取（`deny` 硬拦 / `ask` 审批放行），
  默认允许读的官方行为无需配置 allow
- ✅ 设置页可编辑（`sandbox-allowlist` 设置 namespace，含安全警示说明）
- ✅ 纯插件实现：不修改任何 node_modules / 官方包代码

## 原理

DSH 沙箱允许写哪里 = 允许清单（allow-list）。本插件向清单**追加沙箱授权目录**：

- **Windows**：沙箱用「工作区写 SID 的 Write ACE」作为允许清单。插件在沙箱授权目录上
  物化该 SID 的**继承式写 ACE**（`(OI)(CI)(W,D,DC)`）→ 受限 CLI 直接可写、
  未来子目录自动继承；write/edit 工具由自研 fs 栅栏放行同一份清单。
  **撤销即回收**：从配置中删除目录会触发自动对账，把之前写入该目录树（含子目录）
  的写 ACE 一并移除——无需任何手工清理；对账清单持久化在
  `$DSH_HOME/sandbox-allowlist-grants.json`，即使进程在离线状态下改过配置，
  下次启动也会自动补齐回收。
- **Linux**：`bwrap` 追加 `--bind <root> <root>`；landlock/seatbelt 暂不支持
  （会告警并忽略，建议使用 bwrap）。

## 安装

```bash
# 从 npm registry / GitHub Releases 安装（发布后）
dsh plugin --profile web add dsh-sandbox-allowlist

# 本地开发调试（tarball）
pnpm pack --pack-destination /tmp/pkg
dsh plugin --profile web add /tmp/pkg/dsh-sandbox-allowlist-*.tgz
```

`dsh plugin add` 会自动把本包追加进 profile 的 `dsh.profile.bundles` 层，
其 `cordis.patch.yml` 作为补丁层挂载：禁用官方 `sandbox-policy`/`fs-sandbox`
行（Linux 另禁 `sandbox` 行），插入本包的替换行。改完后 **HMR 自动热应用**，
无需重启。

## 配置（设置页 / settings.yaml）

沙箱授权目录清单通过 `sandbox-allowlist` 设置 namespace 管理（设置页可编辑，写入
`$DSH_HOME/settings.yaml`，实时生效）：

```yaml
sandbox-allowlist:
  allowedDirs:
    - 'D:\Shared\Tools'    # 字面目录：整棵子树可写
    - 'D:\Shared\**'       # 子树（含根自身与未来子目录）
    - 'D:\Data\logs\*'     # 现存的一级子目录
    - 'D:\Archive\202?'       # ? 匹配单个非分隔符字符
    - '/opt/tools/**'      # POSIX 写法同样支持
```

> ⚠️ **安全警示**：沙箱授权目录将被沙箱内的 AI 代理直接写入（无需审批）。请只添加
> 完全信任的目录；目录必须**已存在且归当前用户所有**；撤销信任删除条目即可，
> Windows 上此前授予的写权限会在撤销时自动回收，无需手工清理。

通配符在**每次调用前懒展开**（TTL 缓存，`expandTtlMs` 可调）；不存在的路径跳过
并告警（`strict: true` 可改为抛错）；锚定盘符/根目录且带 `**` 的模式被拒绝
（防整盘遍历）。

## 命令放行（command allow-list）

同一个 `sandbox-allowlist` 设置 namespace 支持**命令放行规则**：哪些命令免询问、
哪些必须询问、哪些直接拦截。规则词汇借鉴 opencode / Claude Code 的权限规则设计，
但判定不是"整串字符串匹配"——它**先把命令拆成一条条独立命令，再按每条命令的能力
分类判定**：所以 `git status && git log` 能整体放行、`git status && git push` 会被
拦住，PowerShell 的 `Get-X | Where-Object | Select-Object` 管道也不需要逐条枚举 cmdlet。

### 规则写法

```yaml
sandbox-allowlist:
  commands:
    default: delegate         # 未命中规则时：delegate=维持现状（默认）/ allow / ask / deny
    escalation: capability    # 沙箱升级自动放行：capability（默认）/ never
    baseline: true            # 内置能力基线（见下）
    sessionCache: true        # 会话级命令缓存（见下）
    rules:                    # 按声明顺序求值，最后一条匹配的生效
      - pattern: 'git status*'  # 窄规则：只放行 git status/log/diff…这类只读形状
        action: allow
      - pattern: 'git push*'    # 同前缀下更细的规则写在后面覆盖前面
        action: ask
      - tool: pwsh              # tool 可选（bash / pwsh，省略=都生效）
        pattern: 'Select-Object *'
        action: allow
      - pattern: 'rm -rf *'
        action: deny
```

- **`pattern`**：整条命令模式（`*` 任意多字符、`?` 单字符）。匹配按**每条独立命令**
  判定（复合命令先拆开），且程序 token 先归一化——自动去掉路径、引号与
  `.exe`/`.cmd` 类后缀，所以 `git *` 也能匹配 `"C:\Program Files\Git\git.exe" status`。
  用窄规则（`git status*`）而不是宽规则（`git *`）就能做到"放行 status、拦住 push"。

### 三种动作

| 动作 | 含义 |
|---|---|
| `allow` | 免询问运行，**并且该形状的沙箱升级请求也自动放行（命令可在沙箱外运行）** |
| `ask` | 强制弹审批 |
| `deny` | 直接拦截并给出原因 |

> ⚠️ **`allow` 的授权力度**：一条宽 `pattern`（如 `pnpm *`、`git *`）等于把该前缀下
> **任意**命令（含 `pnpm run <任意脚本>`、`pnpm dlx <任意包>`、git 协议注入等能力类
> 表本会拦住的形状）都授权到沙箱外。请优先用窄规则。
> 三条硬轨道不受任何规则影响：解析不了的结构、工作区/授权目录之外的路径写入、
> 引用禁读目标——命中即回落人工审批（见下）。

### 判定怎么做的（三层）

1. **拆解**：按 `;` `&&` `&` `|` `||` 与换行拆成独立命令（引号/转义感知）；`$( … )`
   与反引号里的子命令**递归展开后一起判**；重定向**解析目标路径**并与 工作区 ∪
   授权目录 比对；heredoc 正文按数据处理；`FOO=bar cmd` 剥掉前缀再判。真正无法解析
   的结构（进程替换、`$((`、引号不配对、递归超深）一律 **fail-closed**（回落人工）。
2. **能力分类**：每条命令归入 `read` / `local-write` / `repo-exec` / `external` /
   `opaque` / `destructive` / `unknown`，未知一律不自动放行。
3. **聚合**：`deny` > `ask` > `allow` > `default`。任一独立命令命中 deny 就整体拦截
   ——复合命令里藏着的危险命令不会再被前面的 allow 前缀掩盖。

### 内置能力基线（`baseline: true`，默认开）

只读命令（`ls` / `cat` / `grep` / `git status` / `Get-ChildItem` / `Where-Object` …）
与"只写工作区/授权目录内路径"的命令**无需任何规则**即可识别。关掉则完全按你写的规则
判定。

### 沙箱升级自动放行（`escalation`）

dsh 的弹窗有两种：命令审批，与**沙箱升级**——命令被沙箱拒绝后，AI 带
`sandbox_permissions` 重试、命令将在沙箱外运行的那一次。`escalation` 决定后者何时
免询问：

| 值 | 含义 |
|---|---|
| `capability`（默认） | 每条独立命令都命中 `allow` 规则（**allow 自带升级授权**），或都是良性能力类（`read`，或目标都在工作区/授权目录内的 `local-write`）⇒ 自动放行；解释器、网络、包管理器、未知程序、解析不了的结构 ⇒ 弹审批 |
| `never` | 永不自动放行（所有升级都弹审批） |

四条细则（前三条是硬轨道，**任何规则都覆盖不了**）：

- **结构解析不了 ⇒ 不自动**：进程替换、`$((`、引号不配对、递归超深一律回落人工。
- **路径越界 ⇒ 不自动**：写入或重定向目标落在工作区与授权目录之外（含只读命令
  点名了越界路径——`uniq 输入 输出`、`git log --output=…` 这类"看着是读其实会写"
  的形状）。要写工作区之外，正道是加入「沙箱授权 → 授权目录」，那样命令根本不会
  被沙箱拒绝、也就不需要升级审批。
- **禁读联动 ⇒ 不自动**：升级会一并解除 `noRead` 读取限制，因此命令引用了禁读目标时
  绝不自动放行——`allow` 规则也**不覆盖**这条轨道（`noRead` 是读维度上的明确禁制，
  不让一条命令规则静默解除它）。
- **环境变量前缀（`FOO=bar cmd`）只拦能力类兜底**：不命中规则的带前缀命令不会走
  能力类自动放行；但你显式写的 `allow` 规则照常生效（`pnpm *` → allow 覆盖
  `FOO=bar pnpm test`）。
- **元程序展开**：`pnpm run <script>` / `pnpm <script>` 会读工作区 `package.json` 的
  脚本文本（含 `pre`/`post` 钩子）**按真实内容判定**——读不到清单或脚本名不存在时
  保持保守（不自动放行）。注意：若容器命令本身命中了 `allow` 规则，该授权会覆盖
  展开后的脚本体（宽规则的代价）。

### 会话级命令缓存（`sessionCache`，默认开）

你手工批准过的某条命令（**完全相同的命令文本**）在本会话内不再重复询问——AI 反复
重试同一条命令时只问一次。任何参数变化都算另一条命令，需要重新批准。

### 决策轨迹与规则提案

- 每次判定都记入 `$DSH_HOME/sandbox-allowlist-decisions.jsonl`（判定、原因、每条
  命令的能力类与是否可升级）；文件按 2 MiB 自动轮转、保留 3 个历史副本
  （`…jsonl.1` … `…jsonl.3`），不会随安装时长无限增长；
- 需要人工确认时，弹窗文本会附上**为什么没自动放行**以及**可以添加哪条规则**；
- 反复手工批准同一形状的命令会累计成候选规则，写入
  `$DSH_HOME/sandbox-allowlist-proposals.json` 并出现在模型上下文里（**只提案，
  绝不自动应用**）。

规则通过设置页/`settings.yaml` 编辑，**实时生效，无需重启**。

### 判定为什么是这样设计的

一条 `allow` 规则的授权力度，取决于它放行的是"命令文本"还是"命令真正做的事"。纯
字符串匹配的两个极端都不好用：放得太松（`git *`）等于放行该前缀下的任意命令；放得
太紧（每个复杂形状都不放行）则 AI 的复合命令几乎永远落回人工。本插件把决策拆成三个
可分别验证的子问题：

1. **结构**——这条命令实际会执行哪些独立命令？替换体递归展开、重定向解析目标、
   heredoc 当数据、env 前缀剥离（`lib/command-analyze.mjs`）；
2. **语义**——每条独立命令能做什么？（`lib/command-classes.mjs` 的能力类表）
3. **兜底**——判不出来怎么办？一律 fail-closed 回落人工，并把原因写进弹窗
   （`lib/command-decision.mjs` → `lib/command-audit.mjs`）。

在此之上，**授权越靠近"路径"越稳**：与其放行某个命令形状，不如把它要写的目录加入
「授权目录」——目录授权由文件沙箱强制执行，命令根本不会被拒绝，也就永远不会请求
升级审批。命令规则的定位是补齐目录授权覆盖不到的残余（只读侦察、构建/测试、
跨网络操作等）。这条指引同时写进了模型上下文，AI 知道哪些根目录可写、写别处会被拒。

## 禁读规则（noRead）

官方沙箱对**读**不做任何限制（fs 栅栏只拦写）；`noRead` 是它的正交补充：按
**文件名 / 目录 / 路径模式**限制模型读取，命中即按规则动作处理。因为默认本来就
允许读，**不提供 `allow` 动作**（显式 allow 与默认行为无异，纯属噪音）；需要
"人工批准一次再读"用 `ask`。每条规则两个字段：

```yaml
sandbox-allowlist:
  noRead:
    - pattern: '*.pem'        # ① 文件名模式：任意目录深度的 .pem 禁读
      action: deny            #    deny（默认）= 直接拒绝读取
    - pattern: '.env*'        #    覆盖 .env / .env.local / .env.production …
      action: deny
    - pattern: 'id_rsa*'
      action: deny
    - pattern: 'D:\Vault\**\*.key'   # ② 完整路径 + 通配符：保险库下所有 .key
      action: deny
    - pattern: 'D:\Vault'     # ③ 目录级：字面绝对目录 → 整棵子树禁读（含列表）
      action: deny            #    等价写法：'D:\Vault\**'
    - pattern: '*.crt'        # ask：命中时弹一次人工审批，批准后本次放行
      action: ask
```

模式词汇（Windows 大小写不敏感，三种形态自动识别）：

- **① 文件名模式**（不含路径分隔符）：只按**文件名**匹配，任意目录深度命中：
  `*.pem` 拦任何位置的 .pem；`.env*` 拦 .env、.env.local…；`id_rsa` 精确文件名；
- **② 完整路径 + 通配符**（含分隔符且有 `*`/`?`）：`D:\Vault\**\*.key` 拦保险库下
  所有 .key；连续两个 `*` 可跨目录，单个 `*` 不跨；
- **③ 目录级**（含分隔符但无通配符的**绝对**路径）：字面目录（`D:\Vault`）或
  显式子树（`D:\Vault\**`）→ **目录本身及其整棵子树禁读，含目录列表（listDir）**；
  若该路径实际是个文件则等价于只禁读这一个文件。

护栏（配错的宽规则会被拒绝并告警，绝不静默全禁）：锚定盘符/根（`D:\`、`/`）与
纯通配 `*`/`**`/`?` 会被拒绝——避免误伤整盘。

**分层强制（deny 规则双层生效，ask 规则单层生效）**：

1. **fs 强制层（`lib/fs.mjs`）**：对命中 `deny` 的目标，`read` / `read_image` /
   `edit`（隐含读旧内容）、**目录级 listDir**、以及 **write 覆盖已存在文件**
   （需回读旧内容生成 diff，write 工具会把旧内容作为 `before` 返回）一律抛
   `FS_READ_DENIED`；**新建**同名/同格式文件仍允许（限制的是读不是写）；
2. **pre-execute 门（`lib/read-gate.mjs`）**：`read` / `read_image` / `edit` 调用
   在参数 `file_path` 命中时立即返回决策——`deny` 直接拦（不执行任何文件 I/O），
   `ask` 走审批（`allowed-once`，批准后 fs 层不会二次拦截）；
3. **模型提示上下文**：把禁读清单注入系统提示，模型知道哪些不能读、哪些要问人，
   避免反复尝试。

边界请知悉（写入文档也是设计的一部分）：

- **只约束 dsh 自带读文件工具与经 `ctx.fs` 的读取**；`bash`/`pwsh` 的
  cat/type/Get-Content 与 `grep` 工具（spawn 原生 ripgrep，不经 `ctx.fs`）无法按
  文件名/扩展名在水面下强制拦截（进程级 ACL/bwrap 目录隐藏是后续方向）——真敏感
  的文件请移出模型可达范围，或用命令规则 deny 明显的读取命令；
- 目录级禁读只拦**被禁目录自身的列表与树内读取**：其**父级**目录列表仍会显示该目录
  名（模型能看到"存在这个目录"，但读不进任何内容）；
- 会话处于 `danger-full-access`（显式"全信任"）时禁读不生效，与写沙箱一致。

> 📖 三种权限规则（授权目录 / 命令规则 / 禁读规则）的完整使用说明与场景示例见
> [docs/guides/permission-rules.md](docs/guides/permission-rules.md)。

## 包结构

```
lib/policy.mjs      替换 sandbox-policy：沙箱授权目录展开 + Windows ACE 物化与
                    撤销对账（grant-manifest.mjs 持久化清单）+ sandbox-allowlist
                    设置 namespace 注册 + 模型提示上下文（授权目录/禁读/规则提案）
                    + 命令门与升级审批门挂载 + noRead 禁读链路
lib/grant-manifest.mjs  授权清单持久化（跨重启对账的可靠记忆）
lib/acl-revoke.mjs  Windows ACE 回收原语（SDDL 读改写，icacls 在本平台不可用）
lib/command-rules.mjs  规则引擎：pattern（整条命令 glob，程序名归一化后匹配）
                    + allow/ask/deny，纯函数可单测
lib/command-structure.mjs  语句拆分器（引号/转义/双方言感知）
lib/command-analyze.mjs    结构化解析：替换体递归、重定向目标解析、heredoc、env 前缀；
                    不可解析结构 fail-closed
lib/command-classes.mjs    能力分类表：read/local-write/repo-exec/external/opaque/
                    destructive/unknown（未知不自动放行）
lib/command-expand.mjs     元程序展开：pnpm/npm/yarn run → package.json 脚本文本
lib/command-decision.mjs   唯一决策引擎（沙箱相位 + 升级相位）+ 路径范围判定 + 解释
lib/command-audit.mjs      决策轨迹（ring + JSONL）、会话级缓存、规则提案计数
lib/command-gate.mjs       tools/pre-execute 门：沙箱相位判定 + 调用关联 + 审计
lib/command-approval-gate.mjs  approval/request 门：升级相位判定 + 弹窗解释 + 学习
lib/read-deny.mjs   禁读规则引擎（文件名/路径匹配 + deny/ask，纯函数，可单测）
lib/read-gate.mjs   tools/pre-execute 拦截门：read/read_image/edit 的 deny/ask 决策
lib/fs.mjs          替换 fs-sandbox：write/edit 栅栏放行 extraRoots + noRead 读强制层
                    （readText/streamText/readBytes/editText/覆盖写 → FS_READ_DENIED）
lib/provider.mjs    替换 sandbox（仅 Linux）：bwrap --bind 追加
lib/patterns.mjs    通配符匹配与目录展开（共享）
cordis.patch.yml    bundle 补丁层（安装即挂载）
scripts/revoke.mjs  Windows 应急清理脚本（通常无需使用：撤销已自动回收）
src/client/         设置页「沙箱授权」分节源码（需 dsh 开发工具链构建）
test/               自检测试 / 端到端验证 / 对抗回归矩阵 / 补丁组合预检 / 干挂载
```

## 开发与验证

```bash
npm test                     # 自检测试（通配符、规则引擎、能力分类、结构解析、决策引擎、审计/缓存/提案、noRead、schema）
npm run test:command-gate    # 端到端验证命令门（真实 cordis 上下文 + tools/pre-execute 分发 + pattern 规则）
npm run test:approval-gate   # 端到端验证升级审批门（能力基线 / allow 升级授权 / noRead 联动 / 会话缓存 / 规则提案）
npm run test:matrix          # 44 行对抗回归矩阵（评估报告 §2.2 语料 + 能力类/展开用例，沙箱相位 × 升级相位双列断言）
npm run test:read-gate       # 端到端验证 noRead 禁读（policy.noReadRules 挂载 + fs 强制层 + pre-execute deny/ask）
npm run test:client          # 设置页客户端 bundle 渲染断言（含两文件防漂移标记）
npm run test:patch           # 补丁组合预检（离线组合 web profile 补丁层）
npm run test:dry-mount       # 干挂载（临时 cordis 上下文端到端验证）
```

真机验证要点：受限 pwsh / write 工具写沙箱授权目录应成功且无审批；写工作区外**非**可信
目录应仍被拦截（`FS_SANDBOX_DENIED`）；`icacls <dir>` 应能看到工作区 SID
`S-1-4-...` 的 `(OI)(CI)(W,D,DC)` ACE；在设置页删除该目录并保存后，同一
`icacls` 输出中该 ACE（含子目录继承副本）应消失——撤销即回收。

## 设置页界面（客户端分节）

设置页的沙箱授权配置分两层：

1. **服务端数据层（已实现并验证）**：插件通过 `ctx.settings` 注册 `sandbox-allowlist`
   namespace（schema 描述中携带安全警示文案，随 `schema.toJSON()` 供设置页渲染）。
   设置文档（settings.yaml）→ 策略 → ACE → 受限写 全链路已真机验证。

2. **客户端分节（已实现并部署；源码 `src/client/index.tsx`，运行时手写等价物
   `lib/client.js`）**：`src/client/index.tsx` 在设置页 `settings.section` 槽位
   注册「沙箱授权」分节，UI 对齐 `docs/config-ui-prototype.html`（v5）高保真原型与
   dsh 官方插件配置卡片（`dsh-client-ui-settings-plugins`）的设计语言：
   - **分节结构**：标题 + 导语 + 三张可折叠配置卡片（授权目录 / 命令规则 /
      禁读规则），卡片标题含计数与「未保存修改」徽章；收起态主体真正隐藏（CSS
      `:not(.is-open)`），头部信息保留；
   - **授权目录卡片**：克制式安全警示 callout + 结构化目录行（📁 或新增行的
     绿色「＋」圆形徽章 + 等宽输入 + 小 ✕ 图标按钮），焦点只高亮输入框本身
     （行边框不高亮），非法条目标红输入框（浏览器侧轻量校验镜像
     `lib/patterns.mjs` 的拒绝规则）；
   - **命令规则卡片**：未命中默认动作分段选择（`delegate` / `allow` / `ask` /
     `deny`，选中项 = 语义色浅底 + 语义色文字 + 粗体 + 内描边，未选中统一
     中性色）+ 规则表（**自绘工具下拉** + **命令模式输入** + `allow` / `ask` /
     `deny` 紧凑分段 + 小 ✕ 图标按钮）+「添加规则」+ 一个可见勾选框
     （允许沙箱升级自动放行）+ 默认收起的「高级」折叠区（内置能力基线 /
     会话级命令缓存两个勾选框）。其中 `allow` = 放行，**含允许该命令在沙箱外
     运行**（沙箱升级自动放行）；
   - **禁读规则卡片**：与命令规则同款规则表，但动作**只提供 `deny`/`ask` 两档**
     （无 `allow`——官方默认本就允许读，配了是空操作），pattern 输入（占位
     `*.pem`）+ 紧凑 `deny`/`ask` 分段 + 小 ✕ +「添加规则」；保存写入
     `noRead` 字段（`scope.set('noRead', [...])`）；页脚提示说明豁免用 `ask`；
   - 工具下拉为**自绘组件**（原生 `<select>` 展开态由浏览器渲染、CSS 无法定制，
     故用胶囊触发按钮 + 自绘菜单实现，展开/选中态完全可控）；选项仅
     `bash` / `pwsh` / `任意`——dsh 只有这两个 shell 工具，其它值会被服务端
     `CommandRuleSchema`（`z.union(SHELL_TOOLS)`）校验拒绝；
   - 样式由 `lib/client.js` 注入作用域化 `<style>`（`.sabx-*` 前缀），全部使用
     dsw 运行时令牌（`--dsw-alias-*` / `--dsw-specific-*`，带十六进制 fallback），
     随宿主深浅色主题自适应。
   两处源码（TS 参考 + 手写 bundle）必须保持一致；`lib/client.js` 改动需重新部署到
   web profile 的 `node_modules/dsh-sandbox-allowlist/lib/client.js` 并刷新页面生效
   （`dsh-client-modules` 的 `/plugins/<id>/client.js` 路由每次请求都从磁盘读取，
   无需重启服务）。
   构建步骤（如需用工具链从 `src/client/index.tsx` 重建 bundle）：

   ```bash
   # 1) 在 dsh 开发仓库的 pnpm workspace 中（client 依赖需可解析）：
   pnpm install
   pnpm run build:client     # tsc + tsdown → lib/client.js（__ModuleLoader__ 格式）
   ```

   构建产物 `lib/client.js` 就位后，在 package.json 的 `dsh` 字段补充
   `client` 声明（产物缺失时不可声明，否则 web 应用加载会失败）：

   ```json
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": {
       "inject": [
         "@deepseek-ai/dsh-client-ui-renderer",
         "@deepseek-ai/dsh-client-connection",
         "@deepseek-ai/dsh-client-ui-slots",
         "@deepseek-ai/dsh-client-ui-settings"
       ],
       "platform": "web"
     }
   }
   ```

   > 客户端插件须用 dsh 官方构建链（tsdown）产出 `__ModuleLoader__` 格式。
   > 源码中的 `TODO` 标记（settings scope 绑定、写 RPC 签名）需对照 dsh 开发
   > 仓库中 client 包的 `.d.ts` 复核后构建验证。
   >
   > `dsh.client.inject` 自 dsh 0.1.5 起的语义是「**工厂必须先于本行到达的包行**」，
   > 不再是纯信息性元数据：`@deepseek-ai/dsh-client-runtime` 在 0.1.5 已不存在
   > （其 `slots` 服务职责迁到 `dsh-client-ui-renderer`），声明死条目是明确的配置
   > 矛盾，故替换之。客户端入口 `exports.inject = ['slots', 'connection',
   > 'settingsScope']` 消费的三个服务仍由余下三行提供。

## 版本与兼容基线

- 当前基线：**dsh 0.1.5-rc.2**。P0 迁移项已按
  [docs/upgrade/dsh-0.1.5-migration-plan.md](docs/upgrade/dsh-0.1.5-migration-plan.md)
  执行完毕（该文档末尾附执行记录）。
- `devDependencies` 与之对齐；测试用的裸 cordis 上下文必须提供
  `sessionProjections`（0.1.5 起 `SandboxPolicyService` 构造时注册 `sandboxMode`
  投影），见 `test/dry-mount.mjs` 的注释。
- `systemPrompt` 上下文顺序改为从官方 `getContextOrder('SANDBOX_POLICY')` 推导
  （旧宿主没有该访问器时回退常量 `110`），避免官方调整顺序表时静默漂移。

## 已知限制

- **Windows**：沙箱授权目录必须存在且归当前用户所有（需能改 DACL）
- **Windows（撤销回收）**：回收失败（如目录不再归当前用户所有、无法改写 DACL）的
  目录会保留在 `$DSH_HOME/sandbox-allowlist-grants.json` 中，下次对账自动重试；
  已删除的目录直接视为已回收。回收宿主优先使用系统自带 Windows PowerShell 5.1，
  缺失时回退 PowerShell 7（pwsh，PATH 或标准安装目录）；两者皆缺时回收挂起并告警，
  待下次对账重试。若插件被卸载而目录残留了 ACE，可用
  `node scripts/revoke.mjs` 应急清理
- **Linux**：`bwrap` 完整支持；`landlock`/`seatbelt` 暂不支持
- write/edit 工具只在 `workspace-write` 模式下放行沙箱授权目录
- **noRead 只约束模型的文件工具与经 ctx.fs 的读取**：shell 命令（cat/type/
  Get-Content）与 `grep`/`glob` 工具（spawn 原生 ripgrep，不经 ctx.fs）无法按
  文件名/扩展名强制拦截；**目录级**禁读同样只覆盖工具层（进程级 ACL deny /
  bwrap 目录隐藏是后续方向），且被禁目录的**父级列表**仍会显示其目录名；
  `danger-full-access`（全信任模式）下禁读不生效
- noRead 的 `ask` 规则只作用于 read / read_image / edit 工具（write 覆盖旧文件
  只受 `deny` 规则的 fs 层拦截，新建不受限）；目录级 `deny` 另拦 listDir
- dsh 升级时若基类（`SandboxPolicyService` / `SandboxedFileSystem` /
  `LocalSandboxProvider`）签名变化，本插件可能需要小调（0.1.5 三个基类签名无变化，
  仅新增 `static inject = ['sessionProjections']` 依赖）
- **命令判定的能力分类表是保守的手写表**：表里没有的程序一律 `unknown`（只弹审批、
  绝不自动放行）。每个程序**只归属一张表**（`test/test.mjs` 有单源断言，防止两张表
  对同一程序给出不同能力类），新增条目必须同时加测试
  （见 `test/verify-command-matrix.mjs`）。少数刻意的保守取舍：
  `sed` 归为 `opaque`（sed 脚本的 `e`/`w`/`r` 命令能执行与写文件，逐脚本解析不可靠）、
  `get-*` 形式的 PowerShell 动词按"批准动词约定"视为只读、只读命令引用越界路径时
  不自动放行
- **宽 `pattern` 的授权力度 = 全机执行**：单层 `allow` 之后，能力类表不再拦得住
  宽规则——`git *` → `allow` 会把 git 协议注入（`ext::sh`）也授权到沙箱外；
  `pnpm *` → `allow` 等于放行 `pnpm run <任意脚本>` / `pnpm dlx <任意包>`。这是
  `allow` 的固有语义（含沙箱升级授权），请用窄规则（`git status*`、`pnpm test*`）
  表达精确意图
- **元程序展开只覆盖 package.json 脚本**：`node script.mjs`、`mvn deploy` 之类的
  真实行为没有能力类兜底，需要显式 `allow` 规则（该规则会一并授权它们在沙箱外运行）
- `get-*` 形式的 PowerShell 动词按"批准动词约定"视为只读（无法从字符串确认）；
  这是有意的约定性折中，已在 `lib/command-classes.mjs` 头部注明

## License

MIT
