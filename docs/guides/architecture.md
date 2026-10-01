# 架构与安全边界

> 语言切换：[English](architecture.en.md) ｜ 简体中文
>
> 本文说明本插件的工作原理、安全边界与已知限制。三类规则的使用方法见
> [权限规则指南](permission-rules.md)。适用版本 `v0.2.0-beta.1`，兼容基线
> dsh `0.2.0-rc.2`。

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
- **Linux**：`bwrap` 路径已实现但尚未真机验证；`landlock`/`seatbelt` 不支持。
- write/edit 工具只在 `workspace-write` 模式下放行授权目录。
- noRead 的 `ask` 规则只作用于 read / read_image / edit 工具；write 覆盖旧文件
  只受 `deny` 规则的 fs 层拦截，新建不受限；目录级 `deny` 另拦 listDir。
- 运行中的插件安装/卸载/启停依赖 dsh 宿主对 profile 补丁层的动态重载；若遇到
  异常，参见 [已知问题](../issues/ki-1-session-controller-reload-race.md)。
- dsh 升级若改变基类（`SandboxPolicyService` / `SandboxedFileSystem` /
  `LocalSandboxProvider`）的签名，本插件需要相应小调。

## 配套文档

- [权限规则指南](permission-rules.md)（[English](permission-rules.en.md)）——三类规则的使用与排障
- [README](../../README.md)（[English](../../README.en.md)）——安装与快速开始
- [开发与测试](../development.md)（[English](../development.en.md)）——测试、构建与内部契约
- [已知问题](../issues/ki-1-session-controller-reload-race.md)——KI-1 重载竞态的背景与处置
