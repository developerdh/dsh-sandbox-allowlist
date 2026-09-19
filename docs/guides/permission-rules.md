# dsh-sandbox-allowlist 三种权限规则使用说明

本插件在官方 DSH 沙箱之上追加了三类**可配置权限规则**，全部在设置页
「沙箱授权」分节（设置 namespace `sandbox-allowlist`，落盘
`$DSH_HOME/settings.yaml`）编辑，保存后实时生效：

| 规则 | 解决什么问题 | 一句话 | 面向对象 |
|---|---|---|---|
| **授权目录** `allowedDirs` | 想让代理写工作区之外 | 额外放行哪些目录可**写** | 目录 |
| **命令规则** `commands` | 想让某些命令免审批/必审批/被拦 | 哪些命令 **allow / ask / deny** | shell 命令 |
| **禁读规则** `noRead` | 不想让代理读到某些东西 | 哪些文件/目录**不许读**（或需批准） | 文件 / 目录 |

三者相互独立、可叠加：授权目录管"写不写得了"，命令规则管"命令问不问/拦不拦"，
禁读规则管"读不读得到"。禁读规则**故意没有 `allow` 动作**——官方默认本来就允许
读，配一个 allow 等于没配；需要"放行一次"时用 `ask`（弹人工审批）。

> 术语：**审批** = 工具执行前弹给用户的人工确认；**沙箱** = 文件系统级的写边界
> （read-only / workspace-write / danger-full-access 三档）。

---

## 1. 授权目录（allowedDirs）—— 允许写工作区之外

### 用途
DSH 默认只允许在工作区内（外加临时目录）写入。`allowedDirs` 追加若干
**受信可写目录**：沙箱内的 CLI 命令与 write/edit 工具写这些目录**无需审批**。

### 语法
```yaml
sandbox-allowlist:
  allowedDirs:
    - 'D:\Shared\Tools'   # 字面目录：整棵子树可写
    - 'D:\Shared\**'      # 显式子树（含未来新建的子目录）
    - 'D:\Data\logs\*'    # 现存的一级子目录
    - 'D:\Archive\202?'      # ? 匹配单个非分隔符字符
    - '/opt/tools/**'     # POSIX 同样支持
```

### 注意
- **放行的是写**，与读无关（官方本就允许读）；目录必须**已存在且归当前用户所有**；
- Windows：插件会把"工作区写 SID 的写 ACE"物化到这些目录（含子目录继承），
  受限 CLI 才能写；从清单删除目录会自动回收该 ACE（对账持久化，重启补账）；
- Linux：bwrap 追加 `--bind <目录> <目录>`；
- 只在 `workspace-write` 模式放行；`read-only` 仍全拒写，`danger-full-access`
  无沙箱则无需本清单；
- 通配符每次调用前懒展开（TTL 缓存）；锚定盘符/根且带 `**` 的模式会被拒绝
  （防整盘遍历）。

### 场景示例
1. **工具/脚本目录**：代理需要维护 `D:\Shared\Tools` 下的脚本与批处理：
   ```yaml
   allowedDirs:
     - 'D:\Shared\Tools'
   ```
2. **数据落盘**：让测试产物写进 `D:\Data\exports`（一级子目录按年份分开）：
   ```yaml
   allowedDirs:
     - 'D:\Data\exports\*'
   ```
3. **个人笔记库（示例占位路径，请替换成你的实际目录）**：工作区外自己的 Obsidian 知识库 `D:\Notes\MyVault`
   整棵可写（含未来目录用 `**`）：
   ```yaml
   allowedDirs:
     - 'D:\Notes\MyVault\**'
   ```

---

## 2. 命令规则（commands）—— 免审批 / 必审批 / 拦截命令

### 用途
dsh 的 bash / pwsh 工具执行命令前可能弹审批；命令被沙箱拒绝后 AI 还会带
`sandbox_permissions` 重试，那会弹第二次（**沙箱升级**审批：命令将在沙箱外运行）。
`commands` 决定这两处怎么办：哪些命令直接跑、哪些必须问、哪些直接拦。

判定不是"整串匹配"：命令先被拆成一条条独立命令，每条按**能力分类**
（只读 / 写工作区 / 跑仓库工具链 / 跨网络 / 执行不可见代码 / 破坏性 / 未知）判定，
再按 `deny > ask > allow > default` 聚合。所以 `git status && git log` 能整体放行，
`git status && git push` 会被拦住，PowerShell 管道也不必逐条枚举 cmdlet。

### 语法
```yaml
sandbox-allowlist:
  commands:
    default: delegate        # 未命中规则时：delegate=维持现状（默认）| allow | ask | deny
    escalation: capability   # 沙箱升级自动放行：capability（默认）| never
    baseline: true           # 内置能力基线（默认开）
    sessionCache: true       # 会话级命令缓存（默认开）
    rules:                   # 按声明顺序求值，最后一条命中的生效
      - tool: bash           # 可选：bash / pwsh；省略 = 两种都生效
        pattern: 'git status*'
        action: allow        # 窄规则：只放行 git status / git status -s… 这类形状
      - pattern: 'git push*'
        action: ask          # 同前缀下更细的规则放后面覆盖
      - pattern: 'rm -rf *'
        action: deny         # 两种 shell 都拦
```

### 三种动作
| 动作 | 含义 |
|---|---|
| `allow` | 免询问运行，**并且该形状的沙箱升级请求也自动放行（命令可在沙箱外运行）** |
| `ask` | 强制弹审批 |
| `deny` | 拦截并给出原因 |

### 注意
- **命令字符串会**规范化**（折叠空格；Windows 大小写不敏感），程序 token 会先归一化
  （去路径、去引号、去 `.exe`/`.cmd` 类后缀）再参与匹配——`git *` 也能匹配
  `"C:\Program Files\Git\git.exe" status`；
- `*` 匹配任意多字符、`?` 匹配单个字符；规则锚定在命令开头（`git *` 不会误匹配
  `gitdb status`）；
- 复合命令按 `;` `|` `&&` `&` `||` 与换行**分段判定**，任何一段 deny ⇒ 整体拦，
  任何一段 ask ⇒ 整体询问；
- `$( … )` / 反引号里的子命令**递归展开后一起判**（所以 `echo $(whoami)` 里的
  `whoami` 会命中针对 `whoami` 的 deny 规则）；重定向**解析目标路径**并与工作区 ∪
  授权目录比对；heredoc 正文按数据处理；
- **无法解析的结构一律 fail-closed**（进程替换 `<(...)`、`$((`、引号不配对、递归超深）；
- ⚠️ **宽 pattern 的授权力度 = 全机执行**：`git *` → `allow` 会把该前缀下**任意**
  命令（含 git 协议注入 `ext::sh`）授权到沙箱外，`pnpm *` → `allow` 等于放行
  `pnpm run <任意脚本>`。请用窄规则（`git status*`、`pnpm test*`）表达精确意图；
- 规则只管 **bash / pwsh 两个 shell 工具**，其它工具与命令规则无关。

### 内置能力基线（`baseline`）
开启时（默认），只读命令（`ls`/`cat`/`grep`/`git status`/`Get-ChildItem`/`Where-Object`…）
与"只写工作区/授权目录内路径"的命令**无需任何规则**即可识别。关掉则完全按规则判定。

### 沙箱升级自动放行（`escalation`）
| 值 | 含义 |
|---|---|
| `capability`（默认） | 每条独立命令都命中 `allow` 规则（**allow 自带升级授权**），或都是良性能力类（只读、或只写工作区/授权目录内路径）⇒ 自动放行；其余（解释器、网络、包管理器、未知程序、解析不了的结构）弹审批 |
| `never` | 永不自动放行 |

三条硬约束（**任何规则都覆盖不了**，与配置无关永远生效）：
1. 命令引用了 **noRead 禁读目标**时绝不自动放行——升级会一并解除读取限制，
   `allow` 规则也不解除这条轨道；
2. 写入/重定向目标落在**工作区与授权目录之外**时不自动放行——正道是把它加入
   「沙箱授权 → 授权目录」，那样命令根本不会被沙箱拒绝；
3. 任一段命中 `deny` / `ask` 规则时不自动放行。

另有一条保守规则：**只读命令只要点名了工作区/授权目录之外的路径，也不自动走能力类
兜底**（`uniq 输入 输出`、`git log --output=…`、`tree -o 文件` 这类"看着是读其实
会写"的参数位置无法逐程序解析，宁可多问一次）。

**环境变量前缀**（`FOO=bar cmd`）只拦能力类兜底：显式写的 `allow` 规则照常生效。

**元程序展开**：`pnpm run <script>` / `pnpm <script>` 会读工作区 `package.json` 的
脚本文本（含 `pre`/`post` 钩子）按真实内容判定。读不到清单时保持保守。注意：若容器
命令本身命中了 `allow` 规则，该授权会覆盖展开后的脚本体（宽规则的代价）。

### 会话级命令缓存（`sessionCache`）
你手工批准过的某条命令（**完全相同的命令文本**）在本会话内不再重复询问；参数
有任何变化都算另一条命令。

### 场景示例
4. **日常放行**：pnpm / npm / git（非推送）免询问：
   ```yaml
   commands:
     default: delegate
     rules:
       - pattern: 'pnpm test*'
         action: allow
       - pattern: 'npm run*'
         action: allow
       - pattern: 'git status*'
         action: allow
       - pattern: 'git log*'
         action: allow
       - pattern: 'git add*'
         action: allow
       - pattern: 'git commit*'
         action: allow
       - pattern: 'git push*'
         action: ask          # 推送要你点头
   ```
5. **高危命令拦截**：删除类、磁盘清理类一律拦下，提示用审批走 ask 或人肉执行：
   ```yaml
   commands:
     rules:
       - pattern: 'rm *'
         action: deny
       - pattern: 'format *'
         action: deny
       - pattern: 'git reset*'
         action: ask          # 重置要你点头
   ```
6. **让某一个形状也能跑在沙箱外**（例如你信任的构建脚本）：`allow` 自带沙箱升级
   授权，写一条窄规则即可：
   ```yaml
   commands:
     rules:
       - pattern: 'pnpm build*'
         action: allow        # 免询问，且沙箱升级也自动放行
   ```
   ⚠️ 这条规则的真实授权力度是"该形状可获得全机执行权限"，只对你确认可信的
   程序/脚本使用。更稳的做法是保持窄 pattern（如 `pnpm build*` 而非 `pnpm *`），
   让 `pnpm run <script>` 尽量按 `package.json` 里脚本的真实内容判定。

---

## 3. 禁读规则（noRead）—— 限制能读到什么

### 用途
官方沙箱对**读**完全不设限；`noRead` 按「文件名 / 完整路径 / 目录」限制读取。
每条规则 `deny`（直接拒绝，fs 强制层兜底）或 `ask`（命中先弹一次人工审批，
批准后本次放行）。

### 三种模式（自动识别）
```yaml
sandbox-allowlist:
  noRead:
    # ① 文件名模式：不含路径分隔符 → 任意目录深度按名字匹配
    - pattern: '*.pem'
      action: deny
    - pattern: '.env*'
      action: deny
    - pattern: 'id_rsa*'
      action: deny

    # ② 完整路径 + 通配符：含分隔符且有 * 或 ?
    - pattern: 'D:\Vault\**\*.key'
      action: deny

    # ③ 目录级：含分隔符、无通配符的绝对路径 → 整棵子树禁读（含目录列表）
    - pattern: 'D:\Vault'        # 字面目录（= D:\Vault\**）
      action: deny
    - pattern: 'C:\Users\me\.ssh'
      action: deny

    # ask：想"偶尔放行一次"就用 ask
    - pattern: '*.crt'
      action: ask
```

模式要点（Windows 大小写不敏感）：
- ① 只比较**文件名**：`.env*` 覆盖 `.env` / `.env.local`；`id_rsa` 不拦 `id_rsa.pub`；
- ② 连续两个 `*` 可跨目录、单个 `*` 不跨；
- ③ 字面绝对目录 = 目录本身 + 整棵子树都禁读，**目录列表（listDir）也拦**；
  若该路径实际是一个文件，则等价于只禁这一个文件；
- 护栏：锚定盘符/根（`D:\`、`/`）与纯通配 `*`/`**`/`?` 会被**拒绝并告警**，
  不会出现"配了等于全禁/配了没用"的静默坑。

### 覆盖范围与边界
| 操作 | 命中 deny 规则时 |
|---|---|
| read / read_image（工具） | 拒绝（pre-execute 门直接 deny；fs 层抛 `FS_READ_DENIED`） |
| edit（隐含先读旧内容） | 拒绝 |
| write **覆盖已存在文件**（会回读旧内容生成 diff） | 拒绝 |
| write **新建**文件（未读任何旧内容） | **允许**（禁的是读不是写） |
| listDir（目录级规则） | 拒绝列出被禁目录及其树内子目录 |
| bash/pwsh 的 cat/type/Get-Content | 本期拦不到（见下） |
| grep / glob 工具（spawn 原生 ripgrep） | 本期拦不到（见下） |

**诚实边界**：`noRead` 只约束 dsh 自带读文件工具与一切经 `ctx.fs` 的读取——
它们是"代码层铁闸"；而 bash/pwsh 子进程与 grep/glob 走的是操作系统/独立进程，
**无法按文件名/扩展名在水面下拦截**（Windows ACL deny / bwrap 目录隐藏属于后续
方向）。对真正敏感的内容，首选把文件/目录**移出模型可达范围**，或用命令规则
拦截明显的读取命令，再叠一层 noRead 作为模型工具的兜底。
另：会话切到 `danger-full-access`（显式全信任）后禁读不生效，与写沙箱一致。

### 场景示例
6. **密钥/凭据**：工作区里散落的 `.env`、`*.pem`、`id_rsa*` 一律不许读：
   ```yaml
   noRead:
     - pattern: '*.pem'
       action: deny
     - pattern: '.env*'
       action: deny
     - pattern: 'id_rsa*'
       action: deny
   ```
7. **企业私有目录整树禁读**：`D:\Vault` 与家目录 `.ssh` 及其子目录，内容与列表
   都不许模型看到/读进：
   ```yaml
   noRead:
     - pattern: 'D:\Vault'
       action: deny
     - pattern: 'D:\Vault\**'
       action: deny          # 或只写一条字面目录，见③
     - pattern: 'C:\Users\me\.ssh'
       action: deny
   ```
8. **低频豁免用 ask**：`.crt` 之类"平时别看、偶尔允许看一眼"：
   ```yaml
   noRead:
     - pattern: '*.crt'
       action: ask
   ```
9. **禁止读特定配置文件**：模型常把 `config.json` 当敏感信息读进上下文；把配置
   所在整目录或该文件路径禁掉：
   ```yaml
   noRead:
     - pattern: 'C:\App\etc'
       action: deny
     - pattern: 'C:\App\etc\config.json'
       action: deny
   ```

---

## 4. 组合使用示例

10. **"能写不能读"的对接目录**：某受信目录代理需要往里面写导出文件，但模型不该
    把里面已有内容读进上下文：
    ```yaml
    sandbox-allowlist:
      allowedDirs:
        - 'D:\Shared\exports\**'   # 允许写
      noRead:
        - pattern: 'D:\Shared\exports'
          action: deny             # 但整棵不许读（含覆盖已存在文件）
    ```
    效果：新建文件可以；读、编辑、覆盖已存在的旧文件都会被拒。
11. **外网不可达 + 禁读 + 命令白名单 三明治**（典型的最小权限组合）：
    ```yaml
    sandbox-allowlist:
      allowedDirs:
        - 'D:\Shared\output'
      commands:
        default: delegate
        rules:
          - pattern: 'git *'
            action: allow
          - pattern: 'rm -rf *'
            action: deny
      noRead:
        - pattern: '*.pem'
          action: deny
        - pattern: '.env*'
          action: deny
        - pattern: 'D:\Secrets'
          action: deny
    ```

---

## 5. 生效与排障速查

| 问题 | 答案 |
|---|---|
| 在哪里配置？ | 设置页「沙箱授权」分节（三个卡片），或直接编辑 `$DSH_HOME/settings.yaml` 的 `sandbox-allowlist:` 段 |
| 什么时候生效？ | 保存即实时生效（服务端策略热读取；服务端模块代码更新需重启 dsh web 才加载） |
| 规则没起作用？ | 看「已知限制」边界（shell/grep 拦不到）；确认会话不是 `danger-full-access`；确认配置没有被 schema 拒绝（保存报错）或模式没被护栏丢弃（服务日志有 `noRead rule ignored` 告警） |
| 为什么没有 allow？ | 默认就允许读，allow 是空操作；需要例外用 ask |
| 禁读能拦住 shell 吗？ | 不能按文件名拦（本期）；请移出可达范围或另配命令规则 |
| 命令规则与文件沙箱关系 | `allow` = 放行**并含沙箱升级授权**（命令可在沙箱外运行）；越界写路径、禁读目标、解析不了的结构三条硬轨道不受规则影响 |
| 授权目录与禁读规则同时命中？ | 两者正交：allowedDirs 管写、noRead 管读，可指向同一目录（组合示例 10） |
| 我配了规则，为什么还是弹审批？ | 看弹窗里 `[sandbox-allowlist]` 那段：它写明**为什么没自动放行**（哪条独立命令、能力类是什么、是否越界/命中禁读）；同一段还会给出可添加的规则 |
| 怎么知道引擎实际判了什么？ | 每次判定都追加到 `$DSH_HOME/sandbox-allowlist-decisions.jsonl`（判定/原因/逐条能力类/是否可升级） |
| 老是被同一条命令问？ | 手工批准一次后本会话不再问（`sessionCache`，默认开）；想长期免问就看 `$DSH_HOME/sandbox-allowlist-proposals.json` 里的候选规则 |
| 想放行 `git status` 但拦住 `git push`？ | 用两条窄 pattern 规则：`git status*` → allow 写前面，`git push*` → ask 写后面；规则是"最后一条命中生效"，更细的放后面 |

配套文档：README（安装/原理/包结构）、`docs/guides/` 与 `docs/upgrade/` 下的设计文档。
