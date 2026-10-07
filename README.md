# dsh-sandbox-allowlist

[English](README.en.md) ｜ 简体中文

DSH（DeepSeek Harness）沙箱扩展插件：在官方沙箱之上增加三类可配置权限规则，
全部经官方插件机制挂载，**不修改任何官方包代码**。

| 规则 | 解决什么问题 | 一句话 |
|---|---|---|
| **沙箱授权目录** `allowedDirs` | 代理要写工作区之外 | 受信目录整棵可写，无需审批、无需关沙箱 |
| **命令放行** `commands` | 命令审批太烦或太松 | 按命令模式 allow / ask / deny，复合命令逐段判定 |
| **禁读规则** `noRead` | 不想被模型读到 | 按文件名/路径 deny 硬拦，或 ask 审批后放行 |

三类规则在设置页可视化编辑，保存实时生效。Windows（ACL 沙箱）已在真机验证；
Linux（bwrap）已实现、**尚未真机验证**。

> 当前版本 `v0.2.1-beta.1`，兼容基线 dsh `0.2.0-rc.2`。

## 安装

```bash
# 从 npm registry / GitHub Releases 安装（发布后）
dsh plugin --profile web add dsh-sandbox-allowlist

# 本地开发调试（tarball）
pnpm pack --pack-destination /tmp/pkg
dsh plugin --profile web add /tmp/pkg/dsh-sandbox-allowlist-*.tgz
```

要求：dsh ≥ 0.2.0-rc.2（当前唯一验证版本，更早版本未验证），Node ≥ 20.11。安装即
向 profile 追加补丁层，后续配置改动 **HMR 自动热应用**，无需重启。

## 快速开始

推荐在设置页「沙箱授权」分节可视化编辑；同一份配置也可直接改 profile 补丁层
（`<profile>/cordis.patch.yml`）中本插件行的 `config`。最小配置（**路径均为示例，
请替换为你的实际目录**）：

```yaml
- id: sandbox-allowlist-policy
  config:
    # ① 授权目录：这些目录（工作区之外）沙箱内可直接写
    allowedDirs:
      - 'D:\Shared\Tools'
    # ② 命令放行：未命中规则时维持 dsh 现状（按需询问）
    commands:
      rules:
        - pattern: 'git status*'   # 窄规则：只放行只读形状
          action: allow
        - pattern: 'rm -rf *'
          action: deny
    # ③ 禁读规则：默认本就允许读，按需加限制
    noRead:
      - pattern: '*.pem'
        action: deny
```

> ⚠️ **安全警示**：授权目录将被沙箱内的 AI 代理**无审批**写入（工作区之外）。
> 只添加完全信任的目录；目录必须**已存在且归当前用户所有**。撤销信任 = 删除
> 条目，此前授予的写权限会自动回收。

## 配置速查

| 字段 | 作用 | 详情 |
|---|---|---|
| `allowedDirs` | 工作区外受信可写目录，支持 `**` / `*` / `?` 通配 | [指南 §1](docs/guides/permission-rules.md) |
| `commands.rules` | 命令模式 + 动作；按序匹配、最后命中生效；复合命令逐段判定 | [指南 §2](docs/guides/permission-rules.md) |
| `commands.default` | 未命中规则时的默认动作：`delegate` / `allow` / `ask` / `deny` | 同上 |
| `commands.escalation` | 沙箱升级自动放行（实验性）：`capability`（默认）/ `never` | 同上 |
| `commands.baseline` | 内置能力基线（默认开） | 同上 |
| `noRead` | 禁读规则：文件名 / 完整路径 / 目录级三种形态，`deny` / `ask` | [指南 §3](docs/guides/permission-rules.md) |

完整语义（判定流程三层、硬约束、Auto review 委让、决策轨迹、场景示例、排障
速查）见 **[权限规则指南](docs/guides/permission-rules.md)**。

## 工作原理（摘要）

沙箱的可写范围是一个允许清单，本插件向清单**追加授权目录**：Windows 上物化
工作区写 SID 的继承式写 ACE（撤销即自动回收，对账清单持久化）；Linux 上给
`bwrap` 追加 `--bind`。原理、安全设计与对账机制详见
[架构与安全边界](docs/guides/architecture.md)。

## 安全边界（务必阅读）

- **宽 `pattern` 的授权力度 = 全机执行**：`allow` 含沙箱升级授权，`git *` 连 git
  协议注入都放行。请用窄规则（`git status*`、`pnpm test*`）表达精确意图。
- **三条硬轨道不受任何规则影响**：解析不了的结构 fail-closed；越界写路径不自动
  放行；命令引用禁读目标绝不自动放行。
- **noRead 只约束模型文件工具与 `ctx.fs` 读取**：bash/pwsh 的 cat、grep/glob 工具
  拦不到——真敏感的文件请移出模型可达范围。
- 完整边界分析见[架构与安全边界](docs/guides/architecture.md)。

## 已知限制

- Windows：授权目录必须已存在且归当前用户所有；残留 ACE 可用
  `node scripts/revoke.mjs` 应急清理（通常无需使用）。
- Linux：`bwrap` 路径已实现但**尚未真机验证**；`landlock`/`seatbelt` 不支持。
- write/edit 工具只在 `workspace-write` 模式放行授权目录。
- 运行中启停插件若遇异常，处置见
  [已知问题](docs/issues/ki-1-session-controller-reload-race.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [权限规则指南](docs/guides/permission-rules.md)（[EN](docs/guides/permission-rules.en.md)） | 三类规则的完整语法、语义、场景与排障 |
| [架构与安全边界](docs/guides/architecture.md)（[EN](docs/guides/architecture.en.md)） | 工作原理、安全边界、已知限制 |
| [开发与测试](docs/development.md)（[EN](docs/development.en.md)） | 测试套件、构建部署、内部契约、包结构 |
| [权限配置测试计划](docs/testing/test-plan-permissions.md)（[EN](docs/testing/test-plan-permissions.en.md)） | 会话内端到端验证脚本 |
| [docs 目录说明](docs/agents.md) | 文档结构与协作约定（供协作者与 AI） |

## 开发

```bash
npm test && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client \
  && npm run test:dry-mount
```

测试环境变量、真机验证要点与内部契约见[开发与测试](docs/development.md)。

## License

MIT
