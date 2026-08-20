# dsh-sandbox-allowlist

DSH（DeepSeek Harness）沙箱扩展插件：为官方默认沙箱增加**可配置的可信可写目录**，
让沙箱内的 CLI 命令与 write/edit 文件工具都能写工作区之外的「沙箱授权目录」——
**不需要每次审批、不需要关闭沙箱**。

- ✅ 通过官方插件机制安装：`dsh plugin --profile <name> add dsh-sandbox-allowlist`
- ✅ 配置支持多个目录、**通配符**（`**` 子树、`*` 一级子目录、`?` 单字符）
- ✅ 覆盖 **Windows（ACL 沙箱）与 Linux（bwrap）**
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

## 包结构

```
lib/policy.mjs      替换 sandbox-policy：沙箱授权目录展开 + Windows ACE 物化 +
                    sandbox-allowlist 设置 namespace 注册 + 模型提示上下文
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
npm test                     # 自检测试（通配符展开、类继承、Config/schema 校验）
npm run test:patch           # 补丁组合预检（离线组合 web profile 补丁层）
npm run test:dry-mount       # 干挂载（临时 cordis 上下文端到端验证）
```

真机验证要点：受限 pwsh / write 工具写沙箱授权目录应成功且无审批；写工作区外**非**可信
目录应仍被拦截（`FS_SANDBOX_DENIED`）；`icacls <dir>` 应能看到工作区 SID
`S-1-4-...` 的 `(OI)(CI)(W,D,DC)` ACE。

## 设置页界面（客户端分节）

设置页的沙箱授权目录配置分两层：

1. **服务端数据层（已实现并验证）**：插件通过 `ctx.settings` 注册 `sandbox-allowlist`
   namespace（schema 描述中携带安全警示文案，随 `schema.toJSON()` 供设置页渲染）。
   设置文档（settings.yaml）→ 策略 → ACE → 受限写 全链路已真机验证。

2. **客户端分节（源码脚手架，需 dsh 开发工具链构建）**：`src/client/index.tsx`
   在设置页 `settings.section` 槽位注册「沙箱授权目录」分节（警示横幅 + 每行一个
   模式的文本列表编辑器）。构建步骤：

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
