# M1-03/04/05 自动化测试计划（执行手册）

> 供执行 agent 按此完成任务。分支：`feature/m1-03-04-05`（被测差异 = 该分支相对
> `main` 的 5 个提交）。本文不提交也可执行；若入库须通过仓库隐私扫描（见约束）。
> 配套文档：[真机验收用例](m1-03-04-05-manual-acceptance.md)（人工执行，不在本计划内）。

## 0. 范围与排除项

被测功能（按主题）：

1. 授权清单 v2 与即时落盘（`lib/grant-manifest.mjs`）；
2. 对账引擎强化（`lib/policy.mjs`：排除清扫、pendingRevoke 重试、v1 迁移补记 grantedAt、父先子后剥离）；
3. 会话区授权状态面板 host 半件（`lib/state-routes.mjs`，自建路由 + 统一信封）；
4. 客户端半件（`src/client/index.tsx` → 构建产物 `lib/client.js` 的状态面板弹层）；
5. KI-2 孤儿授权发现清理（`lib/acl-scan.mjs`、`scripts/verify-ace.mjs`）。

**排除项**：审批弹框结构化文案（可行性报告方案一/二）的专项测试**不做扩展**——
`test:approval-gate`、`test:command-gate`、`test:command-matrix`、`test:read-gate`
只作为回归门运行，必须全绿，但不新增用例、不修改其断言。

## 1. 执行者约束（必须遵守）

- **仓库红线**：提交前按仓库根 `AGENTS.md` 执行隐私扫描；文档/测试中禁止出现
  本机真实路径、用户名、邮箱、IP、真实远程仓库名。机器相关路径一律用
  `mkdtemp` 临时目录或环境变量（`DSH_TEST_WORKSPACE`、`DSH_TEST_TRUSTED`、
  `DSH_TEST_OUTSIDE`、`DSH_HOME`、`DHS_INSTALL_ANCHOR`，用途见各测试文件头注释）。
- **产品代码零改动**：测试发现的疑似产品缺陷只记录（现象 + 最小复现 + 影响面），
  不修改 `lib/`、`src/`、`scripts/` 下任何文件；测试自身的问题可修。
- **提交规范**：Conventional Commits（`test:` 类型），正文说明补了什么、为什么；
  严禁 Co-Authored-By 与任何 AI 签名；在现有 feature 分支上提交，不开新分支。
- **平台守卫**：涉真 DACL/PowerShell 的用例（第 2、6 层运行期部分）必须保留/补上
  win32 条件跳过，保证非 win32 机器上测试套件可跑（跳过而非失败）。
- **清理纪律**：新用例沿用现有测试的退出钩子清理模式（`process.on('exit')` +
  best-effort `rmSync`），不留临时目录残留。

## 2. 环境准备

- Node ≥ 20.11；win32（第 2、6 层需要；第 1、3、4 层跨平台）。
- 从仓库根 `npm install`（devDependencies 含 `@deepseek-ai/cordis` 等，装完即可解析）。
- 若 `@deepseek-ai/*` 仍解析失败，按 `docs/development.md` 的 resolve-hook 方式运行
  （`test/resolve-hook.mjs`，需 `DHS_INSTALL_ANCHOR` 指向安装内锚文件）。
- 基线：动手前先跑一遍全部现有命令，确认全绿再开始，任何一条基线红先停手报告。

```bash
npm test && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client \
  && npm run test:dry-mount
```

## 3. 分层任务

标记说明：[已有]=已覆盖，核实断言强度即可；[补齐]=需新增；[核实]=先确认是否已
覆盖，未覆盖才补。每条用例给出「放哪 + 断什么 + 通过标准」。

### 第 1 层：清单数据层纯函数（`test/test.mjs`，跨平台）

| ID | 状态 | 用例 | 断言要点 |
|---|---|---|---|
| L1-01 | [已有] | 缺失/损坏清单 → 空结构；v1 裸数组迁移 + `needsWriteBack`；save 写回 v2 | 现有用例（约 224–255 行）保持全绿 |
| L1-02 | [已有] | `diffGrantedV2` 排除感知、父先子后排序 | 现有用例（约 293–312 行）保持全绿 |
| L1-03 | [已有] | `pushHistory` FIFO 上限 200、最老先掉且顺序保持 | 现有用例保持全绿；若无则补 |
| L1-04 | [补齐] | `normalizeRecord` 容错矩阵 | roots 含非对象项被过滤；pendingRevoke/history 条目缺字段用契约默认补齐；`origin` 非法值回退 `config-removed`；`attempts` 非数字归 0；`sid`/`updatedAt` 非字符串被丢弃 |
| L1-05 | [补齐] | `isExcludedPath` 三处命中 | roots 活标记 / pendingRevoke(origin=excluded) / history(origin=excluded) 三处分别命中；路径同判不区分分隔符方向与大小写 |
| L1-06 | [补齐] | `saveManifest` 原子性 | 断言写 `.tmp` 后 rename，正常路径不残留 `.tmp`；目标目录不存在时自动创建 |

### 第 2 层：对账引擎集成（`test/dry-mount.mjs`，win32 真实 DACL）

现有覆盖（**先读懂再动手，勿重复造**）：头部注释 1/2/2b/3/4a/4b/4c/4e 节与第 5 节
state-routes 契约。已含：运行期授权即时落盘回归锚（2b）、v1 迁移写回（4a）、
排除→剥离→history→恢复（4b）、撤销失败→pendingRevoke→重试、目录已删→记账剔除（4c）。

| ID | 状态 | 用例 | 断言要点 |
|---|---|---|---|
| L2-01 | [核实] | v1 迁移条目 `grantedAt` 补记 | 预置 v1 清单（含配置仍覆盖 + 配置已不含两类路径）→ 首次对账后：覆盖路径 `grantedAt` 从 null 变为有效时间且不再显示为 null；未覆盖路径 ACE 真实剥离、进 history(origin=config-removed)。若 4a 已断言 grantedAt 补记则只补缺失侧 |
| L2-02 | [补齐] | 损坏清单自愈 | 预置非法 JSON 清单 → 挂载 → 首次对账 → 视图重建出配置内目录记录、文件被重写为合法 v2 |
| L2-03 | [补齐] | 假账纠正链路 | 手工构造「账面 granted 但目录无 ACE」（如先授权再于非受限终端剥 ACE，或直接改清单指向新目录）→ 走 API `revoke`（对无 ACE 目录剥离应为幂等成功）→ `restore` → 断言拿到带新 `grantedAt` 的 granted，或如实转 failed 且 error 可读 |
| L2-04 | [补齐] | failed 行的「重试授权」真实路径 | 对不可写目录（ACL 拒绝）授权 → `status=failed` 且 error 入账 → 修 ACL → API `grant` → granted + 新 `grantedAt`。注意制造不可写目录的方式要在清理钩子里还原 ACL |
| L2-05 | [补齐] | workspace 解析优先级 | 显式 `workspace` > `sessionCwd` 命中 > 实例根，三级分别断言 `current`/生效目标；显式 workspace 不在清单 → `unknown-workspace`（已有部分，补优先级序） |

### 第 3 层：状态路由契约（`test/dry-mount.mjs` 直驱 + HTTP 适配层）

| ID | 状态 | 用例 | 断言要点 |
|---|---|---|---|
| L3-01 | [已有] | 信封契约、视图 JSON、`unknown-path`/`unknown-workspace`/方法名字符集、revoke/restore/grant 全链路 | 现有第 5 节保持全绿 |
| L3-02 | [补齐] | HTTP 适配层（`handleRequest`） | 用假 req/res（或 node:http 本地回环，地址限 127.0.0.1）直驱：非 POST → `bad-method`；body > 1MB → internal 错误信封；非法 JSON body → 错误信封；HTTP 恒 200 + 统一信封形状 |
| L3-03 | [补齐] | 非 win32 平台门 | 仅在非 win32 环境断言路由不注册（`captured.route === null`）；win32 机器上此用例以条件跳过形式存在，不得删除 |

### 第 4 层：客户端面板 UI（`test/verify-client-editor.mjs`，stub React + stub fetch，跨平台）

现有覆盖：`/api/state` 拉取、工作区指示器、时间单元格、revoke/restore 请求发出、
外部工作区空态。新增用例沿用现有 stub fetch 与元素树渲染模式（`findByClass` 等）。

| ID | 状态 | 用例 | 断言要点 |
|---|---|---|---|
| L4-01 | [补齐] | 坏数据渲染矩阵 | stub 视图逐一断言：`grantedAt:null` 的 granted 行时间列渲染「—」；`status:'failed'` 行 = 失败点 + reason 列 error 原文 + 操作列「重试授权」按钮；pendingRevoke 行 = 待回收 + error、操作列为空；history(origin=excluded) 行 = 已撤销 + 「恢复」按钮；granted 行 = 「撤销」按钮 |
| L4-02 | [补齐] | 空态与错误态 | `workspaces` 为空对象 → 空态文案（locale `status.empty`）；fetch reject → `role="alert"` 错误行 + `status.error` 文案，面板不崩 |
| L4-03 | [补齐] | 确认弹层流 | 点「撤销」先出确认层（`role="alertdialog"`）且**未**发请求；取消（遮罩/取消按钮）→ 无请求；确认 → 恰好一次 POST `/api/revoke`；「恢复」同理走 `/api/restore` |
| L4-04 | [补齐] | 状态过滤器 | 四态过滤 + 全部，各过滤下行数与 kind 正确 |
| L4-05 | [补齐] | 会话工作区选中语义 | `sessionCwd` 命中清单键（host `current` 宽松同判）→ 选中该工作区；不命中 → 恒空态，绝不回退实例根/最近使用键（现有部分覆盖，补「不命中」侧断言） |

### 第 6 层：KI-2 工具（`lib/acl-scan.mjs` 纯函数 + roundtrip）

| ID | 状态 | 用例 | 断言要点 |
|---|---|---|---|
| L6-01 | [已有] | `verify-ace.mjs --roundtrip`（win32 非受限终端人工触发一次） | 自造目录→物化→scan 命中→revoke 剥离→复扫归零；结果记入报告 |
| L6-02 | [补齐] | `parseDaclHits` 形状匹配（跨平台纯函数） | `S-1-4-<x>-<y>` 形状命中；私有临时目录 SID（第三段以 `-1` 结尾）被区分排除；`sidFilter` 生效；explicit 与 inherited-copy 分类正确 |
| L6-03 | [补齐] | `writeSidForDirectory` | 同目录重复调用稳定；路径规范化（分隔符/大小写）不影响结果；与文档示例形状一致 |

### 回归门（每层完成后 + 收尾各跑一次）

```bash
npm test && npm run test:client && npm run test:dry-mount \
  && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run typecheck
```

## 4. 产出与报告

1. 新增/修改的测试文件（在现有文件内扩展，风格随既有代码；不新建平行测试框架）。
2. 一份执行报告（`docs/testing/` 下或直接写在提交说明里）：
   - 每个用例 ID：结果（通过/失败/跳过）、关键断言、发现的问题；
   - 疑似产品缺陷清单：现象、最小复现、涉及文件与行号、影响面、建议修法（**不改代码**）；
   - 全量回归门最终输出摘要。
3. 提交切分建议：按层各一个 `test:` 提交（L1/L2+L3 可合并、L4、L6），便于回看。

## 5. 已知风险提示

- dry-mount 用真实 PowerShell 改临时目录 DACL：断言失败中断时靠退出钩子兜底清理，
  新用例必须沿用该模式；制造「不可写目录」类夹具要保证还原。
- `lib/client.js` 是构建产物（`npm run build:client` 生成），verify-client-editor 直测
  产物文本 + 运行时渲染：若产品端 TSX 有改动需先重建再测（本计划不涉及产品改动，
  仅在发现产物与源码不同步时报告）。
- locale 断言锚定 key（如 `status.empty`）与关键实词，不锚整句，降低文案微调碎断。
