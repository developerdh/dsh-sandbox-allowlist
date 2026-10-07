# M1-03/04/05 测试用例规格（执行辅助）

> 上游计划：[m1-03-04-05-test-plan.md](m1-03-04-05-test-plan.md)（分层任务与约束的唯一来源，
> 本文只是把每个用例 ID 展开为可照做的步骤，不改变计划的范围与排除项）。
> 真机人工用例见 [m1-03-04-05-manual-acceptance.md](m1-03-04-05-manual-acceptance.md)，与本文件无重叠。
>
> 本文基于 `feature/m1-03-04-05` 分支当前代码核实编写。行号引用（如 `test.mjs:389`）
> 对应该分支，执行时如行号漂移以标识符为准。

## 0. 计划核实结论（动手前先读）

编写本规格时已对照现有测试逐条核实，与计划表述有出入的点如下，执行时按本文处置：

| ID | 计划标注 | 核实结论 | 处置 |
|---|---|---|---|
| L1-03 | [已有]，"若无则补" | `test.mjs:317` 已覆盖 FIFO 封顶 + 最老先掉 + pendingRevoke 单条约束 | 标记已有，无需新增 |
| L1-04 | [补齐] | `normalizeRecord`/`normalizeRootEntry` **未导出**，只能经 `loadManifest` 公共入口驱动；初版执行发现 roots 非对象项被收敛为 `path:''` 条目而非过滤（VAR-1），**已修复**：非对象/缺 path 条目现直接丢弃（与 pendingRevoke/history 语义对齐），用例断言丢弃契约 | 修复提交见执行报告 §10 |
| L6-02 | [补齐] | `test.mjs:389-399` 已覆盖全部四个断言要点（形状命中 / 临时 SID 排除 / sidFilter / explicit 与 inherited 分类） | 标记已覆盖，执行时仅记录核实结论，不新增用例 |
| L6-03 | [补齐] | `test.mjs:371-387` 已覆盖派生公式一致、大小写收敛、异目录异 SID、目录不存在可重算 | 只补两条微断言：分隔符方向变体、输出形状正则 |
| L4-05 | [补齐]"补不命中侧" | 现有 ⑤（foreign cwd）已覆盖"不命中 → 空态、不串显、选择器禁用" | 补的是"宽松同判命中"侧与"current 命中但清单无此键"防御分支，见用例正文 |
| 全局 | — | `lib/client.js` 为构建产物；`src/client/index.tsx` 为源码。本计划不改产品代码，若发现产物与源码不同步（反漂移锚 `verify-client-editor.mjs:551` 起会拦住大半），只报告不重建 | — |

## 1. 第 1 层：清单数据层纯函数（`test/test.mjs`，跨平台）

公共约定：沿用文件内既有风格——`mkdtempSync(join(tmpdir(), 'dsh-…'))` 建夹具、
`try { … } finally { rmSync(…, { recursive: true, force: true }) }` 清理；断言用
`node:assert/strict`；一个用例一个 `{ … }` 块 + 一行中文分节注释。新增块建议插在
既有「grants manifest v2」块（`test.mjs:218`）与「granted × wanted diff」块（`test.mjs:283`）
之后，与被测模块相邻。

### L1-04 `normalizeRecord` 容错矩阵（经 `loadManifest` 驱动）

- **放哪**：`test/test.mjs` 新块。
- **前置**：临时目录 + 清单文件路径（`manifestPath(dir)`）。
- **步骤与断言**（全部通过「写入 JSON → `loadManifest(file)` → 检查内存结构」驱动，
  不直接调用私有函数）：
  1. `workspaces.W` 为 `{ roots: [null, 42, 'str', { path: 42 }, { path: 'D:\\ok' }] }` →
     契约（VAR-1 修复后）：非对象与缺 `path`（含非字符串 `path`）条目**整条丢弃**，
     仅剩的合法条目为完整契约形状（`emptyRootEntry` 形状）。
  2. `pendingRevoke` 条目缺字段：`[{ path: 'D:\\p' }]` → 补齐为
     `{ path, fromPatterns: [], origin: 'config-removed', error: null, attempts: 0, lastAttemptAt: null }`；
     条目缺 `path`（如 `{ origin: 'excluded' }`）→ 整条被丢弃。
  3. `history` 条目缺字段：同上对称断言（缺 `path` 丢弃；缺 `revokedAt`/`origin`/`fromPatterns`
     用默认 `null`/`'config-removed'`/`[]` 补齐）。
  4. `origin` 非法值：`origin: 'bogus'` → 回退 `'config-removed'`（pendingRevoke 与 history 各断一次）。
  5. `attempts` 非数字：`attempts: 'x'` → 归 0；`attempts: 3.5`（`Number.isFinite` 为真）→ 保留 3.5，
     一并断言（记录该宽松行为）。
  6. `sid: 42`、`updatedAt: 7`（非字符串）→ 记录中二者保持 `null`。
  7. 整个 `workspaces.W` 为 `null` / `42` / `'str'` → 返回空记录（`emptyWorkspaceRecord` 形状），
     且 `needsWriteBack === true`。
- **通过标准**：以上断言全绿；差异清单已登记第 1 条。
- **清理**：`finally` 删临时目录。

### L1-05 `isExcludedPath` 三处命中

- **放哪**：`test/test.mjs` 新块（可紧跟 L1-04）。
- **步骤与断言**：构造三条独立记录，分别只含一处排除痕迹，逐一断言 `isExcludedPath(record, path) === true`：
  1. `roots` 活标记：`ensureRootEntry(record, 'D:\\a')` 后置 `excluded = true`；
  2. `pendingRevoke`：`enterPendingRevoke(record, { path: 'D:\\b', origin: 'excluded', error: 'e' })`；
  3. `history`：`pushHistory(record, { path: 'D:\\c', origin: 'excluded' })`。
  对照组：`origin:'config-removed'` 的 pendingRevoke/history 条目 → `false`（只有 excluded
  来源计入排除）。
- **路径同判**：对第 3 条记录断言 `isExcludedPath(record, 'd:/C') === true`（分隔符
  方向与大小写折叠，win32）；注意 `comparablePath` **不折叠尾分隔符**——
  `isExcludedPath(record, 'D:\\C\\')` 为 `false`（VAR-2，初版规格误写为「亦命中」，
  按实际契约断言；POSIX 侧逐字比较，条件分支同用例实现）。
- **通过标准**：三处命中 + 对照组 + 路径同判全绿。

### L1-06 `saveManifest` 原子性与目录自建

- **放哪**：`test/test.mjs` 新块。
- **说明**：套件不 mock `node:fs`，不直接观测「先写 `.tmp` 再 rename」的两步顺序；
  断言可观测契约（两步写的最终效果）。
- **步骤与断言**：
  1. 目标目录**不存在**（`join(base, 'nested', 'deep')` 下的清单路径）→ `saveManifest` 成功；
     目录被自动创建（`existsSync(dirname(file))`），文件内容为合法 JSON 且
     `version === MANIFEST_VERSION`、传入的 `workspaces` 原样透传。
  2. 保存后 `${file}.tmp` **不存在**（正常路径无临时残留）。
  3. 传入带 `needsWriteBack: true` 的清单 → 落盘内容**不含** `needsWriteBack` 键
     （`saveManifest` 只写 `{ version, workspaces }`）。
  4. 追加断言（可选，行为锚）：保存前手工放置一个同名 `.tmp` 垃圾文件 → 保存后该路径
     已被 rename 覆盖、文件内容为新内容（证明 rename 确实发生且覆盖）。
- **通过标准**：全绿；临时目录无残留。

## 2. 第 2 层：对账引擎集成（`test/dry-mount.mjs`，win32 真实 DACL）

公共约定：全部沿用第 4 节既有模式——`mountFreshPolicy({ workspaceRoot, allowedDirs, home })`
每个场景独立 `DSH_HOME`；挂载后先 `policy.resolve()` + `await policy._reconcileTail` 等启动
对账落地再驱动；读清单用 `readFileSync(join(home, 'sandbox-allowlist-grants.json'))`；结束时
`await mount.fiber.dispose()`。真实剥离不打桩（`_revokeAces` 保持原样），除非用例明说。
新场景编号沿用文件头注释的 4x 序列（建议 4f/4g/4h/4i），并同步补头部注释。

### L2-01 v1 迁移条目 `grantedAt` 补记 + 未覆盖路径回收

- **放哪**：`test/dry-mount.mjs` 第 4 节新场景（紧跟 4a 之后）。
- **与 4a 的关系**：4a 只断言「迁回 v2 + granted + fromPatterns 回填」，未断言 `grantedAt`
  补记，也只有单条仍覆盖路径；本用例补双侧。
- **前置**：v1 清单预置**两条**路径：`rootCovered`（配置仍覆盖）与 `rootGone`（配置已不含，
  `allowedDirs` 不含它）。
- **步骤**：
  1. `writeFileSync(join(home, 'sandbox-allowlist-grants.json'), JSON.stringify({ workspaces: { [ws]: [rootCovered, rootGone] } }))`；
  2. `mountFreshPolicy`，`allowedDirs: [rootCovered]`，resolve + 等 `_reconcileTail`；
  3. 读清单文件核对。
- **断言**：
  - 文件 `version === 2`（迁移写回，同 4a）；
  - `rootCovered`：仍在 `roots`，`status === 'granted'`，`grantedAt` 从 `null` 变为合法 ISO 串
    （`!Number.isNaN(new Date(grantedAt).getTime())`）——补记确认时间；
  - `rootGone`：已离开 `roots`，出现在 `history`，`origin === 'config-removed'`；
  - （ACE 侧，环境允许时）`rootGone` 目录 DACL 上无工作区 SID ACE。本环境子进程输出捕获
    可能受限（文件头注 2 节的说明），故此断言标记为「尽力而为」：可用 `lib/acl-scan.mjs`
    的 `readDaclBatch([rootGone])`（其内部 spawn PowerShell 捕获输出，4b/4c/5 的真实剥离
    已证明 spawn 可用）；若捕获确实失败，降级为只断记账侧并在报告注明。
- **通过标准**：记账侧全绿；ACE 侧 either 绿 or 报告注明降级原因。
- **清理**：`dispose` + 退出钩子（`created` 数组）兜底。

### L2-02 损坏清单自愈

- **放哪**：同上，新场景。
- **步骤**：
  1. `writeFileSync(manifestFile, '{oops', 'utf8')`（非法 JSON）；
  2. `mountFreshPolicy`（`allowedDirs: [`${root}\\**`]`），resolve + 等 `_reconcileTail`。
- **断言**：
  - 挂载与首次对账不抛错（能走到断言即证明）；
  - 清单文件已被重写为合法 JSON：`JSON.parse` 成功、`version === 2`；
  - 视图重建：`workspaces[ws].roots` 含配置内目录，`status === 'granted'` 且带 `grantedAt`；
    `fromPatterns` 的实时覆盖合并在**视图层**（`collectViews`），文件层仅随其他脏标记
    落盘（VAR-3，初版规格误写为文件层断言）；
  - `pendingRevoke`/`history` 为空（损坏即清零重建，无幽灵记录）。
- **通过标准**：全绿。

### L2-03 假账纠正链路（账面 granted、实际无 ACE）

- **放哪**：同上，新场景。
- **假账构造**（推荐 a，保真实；b 为等价简化）：
  - a. 正常挂载授权 `root` → 启动对账后，测试自己调 `revokeWriteAces([root], sid)` 剥掉
    ACE（`sid` 用 `writeSidForDirectory` 或清单里的 `record.sid`）——此刻账面仍是 granted、
    磁盘无 ACE；
  - b. 或直接手写清单：`roots: [{ path: rootX, status: 'granted', grantedAt: <旧时间>, … }]`
    指向一个从未授权的目录。
- **步骤与断言**（以 a 为例）：
  1. 断言假账前提成立：清单 `status === 'granted'`；
  2. 经 API 走撤销：`const api = createApiHandler(policy)`，
     `await api('revoke', { path: root, workspace: ws })` → `ok === true`
     （对无 ACE 目录剥离为幂等成功，这就是 A5 真机用例的自动化对应）；返回视图里该路径
     已入 `history`（`origin === 'excluded'`）；
  3. `await api('restore', { path: root, workspace: ws })` → `ok === true`，`roots` 里该路径
     `status === 'granted'` 且 `grantedAt` **晚于**修复前的旧值（方案 a 下即重新物化的时间）；
  4. 失败面如实断言（防御）：若任一步返回 `ok === false`，断言 `error.message` 非空可读
     ——不允许静默失败。实现上先断成功路径；若环境导致失败路径触发，转而断言错误可读
     并在报告记录环境因素。
- **通过标准**：链路全绿或失败面有可读错误 + 报告注明。

### L2-04 failed 行的「重试授权」真实路径

- **放哪**：同上，新场景。
- **不可写目录夹具（二选一，报告注明用了哪种）**：
  - **方案 A（真实 ACL，计划本意）**：`mkdirSync(dir)` 后用 `icacls` 收权：
    `icacls "<dir>" /inheritance:r` 随后 `icacls "<dir>" /grant:r "*S-1-5-18:F"` 之类仅保留
    SYSTEM——使当前令牌无法改写 DACL（`grant.add` 抛 Win32 5）。
    **纪律**：清理钩子（含 `process.on('exit')` 兜底）必须先 `icacls "<dir>" /reset`
    （best-effort，spawn 失败也要吞掉）再 `rmSync`，否则测试进程自己都删不掉夹具；
  - **方案 B（接缝降级，环境受限时）**：给 `policy._grants` 预置假 grant——
    `policy._grants.set(ws, { add() { throw new Error('simulated Win32 5: ACCESS_DENIED') }, dispose() {} })`
    → 断言 failed 记账；重试阶段换成 `{ add() { /* 成功 */ }, dispose() {} }`。
    不覆盖真实 Win32 错误文案路径，报告中注明此局限。
- **步骤与断言**（方案 A）：
  1. 挂载 `allowedDirs: [`${dir}\\**`]` → resolve + 等 `_reconcileTail`；
  2. 清单中该路径 `status === 'failed'`，`error` 非空且含可定位信息（真实 Win32 错误时
     断言含 `ACCESS_DENIED` 或 `Win32`；方案 B 断言含 `simulated`），`attempts >= 1`，
     `errorAt` 为合法时间；
  3. 修复：`icacls "<dir>" /reset`（方案 B 换可用 stub）；
  4. 经 API 重试：`await api('grant', { path: dir, workspace: ws })` → `ok === true`，
     返回视图中该路径 `status === 'granted'`、`grantedAt` 为新时间、`error`/`errorAt` 归
     `null`、`attempts` 归 0（`_ensureGrants` 成功路径的清理语义）。
- **前置校验**：若方案 A 下第 2 步居然 granted（执行令牌对自有目录仍有 WRITE_DAC 的环境），
  本用例按「环境不支持」跳过并报告，**不得**强行算通过。
- **通过标准**：failed 记账 + 重试转 granted 全绿，或如实跳过并报告。

### L2-05 workspace 解析优先级（显式 > sessionCwd 命中 > 实例根）

- **放哪**：第 5 节 state-routes 契约内追加（该节已有 `createApiHandler(policyD)` 与双工作区
  可复用的挂载方式；本用例需**两个**已记账工作区——仿 `mountFreshPolicy` 挂两个实例各自
  产生记账，或在同一实例内用两个 allowedDirs 根 + 两个 workspace 键的预置清单。推荐后者：
  预置 v2 清单两个键，挂载后首扫补齐，少一次跨实例协调）。
- **步骤与断言**（`api` 为 `createApiHandler`，视图读 `current` 与生效目标）：
  1. **显式 workspace 最高**：`api('state', { workspace: wsA, sessionCwd: wsB })` →
     `value.current === wsA`（`resolveWorkspaceArg` 先看显式参）；
  2. **sessionCwd 命中次之**：`api('state', { sessionCwd: wsB })`（无显式 workspace）→
     `value.current === wsB`；对 wsB 内路径的 `revoke` 不带 workspace → 实际作用于 wsB
     （用两工作区各有一条 root 的清单，断言操作后 wsB 的 roots/history 变化而 wsA 不动）；
  3. **实例根兜底**：`api('state', { sessionCwd: join(base, 'no-match') })` →
     `value.current === 实例 workspaceRoot`（`resolveCurrentRoot` 的 fallback）；
  4. **显式未知工作区**：`api('revoke', { path, workspace: 'W:\\elsewhere' })` →
     `error.code === 'unknown-workspace'`（已有断言，保留作优先级链的收尾）。
- **通过标准**：四级全绿。

## 3. 第 3 层：状态路由契约（`test/dry-mount.mjs`）

### L3-01 已有覆盖

`test/dry-mount.mjs:389` 起的第 5 节已覆盖：fake webServer 注册形状、视图 JSON、
`unknown-path`/`unknown-workspace`、方法名字符集、revoke/restore/grant 全链路（真实剥离）。
执行时确认全绿即可，不新增。

### L3-02 HTTP 适配层（`handleRequest`）

- **放哪**：`test/dry-mount.mjs` 第 5 节内追加（复用该节捕获的 `captured.route.handler`，
  即 `handleRequest(policyD, req, res)` 的句柄——`handleRequest` 未导出，必须这样拿）。
- **夹具**：
  - fake req：`Readable.from([Buffer.from(body)])` 并挂 `url`/`method` 属性
    （`readJsonBody` 只要求 async 可迭代）；GET 等无 body 场景用 `Readable.from([])`；
  - fake res：`{ statusCode: 未设置, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(payload) { this.body = payload } }`。
  - 备选：`node:http` 真回环（`createServer` + `handler`，监听 `127.0.0.1:0`），断言同下；
    地址**必须**限 `127.0.0.1`。
- **步骤与断言**（`call = (method, url, body) => new Promise(... handler(req, res) ...)`）：
  1. `GET` + 合法 url → `res.body` 解析为 `{ ok: false, error: { code: 'bad-method' } }`；
  2. `POST` + body > 1MB（`'x'.repeat(1024 * 1024 + 1)` 或 Buffer）→
     `{ ok: false, error: { code: 'internal' } }` 且 message 含 `too large`；
  3. `POST` + body `'{oops'` → `{ ok: false, error: { code: 'internal' } }` 且 message 含
     `not valid JSON`；
  4. `POST` 空 body → 按 `{}` 处理 → `state` 方法返回 `ok === true` 视图；
  5. **HTTP 恒 200**：以上每种响应 `res.statusCode` 均未被赋值（保持 undefined/默认 200）、
     `content-type` 恒为 `application/json; charset=utf-8`、信封形状统一
     （成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, details? } }`）。
- **通过标准**：全绿。

### L3-03 非 win32 平台门

- **放哪**：`test/dry-mount.mjs`，win32 guard **之外**（第 3 节 fence 断言之后即可）。
  需把 `mountFreshPolicy`（或一个只挂 policy + fake webServer 的精简版）定义提到 guard 外。
- **步骤**：全新 Context + `provide` 三个 stub + fake `webServer`（捕获 register）→
  挂 policy → 等 `ctx.inject` 回调落地（`setTimeout 20ms`，同第 5 节节奏）。
- **断言**（整块包在 `if (process.platform !== 'win32') { … }` 内）：
  `captured.route === null`——非 win32 宿主不注册任何状态路由（客户端因此没有入口信号）。
  win32 机器上此块自然跳过，**不得删除**（保证跨平台机器上套件仍验证此契约）。
  win32 侧的正向断言（注册形状）已由第 5 节覆盖，勿重复。
- **补充（3c 块，已实现）**：dry-mount 另有进程内验证——临时伪装 `process.platform`
  调 `applyStateRoutes` 后 `finally` 还原（同步代码），使「非 win32 不注册」契约在
  win32 机器上也有可执行断言（不再是纯跳过态）；3b 的完整挂载路径验证仍保留给
  非 win32 环境。
- **通过标准**：非 win32 上 3b 断言生效；win32 上 3b 静默跳过、3c 真实执行、套件仍绿。

## 4. 第 4 层：客户端面板 UI（`test/verify-client-editor.mjs`，跨平台）

公共约定：沿用既有 stub 体系——`reactStub`、`globalThis.fetch` 打桩、
`render()`/`collect()`/`findByClass`/`findButtonByAria`/`findButtonByText`/`hasTextIn` 辅助、
`settle()`（20ms）节奏。**两条已踩过的坑要写进新用例的注释**：

1. **busy 最短展示**：`BUSY_MIN_MS = 700`（`src/client/index.tsx:1400`）——凡触发过
   `withBusy`（手动刷新/操作）的组件实例，之后 ≤700ms 内的断言都会看到 busy 层与
   `disabled` 按钮。新用例要么在断言前 `await new Promise(r => setTimeout(r, 800))`，
   要么换新阶段前重开面板（现有脚本用等待 800ms 的节奏，沿用）；
2. **hooks 状态残留**：`hooksByType` 按组件类型累积 state，同一 `panelType` 跨阶段共享
   `open/data/ws/filter/confirm/busy`。跨场景切换 stub 视图后必须**走一次「点开 + 刷新」**
   让 `load()` 重新拉数据，不能假设新 stub 自动生效。

新增用例建议插在现有 ⑤（foreign cwd）之后、「Plugins 页配置界面」块之前。

### L4-01 坏数据渲染矩阵

- **步骤**：stub 视图 `workspaces[SESSION_CWD]` 的切片含五类行，点开面板 + 刷新 + 等 800ms：
  - `roots[0]`：`granted` 且 `grantedAt: null`；
  - `roots[1]`：`status: 'failed'`，`error: 'SetNamedSecurityInfoW failed (Win32 5)'`，
    `errorAt: <时间>`；
  - `roots[2]`：`granted` 且 `excluded: true`（渲染为「待回收」行——`stateRowsOf` 把 roots 里
    excluded 的行算 pending，`reason` 为 `status.dotPending` 文案）；
  - `pendingRevoke[0]`：`{ path, error: 'strip failed', attempts: 2, lastAttemptAt: <时间> }`；
  - `history[0]`：`{ path, revokedAt: <时间>, origin: 'excluded' }`。
- **断言**（全部在「全部」过滤器下）：
  1. granted+null 时间行：对应 `<td class="sabx-panel-time">` 的 children 为
     `['—']`（`status.none` 键；**锚 key 对应文案，不锚整句**）；
  2. failed 行：状态列文本含「授权失败」（`status.stateFailed`）；原因列
     `<td class="sabx-panel-reason">` 含 error 原文且 `data-tip` 同步承载完整 error；
     操作列有 aria-label「手动重试该目录的写授权物化」的按钮；
  3. 待回收两行（roots-excluded 与 pendingRevoke）：状态列含「待回收」；
     pendingRevoke 行原因列含其 error；**两行操作列均为空**（`sabx-panel-actions`
     span 内无 button）；
  4. 已撤销行：状态列含「已撤销」；操作列有 aria-label「恢复该目录的写授权」按钮；
  5. granted 正常行（可复用 roots[0]，它同时是 granted 行）：操作列有 aria-label
     「撤销该目录的写授权」按钮；
  6. 行总数 = 5（全部过滤器下 tbody 内 `tr` 数，排除表头与空态行）。
- **通过标准**：全绿。

### L4-02 空态与错误态

- **空态**：stub 返回 `{ supported: true, current: '', workspaces: {} }`，sessionProps 无 cwd
  （`sessionProps('')`）或 cwd 不命中 → 断言文本「当前工作区暂无授权记录。」
  （`status.empty`）出现、无任何行按钮。
  （现有 ⑤ 已覆盖「cwd 不命中」变体，本条补「清单本身为空」变体即可，两断言可合并。）
- **错误态**：`globalThis.fetch = async () => { throw new Error('boom') }`，点开面板 →
  settle → 断言：
  - 存在 `role="alert"` 的元素（`collect()` 里 `element.type === 'p'` 且
    `props.role === 'alert'`，class `sabx-panel-error`）；
  - 文本含「载入失败」（`status.error` 的前缀实词）与 `'boom'`；
  - **面板不崩**：再次 `render` 同组件仍出完整树（含刷新按钮），且表格区显示
    `status.loading` 或空态文案（`data.view === null` 走 `status.loading`）；
  - 错误恢复：重新打桩 fetch 返回有效视图 → 点刷新 → settle + 等 800ms → 错误行消失、
    行渲染恢复（`load()` 成功路径会清 `error`）。
- **通过标准**：全绿。

### L4-03 确认弹层流（取消不发请求 / 确认恰一次）

- **前置**：grantView stub（现有 ③④ 已建），组件已打开且有 granted 行 + revoked 行。
- **步骤与断言**：
  1. 点「撤销」→ 确认层出现（已有断言，沿用）；
  2. **取消路径 A（遮罩）**：`fetchCalls.length = 0` → 找到 `sabx-confirm-overlay` 元素，
    调其 `props.onClick()`（点遮罩 = 取消，`index.tsx` 中 overlay onClick 即 `setConfirm(null)`）
    → settle → `fetchCalls` 中无 `/api/revoke`；确认层消失（再次 render 无 overlay）；
  3. **取消路径 B（取消按钮）**：重新点「撤销」→ 找文本「取消」按钮 → `props.onClick()` →
    settle → 无 `/api/revoke`、无 `/api/restore`；
  4. **确认路径恰一次**：再点「撤销」→ 确认 → settle → `/api/revoke` 请求**恰好一次**
     （`fetchCalls.filter(c => c.url.endsWith('/api/revoke')).length === 1`），body 为
     `{ path, workspace: SESSION_CWD }`；
  5. **恢复对称**：等 800ms 过 busy 窗口 → 对 revoked 行点「恢复」→ 先断言未发请求 →
     确认 → `/api/restore` 恰好一次。
- **通过标准**：全绿（全程 `nativeConfirmCalls === 0` 保持断言）。

### L4-04 状态过滤器

- **前置**：L4-01 的五类行视图（1 granted、1 failed、2 待回收 [roots 内 excluded 行
  与 pendingRevoke 各一]、1 已撤销）。
- **步骤与断言**：过滤器按钮在 `sabx-panel-filters` 容器内，按**文本**定位
  （「全部/已授权/授权失败/待回收/已撤销」，锚 `status.filter*` key 对应文案）：
  1. 「全部」→ 5 行；
  2. 「已授权」→ 1 行（granted 行的 path；roots 内 excluded 行归待回收类，VAR-4）；
  3. 「授权失败」→ 1 行（failed path）；
  4. 「待回收」→ 2 行（roots-excluded + pendingRevoke 的 path）；
  5. 「已撤销」→ 1 行（history path）；
  6. 选中态：点击后该按钮 `data-active === 'true'`，其余为 `'false'`；
  7. 每行 kind 语义核对：行内状态列文本与过滤器一致（抽查即可，L4-01 已逐行断过）。
- **注意**：点过滤器是纯 setState，不走 `withBusy`，无 700ms 窗口问题；但若之前触发过
  busy，按钮 disabled 会拦住 onClick——先等 800ms。
- **通过标准**：全绿。

### L4-05 会话工作区选中语义（宽松同判 + 防御分支）

- **现状**：现有 ①（命中→请求带 cwd）、③（选中并显示会话工作区）、⑤（不命中→空态、
  不串显、选择器禁用且仍显示在看的 cwd）已覆盖主干。
- **补断言一（宽松同判命中，VAR-4 修正语义）**：客户端采纳要求 host `current`
  **精确等于**某清单键（`hasOwnProperty`），宽松同判发生在 host 侧 cwd→键解析。
  夹具：`current` 返回精确键 `SESSION_CWD`，`sessionCwd` 传拼写变体
  `'d:\\demo\\workspace'` → 刷新后：
  - 请求体携带原始 cwd（host 据此宽松解析）；`samePath(current, cwd)` 确认命中，
    `ws` 采纳**清单键**；
  - `sabx-panel-ws-value` 显示 `D:\\Demo\\Workspace`（键原样），非空态，行渲染正常；
- **补断言二（防御分支：current 命中但清单无此键）**：stub 返回
  `current: SESSION_CWD` 但 `workspaces: {}` → 空态（`adoptWorkspaces` 的
  `hasOwnProperty` 防御），不崩；
- **补断言三（不命中恒空态，强化现有 ⑤）**：`current` 指向实例根、`workspaces` 含实例根
  记录、sessionCwd 不命中 → **仍空态且不显示实例根记录**（绝不回退实例根）——现有 ⑤ 的
  foreignView 已是此形状，执行时确认其断言覆盖「记录存在但不显示」这一侧（现有断言
  `!hasTextIn(foreignNodes, 'D:\\Other\\Stale')` 已覆盖，登记核实结论即可）。
- **通过标准**：补断言一二绿；断言三核实结论登记。

## 5. 第 6 层：KI-2 工具（`lib/acl-scan.mjs` + `scripts/verify-ace.mjs`）

### L6-01 `verify-ace --roundtrip`（人工，win32 非受限终端）

- **执行**：非受限终端（普通 PowerShell，非 dsh 会话内）运行
  `node scripts/verify-ace.mjs --roundtrip`。
- **断言**（脚本自带）：自造临时目录 → `AclWriteGrant.add` 物化 → `icacls` 可见预期
  `S-1-4-…` SID ACE → dispose 后 ACE 仍在（standing）→ 清理。
- **结果**：把脚本完整输出记入执行报告（成功 = 末行 `ROUNDTRIP OK`；在受限令牌里运行
  会 GRANT FAILED，那也是有效结论但须换终端重跑）。
- 与计划 L6-01 的差异说明：计划还列了「scan 命中→revoke 剥离→复扫归零」，该链路由
  真机验收 A4 承接（需要无账残留构造 + 人工确认），自动化不重复。

### L6-02 `parseDaclHits` 形状匹配

**已覆盖**（`test.mjs:389-399`）：形状命中（explicit + inherited-copy 分类）、私有临时
SID（第三段 `-1`）排除、`sidFilter` 精确过滤、无 allow ACE 零命中。执行时逐条比对上述
四个要点与计划清单，登记「已核实覆盖」结论；不新增用例。

### L6-03 `writeSidForDirectory` 稳定性与规范化

- **放哪**：`test/test.mjs` 既有「SID 工具」块（`test.mjs:371`）内追加两行断言。
- **补断言**：
  1. 分隔符方向不影响结果：`writeSidForDirectory(dir.replace(/\\/g, '/')) === expected`
     （win32 `resolve` 归一分隔符；非 win32 上 `/` 本就是原生形态，同样成立）；
  2. 输出形状：`assert.match(writeSidForDirectory(dir), /^S-1-4-\d+-\d+$/)`
     （与 `WORKSPACE_SID_SDDL_SOURCE` 及文档示例形状一致）；
  3. （可选直断）同目录连续两次调用相等：`writeSidForDirectory(dir) === writeSidForDirectory(dir)`
     （现有「与独立 sha256 重算一致」已隐含，此断言为可读性锚）。
- **通过标准**：追加断言全绿。

## 6. 断言锚定约定（全层适用）

- locale/文案只锚 **key 对应的当前词典实词**（如 `status.empty` → 「当前工作区暂无授权
  记录」），不锚整句；词典值变化时用例只需对齐实词。
- DOM 定位优先用 `aria-label`（操作按钮）、`role`（`alert`/`alertdialog`/`status`）、
  语义 class（`sabx-panel-time`/`sabx-panel-reason`/`sabx-panel-ws-value` 等），不锚样式
  class 之外的布局细节。
- 路径类断言不写死本机路径：一律 `mkdtemp` 临时目录或既有夹具常量；客户端层沿用
  `D:\\Demo\\…` 虚构示例（现有脚本同款，纯 stub 数据）。
