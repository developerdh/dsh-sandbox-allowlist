# dsh-sandbox-allowlist

DSH（DeepSeek Harness）沙箱扩展插件：为官方默认沙箱增加**可配置的可信可写目录**，
让沙箱内的 CLI 命令与 write/edit 文件工具都能写工作区之外的「沙箱授权目录」——
**不需要每次审批、不需要关闭沙箱**。

- ✅ 通过官方插件机制安装：`dsh plugin --profile <name> add dsh-sandbox-allowlist`
- ✅ 配置支持多个目录、**通配符**（`**` 子树、`*` 一级子目录、`?` 单字符）
- ✅ 覆盖 **Windows（ACL 沙箱）与 Linux（bwrap）**
- ✅ **命令白名单**：配置哪些命令无需询问即可运行（`allow`）/必须询问（`ask`）/被拦截
  （`deny`），参考 opencode / Claude Code 的权限规则设计，通配符忽略参数
- ✅ 设置页可编辑（`sandbox-allowlist` 设置 namespace，含安全警示说明）
- ✅ 纯插件实现：不修改任何 node_modules / 官方包代码

## 原理

DSH 沙箱允许写哪里 = 允许清单（allow-list）。本插件向清单**追加沙箱授权目录**：

- **Windows**：沙箱用「工作区写 SID 的 Write ACE」作为允许清单。插件在沙箱授权目录上
  物化该 SID 的**继承式写 ACE**（`(OI)(CI)(W,D,DC)`）→ 受限 CLI 直接可写、
  未来子目录自动继承；write/edit 工具由自研 fs 栅栏放行同一份清单。
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
    - 'D:\Work\202?'       # ? 匹配单个非分隔符字符
    - '/opt/tools/**'      # POSIX 写法同样支持
```

> ⚠️ **安全警示**：沙箱授权目录将被沙箱内的 AI 代理直接写入（无需审批）。请只添加
> 完全信任的目录；目录必须**已存在且归当前用户所有**；撤销信任删除条目即可
> （Windows 上旧目录的 ACE 用 `node scripts/revoke.mjs` 清理）。

通配符在**每次调用前懒展开**（TTL 缓存，`expandTtlMs` 可调）；不存在的路径跳过
并告警（`strict: true` 可改为抛错）；锚定盘符/根目录且带 `**` 的模式被拒绝
（防整盘遍历）。

## 命令白名单（command allow-list）

同一个 `sandbox-allowlist` 设置 namespace 还支持**命令放行规则**：配置哪些命令
执行时**直接放行而不用询问**（或应被拒绝）。思路上借鉴了 opencode 与 Claude Code
CLI 的权限规则设计——**按 shell 工具（`bash` / `pwsh`）+ 命令模式匹配**，支持通配符
以忽略参数，三条决策 `allow`（放行，不询问）/ `ask`（询问）/ `deny`（拦截）。

```yaml
sandbox-allowlist:
  commands:
    default: delegate          # 未命中规则时的处理：delegate=维持现状（默认）
                               # 可选 allow / ask / deny
    rules:                     # 规则按声明顺序求值，最后一条匹配的生效
      - tool: bash             # 可选；省略则对 bash 与 pwsh 都生效
        pattern: 'git *'       # '*' 匹配任意字符，'?' 匹配单个字符
        action: allow          # → git status / git commit … 均直接运行，不询问
      - tool: pwsh
        pattern: 'git status *'
        action: allow
      - pattern: 'rm -rf *'    # 未指定 tool ⇒ 两种 shell 工具都拦截
        action: deny
      - tool: bash
        pattern: 'git push *'
        action: deny           # 更具体的规则放在后面，覆盖前面的 allow
```

- **参数忽略**：用前缀 + `*` 即可忽略命令的任意参数——`git *` 允许所有以 `git` 开头
  的子命令；`git status *` 只放行 `git status` 及后续参数。命令字符串会规范化
  （折叠多余空格；Windows 上大小写不敏感）。
- **语义**：命中 `allow` 只跳过**审批询问**，命令仍受文件沙箱约束（写盘边界不变）；
  `ask` 强制弹审批；`deny` 直接拦截并给出原因；未命中则 `next()` 委托给下游，
  完全保留部署原有的行为。
- 规则通过设置页/`settings.yaml` 编辑，**实时生效，无需重启**。

## 包结构

```
lib/policy.mjs      替换 sandbox-policy：沙箱授权目录展开 + Windows ACE 物化 +
                   sandbox-allowlist 设置 namespace 注册 + 模型提示上下文 +
                   命令白名单 gate 挂载
lib/command-rules.mjs  命令白名单规则引擎（通配符匹配，纯函数，可单测）
lib/command-gate.mjs    tools/pre-execute 拦截门：allow/ask/deny 决策
lib/fs.mjs          替换 fs-sandbox：write/edit 栅栏放行 extraRoots
lib/provider.mjs    替换 sandbox（仅 Linux）：bwrap --bind 追加
lib/patterns.mjs    通配符匹配与目录展开（共享）
cordis.patch.yml    bundle 补丁层（安装即挂载）
scripts/revoke.mjs  Windows ACE 撤销脚本
src/client/         设置页「沙箱授权目录」分节源码（需 dsh 开发工具链构建）
test/               自检测试 / 补丁组合预检 / 干挂载测试
```

## 开发与验证

```bash
npm test                     # 自检测试（通配符展开、命令规则、类继承、Config/schema 校验）
npm run test:command-gate    # 端到端验证命令白名单 gate（真实 cordis 上下文 + tools/pre-execute 分发）
npm run test:patch           # 补丁组合预检（离线组合 web profile 补丁层）
npm run test:dry-mount       # 干挂载（临时 cordis 上下文端到端验证）
```

真机验证要点：受限 pwsh / write 工具写沙箱授权目录应成功且无审批；写工作区外**非**可信
目录应仍被拦截（`FS_SANDBOX_DENIED`）；`icacls <dir>` 应能看到工作区 SID
`S-1-4-...` 的 `(OI)(CI)(W,D,DC)` ACE。

## 设置页界面（客户端分节）

设置页的沙箱授权配置分两层：

1. **服务端数据层（已实现并验证）**：插件通过 `ctx.settings` 注册 `sandbox-allowlist`
   namespace（schema 描述中携带安全警示文案，随 `schema.toJSON()` 供设置页渲染）。
   设置文档（settings.yaml）→ 策略 → ACE → 受限写 全链路已真机验证。

2. **客户端分节（已实现并部署；源码 `src/client/index.tsx`，运行时手写等价物
   `lib/client.js`）**：`src/client/index.tsx` 在设置页 `settings.section` 槽位
   注册「沙箱授权」分节，UI 对齐 `docs/config-ui-prototype.html`（v5）高保真原型与
   dsh 官方插件配置卡片（`dsh-client-ui-settings-plugins`）的设计语言：
   - **分节结构**：标题 + 导语 + 两张可折叠配置卡片（授权目录 / 命令规则），
     卡片标题含计数与「未保存修改」徽章；收起态主体真正隐藏（CSS
     `:not(.is-open)`），头部信息保留；
   - **授权目录卡片**：克制式安全警示 callout + 结构化目录行（📁 或新增行的
     绿色「＋」圆形徽章 + 等宽输入 + 小 ✕ 图标按钮），焦点只高亮输入框本身
     （行边框不高亮），非法条目标红输入框（浏览器侧轻量校验镜像
     `lib/patterns.mjs` 的拒绝规则）；
   - **命令规则卡片**：未命中默认动作分段选择（`delegate` / `allow` / `ask` /
     `deny`，选中项 = 语义色浅底 + 语义色文字 + 粗体 + 内描边，未选中统一
     中性色）+ 规则表（**自绘工具下拉** + 命令模式 + `allow`/`ask`/`deny`
     紧凑分段 + 小 ✕ 图标按钮）+「添加规则」；
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
         "@deepseek-ai/dsh-client-runtime",
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

## 已知限制

- **Windows**：沙箱授权目录必须存在且归当前用户所有（需能改 DACL）
- **Linux**：`bwrap` 完整支持；`landlock`/`seatbelt` 暂不支持
- write/edit 工具只在 `workspace-write` 模式下放行沙箱授权目录
- dsh 升级时若基类（`SandboxPolicyService` / `SandboxedFileSystem` /
  `LocalSandboxProvider`）签名变化，本插件可能需要小调

## License

MIT
