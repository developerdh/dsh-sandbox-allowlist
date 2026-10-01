# dsh-sandbox-allowlist 升级计划：dsh 0.1.5-rc.2 → 0.2.0-rc.2

> 版本基准：插件 `0.1.0-beta.1`，当前兼容基线 dsh `0.1.5-rc.2`；目标平台 dsh `0.2.0-rc.2`。
> 依据来源：官方依据均以 npm 上 `0.2.0-rc.2` 包内 `.d.ts` / `lib/*.js` 实际核对为准（2026-09-30），
> 辅以《插件开发-09-依赖升级检查清单》（0.1.5→0.2.0 升级实践复核版）。rc 阶段官方 changelog 滞后，
> 安装包内 `.d.ts` 与源码是最终权威。

## 变更总览

| # | 变更项 | 严重程度 | 涉及文件 | 状态 |
|---|---|---|---|---|
| U1 | devDependencies 整体 bump + overrides 钉版 | 🔴 必改 | `package.json` | 待执行 |
| U2 | 删除宿主 settings namespace 注册 | 🔴 必改 | `lib/policy.mjs` | 待执行 |
| U3 | 配置读取路径收敛到 Config + Loader 重载模型 | 🔴 必改 | `lib/policy.mjs` | 待执行 |
| U4 | 生命周期卫生：disposer 交给 `ctx.effect` | 🔴 必改 | `lib/policy.mjs`、`lib/command-gate.mjs`、`lib/read-gate.mjs`、`lib/command-approval-gate.mjs` | 待执行 |
| U5 | 客户端迁移 `settingsScope` → `configForms` | 🔴 必改 | `lib/client.js`、`src/client/index.tsx` | 待执行 |
| U6 | tsdown externals / 构建链核对 | 🟠 验证 | `tsconfig.build.json`、构建脚本 | 待执行 |
| U7 | 测试床同步 | 🟠 必改 | `test/*` | 待执行 |
| U8 | 升级后验证（DoD） | 🟡 流程 | — | 待执行 |
| U9 | 与 auto-review 共存的预设感知 | 🟡 待决策 | `lib/command-gate.mjs` 等 | 方案讨论中（见 §10） |

---

## U1 package.json：依赖 bump 与钉版

**改哪里**：`package.json` `devDependencies` 与（新增）`pnpm.overrides`。

**改什么**：

- 7 个 `@deepseek-ai/*` 平台包：`^0.1.5-rc.2` → `0.2.0-rc.2`（确切版本或 `~`）。
  涉及：`dsh-app-boot`、`dsh-fs`、`dsh-fs-sandbox`、`dsh-sandbox`、`dsh-sandbox-local`、
  `dsh-sandbox-policy`、`dsh-sandbox-windows-acl`。
- `@deepseek-ai/cordis`：`^4.0.2` → `~4.0.4`。
- 新增 `pnpm.overrides`，把 `@deepseek-ai/schemastery` 钉成全图单一版本（`~3.18.4`）。
- 若采纳 §10 预设感知，追加 devDependencies：`@deepseek-ai/dsh-permission-presets@0.2.0-rc.2`。
- `dsh.client.inject` 的 4 个基座包（`dsh-client-ui-renderer` / `dsh-client-connection` /
  `dsh-client-ui-slots` / `dsh-client-ui-settings`）在 0.2.0-rc.2 均存在，清单可保留。

**官方依据**：

- prerelease semver 元组规则：`^0.1.5-rc.2` 只匹配同 `[major,minor,patch]` 元组，
  匹配不到 `0.2.0-rc.2`——不存在「小版本飘上去」的路径（检查清单 §1）。
- `npm view @deepseek-ai/dsh@0.2.0-rc.2 dependencies`：内嵌 `@deepseek-ai/cordis: ~4.0.4`、
  `@deepseek-ai/schemastery: ~3.18.4`；上述 7 个平台包在 npm 均有 `0.2.0-rc.2`（已逐一核实）。
- 依赖劈叉教训：`auto-install-peers=true` 下直装依赖与 peer 图各解析一版 schemastery，
  全局 interface 声明合并导致 typecheck 失败（检查清单 §1「依赖劈叉与 overrides 钉版」）。

**验收**：`npm run typecheck` 全绿；`node_modules` 内 schemastery 仅一个版本。

---

## U2 删除宿主 settings namespace 注册

**改哪里**：`lib/policy.mjs` 的 `_registerSettingsNamespace(ctx)` 方法及构造函数中的调用点。

**改什么**：整体删除。0.2.0 的 `SettingsForms` 没有 `register(namespace, schema, {base})`
方法，调用会在运行时直接失败。替代机制见 U3。

**官方依据**：

- `@deepseek-ai/dsh-settings@0.2.0-rc.2` `lib/types/index.d.ts`：`SettingsForms` 仅暴露
  `configure` / `describe` / `update` / `replace` / `mutate` / `prepareDocument` /
  `importLegacyDocument`（私有）；无任何按 namespace 注册 schema 的入口。
- 同文件 `SettingsDescriptor`：`ns` 即 profile entry id，`schema`/`value`/`base`/`user`/
  `revision` 直接来自插件 Loader 条目——设置表单的来源是「插件的 Schemastery `static Config`
  投影」，不再走注册式 API（检查清单 §2）。

**验收**：`grep -n "settings.register\|_settingsScope" lib/policy.mjs` 无结果。

---

## U3 配置读取收敛：Config 为唯一事实源 + Loader 重载模型

**改哪里**：`lib/policy.mjs`。

**改什么**：

- 删除 `_currentPatterns()` / `_currentCommands()` / `_currentNoRead()` 的
  `_settingsScope.get()` 回退分支，直接返回 `this.patterns` / `this.commands` / `this.noRead`
  （构造时从 Config 读取，已是现状的字段）。
- 删除 `_settingsScope` 字段、`_settingsDisposer` 字段与 watch 逻辑。
- `static Config`（`AllowlistPolicyService.Config`）已是设置表单的投影来源：
  `allowedDirs` / `commands` / `noRead` 字段与中文描述齐备，无需新增 schema。
  namespace 自动等于 loader entry id（`cordis.patch.yml` 的 `sandbox-allowlist-policy` 行）。
- 若需要抑制宿主自动生成的默认页（自绘客户端分节保留时），在构造期调用
  `ctx.settings.configure({ auto: false })`——0.2.0 该 API 仍存在（dsh-settings `.d.ts` 已核）。
- ACL 对账：删除 watch 触发后，对账收敛为**构造期幂等执行**（现有 `_startupReconciled`
  分支改为主路径）。0.2.0 下用户保存配置 → Loader reconcile → 插件重载 → 构造函数重跑，
  天然覆盖「编辑后生效」；grant-manifest 的跨重启补账已保证离线编辑与崩溃修复。

**官方依据**：

- `@deepseek-ai/dsh-settings@0.2.0-rc.2` `.d.ts`：`describe()` 读取「active plugin schemas
  and their live values」、`SettingsDescriptor.base/user` 分层；`importLegacyDocument` 负责
  旧 settings.yaml 一次性迁移（首写前改名，部分导入不重复）。
- 检查清单 §3：0.2.0 插件重载是配置保存的常态路径（Loader reconcile，普通字段变更触发
  重载重放 apply）——live watch 模型被重载模型取代。

**验收**：设置/插件页修改 `allowedDirs` 后：插件重载、构造期对账执行、`icacls` 可见
ACE 增删（撤销即回收语义不变）。

---

## U4 生命周期卫生：所有 register 类调用交给 `ctx.effect`

**改哪里**：

- `lib/policy.mjs`：`_registerTrustedRootsContext` / `_registerNoReadContext` /
  `_registerProposalContext` 三处 `scope.systemPrompt.context({...})`（返回的 disposer 目前被丢弃）；
  `_registerCommandGate` / `_registerReadGate` 内 `ctx.inject(['tools'], ...)` 中的
  `ctx.on('tools/pre-execute', ...)`、`ctx.on('approval/request', ...)`。
- `lib/command-gate.mjs`、`lib/read-gate.mjs`、`lib/command-approval-gate.mjs` 的 `apply()`：
  返回注册 disposer（或改由 policy.mjs 侧统一 effect 包裹）。

**改什么**：统一改为官方写法——

```js
ctx.effect(() => scope.systemPrompt.context({ ... }), 'sandbox:allowlist-context')
// 批量注册时 collect 全部 disposer，卸载时逆序注销
```

**为什么必须改**：0.2.0 下「保存配置」即触发 Loader reconcile 重载。残留注册会让
**第一次保存配置**就报 `duplicate ...` 并使整片激活失败，且运行时无法清除、需重启宿主进程
（检查清单 §3 实战踩坑）。

**官方依据**：

- `@deepseek-ai/dsh-system-prompt@0.2.0-rc.2` `.d.ts`：`context(context): () => void`
  返回 disposer，语义为调用方持有。
- `@deepseek-ai/dsh-experimental-auto-review@0.2.0-rc.2` `lib/index.js`：官方插件在
  `ctx.effect(function* () { yield ctx.on('tools/pre-execute', ..., { prepend: true }); ... },
  'auto-review lifecycle')` 生成器中登记 listener 与撤销逻辑——register 类合同的示范写法。
- 检查清单 §3：「register 类合同返回的 disposer 是唯一清理通道；随 fiber 卸载自动清理
  是错误假设，实测不成立」。

**验收**：live 重载链路实测（U8）：安装 → 修改配置触发重载 → 再次重载，无 duplicate 报错。

---

## U5 客户端半件迁移：`settingsScope` → `configForms`

**改哪里**：`lib/client.js`（运行时产物，手写 `__ModuleLoader__` bundle）与
`src/client/index.tsx`（等价 TS 源码，两处必须同步改，`test:client` 有防漂移断言）。

**改什么**：

| 现状（0.1.5） | 0.2.0 |
|---|---|
| `inject: ['slots', 'connection', 'settingsScope']` | `inject: ['slots', 'connection', 'configForms']` |
| `ctx.settingsScope.bind({ namespace: 'sandbox-allowlist' })` | `ctx.configForms.get('sandbox-allowlist-policy')`（key = loader entry id） |
| `scope.get()` 直读值 | `getSnapshot()` 读 `{ status, value, base, user, revision, writable, mode }` |
| `scope.set(field, value)` | `set(field, value): Promise<boolean>`；整组数组编辑建议 `mutate(ops, expectedRevision?)` 原子提交 |
| watch 回调刷新 | `subscribe(listener)` 订阅快照替换 |

- 必须处理 `status`：`loading` 降级渲染（骨架/禁用）、`unavailable` 不崩（见下条）。
- `mode: 'memory'`（desktop 壳内连接偏好进程本地）时 `writable: false`——原生通路只读，
  **必须保留自建读写降级通路**（两条通路写同一存储），原生通路仅在 `status === 'ready'`
  时作为增强。否则插件页变「不可写」死胡同（检查清单 §5 实测注记）。
- 覆盖标记（「未保存修改」徽章、重置按钮）按 `user` 对象的**键存在性**判断，
  不按值比较（`user` 键在场即覆盖，即使值等于 base）。
- 并发写冲突由 revision fence 兜底：保存失败分支要处理 `Promise<boolean>` 的 false 返回。

**官方依据**：

- `@deepseek-ai/dsh-client-ui-settings@0.2.0-rc.2` `lib/types/client/config-form.d.ts`：
  `ConfigForms.get(entryId)`、`ConfigFormController.getSnapshot/subscribe/set/unset/mutate/dispose`。
- 同目录 `config-form-types.d.ts`：`ConfigFormSnapshot` 结构与 `status`/`writable`/`mode`/
  `user` 键在场即覆盖的语义注释。
- 检查清单 §5：`settingsScope → configForms`、快照结构、`set/unset` 返回契约、
  宿主 `form` 不可依赖。

**验收**：web 端设置分节正常渲染与保存；`loading` 态不闪错；desktop 壳（memory 模式）
下自建通路可写；双入口并发修改保存被拒（revision fence）。

---

## U6 构建工具链核对

**改哪里**：tsdown 配置（client 侧 `externals`）与 `tsconfig*.json`。

**改什么**：

- client 侧 `externals` 与 0.2.0 web 前端白名单（`dsh-web-frontend/dist/assets/index-*.js`
  的 `staticModules`）逐项核对：多列打包失败或重复注入，少列运行时缺模块。
- host 侧 `neverBundle` 移除已消失的包（本次核对 7 个 host 依赖包均存在，预计无变化）。
- 两个 tsc 配置全过：`tsc -p tsconfig.json`（产物）+ typecheck。
- 已知验证点：`SandboxedFileSystem.checkedTarget` 在 0.2.0 `.d.ts` 中声明为 `private`
  （`lib/fs.mjs` 通过 `super.checkedTarget(...)` 调用，运行时存在）。`tsc --noEmit`
  若报错，处理方式：改用 `.d.ts` 交叉断言或调整调用点，不得改官方包。

**官方依据**：`@deepseek-ai/dsh-fs-sandbox@0.2.0-rc.2` `lib/types/index.d.ts` 第 91 行
`private checkedTarget;`；检查清单 §6。

---

## U7 测试床同步

**改哪里**：`test/dry-mount.mjs`（裸 cordis 上下文 stub）及各 verify 脚本。

**改什么**：

- stub 必须补 `ctx.effect` 生成器/回调语义（U4 改造后产物依赖它；测试床先于产物崩是
  检查清单 §7 明示的坑）。
- 删除 settings namespace 相关 stub（`settings.register` 已不存在）。
- `@deepseek-ai/dsh-permission-presets` stub：若采纳 §10，stub 需提供
  `current(session)` 与 `AUTO_PRESET` 常量。
- devDependencies 升级后重跑全部测试；esbuild 非 ASCII 转义假阴性——部署标记一律用
  ASCII 字符串（现状已满足，保持）。
- `DSH_HOME` / `DSH_TEST_*` 环境变量隔离（现状已满足，保持）。

**官方依据**：检查清单 §7；`@deepseek-ai/dsh-sandbox-policy@0.2.0-rc.2` `lib/index.js`
`static inject = ['sessionProjections']`（stub 继续需要提供该服务）。

---

## U8 升级后验证（DoD）

按检查清单 §8 执行，本插件特别关注：

- [ ] `npm run typecheck` / `test` / `test:command-gate` / `test:approval-gate` /
      `test:matrix` / `test:read-gate` / `test:client` / `test:dry-mount` 全绿。
- [ ] **live 重载链路**：安装 → 卸载 → 重装 → 保存一次配置触发 Loader reconcile 重载 →
      再改一次再重载（U4 生命周期卫生只有这条链路能验收）。
- [ ] 同版本重装会被 ambiguous-install 拒绝：本地测试 bump 版本号消歧。
- [ ] Windows 真机：授权目录写通 / 撤销回收（`icacls` 验证 ACE 出现与消失）。
- [ ] 插件页/设置页：字段完整渲染、保存成功、并发修改被 revision fence 拒绝、
      memory 模式降级通路可写。
- [ ] Linux（如可用）：bwrap `--bind` 追加生效。

---

## §10 与 auto-review 共存：已决策方案（2026-09-30 定稿）

> 背景与冲突分析见 2026-09-30 会话记录。核心冲突：本插件命令门 prepend
> `tools/pre-execute` 且不看权限预设——宽 `allow` 规则可能短路绕过官方
> auto-review 的 LLM 审查（两个 prepend 的先后取决于注册顺序，不可依赖）。

**决策**：命令审查功能本体不动（判定引擎、规则、缓存、提案全部保留）；
仅增加**官方同款预设探测**做会话级分流：

| 会话状态 | 行为 |
|---|---|
| 非 Auto 预设（含无预设层宿主、探测失败、agentless 调用） | 现行行为，一行不改 |
| Auto 预设（`permissionPresets.current(session) === 'auto'`） | 命令门整体 `next()` 委让——allow/ask/deny 全不参与，由官方逐调用 LLM 审查裁决 |
| 授权目录 | 无需改动：Auto 会话无沙箱，工作区外写天然全通（超集） |
| 禁读（noRead） | 无需改动：fs 层 sessionless resolve 与读门 `defaultMode` 均锚定**部署默认模式**，不随 Auto 会话的 Full access 覆盖失效 |

**实现**（已落地）：

- `lib/preset.mjs`（新增）：动态 import `@deepseek-ai/dsh-permission-presets` 取
  `AUTO_PRESET`（已核实为普通字符串 `"auto"`，包源码 lib/index.js:52；import 失败回退
  字面量），`isAutoSession(ctx, session)` 以 `ctx.permissionPresets.current(session)`
  判定——与官方 auto-review 自身 listener 的判定完全同源（auto-review 0.2.0-rc.2
  lib/index.js:464）。`'auto'` 是保留名（用户预设不可占用，permission-presets
  lib/index.js:176），探测无歧义。
- `lib/command-gate.mjs`：listener 开头 `isAutoSession(exec.agent?.session)` 命中即
  `next()`，在 callStore 记录/缓存/审计之前——Auto 会话中全部 layer-0 机制不参与。
- 升级审批门（approval/request）无需改动：Auto 会话无沙箱拒绝 → 无升级请求，天然 inert。
- 测试：`test/verify-command-gate.mjs` 新增 Auto 委让（allow 与 deny 都不短路）、
  非 Auto 会话行为不变、agentless 回落、无 presets 服务回落四组用例。

**升级联动**：U1 devDependencies 追加 `@deepseek-ai/dsh-permission-presets@0.2.0-rc.2`；
U7 测试床无需额外 stub（preset.mjs 的降级路径即为测试路径）。

---

## 附：本次核对引用的平台包（均 0.2.0-rc.2）

`dsh-settings`（SettingsForms 无 register、describe/mutate 合同）、`dsh-sandbox-policy`
（SandboxPolicyService 签名不变、`static inject=['sessionProjections']`）、`dsh-sandbox`
（`writableRoots()` 无 extraRoots 扩展点——授权目录机制仍为自研必需）、`dsh-fs-sandbox`
（writeText/editText 签名一致、`checkedTarget` 变 private）、`dsh-sandbox-local`
（LocalSandboxProvider 构造签名不变）、`dsh-sandbox-windows-acl`（workspaceWriteSid /
AclWriteGrant.create 不变）、`dsh-system-prompt`（context() 返回 disposer）、
`dsh-client-ui-settings`（configForms / ConfigFormSnapshot）、`dsh-client-ui-slots`
（slots.register 不变）、`dsh-client-connection`、`dsh-experimental-auto-review`
（AUTO preset 判定与 effect 写法）、`dsh-permission-presets`。
