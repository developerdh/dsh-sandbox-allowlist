# HANDOFF —— dsh-sandbox-allowlist「命令白名单 + 命名修改」任务交接

生成时间：本次会话末尾
交接原因：原会话在执行工具调用时反复中断，无法可靠地完成"验证后端生效 + 设置页命令规则可视化编辑器"两步。以下为已完成事实与待办，供新会话直接接手。

---

## 一、任务背景与已完成的工作（均已真实验证，勿重复）

### 1. 命令白名单功能（已实现并测试通过）
目标：参考 opencode / Claude Code 的命令放行设计，在 DSH 沙箱新增「命令白名单」——配置的命令执行时可直接放行（allow）免询问 / 拦截（deny）/ 弹审批（ask），支持通配符忽略参数。
- 设计已交用户确认：opencode 风格（tool + pattern + action）；`allow` 仅跳过审批询问、仍受文件沙箱约束；未命中默认维持现状（delegate）。

代码仓库（dev）：`<repo>`
- **新增** `lib/command-rules.mjs` —— 规则引擎（纯函数）：`*` 任意字符、`?` 单字符；`normalizeCommand`（折叠空格、Windows 大小写不敏感）；`compileCommandRules`（last-match-wins、tool 区分）；`validateCommandRule`。
- **新增** `lib/command-gate.mjs` —— `tools/pre-execute` 拦截门：命中 allow→`{kind:'allow'}`、deny→`{kind:'deny',reason}`、ask→`{kind:'ask'}`、未命中→`next()`。以 `{prepend:true}` 注册（排在其它询问监听器之前）。导出的 `apply(ctx,{getRuleSource})`。
- **修改** `lib/policy.mjs` —— 新增 `CommandRuleSchema`、`CommandSettingsSchema`、`AllowlistSettingsSchema` 增加 `commands` 字段；`Config.commands`；`_currentCommands()`；`_registerCommandGate(ctx)`（用 `ctx.inject(['tools'], ...)` 延迟到 tools 就绪后调用 `applyCommandGate`）；settings 命名空间 `base` 增加 `commands`。
- **修改** `test/test.mjs` —— 命令规则/schema/gate 单测；**新增** `test/verify-command-gate.mjs` —— 真实 cordis 上下文端到端验证（allow 短路下游 ask、ask/deny 带 reason、未命中委托、非 shell 工具绕过），**已运行通过**。
- **修改** `package.json` —— 增加 `test:command-gate` 脚本，`prepublishOnly` 含它。
- **修改** `README.md` —— 命令白名单配置文档、包结构、验证说明。

测试结果（均已通过）：
- `npm test`、`npm run test:command-gate`、`npm run test:dry-mount`、`npm run test:patch` 全部通过。

### 2. 设置页显示名「沙箱授权目录」→「沙箱授权」（已实现）
- 只改 UI 显示名，内部命名空间 id `sandbox-allowlist` 保持不变（避免破坏既有 `settings.yaml`）。
- 同步了两处（必须保持一致）：
  - `src/client/index.tsx` 第 84 行 `<h2>`、第 143 行 `label: () => '沙箱授权'`
  - `lib/client.js` 第 99 行 h2、第 148 行 label
- 用户已确认重启后能看到菜单名已改为「沙箱授权」✓ —— 说明部署生效。

### 3. 已部署到运行环境（用户已授权 danger-full-access，已完成）
web profile：`C:\Users\<用户名>\.dsh\profiles\web`
- 新 tarball：`<repo>\.pack\dsh-sandbox-allowlist-0.1.0.tgz`
- 已覆盖依赖 tarball：`C:\Users\<用户名>\AppData\Local\Temp\dsh-pkg\dsh-sandbox-allowlist-0.1.0.tgz`（14KB→20KB）
- 已手术式刷新插件副本：`C:\Users\<用户名>\.dsh\profiles\web\node_modules\dsh-sandbox-allowlist\lib\` 现含 `command-gate.mjs`、`command-rules.mjs`、新版 `policy.mjs`、更新后 `client.js`。旧版备份在 `<repo>\.pack\backup-installed`。
- 已静态校验部署文件含新功能；已用 node 加载部署的 `policy.mjs` 成功（default=function，无 ESM/语法错误）。
- **未走的路径**：`pnpm install` 全量重装会失败（profile 有 `github git+ssh:` 依赖 `dsh-at-file`/`dsh-navbar`/`dsh-skin` 等，SSH host key 验证失败）。**不要**绕道改 git/SSH 配置。手术式直接覆盖插件副本是可行且已采用的方式。

> 用户已重启过 dsh web 服务，并确认：菜单名已变为「沙箱授权」。

---

## 二、待办（新会话需完成）

### TODO-A【优先】验证后端命令白名单确实生效
用户确认重启后未见命令配置界面（符合预期，因为还没做可视化 UI）。但需先证明"后端门已工作"，否则 UI 无从谈起。
建议实证法（用户已授权本会话用 bash/命令读取与修改）：
1. 备份 `C:\Users\<用户名>\.dsh\settings.yaml`（工作区外，需 danger-full-access 写入）。
2. 在 `sandbox-allowlist` 下临时加一条测试 deny 规则，例如：
   ```yaml
   sandbox-allowlist:
     commands:
       rules:
         - tool: pwsh
           pattern: 'sandbox-allowlist-test*'
           action: deny
   ```
3. 在会话里执行一个匹配命令（如 pwsh 执行 `Write-Output sandbox-allowlist-test`），观察是否被 `tools/pre-execute` 门拦截（返回 deny 原因）。被拦截=生效。
4. 立即还原 settings.yaml（删掉临时配置）。

> 当前 `settings.yaml` 的 `sandbox-allowlist` 只有 `allowedDirs`：
> ```yaml
> sandbox-allowlist:
>   allowedDirs:
>     - C:\Users\<用户名>\.confluence-mcp
>     - C:\Users\<用户名>\.jenkins-mcp
>     - C:\Users\<用户名>\.rancher-mcp
>     - C:\Users\<用户名>\.confluence-mcp
> ```

### TODO-B 设置页加「命令规则」可视化编辑器分节
用户已确认要"在「沙箱授权」设置页分节里，再加一个命令白名单可视化编辑器（规则列表：tool/pattern/action，可增删行），与目录编辑器并列"。
- 后端数据层已就绪（`CommandSettingsSchema`、`_currentCommands()`、settings 命名空间 `commands`、设置保存实时生效）。
- 需要：改 `src/client/index.tsx`，在现有分节内加一个 commands 编辑区（每行一条规则），保存到 `scope.set('commands', ...)`；并同步手写 `lib/client.js`（两者必须一致）。
- 注意：`lib/client.js` 是手写 `__ModuleLoader__` 格式 bundle（非构建产物），改动后要让 GUI 显示需**重新部署 client 到 web profile 的 `node_modules\dsh-sandbox-allowlist\lib\client.js` 并重启**（同前部署方式：覆盖 + 重启，不能用 pnpm install）。
- 说明：README 提到客户端本可用 tsdown 构建，但当前仓库客户端是手写等价物，需人工保持两个文件同构。

---

## 三、关键环境事实（供新会话）

- DSH_HOME：`C:\Users\<用户名>\.dsh`
- web profile：`C:\Users\<用户名>\.dsh\profiles\web`
- 安装的插件副本：`C:\Users\<用户名>\.dsh\profiles\web\node_modules\dsh-sandbox-allowlist`
- profile 依赖声明：`file:C:\Users\<用户名>\AppData\Local\Temp\dsh-pkg\dsh-sandbox-allowlist-0.1.0.tgz`
- dsh CLI：全局 bin 在 `D:\ProgramData\nvm\v22.22.2\dsh*`（dsh/dsh.cmd/dsh.ps1）；web profile 用 pnpm（`prepublishOnly`、`file:` dep）。
- 沙箱权限：当前会话 `workspace-write`，写工作区外（profile、temp dsh-pkg、settings.yaml）需 `danger-full-access` 提升（用户已授权过此类操作）。
- dev 仓库 Node：`@deepseek-ai/*` 包已装在 dev 仓库 node_modules，`npm test` 可独立跑。

## 四、给用户的下一步（已沟通）
- TODO-A 验证后：告知后端是否生效。
- TODO-B 完成并重新部署 client + 重启后：用户可在设置页看到命令规则编辑器。
- 命令配置示例（`settings.yaml`）：
  ```yaml
  sandbox-allowlist:
    commands:
      default: delegate
      rules:
        - tool: bash
          pattern: 'git *'
          action: allow
        - pattern: 'rm -rf *'
          action: deny
  ```
  语义：allow=免询问（仍受文件沙箱约束）；ask=弹审批；deny=拦截；delegate=维持现状。规则按顺序、最后一条匹配的生效。

## 五、风险与注意
- 不要用 `pnpm install` 全量重装 web profile（github git+ssh 依赖会失败）。
- 改 settings.yaml 前务必先备份；验证用的临时规则验证后一定还原。
- 部署/验证均涉及工作区外写入，需 danger-full-access，且要用用户明确授权。
- 原会话工具调用多次中断（可能是环境/权限导致），新会话建议：遇到需要工作区外写操作时，一次性连续执行多个步骤，避免长间隔导致中断。
