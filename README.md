# dsh-sandbox-allowlist

DSH（DeepSeek Harness）沙箱扩展插件。官方默认沙箱只允许写工作区，本插件为它增加
三类可配置的权限规则——全部通过官方插件机制挂载，**不修改任何 node_modules /
官方包代码**：

- **沙箱授权目录**：把工作区之外的可信目录加入可写清单。沙箱内的 CLI 命令与
  write/edit 文件工具都能直接写这些目录——**不需要每次审批，也不需要关闭沙箱**；
- **命令放行（command allow-list）**：配置哪些命令免询问（`allow`）、必须询问
  （`ask`）、直接拦截（`deny`）。判定不是整串字符串匹配，而是「拆成独立命令 →
  能力分类 → 聚合」：`git status && git log` 能整体放行，`git status && git push`
  会被拦住；
- **禁读规则（noRead）**：按文件名 / 路径模式限制模型读取（官方沙箱对读不设限），
  `deny` 硬拦 / `ask` 审批后放行。

三类规则都在设置页可视化编辑（`sandbox-allowlist` 设置 namespace），**保存实时
生效，无需重启**。支持 **Windows（ACL 沙箱）与 Linux（bwrap）**。

> 当前版本 `v0.1.0-beta.1`，兼容基线 dsh **0.1.5-rc.2**。
> 📖 三类规则的完整使用说明与场景示例：
> [docs/guides/permission-rules.md](docs/guides/permission-rules.md)

## 安装

```bash
# 从 npm registry / GitHub Releases 安装（发布后）
dsh plugin --profile web add dsh-sandbox-allowlist

# 本地开发调试（tarball）
pnpm pack --pack-destination /tmp/pkg
dsh plugin --profile web add /tmp/pkg/dsh-sandbox-allowlist-*.tgz
```

要求：dsh ≥ 0.1.5-rc.2，Node ≥ 20.11。Windows 使用官方 ACL 沙箱，Linux 使用
`bwrap`（landlock / seatbelt 暂不支持，会告警并忽略）。

`dsh plugin add` 会把本包追加进 profile 的 `dsh.profile.bundles` 层，其
`cordis.patch.yml` 作为补丁层挂载：禁用官方 `sandbox-policy` / `fs-sandbox` 行
（Linux 另禁 `sandbox` 行），插入本包的替换行。改完后 **HMR 自动热应用**，无需重启。

## 快速开始

三类规则共用 `sandbox-allowlist` 设置 namespace（设置页可编辑，落盘
`$DSH_HOME/settings.yaml`）。一份最小配置（**路径均为示例，请替换为你的实际目录**）：

```yaml
sandbox-allowlist:
  # ① 沙箱授权目录：这些目录（工作区之外）沙箱内可直接写
  allowedDirs:
    - 'D:\Shared\Tools'        # 字面目录：整棵子树可写
    - 'D:\Data\logs\*'         # 现存的一级子目录
  # ② 命令放行：未命中规则时维持 dsh 现状（按需询问）
  commands:
    rules:
      - pattern: 'git status*' # 窄规则：只放行只读形状
        action: allow
      - pattern: 'rm -rf *'
        action: deny
  # ③ 禁读规则：默认本就允许读，按需加限制
  noRead:
    - pattern: '*.pem'
      action: deny
```

> ⚠️ **安全警示**：授权目录将被沙箱内的 AI 代理**无审批**写入（工作区之外）。
> 只添加完全信任的目录；目录必须**已存在且归当前用户所有**。撤销信任 = 删除条目，
> 此前授予的写权限会自动回收（见[工作原理](#工作原理)）。

## 配置参考

### ① 沙箱授权目录（`allowedDirs`）

通配符词汇（`\` 与 `/` 均为分隔符，POSIX 写法同样支持）：

| 模式 | 含义 |
|---|---|
| `D:\Shared\Tools` | 字面目录 → 整棵子树可写 |
| `D:\Shared\**` | 显式子树（含根自身与未来新建的子目录） |
| `D:\Data\logs\*` | 现存的一级子目录 |
| `D:\Archive\202?` | `?` 匹配单个非分隔符字符 |

展开语义：每次调用前**懒展开**（TTL 缓存，`expandTtlMs` 可调）；不存在的路径跳过
并告警（`strict: true` 改为抛错）；**锚定盘符/根且带 `**` 的模式会被拒绝**（防整盘
遍历）。

### ② 命令放行（`commands`）

```yaml
sandbox-allowlist:
  commands:
    default: delegate         # 未命中规则时：delegate=维持现状（默认）/ allow / ask / deny
    escalation: capability    # 沙箱升级自动放行：capability（默认）/ never
    baseline: true            # 内置能力基线（默认开）
    sessionCache: true        # 会话级命令缓存（默认开）
    rules:                    # 按声明顺序求值，最后一条匹配的生效
      - pattern: 'git status*'  # 窄规则：只放行 git status/log/diff… 这类只读形状
        action: allow
      - pattern: 'git push*'    # 同前缀下更细的规则写在后面覆盖前面
        action: ask
      - tool: pwsh              # tool 可选（bash / pwsh，省略 = 两个 shell 都生效）
        pattern: 'Select-Object *'
        action: allow
      - pattern: 'rm -rf *'
        action: deny
```

**pattern 语义**：整条命令模式（`*` 任意多字符、`?` 单字符），按**每条独立命令**
判定（复合命令先拆开）。程序 token 先归一化——自动去掉路径、引号与 `.exe`/`.cmd`
类后缀，所以 `git *` 也能匹配 `"C:\Program Files\Git\git.exe" status`。用窄规则
（`git status*`）而不是宽规则（`git *`）就能做到「放行 status、拦住 push」。

**动作**：

| 动作 | 含义 |
|---|---|
| `allow` | 免询问运行，**并且该形状的沙箱升级请求也自动放行（命令可在沙箱外运行）** |
| `ask` | 强制弹审批 |
| `deny` | 直接拦截并给出原因 |

**判定流程（三层）**：

1. **拆解（结构）**：按 `;` `&&` `&` `|` `||` 与换行拆成独立命令（引号/转义感知）；
   `$( … )` 与反引号里的子命令递归展开后一起判；重定向**解析目标路径**并与
   工作区 ∪ 授权目录 比对；heredoc 正文按数据处理；`FOO=bar cmd` 剥掉前缀再判。
   解析不了的结构（进程替换、`$((`、引号不配对、递归超深）一律 **fail-closed**
   回落人工。
2. **能力分类（语义）**：每条命令归入 `read` / `local-write` / `repo-exec` /
   `external` / `opaque` / `destructive` / `unknown`——未知一律不自动放行。
3. **聚合（兜底）**：`deny` > `ask` > `allow` > `default`。任一独立命令命中 deny
   就整体拦截——复合命令里藏着的危险命令不会被前面的 allow 前缀掩盖。

**内置能力基线（`baseline: true`，默认开）**：只读命令（`ls` / `cat` / `grep` /
`git status` / `Get-ChildItem` / `Where-Object` …）与「只写工作区/授权目录内路径」
的命令无需任何规则即可识别。关掉则完全按你写的规则判定。

**沙箱升级自动放行（`escalation`）**：dsh 的弹窗有两种——命令审批，与**沙箱升级**
（命令被沙箱拒绝后，AI 带 `sandbox_permissions` 重试、命令将在沙箱外运行的那一次）。

| 值 | 含义 |
|---|---|
| `capability`（默认） | 每条独立命令都命中 `allow` 规则（allow 自带升级授权），或都是良性能力类（`read`，或目标都在工作区/授权目录内的 `local-write`）⇒ 自动放行；解释器、网络、包管理器、未知程序、解析不了的结构 ⇒ 弹审批 |
| `never` | 永不自动放行（所有升级都弹审批） |

**会话级命令缓存（`sessionCache`，默认开）**：你手工批准过的某条命令（**完全相同
的命令文本**）在本会话内不再重复询问。任何参数变化都算另一条命令，需重新批准。

**决策轨迹与规则提案**：

- 每次判定记入 `$DSH_HOME/sandbox-allowlist-decisions.jsonl`（判定、原因、每条命令
  的能力类与是否可升级）；按 2 MiB 自动轮转、保留 3 个历史副本，不会无限增长；
- 需人工确认时，弹窗文本会附上**为什么没自动放行**以及**可以添加哪条规则**；
- 反复手工批准同一形状的命令会累计成候选规则，写入
  `$DSH_HOME/sandbox-allowlist-proposals.json` 并出现在模型上下文里
  （**只提案，绝不自动应用**）。

> **设计取舍**：一条 `allow` 规则的授权力度，取决于它放行的是「命令文本」还是
> 「命令真正做的事」。本插件把决策拆成结构 / 语义 / 兜底三个可分别验证的子问题
> （分别对应 `lib/command-analyze.mjs` / `lib/command-classes.mjs` /
> `lib/command-decision.mjs`）。在此之上，**授权越靠近「路径」越稳**：与其放行
> 某个命令形状，不如把它要写的目录加入授权目录——目录授权由文件沙箱强制执行，
> 命令根本不会被拒绝，也就永远不会请求升级审批。命令规则的定位是补齐目录授权
> 覆盖不到的残余（只读侦察、构建/测试、跨网络操作等）。

### ③ 禁读规则（`noRead`）

官方沙箱对**读**不做任何限制（fs 栅栏只拦写），`noRead` 是它的正交补充：按
**文件名 / 目录 / 路径模式**限制模型读取。因为默认本来就允许读，**不提供
`allow` 动作**（显式 allow 与默认行为无异，纯属噪音）；需要「人工批准一次再读」
用 `ask`。

```yaml
sandbox-allowlist:
  noRead:
    - pattern: '*.pem'       # ① 文件名模式：任意目录深度的 .pem 禁读
      action: deny           #    deny（默认）= 直接拒绝读取
    - pattern: '.env*'       #    覆盖 .env / .env.local / .env.production …
      action: deny
    - pattern: 'id_rsa*'
      action: deny
    - pattern: 'D:\Vault\**\*.key'  # ② 完整路径 + 通配符：保险库下所有 .key
      action: deny
    - pattern: 'D:\Vault'    # ③ 目录级：字面绝对目录 → 整棵子树禁读（含列表）
      action: deny           #    等价写法：'D:\Vault\**'
    - pattern: '*.crt'       # ask：命中时弹一次人工审批，批准后本次放行
      action: ask
```

模式词汇（Windows 大小写不敏感，三种形态自动识别）：

- **① 文件名模式**（不含路径分隔符）：只按**文件名**匹配，任意目录深度命中；
- **② 完整路径 + 通配符**（含分隔符且有 `*`/`?`）：连续两个 `*` 可跨目录，
  单个 `*` 不跨；
- **③ 目录级**（含分隔符但无通配符的**绝对**路径）：字面目录（`D:\Vault`）或显式
  子树（`D:\Vault\**`）→ 目录本身及其整棵子树禁读，**含目录列表（listDir）**；
  若该路径实际是个文件则等价于只禁读这一个文件。

护栏：锚定盘符/根（`D:\`、`/`）与纯通配 `*`/`**`/`?` 的规则会被**拒绝并告警**
（防误伤整盘），绝不静默全禁。

**分层强制（deny 双层生效，ask 单层生效）**：

1. **fs 强制层**：命中 `deny` 的目标，`read` / `read_image` / `edit`（隐含读旧
   内容）、目录级 listDir、以及 **write 覆盖已存在文件**（需回读旧内容生成 diff）
   一律抛 `FS_READ_DENIED`；**新建**同名/同格式文件仍允许（限制的是读不是写）；
2. **pre-execute 门**：`read` / `read_image` / `edit` 在参数 `file_path` 命中时
   立即返回决策——`deny` 直接拦（不执行任何文件 I/O），`ask` 走审批
   （allowed-once，批准后 fs 层不会二次拦截）；
3. **模型提示上下文**：禁读清单注入系统提示，模型知道哪些不能读、哪些要问人，
   避免反复尝试。

## 工作原理

DSH 沙箱允许写哪里 = 允许清单（allow-list）。本插件向清单**追加沙箱授权目录**：

- **Windows**：沙箱用「工作区写 SID 的 Write ACE」作为允许清单。插件在授权目录上
  物化该 SID 的**继承式写 ACE**（`(OI)(CI)(W,D,DC)`）→ 受限 CLI 直接可写、未来
  子目录自动继承；write/edit 工具由自研 fs 栅栏放行同一份清单。
  **撤销即回收**：从配置中删除目录会触发自动对账，把之前写入该目录树（含子目录）
  的写 ACE 一并移除——无需任何手工清理。对账清单持久化在
  `$DSH_HOME/sandbox-allowlist-grants.json`，即使进程离线时改过配置，下次启动
  也会自动补齐回收。
- **Linux**：`bwrap` 追加 `--bind <root> <root>`。

## 安全边界（务必阅读）

- **宽 `pattern` 的授权力度 = 全机执行**：`allow` 的语义含沙箱升级授权，一条宽
  规则等于把该前缀下**任意**命令授权到沙箱外——`git *` 连 git 协议注入
  （`ext::sh`）也放行；`pnpm *` 等于放行 `pnpm run <任意脚本>` / `pnpm dlx
  <任意包>`。请用窄规则（`git status*`、`pnpm test*`）表达精确意图。
- **三条硬轨道，任何规则都覆盖不了**（命中即回落人工审批）：
  1. 结构解析不了：进程替换、`$((`、引号不配对、递归超深——fail-closed；
  2. 路径越界：写入或重定向目标落在工作区与授权目录之外（含「看着是读其实会写」
     的形状，如 `uniq 输入 输出`、`git log --output=…`）。要写工作区之外，正道是
     加入沙箱授权目录——那样命令根本不会被沙箱拒绝，也就不需要升级审批；
  3. 禁读联动：升级会一并解除 `noRead` 限制，因此命令引用了禁读目标时绝不自动
     放行——`allow` 规则也**不覆盖**这条轨道。
- **noRead 只约束模型的文件工具与经 `ctx.fs` 的读取**：`bash`/`pwsh` 的
  cat/type/Get-Content 与 `grep`/`glob` 工具（spawn 原生 ripgrep，不经 `ctx.fs`）
  无法按文件名/扩展名在水面下强制拦截（进程级 ACL deny / bwrap 目录隐藏是后续
  方向）。**真敏感的文件请移出模型可达范围**，或用命令规则 deny 明显的读取命令。
  另：目录级禁读下，其**父级**目录列表仍会显示该目录名（模型能看到「存在这个
  目录」，但读不进任何内容）；会话处于 `danger-full-access`（显式全信任）时
  禁读不生效，与写沙箱一致。
- **能力分类表是保守的手写表**：表里没有的程序一律 `unknown`（只弹审批、绝不
  自动放行）。少数刻意的保守取舍：`sed` 归为 `opaque`（其 `e`/`w`/`r` 命令能
  执行与写文件，逐脚本解析不可靠）；`get-*` 形式的 PowerShell 动词按「批准动词
  约定」视为只读（无法从字符串确认）。每个程序只归属一张表（`test/test.mjs` 有
  单源断言），新增条目必须同时加测试。
- **元程序展开只覆盖 package.json 脚本**：`pnpm run <script>`（含 `pre`/`post`
  钩子）会按脚本真实内容判定，读不到清单或脚本名不存在时保持保守；
  `node script.mjs`、`mvn deploy` 之类没有能力类兜底，需要显式 `allow` 规则。
  注意：若容器命令本身命中 `allow` 规则，该授权会覆盖展开后的脚本体（宽规则的
  代价）。

## 已知限制

- **Windows**：授权目录必须存在且归当前用户所有（需能改 DACL）；撤销回收失败
  （如目录易主、无法改写 DACL）的目录保留在 grants 清单中，下次对账自动重试，
  已删除的目录直接视为已回收。回收宿主优先系统自带 Windows PowerShell 5.1，
  缺失时回退 PowerShell 7（pwsh）；两者皆缺时回收挂起并告警。若插件被卸载而
  目录残留 ACE，可用 `node scripts/revoke.mjs` 应急清理（通常无需使用）。
- **Linux**：`bwrap` 完整支持；`landlock`/`seatbelt` 暂不支持。
- write/edit 工具只在 `workspace-write` 模式下放行授权目录。
- noRead 的 `ask` 规则只作用于 read / read_image / edit 工具；write 覆盖旧文件
  只受 `deny` 规则的 fs 层拦截，新建不受限；目录级 `deny` 另拦 listDir。
- dsh 升级时若基类（`SandboxPolicyService` / `SandboxedFileSystem` /
  `LocalSandboxProvider`）签名变化，本插件可能需要小调（0.1.5 三个基类签名无
  变化，仅新增 `static inject = ['sessionProjections']` 依赖）。

## 开发与测试

```bash
npm test                     # 自检测试（通配符、规则引擎、能力分类、结构解析、决策引擎、审计/缓存/提案、noRead、schema）
npm run test:command-gate    # 端到端验证命令门（真实 cordis 上下文 + tools/pre-execute 分发）
npm run test:approval-gate   # 端到端验证升级审批门（能力基线 / allow 升级授权 / noRead 联动 / 会话缓存 / 规则提案）
npm run test:matrix          # 对抗回归矩阵（沙箱相位 × 升级相位双列断言）
npm run test:read-gate       # 端到端验证 noRead 禁读（policy 挂载 + fs 强制层 + pre-execute deny/ask）
npm run test:client          # 设置页客户端 bundle 渲染断言（含两文件防漂移标记）
npm run test:dry-mount       # 干挂载（临时 cordis 上下文端到端验证）
npm run test:patch           # 补丁组合预检（需先设 DSH_INSTALL_ANCHOR，见下）
```

机器相关路径一律不写死：测试默认使用临时目录（或仓库自身），需要指向真实环境时
用环境变量覆盖——

| 环境变量 | 用途 | 默认 |
|---|---|---|
| `DSH_TEST_WORKSPACE` | 测试用工作区根（dry-mount / verify-*） | 系统临时目录 |
| `DSH_TEST_TRUSTED` | dry-mount 的授权目录 | 系统临时目录 |
| `DSH_TEST_PROBE_DIR` | readonly-probe 的工作区外探测目录 | 系统临时目录 |
| `DSH_INSTALL_ANCHOR` | test:patch 组合真实 web profile 所需的 dsh 安装锚点 | **无（必填）** |
| `DHS_INSTALL_ANCHOR` | resolve-hook 解析 @deepseek-ai/* 的安装锚点 | 仓库自身 node_modules |

真机验证要点：受限 pwsh / write 工具写授权目录应成功且无审批；写工作区外**非**
可信目录应仍被拦截（`FS_SANDBOX_DENIED`）；`icacls <dir>` 应能看到工作区 SID
`S-1-4-...` 的 `(OI)(CI)(W,D,DC)` ACE；在设置页删除该目录并保存后，同一 `icacls`
输出中该 ACE（含子目录继承副本）应消失——撤销即回收。

**设置页客户端**：源码 `src/client/index.tsx`，运行时手写等价物 `lib/client.js`
（两处必须保持一致，`test:client` 有防漂移断言）。如需从源码重建：

```bash
# 在 dsh 开发仓库的 pnpm workspace 中（client 依赖需可解析）
pnpm install
pnpm run build:client      # tsc + tsdown → lib/client.js（__ModuleLoader__ 格式）
```

产物就位后 package.json 的 `dsh.client.inject` 才能声明（缺失时不可声明，否则
web 应用加载失败；自 dsh 0.1.5 起 inject 的语义是「工厂必须先于本行到达的包行」，
非纯信息性元数据）。部署改动：覆盖 web profile 的
`node_modules/dsh-sandbox-allowlist/lib/client.js` 后刷新页面即可
（`/plugins/<id>/client.js` 每次请求都从磁盘读取，无需重启服务）。

测试用的裸 cordis 上下文必须提供 `sessionProjections` 与 `systemPrompt` stub
（0.1.5 起 `SandboxPolicyService` 构造时注册 `sandboxMode` 投影），见
`test/dry-mount.mjs` 的注释；`systemPrompt` 上下文顺序从官方
`getContextOrder('SANDBOX_POLICY')` 推导（旧宿主没有该访问器时回退常量 `110`）。

## 包结构

```
lib/policy.mjs      替换 sandbox-policy：授权目录展开 + Windows ACE 物化与撤销对账
                    （grant-manifest.mjs 持久化清单）+ 设置 namespace 注册 + 模型提示
                    上下文 + 命令门与升级审批门挂载 + noRead 禁读链路
lib/grant-manifest.mjs  授权清单持久化（跨重启对账的可靠记忆）
lib/acl-revoke.mjs  Windows ACE 回收原语（SDDL 读改写，icacls 在本平台不可用）
lib/command-rules.mjs  规则引擎：pattern（整条命令 glob，程序名归一化后匹配）+ allow/ask/deny
lib/command-structure.mjs  语句拆分器（引号/转义/双方言感知）
lib/command-analyze.mjs    结构化解析：替换体递归、重定向目标解析、heredoc、env 前缀
lib/command-classes.mjs    能力分类表：read/local-write/repo-exec/external/opaque/destructive/unknown
lib/command-expand.mjs     元程序展开：pnpm/npm/yarn run → package.json 脚本文本
lib/command-decision.mjs   唯一决策引擎（沙箱相位 + 升级相位）+ 路径范围判定 + 解释
lib/command-audit.mjs      决策轨迹（ring + JSONL）、会话级缓存、规则提案计数
lib/command-gate.mjs       tools/pre-execute 门：沙箱相位判定 + 调用关联 + 审计
lib/command-approval-gate.mjs  approval/request 门：升级相位判定 + 弹窗解释 + 学习
lib/read-deny.mjs   禁读规则引擎（文件名/路径匹配 + deny/ask，纯函数）
lib/read-gate.mjs   tools/pre-execute 拦截门：read/read_image/edit 的 deny/ask 决策
lib/fs.mjs          替换 fs-sandbox：write/edit 栅栏放行 extraRoots + noRead 读强制层
lib/provider.mjs    替换 sandbox（仅 Linux）：bwrap --bind 追加
lib/patterns.mjs    通配符匹配与目录展开（共享）
cordis.patch.yml    bundle 补丁层（安装即挂载）
scripts/revoke.mjs  Windows 应急清理脚本（通常无需使用：撤销已自动回收）
src/client/         设置页「沙箱授权」分节源码（需 dsh 开发工具链构建）
test/               自检测试 / 端到端验证 / 对抗回归矩阵 / 补丁组合预检 / 干挂载
```

## License

MIT
