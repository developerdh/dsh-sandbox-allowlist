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
dsh 的 bash / pwsh 工具执行命令前默认可能弹审批。`commands` 按
「工具 + 命令模式」决定：`allow`（直接跑，不询问）/ `ask`（强制询问）/
`deny`（拦截），未命中走 `default`（`delegate` = 维持现状）。

### 语法
```yaml
sandbox-allowlist:
  commands:
    default: delegate        # 未命中规则时：delegate=维持现状（默认）| allow | ask | deny
    rules:                   # 按声明顺序求值，最后一条命中的生效
      - tool: pwsh           # 可选：bash / pwsh；省略 = 两种都生效
        pattern: 'git *'
        action: allow
      - pattern: 'rm -rf *'  # 两种 shell 都拦
        action: deny
      - tool: bash
        pattern: 'git push *'
        action: ask          # 更具体的规则放后面，覆盖前面的 allow
```

### 注意
- 命令字符串会**规范化**（折叠空格；Windows 大小写不敏感），`*` 匹配任意字符、
  `?` 匹配单个字符——`git *` 天然忽略 git 后的任意参数；
- 复合命令按 `;` `|` `&&` `&` `||` 与换行**分段判定**，任何一段 deny ⇒ 整体拦，
  任何一段 ask ⇒ 整体询问；allow 只跳过审批段组合；
- `allow` **只跳过审批询问**，命令仍受文件沙箱约束（写盘边界不变）；
- 规则只管 **bash / pwsh 两个 shell 工具**，其它工具与命令规则无关。

### 场景示例
4. **日常放行**：pnpm / npm / git（非推送）免询问：
   ```yaml
   commands:
     default: delegate
     rules:
       - pattern: 'pnpm *'
         action: allow
       - pattern: 'npm *'
         action: allow
       - pattern: 'git status *'
         action: allow
   ```
5. **高危命令拦截**：删除类、磁盘清理类一律拦下，提示用审批走 ask 或人肉执行：
   ```yaml
   commands:
     rules:
       - pattern: 'rm -rf *'
         action: deny
       - pattern: 'format *'
         action: deny
       - pattern: 'git push *'
         action: ask        # 推送要你点头
       - pattern: 'git reset --hard *'
         action: ask
   ```

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
| 命令规则与文件沙箱关系 | allow 只跳过审批询问，写盘边界不变 |
| 授权目录与禁读规则同时命中？ | 两者正交：allowedDirs 管写、noRead 管读，可指向同一目录（组合示例 10） |

配套文档：README（安装/原理/包结构）、`docs/` 下的设计文档与原型。
