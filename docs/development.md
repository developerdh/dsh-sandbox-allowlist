# 开发与测试

> 语言切换：[English](development.en.md) ｜ 简体中文
>
> 面向维护者与贡献者：测试套件、环境变量、客户端构建与部署、内部契约。
> 使用文档见 [README](../README.md) 与 [docs/agents.md](agents.md) 所载目录说明。

## 测试套件

```bash
npm test                     # 自检测试（通配符、规则引擎、能力分类、结构解析、决策引擎、审计/缓存/提案、noRead、schema、volatileForm 投影守卫）
npm run test:command-gate    # 端到端验证命令门（真实 cordis 上下文 + tools/pre-execute 分发）
npm run test:approval-gate   # 端到端验证升级审批门（能力基线 / allow 升级授权 / noRead 联动 / 会话缓存 / 规则提案）
npm run test:matrix          # 对抗回归矩阵（沙箱相位 × 升级相位双列断言）
npm run test:read-gate       # 端到端验证 noRead 禁读（policy 挂载 + fs 强制层 + pre-execute deny/ask）
npm run test:client          # 设置页客户端 bundle 渲染断言（含防漂移标记与 i18n 词典断言）
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
| `DSH_TEST_OUTSIDE` | dry-mount 的工作区外越界探针目录 | 系统临时目录的父目录（按 pid 隔离） |
| `DSH_INSTALL_ANCHOR` | test:patch 组合真实 web profile 所需的 dsh 安装锚点 | **无（必填）** |
| `DHS_INSTALL_ANCHOR` | resolve-hook 解析 @deepseek-ai/* 的安装锚点 | 仓库自身 node_modules |

真机验证要点（**Windows**；Linux 的 bwrap 路径尚未真机验证）：受限 pwsh / write
工具写授权目录应成功且无审批；写工作区外**非**
可信目录应仍被拦截（`FS_SANDBOX_DENIED`）；`icacls <dir>` 应能看到工作区 SID
`S-1-4-...` 的 `(OI)(CI)(W,D,DC)` ACE；在设置页删除该目录并保存后，同一 `icacls`
输出中该 ACE（含子目录继承副本）应消失——撤销即回收。完整的会话内验证脚本见
[权限配置测试计划](testing/test-plan-permissions.md)。

## 设置页客户端

源码 `src/client/index.tsx`，运行时手写等价物 `lib/client.js`（两处必须保持一致，
`test:client` 有防漂移断言）。界面文案全部走宿主词典服务（`ctx.locale`，
namespace `sandbox-allowlist`），词典在 `src/client/locales.ts`（zh 真源 + en 镜像，
`lib/client.js` 内联同步一份）。i18n 词典化改造采纳自
Bernd Weymann（[@weymann](https://github.com/weymann)）的贡献。从源码重建：

```bash
# 在 dsh 开发仓库的 pnpm workspace 中（client 依赖需可解析）
pnpm install
pnpm run build:client      # tsc + tsdown → lib/client.js（__ModuleLoader__ 格式）
```

产物就位后 package.json 的 `dsh.client.inject` 才能声明（`inject` 意为「工厂必须
先于所列包行到达」；缺失时不可声明，否则 web 应用加载失败）。部署改动：覆盖
web profile 的 `node_modules/dsh-sandbox-allowlist/lib/client.js` 后刷新页面即可
（`/plugins/<id>/client.js` 每次请求都从磁盘读取，无需重启服务）。

测试用的裸 cordis 上下文必须提供 `sessionProjections`、`systemPrompt` 与
`fileUploads` stub，缘由见 `test/dry-mount.mjs` 的注释。

## 插件面板（Plugins 页）槽位

client 半件除设置页分节外，还向插件详情页注册两个官方配置槽位——
`plugins.bundle.config`（key=包名，配置界面渲染在包详情页描述与行列表之间）与
`plugins.row.config`（key=`<包名>#sandbox-allowlist-policy`，策略行获得「配置」
入口），两者与设置页「沙箱授权」分节是同一份数据。`summary` 视图（官方卡片标题
下 / 行描述兜底位）返回一行说明文字。provider 行额外注册了平台提示：详情页
`plugins.detail.badge` 徽标（「仅 Linux 生效」）+ 行说明页（`row.config` 打开，
交代 Linux/Windows/macOS 各自的行为）——配合 provider.mjs 在 Windows 上的惰性
空转，启用错平台时不再出现异常，只有友好说明。

## 行显示元数据

插件管理器按每行的模块说明符解析 `<说明符>/locale/*.json` 的 `meta.title` /
`meta.description`（回退到该地址的 package.json）。`lib/fs.mjs` 与 `lib/provider.mjs`
是子路径说明符，各自的中英描述放在 `lib/meta/<row>/locale/`，由 package.json
`exports` 的精确键映射到 `<行地址>/locale/*.json`；locale 目录只能放语言命名的
JSON（app boot 对其他文件名直接报错）。provider 行描述明确注明平台限制
（仅 Linux bwrap 生效，Windows 空转）。

## volatile 契约（勿删）

`AllowlistPolicyService.Config` 的三个规则字段（`allowedDirs` / `commands` /
`noRead`）必须保持 `.volatile()`——宿主只把带 volatile 标记的字段投影进设置
表单（dsh-settings 的 `volatileForm`），一个 volatile 字段都没有的条目不会被
`settings.describe` 下发，客户端 `configForms.get()` 将拿不到已服务 namespace，
设置页永远只读（提示「宿主没有提供本插件的设置表单」）。volatile 字段经 loader
校验后的值是 cosmokit `Volatile<T>` 稳定引用（保存后宿主原地更新值，无需重挂
插件），服务端一律通过 `_currentPatterns()` / `_currentCommands()` /
`_currentNoRead()` 读穿引用取值，任何直接读 `this.patterns` 等字段的代码在真实
宿主里都会拿到引用对象而崩溃。

## 包结构

```
lib/policy.mjs      替换 sandbox-policy：授权目录展开 + Windows ACE 物化与撤销对账
                    （grant-manifest.mjs 持久化清单）+ 模型提示上下文 + 命令门与
                    升级审批门挂载 + noRead 禁读链路
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
lib/meta/           行显示元数据（fs/provider 的中英描述，exports 映射为
                    <行地址>/locale/*.json 供插件管理器读取）
lib/patterns.mjs    通配符匹配与目录展开（共享）
cordis.patch.yml    bundle 补丁层（安装即挂载）
scripts/revoke.mjs  Windows 应急清理脚本（通常无需使用：撤销已自动回收）
scripts/verify-ace.mjs  Windows ACE 物化手动验证（check 模式核对期望 SID 与实际
                    DACL；--roundtrip 在临时目录上单测物化原语，见文件头说明）
src/client/         设置页「沙箱授权」分节源码（需 dsh 开发工具链构建）
src/client/locales.ts  UI 词典（zh 真源 + en 镜像）
test/               自检测试 / 端到端验证 / 对抗回归矩阵 / 补丁组合预检 / 干挂载
```

## 目录与协作约定

仓库文档的结构、双语同步与写作规范见 [docs/agents.md](agents.md)；内部工作底稿
（如版本升级方案）在 `docs/internal/`，不对用户承诺内容。
