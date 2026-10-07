# M1-03/04/05 自动化测试执行报告

- 执行时间：2026-10-06 晚（定时任务触发，无人值守）
- 分支：`feature/m1-03-04-05`
- 环境：Node v22.22.2 / win32（Windows 11） / 直接运行（无 resolve-hook）
- 执行依据：[测试计划](m1-03-04-05-test-plan.md)、[执行方案](m1-03-04-05-execution-guide.md)、[用例规格](m1-03-04-05-test-cases.md)
- 当前状态：**测试完成，发现的问题已全部处置**（执行轮记录 → 修复回填见 §9；修复后八条回归门全绿）

## 1. 基线证据（批次 0，动手前）

八条基线命令全绿，随后才开始写用例：

| 命令 | 末行输出 |
|---|---|
| `npm test` | `dsh-sandbox-allowlist: all checks passed` |
| `npm run test:command-gate` | `verify-command-gate: all checks passed` |
| `npm run test:approval-gate` | `verify-approval-gate: all assertions passed` |
| `npm run test:matrix` | `verify-command-matrix: 44 rows checked (a mismatch would have thrown at its row)` |
| `npm run test:read-gate` | `verify-read-restriction: all checks passed` |
| `npm run test:client` | `verify-client-editor: all checks passed` |
| `npm run test:dry-mount` | `dry-mount: all checks passed` |
| `npm run typecheck` | 退出码 0 |

## 2. 用例结果总表

标记沿用计划：通过 / 失败 / 跳过 / 降级。「新」= 本次新增，其余为既有覆盖的核实。

| ID | 结果 | 关键断言 | 备注 |
|---|---|---|---|
| L1-01 | 通过 [已有] | 缺失/损坏清单 → 空结构；v1 迁移 + `needsWriteBack`；save 写回 v2 | 既有用例，回归门证明 |
| L1-02 | 通过 [已有] | `diffGrantedV2` 排除感知、父先子后排序 | 既有用例 |
| L1-03 | 通过 [核实] | `pushHistory` FIFO 封顶 200、最老先掉、顺序保持；pendingRevoke 单条约束 | 既有「history FIFO 封顶」块已全覆盖，未新增 |
| L1-04 | 通过 [新] | 容错矩阵七组：roots 非对象项收敛、pendingRevoke/history 缺字段补齐与缺 path 丢弃、origin 非法回退 config-removed、attempts 非数字归 0（有限小数透传）、sid/updatedAt 非字符串丢弃、垃圾工作区值 → 空记录 + needsWriteBack | 经 `loadManifest` 公共入口驱动；VAR-1 |
| L1-05 | 通过 [新] | 三处排除命中（roots 活标记 / pendingRevoke / history，origin=excluded）+ config-removed 对照不命中 + 路径同判 | VAR-2（尾分隔符不折叠） |
| L1-06 | 通过 [新] | 目标目录自动创建、无 `.tmp` 残留、`needsWriteBack` 不落盘、rename 覆盖同名 `.tmp` | 不 mock fs，断言两步写的可观测效果 |
| L2-01 | 通过 [新]（4f） | v1 双路径：仍覆盖路径 `grantedAt` 从 null 补记为合法时间；配置已不含路径离开 roots、入 history(origin=config-removed) | VAR-5（ACE 侧降级说明） |
| L2-02 | 通过 [新]（4g） | 非法 JSON 清单 → 首次对账重写合法 v2、记录重建（granted + grantedAt）、无幽灵 pendingRevoke/history | VAR-3（fromPatterns 断言面在视图层） |
| L2-03 | 通过 [新]（4h） | 假账纠正：真实剥离原语制造账实不符 → API revoke 幂等成功入史 → restore 重物化，grantedAt 不早于旧值 | 对应真机验收 A5 的自动化面 |
| L2-04 | 通过 [新]（4i） | failed 记账（status/error/errorAt/attempts）→ 修复 → API grant → granted + 新 grantedAt + error/errorAt 归 null + attempts 归 0 | 夹具降级为方案 B（接缝），VAR-6 |
| L2-05 | 通过 [新]（4j） | 显式 workspace 压过 sessionCwd（操作级断言）；sessionCwd 命中 → current 与操作目标均落该键；未命中兜底实例根；未知工作区拒绝 | 4j 注释说明 state.current 不受显式参影响 |
| L3-01 | 通过 [已有] | 信封契约、视图 JSON、unknown-path/unknown-workspace、方法字符集、revoke/restore/grant 全链路 | 既有第 5 节 |
| L3-02 | 通过 [新] | 非 POST → bad-method；body > 1MB → internal(too large)；非法 JSON → internal(not valid JSON)；空 body → state ok；HTTP 恒 200 形状 + content-type 恒 JSON + 统一信封 | 假 req/res 直驱（`Readable` + 记录型 res），未用真回环 |
| L3-03 | 跳过 → 已收口 [新] | 非 win32 断言 `captured.route === null`（路由不注册） | 执行轮 win32 本机按设计条件跳过；修复阶段新增 3c 进程内平台伪装验证并**通过**，真实 POSIX 完整挂载（3b）仍待跨平台机器 |
| L4-01 | 通过 [新] | 五类行渲染矩阵：grantedAt:null → 时间列「—」；failed 行 = errorAt 时间 + 原因列 error 原文（data-tip 全文）+ 重试授权；roots 内 excluded 与 pendingRevoke 行 = 待回收（后者带 error 原文与 lastAttemptAt）且操作列空；history(excluded) = 已撤销 + 恢复；granted 行 = 撤销 | VAR-4 相关（excluded root 行归 pending 类） |
| L4-02 | 通过 [新] | 空清单 → `status.empty` 空态零行；fetch reject → `role="alert"` + 「载入失败」+ 原因，面板不崩（刷新仍可用）；恢复后错误行消失、五行回归 | |
| L4-03 | 通过 [新] | 遮罩点击 / 取消按钮两条取消路径零请求且弹层关闭；撤销、恢复确认各自**恰好一次** POST，payload 指向所看工作区对应行 | 与既有 ③④ 互补（既有只断确认正向路径） |
| L4-04 | 通过 [新] | 四态 + 全部的行集合精确断言 + `data-active` 选中态 | 执行轮含 DEF-1 已知缺陷锚点，修复后已改为正向断言（§9）；VAR-4 |
| L4-05 | 通过 [新] | cwd 拼写变体（大小写/分隔符）→ 请求携带原始 cwd、采纳精确清单键并渲染行；current 命中但清单无此键 → 防御空态不崩 | VAR-3 相关；「不命中恒空态不回退」由既有 foreign-cwd 用例覆盖（`!hasTextIn(foreignNodes, 'D:\\Other\\Stale')` 等断言），核实登记 |
| L6-01 | 通过 | `--roundtrip`：物化 → icacls 可见预期 SID → dispose 后 standing（完整输出见 §6） | 本机终端具备 DACL 写权限 |
| L6-02 | 通过 [核实] | 形状命中 / 私有临时 SID 排除 / sidFilter / explicit 与 inherited 分类 | 既有 SID 块四个断言要点全覆盖，未新增 |
| L6-03 | 通过 [新] | 分隔符方向变体同 SID；输出形状 `/^S-1-4-\d+-\d+$/` | 派生公式、大小写收敛、异目录异 SID、不存在目录可重算均既有 |

排除项（计划 §0）：`test:command-gate`、`test:approval-gate`、`test:matrix`、`test:read-gate`
仅作回归门运行，**零用例新增、零断言修改**，每批次与收尾共跑 5 轮全绿。

## 3. 缺陷与差异清单

### DEF-1（产品缺陷 + 产物漂移，**已修复**）：面板状态过滤器点击抛 ReferenceError

- **现象**：点击面板任意状态过滤器，`setFilter(entry.key)` 生效后同步抛
  `ReferenceError: setConfirmKey is not defined`。
- **最小复现**：打开会话授权状态面板（有任意记录），点「已授权/授权失败/待回收/已撤销/全部」
  任一过滤器按钮。自动化复现：`npm run test:client` 中 L4-04 的 `applyFilter`（每次点击捕获到该异常）。
- **涉及位置**：`lib/client.js:2276`
  `onClick: function onFilter() { setFilter(entry.key); setConfirmKey(null); }`——
  组件内只存在 `setConfirm`（lib/client.js:2026 定义，2058/2097/2183/2189/2304/2312/2316
  均正确使用），`setConfirmKey` 从未定义。
- **源码对照（漂移证据）**：`src/client/index.tsx:1711` 为
  `onClick={() => setFilter(entry.key)}`，无 `setConfirmKey` 语句——手写构建产物与源码不同步。
- **影响面**：真实 UI 每次切换过滤器都向控制台抛错（React 事件处理器内同步异常，不致命但
  持续报错）；若该语句意图是「切换过滤器时关闭确认层」，该副作用从未生效。
- **建议修法（未实施，产品代码零改动）**：`setConfirmKey(null)` → `setConfirm(null)`
  （与 2316 行取消按钮一致，同时保住「切过滤器关确认层」的意图）；或删除该语句与 TSX 对齐。
  修复后须同步：更新 L4-04 的 DEF-1 锚点断言（锚点会在缺陷消失时变红提示）。
- **修复状态**：已按第一方案修复（产物 + 源码同步），L4-04 已改为正向断言，详见 §9。

### VAR 差异（计划/用例规格表述与实现的偏差，非缺陷必修）

- **VAR-1**：计划 L1-04 写「roots 含非对象项被过滤」；实现是收敛为 `path:''` 的契约默认
  条目（`normalizeRootEntry`；仅 v1 裸数组分支过滤非字符串）。空路径条目会进入
  `activeEntries` 与视图，属鲁棒性瑕疵，供评审；用例按实际契约断言。
  **→ 已修复：现整条丢弃，L1-04 断言丢弃契约。**
- **VAR-2**：用例规格 L1-05 写「尾分隔符归一」；`comparablePath` 只折叠分隔符方向与
  大小写，不折叠尾分隔符（`patterns.mjs` comparablePath）。用例按实际契约断言不命中。
  **→ 维持契约不修（全局改变影响 scope/fence 路径比较）；用例规格已按实际契约修正。**
- **VAR-3**：用例规格 L2-02 写「fromPatterns 回填」到文件层；实现中文件层 fromPatterns
  仅随其他脏标记落盘（4a 的 v1 迁移路径因 `needsWriteBack` 为真才带上），对账后的实时
  覆盖合并在视图层（`collectViews`）。用例改为断言视图层（计划原文「视图重建」本意即此）。
  **→ 用例规格已修正为视图层语义。**
- **VAR-4**：用例规格 L4-05 宽松同判夹具写反了方向——客户端采纳要求 host `current`
  **精确等于**某清单键（`hasOwnProperty`），宽松同判发生在 host 侧 cwd→键解析；用例
  按正确语义实现（cwd 传拼写变体、current 返回精确键 → 选中）。另计划 L4-04 的
  「2 granted」实为 1（roots 内 excluded 行渲染为 pending 类），按实际 kind 断言。
  **→ 用例规格已修正（夹具方向 + 过滤器行数）。**
- **VAR-5**：计划 L2-01「未覆盖路径 ACE 真实剥离」——v1 夹具从未物化过 ACE，可断言的
  是真实剥离原语（未打桩）对「目录存在但无命中 ACE」的幂等成功及其记账效果（入史
  config-removed）。ACE 物化侧由 dry-mount 主段（第 2 节）与 L6-01 roundtrip 覆盖。
- **VAR-6**：计划 L2-04 方案 A（真实 ACL 夹具）在非提升环境不可确定性构造：自建目录的
  所有者隐式持有 WRITE_DAC，grant 不会失败；而收权（去继承/拒 WDAC）后清理路径自身
  被锁、必留残留。降级为方案 B（`_grants` 接缝注入失败/成功 grant），真实 Win32 错误
  文案路径不在自动化覆盖面（其告警文案由 `_ensureGrants` 承载，真机验收 A6 可人工看）。

## 4. 回归门最终输出（收尾轮，八条全绿）

```
dsh-sandbox-allowlist: all checks passed          (npm test)
verify-client-editor: all checks passed           (test:client)
dry-mount: all checks passed                      (test:dry-mount)
verify-command-gate: all checks passed            (test:command-gate)
verify-approval-gate: all assertions passed       (test:approval-gate)
verify-command-matrix: 44 rows checked            (test:matrix)
verify-read-restriction: all checks passed        (test:read-gate)
typecheck: exit 0
```

## 5. L6-01 roundtrip 完整输出

（目录路径按仓库隐私红线占位化；SID 为临时路径的派生值，非个人数据）

```
roundtrip dir: <系统临时目录>\dsh-verify-ace-XXXXXX
expected SID:  S-1-4-445713736-818223242
before grant:  no S-1-4-* ACEs (expected)
after grant:   ["S-1-4-445713736-818223242:(OI)(CI)(W,D,DC)"]
ROUNDTRIP OK: grant materialized the expected S-1-4-* ACE
after dispose: ["S-1-4-445713736-818223242:(OI)(CI)(W,D,DC)"]
```

## 6. 清理与残留抽查

- 本次新增夹具前缀零残留：`dsh-grants-norm-*`、`dsh-grants-save-*`、`dsh-verify-ace-*`、
  `dsh-scan-sid-*`、`dsh-revoke-tree-*`、`dsh-grants-man-*` 均为 0。
- `dsh-drymount-home-*` 现存 50 个中仅 9 个来自本次执行（约每轮漏 1–2 个 best-effort
  清理），其余 41 个与 `dsh-allowlist-home-*`×21 等均为 100+ 小时前的历史残留——
  属既有测试基建行为（退出钩子 best-effort 的已知局限），非本次引入。修复阶段已加
  启动清扫（>24h 前缀目录）：首跑后可清扫前缀残留 111+ → 16，历史存量
  已清空，余量为当日新鲜夹具（将随过期被后续运行清掉）。

## 7. 遗留与建议（修复阶段处置状态）

1. **L3-03 跨平台验证** → **部分收口**：已新增 3c 进程内平台伪装验证，
   win32 上「非 win32 不注册路由」契约已有可执行断言并通过；真实 POSIX 环境的完整
   挂载路径（3b）仍待在 Linux/macOS 跑一次 `npm run test:dry-mount`。
2. **dry-mount 残留** → **已修复**：`test.mjs` 与 `dry-mount.mjs` 启动时
   清扫超过 24h 的同名前缀夹具目录；首跑 111+ → 16（余为当日新鲜夹具，将随过期清除）。
3. **DEF-1 修复联动** → **已完成**：产物与源码同步 `setConfirm(null)`，
   L4-04 改为正向断言（点击不抛错 + 切过滤器关确认层）；真机补验一次过滤器点击
   无控制台报错仍建议保留在人工验收清单。
4. **VAR-1 评审** → **已修复**：`normalizeRecord` 对 roots 非对象/缺 path
   条目整条丢弃，与 pendingRevoke/history 语义对齐；L1-04 用例同步更新。

## 8. 完成度结论

**自动化测试：完成；执行中发现的问题已全部处置（修复回填见 §9，修复后回归门八条全绿）。**

- 计划范围内 22 个用例 ID：19 通过（含 8 个新增块/场景、5 个核实登记）、L3-03 执行轮
  条件跳过（修复阶段已补 3c 进程内验证，现为通过态）、L2-04 以接缝夹具降级通过
  （VAR-6）、无失败。
- 排除项（四个 gate 套件）零改动、五轮回归全绿；修复阶段后八条回归门复跑全绿。
- 执行轮产品代码零改动（变更仅限 `test/` 与 `docs/testing/`）；
  修复阶段的产品代码变更（DEF-1 / VAR-1）见 §9。

**真机人工验收衔接**（[m1-03-04-05-manual-acceptance.md](m1-03-04-05-manual-acceptance.md)）：

- A2（v1 迁移）、A3（损坏自愈）、A5（假账纠正）、A7（工作区语义）的**数据/链路面**
  已由 4f/4g/4h/4j 自动化覆盖，人工验收聚焦其 GUI 断言（时间列显示、面板刷新、
  空态文案）即可；
- A4（无账残留 KI-2 主链路）仍需人工在非受限终端执行 scan/revoke（自动化不覆盖
  无账残留构造与 `yes` 确认交互）；
- A6（焦点回归）、A8（弹框多行）、A9（12s 重试窗口）为纯 GUI/真机行为，保持人工；
- DEF-1 修复落地后，建议在真机补验一次过滤器点击无控制台报错。

## 9. 缺陷修复回填（同日修复阶段）

执行阶段按测试计划约束保持产品代码零改动；随后授权修复，逐项处置如下
（修复后八条回归门复跑全绿）：

| 项 | 处置 |
|---|---|
| DEF-1 | **已修复**：`lib/client.js:2276` `setConfirmKey(null)` → `setConfirm(null)`，`src/client/index.tsx` 同步该语句（消除产物-源码漂移，保留「切过滤器关确认层」意图）；L4-04 锚点改为正向断言（点击不抛错 + 切过滤器关闭确认层 + 回位「全部」） |
| VAR-1 | **已修复**：`normalizeRecord` 对 roots 非对象/缺 path（含非字符串 path）条目整条丢弃，与 pendingRevoke/history 容错语义对齐；L1-04 用例改断言丢弃契约 |
| 残留（遗留 2） | **已修复**：`test.mjs` 与 `dry-mount.mjs` 启动时清扫超过 24h 的同名前缀夹具目录（阈值远大于单轮运行时长，不影响并行运行）。首跑验证：可清扫前缀残留 111+ → 16（余 8 个为当日新鲜夹具，正确保留，将随过期被后续运行清掉） |
| L3-03（遗留 1） | **部分收口**：dry-mount 新增 3c 块——进程内临时伪装 `process.platform` 真实执行「非 win32 不注册路由」断言（win32 上不再纯跳过态）；真实 POSIX 环境的完整挂载验证（3b 路径）仍待跨平台机器跑一次 |
| VAR-2 | **不修（维持契约）**：`comparablePath` 不折叠尾分隔符是现行语义，全局改变会影响 scope 判定与 fs fence 的路径比较，风险大于收益；用例规格文档已按实际契约修正 |
| VAR-3 / VAR-4 | **文档修正**：用例规格中 fromPatterns 断言面（视图层）、宽松同判夹具方向、过滤器行数已更正为实际契约 |
| VAR-5 / VAR-6 | **保持**：夹具/范围说明，无产品问题需要修 |
