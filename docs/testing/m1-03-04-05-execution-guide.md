# M1-03/04/05 自动化测试执行方案

> 上游计划：[m1-03-04-05-test-plan.md](m1-03-04-05-test-plan.md)（范围、约束、排除项的唯一来源）。
> 用例步骤明细：[m1-03-04-05-test-cases.md](m1-03-04-05-test-cases.md)。
> 真机人工验收：[m1-03-04-05-manual-acceptance.md](m1-03-04-05-manual-acceptance.md)（不在本方案内）。
>
> 本文回答「按什么顺序跑、每步怎么算过、卡住怎么办、产出什么」；步骤细节一律看用例规格。

## 1. 环境准备（开工 checklist）

逐项打勾，全部满足才进入批次 0：

- [ ] 分支正确：`git status` 显示 `feature/m1-03-04-05`，工作区干净（`docs/tasks` 等例外目录忽略）；
- [ ] Node ≥ 20.11：`node -v`；
- [ ] win32 可用（批次 2/3/6 的运行期部分需要；批次 1/4 跨平台，非 win32 机器可先跑并
      按「平台守卫」确认用例是**跳过而非失败**）；
- [ ] 依赖就绪：仓库根 `npm install`（或既有 pnpm 环境 `pnpm install`），`@deepseek-ai/*`
      能解析——判据：批次 0 的基线命令能跑起来；
- [ ] 若 `@deepseek-ai/*` 解析失败：按 `docs/development.md` 的 resolve-hook 方式运行
      （`test/resolve-hook.mjs`，`DHS_INSTALL_ANCHOR` 指向安装内锚文件），全套命令都带
      loader 前缀执行；
- [ ] 环境变量未污染：确认 `DSH_HOME`、`DSH_TEST_WORKSPACE`、`DSH_TEST_TRUSTED`、
      `DSH_TEST_OUTSIDE`、`DHS_INSTALL_ANCHOR` **未**在 shell 里指向真实目录（留空让测试
      自建临时目录是默认正确状态）。

### 批次 0：基线验证（任何一条红 → 停手报告，不开始写用例）

```bash
npm test && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run test:client \
  && npm run test:dry-mount && npm run typecheck
```

记录每条命令的末行输出（如 `dry-mount: all checks passed`）作为基线证据，贴进执行报告。

## 2. 批次划分与执行顺序

四个实现批次 + 穿插的回归门。顺序依据：L1 是纯函数无环境依赖（最快验证思路）；
L2/L3 同文件且共享挂载夹具（合并为一个批次减少重复挂载）；L4 独立文件；L6 最薄。
每批次「先跑回归门再提交」，任何门红了先修测试自身（产品代码零改动），修不动就停下
按第 4 节登记。

| 批次 | 内容 | 落点文件 | 完成判据 | 提交 |
|---|---|---|---|---|
| 1 | L1-04 / L1-05 / L1-06（L1-03 核实） | `test/test.mjs` | `npm test` 绿 | `test: L1 清单数据层容错与原子性用例` |
| 2 | L2-01…L2-05 + L3-02 + L3-03（L3-01 核实） | `test/dry-mount.mjs` | `npm run test:dry-mount` 绿（win32）；非 win32 上 L3-03 断言生效、其余跳过 | `test: L2 对账集成与 L3 HTTP 适配层用例` |
| 3 | L4-01…L4-05 | `test/verify-client-editor.mjs` | `npm run test:client` 绿 | `test: L4 状态面板坏数据/空错态/确认流/过滤器用例` |
| 4 | L6-03 微补 + L6-01/L6-02 核实登记 | `test/test.mjs`；报告 | `npm test` 绿；roundtrip 输出入报告 | 可并入批次 3 提交或单独 `test: L6 SID 工具微断言` |

> 提交纪律：Conventional Commits，`test:` 类型；正文写「补了什么、为什么」；
> **禁止** Co-Authored-By 与任何 AI 签名；在现有 feature 分支上提交，不开新分支。

### 回归门（每批次提交前必跑）

```bash
npm test && npm run test:client && npm run test:dry-mount \
  && npm run test:command-gate && npm run test:approval-gate \
  && npm run test:matrix && npm run test:read-gate && npm run typecheck
```

四个既有 gate 套件（command-gate / approval-gate / matrix / read-gate）是**回归门**：
只要求全绿，不新增用例、不改断言（计划排除项）。最后一次回归门在收尾时再跑一遍，
输出摘要进报告。

## 3. 执行中的硬约束（违反即返工）

1. **产品代码零改动**：`lib/`、`src/`、`scripts/` 一个字节都不动。测试发现的疑似缺陷
   只登记（第 4 节模板）。测试自身代码（`test/*.mjs`）可改。
2. **隐私红线**：提交前在仓库根跑 `AGENTS.md` 的三行扫描（路径/IP 邮箱/本地关键词表），
   命中逐条人工确认；文档与用例中的机器路径一律 `mkdtemp` 临时目录或环境变量，
   示例路径用 `D:\\Demo\\…`、`W:\\work` 这类虚构形态并注明「示例」。
3. **清理纪律**：新用例沿用 `process.on('exit')` + best-effort `rmSync` 退出钩子模式；
   L2-04 的 ACL 夹具在钩子里必须先 `icacls … /reset` 再删目录。每批次跑完后抽查
   系统临时目录无 `dsh-drymount-*`/`dsh-grants-*` 类残留（有则说明钩子失效，先修）。
4. **平台守卫**：涉真实 DACL/PowerShell 的断言必须保留 win32 条件；非 win32 机器上
   套件的表现是「跳过」，不是「失败」。批次 2 的 L3-03 反向验证（非 win32 断言路由
   不注册）在 win32 机器上是跳过态，属预期，不得为了「看到它跑」而删条件。
5. **dry-mount 的子进程限制**：该文件头注明测试自身可能跑在 dsh 沙箱内、子进程管道
   捕获曾受限。涉及读 DACL 输出的断言（L2-01 ACE 侧）按用例规格的降级路径处理，
   报告注明；不要为绕过限制改产品或加权限。

## 4. 缺陷与差异登记（发现 → 记录，不修）

执行中遇到下列任一情况即登记：断言红且确认非测试自身问题；实现行为与计划/用例规格
表述不一致；挂载/清理出现意外残留。**先复现两次**（排除夹具偶发），再登记：

```
[DEF-序号] 一句话现象（或 [VAR-序号]：计划/规格与实现不一致）
- 用例：L?-?? 第 ? 步
- 环境：Node 版本 / Windows 版本 / 是否 resolve-hook 运行
- 最小复现：脱离测试文件可独立复现的最短脚本或命令序列
- 实际行为 vs 预期行为（引用计划或用例规格原文）
- 涉及文件:行号 + 初步影响面
- 建议（仅建议，不改代码）
```

已知差异（用例规格 §0 核实结论，直接带入报告，无需重新发现）：L1-04 roots 非对象项
收敛而非过滤；L6-02 已全覆盖；L6-03 仅补微断言；L4-05 「不命中」侧已被现有 ⑤ 覆盖。

## 5. 产出清单（执行完成的定义）

1. `test/test.mjs`：L1-04/05/06 新块 + L6-03 微断言（批次 1、4）；
2. `test/dry-mount.mjs`：L2-01…05 四个新场景 + L3-02 HTTP 断言 + L3-03 平台门块，
   头部注释同步补 4f+ 场景说明（批次 2）；
3. `test/verify-client-editor.mjs`：L4-01…05 新块（批次 3）;
4. **执行报告**（`docs/testing/m1-03-04-05-execution-report.md`，模板见第 6 节）；
5. 全量回归门最终输出摘要（报告内）；
6. 提交切分：按第 2 节表格，2–4 个 `test:` 提交。

报告与测试代码同批提交（`docs:` 或并入最后一个 `test:` 提交均可，保持仓库惯例）。

## 6. 执行报告模板

```markdown
# M1-03/04/05 自动化测试执行报告

- 执行时间 / 分支 HEAD / Node 版本 / 平台
- 基线：批次 0 各命令末行输出（全绿证明）

## 用例结果
| ID | 结果（通过/失败/跳过/降级） | 关键断言 | 备注（夹具方案、降级原因） |
|---|---|---|---|
| L1-04 | | | |
| … | | | |

## 核实结论登记
- L1-03 / L3-01 / L6-01 / L6-02 / L4-05(不命中侧)：已核实覆盖的证据（文件:行号）

## 缺陷与差异清单
（第 4 节模板逐条填写；无则写「无」）

## 回归门最终输出
（八条命令的末行输出摘录）

## L6-01 roundtrip 输出
（win32 非受限终端的完整输出；未执行则写明原因）

## 遗留与建议
```

## 7. 风险与应急预案

| 风险 | 信号 | 应急 |
|---|---|---|
| 基线即红（依赖解析失败 / 环境缺 PowerShell host） | 批次 0 非绿 | 停手，按 §1 检查 resolve-hook 与环境；带完整输出报告，不开始写用例 |
| dry-mount 在执行环境抖动（PowerShell spawn 超时/被沙箱拦） | 4b/4c/5 场景偶发红 | 先单独重跑 `npm run test:dry-mount` 三次定位偶发；确认是环境后在新用例里沿用既有降级路径（记账侧断言为主），报告注明环境因素 |
| L2-04 真实 ACL 夹具不可行（受限令牌 grant 意外成功/失败形态不同） | 方案 A 第 2 步断言不成立 | 按用例规格切换方案 B（接缝 stub），报告注明并保留 A 的失败证据 |
| lib/client.js 与 TSX 不同步（构建产物漂移） | 反漂移锚断言红（markers/词典 key） | 只报告（列出漂移的 key/标记），**不**擅自跑 `build:client` 重构产物；等待决策 |
| 客户端用例受 busy 窗口/hooks 残留干扰 | L4 断言偶发红、按钮 disabled | 对照用例规格 §4 的两条坑注释：等 800ms、跨场景强制重新 load；仍红则按缺陷登记 |
| 临时目录残留累积 | 临时区出现成批 `dsh-drymount-*` | 修清理钩子（测试代码），手动清理残留；确认 `created` 数组覆盖了所有夹具路径 |

## 8. 执行完成后的收尾

1. 跑最后一遍全量回归门，摘录进报告；
2. 抽查临时目录无残留；确认 `git status` 只有预期变更文件；
3. 按 `AGENTS.md` 完成隐私扫描（三行命令逐条过）；
4. 按批次表格完成提交（或确认已按批提交）;
5. 在上游测试计划文档（或其执行报告链接处）登记「自动化部分已完成」，指向执行报告；
   真机验收用例仍需人工执行，与自动化结果互不影响。
