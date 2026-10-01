# KI-1 安装 / 卸载 / 启停插件时 session-controller 报「Agent resolver is already registered」

- **状态**：dsh 运行时问题（0.2.0-rc.2 已确认），插件侧无法修复，规避方式可靠。
- **影响范围**：桌面端在**运行中**对本插件做安装启用 / 禁用 / 卸载等动态操作时；
  理论上任何"替换 session-controller 所依赖服务"的插件都会触发。
- **首次记录**：2026-10-01，两台独立机器（不同用户目录）均复现。

### 现象

操作时弹出失败提示（安装/卸载/启停分别对应「启用失败」「卸载失败」等），内容为：

> dsh: warning: 2 entries did not activate session-controller
> (@deepseek-ai/dsh-api-session-controller): Error: file-upload: Agent resolver
> is already registered at Proxy.registerAgentResolver
> (<dsh 安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-file-upload/lib/index.js:190:45) …
> at <用户主目录>/.dsh/profiles/desktop/#session-controller
> at … #include ui-deliverables (@deepseek-ai/dsh-client-ui-deliverables):
> pending (waiting for service: sessionController)

失败条目固定为两个：`session-controller`（上述报错）与 `ui-deliverables`
（pending，等待 sessionController，属连锁反应）。插件管理器概览页显示
「1 个失败」，失败组件为 `api-session-controller`。

### 触发条件

插件处于运行中的 dsh 客户端里，执行以下任一操作：

1. **安装并启用**本插件（新机器首次安装场景）；
2. **卸载**本插件；
3. 对本插件的 bundle / 行做启用 ↔ 禁用切换。

共同点：这些操作都会**动态更换 `fs` 服务的提供方**（官方 `fs-sandbox` 行 ⇄ 本插件的
`lib/fs.mjs` 行）。全新启动（插件已在启用状态时启动客户端）**不触发**。

### 根因（因果链）

1. 宿主 `dsh-api-session-controller` 的 `SessionController` 注入清单包含 **`fs`**
   （`static inject = ["fileUploads", "fs", "llm", "sessions", …]`）。
2. 本插件的 `cordis.patch.yml` 用 `lib/fs.mjs`（提供 `fs` 服务的
   `SandboxedFileSystem` 子类）替换官方 `fs-sandbox` 行——这是本插件的核心设计
   （write/edit 围栏放行授权目录 + noRead 读强制）。
3. 上述任一动态操作使 `fs` 的提供方更换，cordis 按语义**重启所有注入 `fs` 的存活
   条目**，session-controller 在其中。
4. `SessionController` 构造函数会**立即**在 file-upload 服务实例上注册 Agent
   resolver（`ctx.effect(() => ctx.fileUploads.registerAgentResolver(…), …)`）。
   而 `file-upload` 行自身不注入 `fs`（`static inject = ["agents", "attachments",
   "commands", "connection"]`），其 `fileUploads` 实例在重启中**存活不变**。
5. 重启排序上，新的 `SessionController` 构造抢在旧 fiber 的清理 disposer
   （`if (this.agentResolver === resolve) this.agentResolver = void 0`，带身份
   检查）之前执行，撞上实例上尚未清除的旧 resolver，抛出
   `Agent resolver is already registered`（file-upload `lib/index.js:190`：
   `if (this.agentResolver !== void 0) throw`）。
6. session-controller 激活失败 → ui-deliverables 因等待 `sessionController`
   服务而 pending。

跨机器有效性说明：两台机器报错栈中的 dsh 安装路径、模块路径与**行号完全一致**
（file-upload `190:45`、session-controller `2851:37/2851:8`、cordis
`1068:24/1142:34`），可确认是同一份 dsh 构建，宿主源码分析对两台机器同等有效。

### 为什么全新启动是干净的

冷启动时所有条目按依赖序一次性激活：`fs` 提供方在 session-controller 激活前就已
确定，resolver 注册只发生一次，不存在"重启存活服务"的窗口。因此重启客户端后
session-controller 恢复运行中，插件功能完整可用。

### 解决与规避

- **操作后重启客户端**。插件管理器在执行操作时会**先把磁盘状态写好**
  （profile 的 package.json、cordis.patch.yml），报错只发生在运行中的重载过程，
  不回滚已落盘的状态：
  - 安装启用后报此错 → 重启后插件应处于启用状态、`api-session-controller`
    显示运行中；
  - 卸载后报此错 → 重启后插件应已从列表消失；若仍在，说明该次卸载被回滚，
    重新卸载一次再重启即可。
- 开发调试期把「重启」当作装/卸/启停流程的一部分，忽略操作后弹出的该提示。

### 与本插件其他问题的区分

- 早期版本（provider 双重提供服务导致启动失败）的提示同样是 session-controller
  失败，但失败条目为**三个**（多出 `sandbox-allowlist-provider`，报
  `service "sandbox" has been registered`）。该问题已在当前版本修复
  （win32 上 provider 行惰性空转）；若你看到的失败条目不含
  `sandbox-allowlist-provider`，即为本文档所述的 KI-1。

### 建议的宿主侧修复（供反馈 dsh 官方）

任一即可消除该竞态，属 dsh 运行时改进，与本插件无耦合：

1. 重启存活条目时保证顺序：先完成旧 fiber 的 effect disposer，再执行新 fiber 的
   构造（消除重叠窗口）；
2. 或把 `registerAgentResolver` 的语义改为幂等覆盖（新 resolver 直接替换旧的），
   而非 `throw`。

### 复现记录

| 时间 | 机器 | 操作 | 结果 |
|---|---|---|---|
| 2026-10-01 | 机器 B（另一台电脑，独立用户目录） | 插件管理器安装并启用 | 启用失败 toast，2 entries 失败 |
| 2026-10-01 | 机器 A（开发机） | 插件管理器卸载 | 卸载失败 toast，2 entries 失败 |
