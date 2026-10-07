/**
 * dsh-sandbox-allowlist — 客户端半件（手写 __ModuleLoader__ bundle）。
 *
 * 设置页「沙箱授权」分节（v5，对齐 docs/internal/config-ui-prototype.html v5）：
 *
 *   - 分节 = 标题 + 导语 + 三个可折叠配置卡片（授权目录 / 命令规则 / 禁读规则），
 *     视觉与交互对齐 dsh 官方插件配置卡片（dsh-client-ui-settings-plugins）的设计语言
 *     —— 全部使用 dsw 运行时令牌（--dsw-alias-* / --dsw-specific-*，带十六进制
 *     fallback），样式由本 bundle 注入一份作用域化 <style>（.sabx-* 前缀）。
 *   - 卡片默认全部收起，点击标题展开；收起态主体真正隐藏（CSS :not(.is-open)），
 *     头部计数与「未保存修改」徽章保留。
 *   - 授权目录卡片：结构化目录行（📁 或新增行的绿色「＋」圆形徽章 + 等宽输入 +
 *     小 ✕ 图标按钮），焦点只高亮输入框本身（行边框不高亮），非法条目标红输入框。
 *   - 命令规则卡片：未命中默认动作分段选择（delegate/allow/ask/deny，
 *     选中项=语义色浅底+语义色文字+粗体+内描边，未选中统一中性色）；
 *     规则行 = 自绘工具下拉（原生 <select> 展开态无法定制，故为自绘菜单：
 *     胶囊触发按钮 + 圆角阴影浮层 + 选中绿色对勾）+ 命令模式输入 + allow/ask/deny
 *     紧凑分段 + 小 ✕ 图标按钮；三个开关收敛为一个可见勾选框（允许沙箱升级
 *     自动放行）+ 默认收起的「高级」折叠区（内置能力基线）。
 *   - 禁读规则卡片：与命令规则同款规则表（pattern 输入 + 紧凑 deny/ask 分段 +
 *     小 ✕），动作刻意只有 deny / ask —— 官方默认本就允许读，allow 是空操作。
 *   - 数据流（dsh 0.2.0）：`ctx.configForms.get(<loader entry id>)` 取本插件条目的
 *     配置表单 → form.set('allowedDirs' | 'commands' | 'noRead', …) 原子写回宿主
 *     profile → 宿主 reconcile → 插件重载并带上合并后的 Config → 服务端策略即时
 *     生效。整组字段用 form.unset(field) 恢复组合默认值（「重置为默认」）；覆盖
 *     标记按快照 user 的键存在性判断，不比较值。
 *   - 降级契约（官方 ConfigFormSnapshot）：status 为 loading 时只读占位，
 *     unavailable（宿主未提供该 namespace）或 writable === false（memory 模式，
 *     远端连接偏好进程本地）时整节只读并说明原因 —— 绝不假装保存成功。
 *   - i18n：全部用户可见文案走宿主词典服务（ctx.locale，namespace
 *     `sandbox-allowlist`，zh 真源 + en 镜像，回退链末端 en）。词典与
 *     src/client/locales.ts 保持一致，来源见「i18n 词典」一节的归属注释。
 *
 * 构建说明：这是运行时实际加载的产物。src/client/index.tsx 是等价 TS 源码
 * 参考，用于在 dsh 开发工具链下重建（tsc + tsdown）。两处必须保持一致。
 *
 * 风格说明：本 bundle 手写并刻意保持 ES5 运行时风格（var、无 JSX、function
 * 声明），以贴近宿主加载器的执行环境——通用代码规范的 var/let-const 规则对
 * 本文件豁免，其余规则（==、死代码、innerHTML 等）仍然适用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sandbox-allowlist',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require('react');

    /**
     * 本插件在 profile 中的 Loader 条目 id（cordis.patch.yml 的
     * sandbox-allowlist-policy 行）。dsh 0.2.0 按条目 id 索引设置表单，
     * 表单 schema 由该行的 static Config 投影而来。
     */
    const SETTINGS_ENTRY_ID = 'sandbox-allowlist-policy';
    const STYLE_ID = 'dsh-sandbox-allowlist-ui';
    /** 插件面板（Plugins 页）注册键：bundle.config 按包名，row.config 按「包名#行id」。 */
    const BUNDLE_CONFIG_KEY = 'dsh-sandbox-allowlist';
    const ROW_CONFIG_KEY = 'dsh-sandbox-allowlist#sandbox-allowlist-policy';
    const PROVIDER_ROW_ID = 'sandbox-allowlist-provider';
    const PROVIDER_ROW_CONFIG_KEY = 'dsh-sandbox-allowlist#sandbox-allowlist-provider';

    /* ============================================================================
     * 作用域化样式（dsw 令牌 + fallback）。结构与 docs/internal/config-ui-prototype.html
     * 一致；类名加 sabx- 前缀防止与宿主设置页样式冲突。
     * ========================================================================== */
    var INLINE_CSS = [
      /* 关键：整个分节作用域统一 border-box。否则 .sabx-input 等控件的
         width:100% + padding + border 会让其实际渲染宽度超出 flex 父容器，
         右缘压到相邻的权限分段上（即"命令框被挡一部分"，调列宽无效）。
         原型 HTML 顶部有全局 *{box-sizing:border-box}，故原型不溢出；注入到
         宿主设置页时必须自带，不能假设宿主已设。 */
      '.sabx-section,.sabx-section *,.sabx-section *::before,.sabx-section *::after{box-sizing:border-box;}',
      '.sabx-section{max-width:760px;color:var(--dsw-alias-label-primary,#f2f3f5);display:flex;flex-direction:column;gap:12px;padding:8px 0;}',
      '.sabx-section-heading{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f3f5);}',
      '.sabx-section-intro{color:var(--dsw-alias-label-tertiary,#9ca1a9);margin:0 0 4px;font-size:13px;line-height:1.6;max-width:640px;}',
      '.sabx-section code{font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;font-size:.95em;color:var(--dsw-alias-label-secondary,#c9ccd0);}',
      /* ---- 卡片（折叠：收起态隐藏主体） ---- */
      '.sabx-card-openable{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-3,#222227);border-radius:12px;list-style:none;transition:border-color .16s,background .16s;}',
      '.sabx-card-openable:hover{border-color:var(--dsw-alias-label-dimmed,#8a8f99);}',
      '.sabx-card-openable.is-open{background:var(--dsw-alias-bg-layer-2,#1b1b1f);border-color:var(--dsw-alias-label-dimmed,#8a8f99);}',
      '.sabx-card-openable+.sabx-card-openable{margin-top:12px;}',
      '.sabx-card-openable:not(.is-open) .sabx-card-body{display:none;}',
      '.sabx-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px;}',
      '.sabx-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px;border-radius:12px;}',
      '.sabx-card-head-text{display:flex;flex-direction:column;flex:1;gap:3px;min-width:0;}',
      '.sabx-card-name{color:var(--dsw-alias-label-primary,#f2f3f5);font-size:15px;font-weight:600;line-height:1.4;}',
      '.sabx-card-name .sabx-count{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-weight:400;font-size:13px;margin-left:8px;}',
      '.sabx-card-desc{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:13px;line-height:1.5;}',
      '.sabx-card-chevron{color:var(--dsw-alias-label-tertiary,#9ca1a9);flex:none;width:18px;height:18px;transition:transform .16s;}',
      '.sabx-card-openable.is-open .sabx-card-chevron{transform:rotate(180deg);}',
      '.sabx-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform,#2a2a30);color:var(--dsw-alias-label-secondary,#c9ccd0);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;display:none;}',
      '.sabx-card-openable.has-pending .sabx-pending{display:inline-block;}',
      '.sabx-card-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));margin:0 16px;padding-bottom:8px;}',
      /* ---- 字段 ---- */
      '.sabx-field{display:flex;flex-direction:column;gap:6px;padding:14px 0;}',
      '.sabx-field+.sabx-field{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));}',
      '.sabx-field-head{display:flex;align-items:center;gap:8px;}',
      '.sabx-field-label{min-width:0;color:var(--dsw-alias-label-primary,#f2f3f5);flex:1;font-size:13px;font-weight:500;line-height:1.5;}',
      '.sabx-field-reset{font:inherit;color:var(--dsw-alias-label-secondary,#c9ccd0);cursor:pointer;background:transparent;border:none;padding:0;font-size:12px;line-height:1.5;}',
      '.sabx-field-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f2f3f5);}',
      '.sabx-field-hint{color:var(--dsw-alias-label-tertiary,#9ca1a9);margin:0;font-size:12px;line-height:1.55;}',
      '.sabx-field-invalid{color:var(--dsw-alias-state-error-primary,#f85149);margin:0;font-size:12px;line-height:1.5;}',
      /* ---- 输入（焦点只落在这个控件上；所在行边框不高亮） ---- */
      '.sabx-input,.sabx-select{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-3,#222227);height:34px;font:inherit;color:var(--dsw-alias-label-primary,#f2f3f5);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;}',
      '.sabx-input:focus-visible,.sabx-select:focus-visible{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-specific-input-major,#26262b);outline:none;}',
      '.sabx-input.is-invalid{border-color:var(--dsw-alias-state-error-primary,#f85149);}',
      '.sabx-input:disabled,.sabx-select:disabled{color:var(--dsw-alias-label-tertiary,#9ca1a9);cursor:default;}',
      '.sabx-select{cursor:pointer;}',
      '.sabx-mono{font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;}',
      /* ---- 按钮 ---- */
      '.sabx-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;display:inline-flex;align-items:center;gap:6px;}',
      '.sabx-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.sabx-btn:disabled{opacity:.4;cursor:default;}',
      '.sabx-btn-primary{background:var(--dsw-alias-label-primary,#f2f3f5);color:var(--dsw-alias-bg-base,#141416);}',
      '.sabx-btn-primary:hover:not(:disabled){background:#ffffff;}',
      '.sabx-btn-ghost{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.11));color:var(--dsw-alias-label-secondary,#c9ccd0);background:transparent;}',
      '.sabx-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f2f3f5);border-color:var(--dsw-alias-label-dimmed,#8a8f99);}',
      /* ---- 小 ✕ 图标按钮（目录行与规则行统一） ---- */
      '.sabx-icon-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:6px;width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#9ca1a9);background:transparent;padding:0;}',
      '.sabx-icon-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f2f3f5);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));}',
      '.sabx-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.sabx-icon-btn svg{width:12px;height:12px;display:block;}',
      /* ---- 规则表 ---- */
      '.sabx-rules-table{display:flex;flex-direction:column;gap:8px;margin-top:4px;}',
      '.sabx-rule-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-3,#222227);border-radius:8px;padding:7px 8px;}',
      '.sabx-rule-tool{flex:0 0 78px;min-width:0;}',
      '.sabx-rule-pattern{flex:1 1 0;min-width:0;display:flex;gap:6px;align-items:center;}',
      '.sabx-rule-pattern .sabx-mono{width:100%;}',
      '.sabx-rule-action{flex:0 0 auto;min-width:0;white-space:nowrap;}',
      '.sabx-rule-remove{flex:0 0 22px;}',
      /* ---- 勾选框开关（单行一个布尔项） ---- */
      '.sabx-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#f2f3f5);}',
      '.sabx-check input[type="checkbox"]{width:15px;height:15px;flex:none;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;margin:0;}',
      '.sabx-check input[type="checkbox"]:disabled{cursor:default;}',
      '.sabx-check:has(input:disabled){color:var(--dsw-alias-label-tertiary,#9ca1a9);cursor:default;}',
      /* ---- 「高级」默认折叠区 ---- */
      '.sabx-advanced{border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:10px;}',
      '.sabx-advanced summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;line-height:1.5;user-select:none;}',
      '.sabx-advanced summary:hover{color:var(--dsw-alias-label-primary,#f2f3f5);}',
      '.sabx-advanced-item{display:flex;flex-direction:column;gap:4px;}',
      /* ---- 工具自绘下拉（v5：原生 select 展开态不可定制，故自绘菜单） ---- */
      '.sabx-tool-picker{position:relative;}',
      '.sabx-tool-trigger{appearance:none;width:100%;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-3,#222227);color:var(--dsw-alias-label-secondary,#c9ccd0);border-radius:999px;height:32px;padding:0 8px 0 12px;font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;cursor:pointer;transition:border-color .14s,background .14s;}',
      '.sabx-tool-trigger:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#8a8f99);}',
      '.sabx-tool-trigger.is-any{color:var(--dsw-alias-label-tertiary,#9ca1a9);border-style:dashed;}',
      '.sabx-tool-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.sabx-tool-trigger:disabled{opacity:.5;cursor:default;}',
      '.sabx-tool-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}',
      '.sabx-tool-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary,#9ca1a9);transition:transform .14s;}',
      '.sabx-tool-picker.is-open .sabx-tool-chevron{transform:rotate(180deg);}',
      '.sabx-tool-picker.is-open .sabx-tool-trigger{border-color:var(--dsw-alias-label-dimmed,#8a8f99);background:var(--dsw-alias-bg-module-platform,#2a2a30);}',
      '.sabx-tool-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:30;width:78px;padding:4px;background:var(--dsw-alias-bg-layer-2,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:10px;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));display:flex;flex-direction:column;gap:1px;}',
      '.sabx-tool-option{appearance:none;display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c9ccd0);font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;font-size:12px;line-height:1.5;border-radius:6px;padding:6px 8px;cursor:pointer;text-align:left;}',
      '.sabx-tool-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));}',
      '.sabx-tool-option.is-selected{color:var(--dsw-alias-label-primary,#f2f3f5);font-weight:600;}',
      '.sabx-tool-check{margin-left:auto;width:12px;height:12px;color:var(--dsw-alias-state-success-primary,#3fb950);opacity:0;}',
      '.sabx-tool-option.is-selected .sabx-tool-check{opacity:1;}',
      /* ---- 分段选择器（选中项 = 语义色浅底+语义色文字+粗体+内描边；未选中中性色） ---- */
      '.sabx-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:8px;overflow:hidden;height:34px;background:var(--dsw-alias-bg-layer-3,#222227);}',
      '.sabx-seg-item{appearance:none;font:inherit;cursor:pointer;background:transparent;border:0;color:var(--dsw-alias-label-tertiary,#9ca1a9);padding:0 10px;font-size:12px;line-height:1.5;display:inline-flex;align-items:center;gap:5px;transition:background .12s,color .12s;}',
      '.sabx-seg-item:hover:not([data-active="true"]){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));}',
      '.sabx-seg-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-2px;}',
      '.sabx-seg-item[data-active="true"]{font-weight:700;}',
      '.sabx-seg-item[data-active="true"].is-allow{background:rgba(63,185,80,.18);color:var(--dsw-alias-state-success-primary,#3fb950);box-shadow:inset 0 0 0 1px rgba(63,185,80,.42);}',
      '.sabx-seg-item[data-active="true"].is-ask{background:rgba(217,165,63,.18);color:var(--dsw-alias-state-warn-primary,#d9a53f);box-shadow:inset 0 0 0 1px rgba(217,165,63,.42);}',
      '.sabx-seg-item[data-active="true"].is-deny{background:rgba(248,81,73,.18);color:var(--dsw-alias-state-error-primary,#f85149);box-shadow:inset 0 0 0 1px rgba(248,81,73,.42);}',
      '.sabx-seg-item[data-active="true"]:not(.is-allow):not(.is-ask):not(.is-deny){background:var(--dsw-alias-interactive-bg-hover-solid,#2c2c33);color:var(--dsw-alias-label-primary,#f2f3f5);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3,rgba(255,255,255,.18));}',
      '.sabx-seg--compact .sabx-seg-item{padding:0 6px;gap:2px;}',
      '.sabx-dot{width:6px;height:6px;border-radius:50%;flex:none;}',
      '.sabx-dot-allow{background:var(--dsw-alias-state-success-primary,#3fb950);}',
      '.sabx-dot-ask{background:var(--dsw-alias-state-warn-primary,#d9a53f);}',
      '.sabx-dot-deny{background:var(--dsw-alias-state-error-primary,#f85149);}',
      /* ---- 添加行 ---- */
      '.sabx-add-row{appearance:none;font:inherit;cursor:pointer;border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:transparent;color:var(--dsw-alias-label-secondary,#c9ccd0);border-radius:8px;padding:7px 12px;font-size:13px;display:inline-flex;align-items:center;gap:6px;align-self:flex-start;}',
      '.sabx-add-row:hover{color:var(--dsw-alias-label-primary,#f2f3f5);border-color:var(--dsw-alias-label-dimmed,#8a8f99);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));}',
      /* ---- 空态 ---- */
      '.sabx-empty{color:var(--dsw-alias-label-tertiary,#9ca1a9);border:1px dashed var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:8px;padding:20px;text-align:center;font-size:13px;}',
      /* ---- 授权目录列表 ---- */
      '.sabx-dir-list{display:flex;flex-direction:column;gap:8px;margin-top:4px;}',
      '.sabx-dir-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-3,#222227);border-radius:8px;padding:6px 8px 6px 12px;}',
      '.sabx-dir-row .sabx-input{height:34px;}',
      '.sabx-dir-icon{color:var(--dsw-alias-label-tertiary,#9ca1a9);flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;}',
      '.sabx-dir-icon.is-new{width:18px;height:18px;border-radius:50%;background:rgba(63,185,80,.16);color:var(--dsw-alias-state-success-primary,#3fb950);font-size:13px;font-weight:600;line-height:1;}',
      '.sabx-dir-hint-inline{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;line-height:1.5;}',
      /* ---- 安全警示 callout ---- */
      '.sabx-callout-warn{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-3,#222227);border-radius:10px;padding:9px 12px;color:var(--dsw-alias-label-secondary,#c9ccd0);font-size:12px;line-height:1.6;margin-bottom:6px;}',
      /* 只读提示（表单加载中 / 不可用 / memory 模式）：说明为什么整节不可写。 */
      '.sabx-callout-note{display:block;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-module-platform,#2a2a30);border-radius:10px;padding:9px 12px;color:var(--dsw-alias-label-secondary,#c9ccd0);font-size:12px;line-height:1.6;}',
      '.sabx-callout-warn .sabx-dot{margin-top:6px;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d9a53f);}',
      /* ---- 卡片页脚 ---- */
      '.sabx-card-footer{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;margin-top:8px;}',
      '.sabx-card-error{min-width:0;color:var(--dsw-alias-state-error-primary,#f85149);flex:1;margin:0;font-size:12px;line-height:1.5;}',
      /* ---- 插件面板徽标（provider 行平台提示） ---- */
      '.sabx-badge{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-state-warn-border,rgba(217,165,63,.45));background:var(--dsw-alias-state-warn-bg,rgba(217,165,63,.12));color:var(--dsw-alias-state-warn-primary,#d9a53f);border-radius:999px;padding:1px 8px;font-size:11px;line-height:1.7;}',
      /* ---- 会话区授权状态面板（utilities 槽位弹层：居中模态 + 表格） ---- */
      '.sabx-panel-root{position:relative;display:inline-flex;}',
      '.sabx-panel-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#9ca1a9);background:transparent;padding:0;}',
      '.sabx-panel-btn:hover{color:var(--dsw-alias-label-primary,#f2f3f5);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));}',
      '.sabx-panel-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.sabx-panel-btn svg{width:16px;height:16px;display:block;}',
      /* 居中模态：遮罩 flex 居中（对齐官方「反馈」弹窗的位置）；面板默认尺寸固定 */
      '.sabx-panel-overlay{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
      '.sabx-panel{display:flex;flex-direction:column;gap:10px;width:min(880px,calc(100vw - 96px));height:min(560px,calc(100vh - 128px));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-2,#1b1b1f);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));padding:14px 16px;color:var(--dsw-alias-label-primary,#f2f3f5);box-sizing:border-box;font-size:13px;}',
      '.sabx-panel,.sabx-panel *{box-sizing:border-box;}',
      '.sabx-panel-head{display:flex;align-items:center;gap:8px;flex:none;}',
      '.sabx-panel-title{font-size:15px;font-weight:600;flex:1;min-width:0;}',
      '.sabx-panel-filters{display:flex;gap:4px;flex-wrap:wrap;flex:none;}',
      '.sabx-panel-filter{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:transparent;color:var(--dsw-alias-label-secondary,#c9ccd0);border-radius:999px;padding:2px 10px;font-size:12px;line-height:1.6;}',
      '.sabx-panel-filter[data-active="true"]{color:var(--dsw-alias-label-primary,#f2f3f5);font-weight:600;background:var(--dsw-alias-interactive-bg-hover-solid,#2c2c33);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3,rgba(255,255,255,.18));}',
      /* 只有数据区滚动：表头在滚动容器内 sticky 吸顶，过滤胶囊/标题在容器外天然固定 */
      '.sabx-panel-scroll{flex:1 1 0;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));border-radius:8px;background:var(--dsw-alias-bg-layer-3,#222227);}',
      /* 表格：separate（collapse 会让 sticky 单元格的边框随滚动走）；横向滚动时
         首列（路径）与末列（操作）吸附 */
      '.sabx-panel-table{width:100%;min-width:640px;border-collapse:separate;border-spacing:0;table-layout:fixed;}',
      '.sabx-panel-table th{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2,#1b1b1f);text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;line-height:1.5;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));}',
      '.sabx-panel-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}',
      '.sabx-panel-table tr:last-child td{border-bottom:none;}',
      '.sabx-panel-table th:first-child,.sabx-panel-table td:first-child{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-layer-3,#222227);box-shadow:inset -1px 0 0 var(--dsw-alias-border-l1,rgba(255,255,255,.07));}',
      '.sabx-panel-table th:first-child{z-index:3;background:var(--dsw-alias-bg-layer-2,#1b1b1f);}',
      '.sabx-panel-table th:last-child,.sabx-panel-table td:last-child{position:sticky;right:0;z-index:1;background:var(--dsw-alias-bg-layer-3,#222227);box-shadow:inset 1px 0 0 var(--dsw-alias-border-l1,rgba(255,255,255,.07));}',
      '.sabx-panel-table th:last-child{z-index:3;background:var(--dsw-alias-bg-layer-2,#1b1b1f);}',
      '.sabx-panel-cellpath{font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;}',
      '.sabx-panel-status{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;}',
      '.sabx-panel-time{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;}',
      '.sabx-panel-dim{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;}',
      '.sabx-panel-reason{white-space:normal;word-break:break-all;color:var(--dsw-alias-label-secondary,#c9ccd0);font-size:12px;line-height:1.5;}',
      '.sabx-panel-actions{display:flex;gap:6px;align-items:center;}',
      '.sabx-panel-ws-trigger:disabled,.sabx-panel-ws-trigger:disabled:hover{cursor:default;border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.11));opacity:.72;}',
      /* 撤销/恢复确认弹层（DOM 内模态，z 高于面板 90、低于悬停提示 95） */
      '.sabx-confirm-overlay{position:fixed;inset:0;z-index:92;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;}',
      '.sabx-confirm{display:flex;flex-direction:column;gap:10px;width:min(420px,calc(100vw - 64px));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-2,#1b1b1f);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));padding:16px;color:var(--dsw-alias-label-primary,#f2f3f5);box-sizing:border-box;font-size:13px;}',
      '.sabx-confirm-title{font-size:14px;font-weight:600;}',
      '.sabx-confirm-text{margin:0;color:var(--dsw-alias-label-secondary,#c9ccd0);font-size:12px;line-height:1.6;word-break:break-word;}',
      '.sabx-confirm-actions{display:flex;justify-content:flex-end;gap:8px;}',
      /* 操作 busy 层：最短展示 BUSY_MIN_MS，亚秒操作也有可感知的加载反馈 */
      '.sabx-busy-overlay{position:fixed;inset:0;z-index:93;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;}',
      '.sabx-busy{display:flex;align-items:center;gap:10px;background:var(--dsw-alias-bg-layer-2,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:10px;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));padding:12px 18px;color:var(--dsw-alias-label-primary,#f2f3f5);font-size:13px;}',
      '.sabx-busy-spin{width:14px;height:14px;flex:none;border:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);border-radius:50%;animation:sabx-spin .8s linear infinite;}',
      '@keyframes sabx-spin{to{transform:rotate(360deg);}}',
      /* 工作区切换（运行期记账按工作区分键；自绘下拉——原生 select 展开态在
         本宿主不可定制/不可靠，与设置页工具下拉同一决策） */
      '.sabx-panel-ws{display:flex;align-items:center;gap:8px;flex:none;}',
      '.sabx-panel-ws-label{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:12px;flex:none;}',
      '.sabx-panel-ws-picker{position:relative;max-width:460px;}',
      '.sabx-panel-ws-trigger{appearance:none;display:inline-flex;align-items:center;gap:6px;max-width:460px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));background:var(--dsw-alias-bg-layer-3,#222227);color:var(--dsw-alias-label-primary,#f2f3f5);border-radius:8px;height:30px;padding:0 8px 0 10px;font:inherit;font-size:12px;cursor:pointer;}',
      '.sabx-panel-ws-trigger:hover{border-color:var(--dsw-alias-label-dimmed,#8a8f99);}',
      '.sabx-panel-ws-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px;}',
      '.sabx-panel-ws-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;text-align:left;}',
      '.sabx-panel-ws-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary,#9ca1a9);transition:transform .14s;}',
      '.sabx-panel-ws-picker.is-open .sabx-panel-ws-chevron{transform:rotate(180deg);}',
      '.sabx-panel-ws-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:40;min-width:100%;max-width:560px;max-height:220px;overflow:auto;padding:4px;background:var(--dsw-alias-bg-layer-2,#1b1b1f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:10px;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));display:flex;flex-direction:column;gap:1px;}',
      '.sabx-panel-ws-option{appearance:none;display:flex;align-items:center;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#c9ccd0);font:inherit;font-size:12px;line-height:1.5;border-radius:6px;padding:6px 8px;cursor:pointer;text-align:left;font-family:ui-monospace,"Cascadia Code",Consolas,"Courier New",monospace;}',
      '.sabx-panel-ws-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#f2f3f5);}',
      '.sabx-panel-ws-option[data-selected="true"]{color:var(--dsw-alias-label-primary,#f2f3f5);font-weight:600;}',
      '.sabx-panel-error{color:var(--dsw-alias-state-error-primary,#f85149);font-size:12px;line-height:1.5;margin:0;flex:none;}',
      '.sabx-panel-footnote{color:var(--dsw-alias-label-tertiary,#9ca1a9);font-size:11px;line-height:1.5;margin:0;flex:none;}',
      /* 悬停提示：自绘气泡单例直挂 body（宿主的裁剪容器/层叠上下文会吞掉面板内
         fixed 元素——官方 Tooltip 同样自带 portal 逃生门）；样式与面板模态同观感，
         display 由 JS 开关，translateX(-50%) 配合 JS 计算的锚点中心横坐标。
         width:max-content 必须保留：fixed 元素的 shrink-to-fit 只从 left 取到视口
         右缘的可用空间，右上角的按钮会把气泡压成一行几个字——max-content 按
         内容定宽、max-width 封顶（官方 Tooltip 同款解法）。 */
      '.sabx-tip{position:fixed;z-index:95;display:none;width:max-content;max-width:480px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));border-radius:8px;background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:12px;line-height:1.6;box-shadow:var(--dsw-shadow-lv2,0 6px 24px rgba(0,0,0,.35));pointer-events:none;word-break:break-all;white-space:pre-line;transform:translateX(-50%);animation:sabx-tip-in 120ms ease-out;}',
      '@keyframes sabx-tip-in{from{opacity:0;}}',
      '@media (prefers-reduced-motion:reduce){.sabx-tip{animation:none;}}',
      '.sabx-dot-revoked{background:var(--dsw-alias-label-dimmed,#8a8f99);}',
      /* ---- 窄屏折行 ---- */
      '@media (max-width:640px){.sabx-rule-row{flex-wrap:wrap;}.sabx-rule-tool{flex:1 0 auto;}.sabx-rule-pattern{flex:1 1 100%;order:2;}.sabx-rule-action{flex:1 1 auto;order:3;}.sabx-rule-remove{flex:0 0 auto;order:4;}}'
    ].join('\n');

    /** 注入一次作用域化样式（浏览器环境；Node 测试桩无 document 时跳过）。 */
    function injectStyles() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = INLINE_CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    injectStyles();

    /* ============================================================================
     * i18n 词典（namespace `sandbox-allowlist`），与 src/client/locales.ts 保持
     * 一致。bundle 不能 import，词典内联一份；test:client 的防漂移断言锁死同步。
     * 词典来自 Bernd Weymann（GitHub: @weymann）的贡献：其将本仓库 fork 为
     * https://github.com/weymann/dsh-sandbox-allowlist 并在提交 b814e0f
     * （"dsh 0.1.7-rc.2 update"）中完成词典化改造，本仓库采纳该实现。
     * 宿主按当前语言解析键，回退链末端永远是 en。
     * ========================================================================== */
    const LOCALE_NS = 'sandbox-allowlist';
    const zh = {
      // ── 授权目录卡片 ──────────────────────────────────────────────────────────
      'dirs.warn': '安全警示：授权目录会被沙箱内的 AI 代理<b>无审批</b>写入（工作区之外），请勿配置存储重要文件的目录。',
      'dirs.hint': '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Archive\\202?（单字符）。',
      'dirs.validateHint': '校验规则：Windows 路径或通配符；非法条目会在保存前标红提示，不会静默丢弃。',
      'dirs.name': '授权目录',
      'dirs.desc': '允许沙箱内代理直接写入的工作区外目录；仍受文件沙箱约束，写入无需审批。',
      'dirs.fieldLabel': '工作区外的受信可写目录',
      'dirs.empty': '尚未授权任何目录。点击「添加目录」新增一行。',
      'dirs.placeholder': 'D:\\Shared\\Tools',
      'dirs.rowAria': '授权目录 {index}',
      'dirs.add': '添加目录',
      'dirs.delete': '删除',
      'dirs.deleteTitle': '删除该目录',
      'dirs.save': '保存目录',
      'dirs.count': '{count} 个目录',
      'dirs.countPending': ' · {count} 处未保存',

      // ── 命令规则卡片 ──────────────────────────────────────────────────────────
      'cmd.defaultHint': 'delegate 表示维持 dsh 现有行为（按需询问）；allow / ask / deny 会覆盖未命中命令的处理。',
      'cmds.hint': '命令模式支持 <code>*</code>（任意多字符）与 <code>?</code>（单字符），如 <code>git status*</code>；'
        + '程序名自动去掉路径、引号与 <code>.exe</code> 类后缀再参与匹配。'
        + '按「每条独立命令」判定（复合命令按 <code>;</code> / <code>&amp;&amp;</code> / <code>|</code> 拆开分别匹配），最后一条命中的规则生效。<br>'
        + '动作：<code>allow</code>=放行（<b>含允许它在沙箱外运行</b>）；<code>ask</code>=弹审批；<code>deny</code>=拦截。',
      'cmds.tailHint': '空白行不会保存；工具留空（任意）时规则对所有 shell 工具生效。写工作区之外的路径请用「授权目录」，命令规则覆盖不了越界写入。',
      'cmds.escalationHint': '实验性功能。沙箱升级指：命令被沙箱拦截后，AI 携带 sandbox_permissions 重新发起执行、使命令脱离沙箱约束运行，此类请求默认需要人工审批。'
        + '开启后，满足以下任一条件的升级将自动批准、不再弹窗：① 命中 allow 规则的命令；② 属于内置能力基线的安全命令（只读，或仅写入工作区与授权目录）。'
        + '其余升级（解释器、联网、包管理器等）仍会弹窗审批；命中 deny/ask 规则、越界写入或引用禁读文件的命令永远不会自动批准。',
      'cmds.baselineHint': '开启后，只读命令（如 ls、git status）与只在工作区/授权目录内写入的命令，不需要写任何规则就免审批运行——引擎内置了这份「安全命令」清单。若「沙箱升级」也开启，这类命令的升级请求同样自动批准。关闭后没有这份清单：一切按你写的规则判定，未命中规则的命令按上方「默认动作」处理。',
      'cmds.name': '命令规则',
      'cmds.desc': '按「命令模式 + 动作」放行 / 询问 / 拦截 shell 命令。',
      'cmds.defaultLabel': '未命中任何规则时的默认动作',
      'cmds.defaultAria': '未命中规则时的默认动作',
      'cmds.rulesLabel': '放行规则（按顺序匹配，最后一条命中生效）',
      'cmds.empty': '尚无命令规则。点击「添加规则」新增一行。',
      'cmds.patternAria': '命令模式',
      'cmds.patternPlaceholder': 'git *',
      'cmds.add': '添加规则',
      'cmds.actionAria': '动作',
      'cmds.removeAria': '删除规则',
      'cmds.removeTitle': '删除该规则',
      'cmds.escalationLabel': '沙箱升级（实验性）',
      'cmds.escalationCheck': '允许自动批准沙箱升级',
      'cmds.advanced': '高级',
      'cmds.baselineLabel': '内置能力基线',
      'cmds.save': '保存命令规则',
      'cmds.count': '{count} 条规则',
      'cmds.countPending': ' · {count} 处未保存',

      // ── 禁读规则卡片 ──────────────────────────────────────────────────────────
      'noread.hint': 'pattern 支持 <code>*</code>（任意多个字符）与 <code>?</code>（单个字符）。'
        + '不含路径分隔符 ⇒ 按文件名匹配任意目录深度（<code>*.pem</code>、<code>.env*</code>、<code>id_rsa*</code>）；'
        + '含分隔符 ⇒ 按完整路径匹配（<code>D:\\Vault\\**\\*.key</code> 之类）。'
        + '目录级：写绝对目录路径（如 <code>D:\\Vault</code>）或末尾加 <code>/**</code>，整棵子树（含目录列表）禁读。',
      'noread.tailHint': '空 pattern 的行不会保存。不提供 allow 动作——官方默认本就允许读；'
        + '想临时放行某个命中文件，把该条动作配成 ask（弹一次人工审批）。',
      'noread.name': '禁读规则',
      'noread.desc': '按文件名 / 路径模式限制读取：deny 直接拒绝，ask 命中时请求人工批准一次。',
      'noread.fieldLabel': '限制读取的文件模式（命中即按动作处理）',
      'noread.empty': '尚无禁读规则。点击「添加规则」新增一行。',
      'noread.patternAria': '禁读模式',
      'noread.patternPlaceholder': '*.pem',
      'noread.add': '添加规则',
      'noread.save': '保存禁读规则',
      'noread.count': '{count} 条规则',
      'noread.countPending': ' · {count} 处未保存',
      'noread.actionAria': '禁读动作',
      'noread.removeAria': '删除禁读规则',
      'noread.removeTitle': '删除该禁读规则',

      // ── 通用 ──────────────────────────────────────────────────────────────────
      'section.title': '沙箱授权',
      'section.intro': '配置沙箱内的目录操作、命令执行与文件读取限制，保存后立即生效。',
      'common.unsavedBadge': '未保存修改',
      'common.discard': '放弃修改',
      'common.saving': '保存中…',
      'common.any': '任意',
      'common.allowHint': 'allow：放行（含允许它在沙箱外运行）',
      'common.askHint': 'ask：弹审批',
      'common.denyHint': 'deny：拦截',

      // ── 校验与错误 ────────────────────────────────────────────────────────────
      'validate.notString': '目录必须是字符串。',
      'validate.empty': '目录不能为空。',
      'validate.notAbsolute': '「{value}」不是绝对路径（需要盘符或根开始的路径）。',
      'validate.tooWide': '「{value}」锚定过宽（** 需要锚定至少一级具名目录）。',
      'error.validate': '校验失败：{message}',
      'error.validateMore': '（另有 {count} 处）',

      // ── local extensions（本仓库扩展：0.2.0 特有界面，fork 贡献里没有的键）────
      'section.summary': '沙箱授权目录 / 命令放行 / 禁读规则 —— 与设置页「沙箱授权」分节是同一份配置。',
      'readonly.loading': '正在载入插件设置…',
      'readonly.unavailable': '宿主没有提供本插件的设置表单（条目未挂载或设置服务不可用），本页暂时只读。',
      'readonly.memory': '当前连接的配置为进程本地（memory）模式：官方写入通路只读，修改不会被写回宿主配置。请在宿主本机页面或配置文件中编辑。',
      'error.notWritable': '当前连接不可写。',
      'error.saveRejected': '保存被拒绝：配置已在别处修改（revision 冲突）或宿主未接受本次写入，请重新载入后再试。',
      'error.resetRejected': '恢复默认被拒绝：配置已在别处修改（revision 冲突）或宿主未接受本次写入，请重新载入后再试。',
      'common.resetOverrideTitle': '清除用户层覆盖，回到部署默认',
      'common.resetNotOverrideTitle': '当前未覆盖部署默认',
      'common.reset': '重置为默认',
      'provider.badge': '仅 Linux 生效',
      'provider.summary': '仅 Linux（bwrap）实际生效；Windows 空转，macOS 忽略授权目录。',
      'provider.notice': '此行是 Linux 专用扩展：只有在 Linux（bwrap 运行器）上才会把「授权目录」加入沙箱写白名单。Windows 上官方 ACL 沙箱保持原样，本行即使启用也自动空转、不产生任何效果；macOS（seatbelt）与其余运行器无法扩展，授权目录会被忽略并记录一次警告。',

      // ── 会话区授权状态面板（utilities 槽位弹层）──────────────────────────────
      'status.panelTitle': '授权状态',
      'status.panelAria': '查看沙箱授权状态',
      'status.wsLabel': '工作区',
      'status.refresh': '刷新',
      'status.refreshAria': '刷新授权状态',
      'status.close': '关闭',
      'status.filterAll': '全部',
      'status.filterGranted': '已授权',
      'status.filterFailed': '授权失败',
      'status.filterPending': '待回收',
      'status.filterRevoked': '已撤销',
      'status.colPath': '路径',
      'status.colStatus': '状态',
      'status.colTime': '时间',
      'status.colReason': '失败原因',
      'status.colSource': '来源',
      'status.colAction': '操作',
      'status.stateGranted': '已授权',
      'status.stateFailed': '授权失败',
      'status.statePending': '待回收',
      'status.stateRevoked': '已撤销',
      'status.dotGranted': '已授权目录：沙箱内可直接写入',
      'status.dotFailed': '授权失败目录：每次使用时自动重试，也可手动重试',
      'status.dotPending': '撤销中：待下次对账回收',
      'status.dotRevoked': '已撤销目录：可恢复',
      'status.actionRevoke': '撤销',
      'status.actionRevokeAria': '撤销该目录的写授权',
      'status.actionRestore': '恢复',
      'status.actionRestoreAria': '恢复该目录的写授权',
      'status.actionGrant': '重试授权',
      'status.actionGrantAria': '手动重试该目录的写授权物化',
      'status.confirmRevoke': '确认撤销该目录的写授权？对应的磁盘访问授权将被回收（可随时恢复）。',
      'status.confirmTitleRevoke': '撤销授权',
      'status.confirmRestore': '确认恢复该目录的写授权？对应的写 ACE 将重新物化。',
      'status.confirmTitleRestore': '恢复授权',
      'status.confirmOk': '确认',
      'status.actionCancel': '取消',
      'status.busy': '正在执行，请稍候…',
      'status.empty': '当前工作区暂无授权记录。',
      'status.loading': '载入中…',
      'status.error': '载入失败：{message}',
      'status.actionFailed': '操作失败：{message}',
      'status.none': '—',
      'status.footnote': '失败与撤销失败都会自动重试；修复目录 ACL 后，可点「重试授权」立即重试。',
    };
    const en = {
      // ── Authorized directories card ─────────────────────────────────────────
      'dirs.warn': 'Security warning: sandboxed AI agents may write to authorized directories <b>without approval</b> (outside the workspace). Do not configure directories holding important files.',
      'dirs.hint': 'Wildcards are supported: D:\\Shared\\** (subtree), D:\\Data\\* (one level of subdirectories), D:\\Archive\\202? (single character).',
      'dirs.validateHint': 'Validation: Windows paths or wildcards; invalid entries are highlighted before saving and are never dropped silently.',
      'dirs.name': 'Authorized directories',
      'dirs.desc': 'Out-of-workspace directories the sandboxed agent may write to directly; still bounded by the file sandbox, and writes need no approval.',
      'dirs.fieldLabel': 'Trusted writable directories outside the workspace',
      'dirs.empty': 'No directory authorized yet. Click "Add directory" to create a row.',
      'dirs.placeholder': 'D:\\Shared\\Tools',
      'dirs.rowAria': 'Authorized directory {index}',
      'dirs.add': 'Add directory',
      'dirs.delete': 'Delete',
      'dirs.deleteTitle': 'Delete this directory',
      'dirs.save': 'Save directories',
      'dirs.count': '{count} directory(ies)',
      'dirs.countPending': ' · {count} unsaved',

      // ── Command rules card ──────────────────────────────────────────────────
      'cmd.defaultHint': 'delegate keeps the current dsh behaviour (ask when needed); allow / ask / deny override how unmatched commands are handled.',
      'cmds.hint': 'Command patterns support <code>*</code> (any number of characters) and <code>?</code> (a single character), e.g. <code>git status*</code>. '
        + 'Program names are stripped of paths, quotes and <code>.exe</code>-style suffixes before matching. '
        + 'Matching is per individual command (compound commands are split on <code>;</code> / <code>&amp;&amp;</code> / <code>|</code> and matched separately), and the last matching rule wins.<br>'
        + 'Actions: <code>allow</code> = permit (<b>including running it outside the sandbox</b>); <code>ask</code> = prompt for approval; <code>deny</code> = block.',
      'cmds.tailHint': 'Blank rows are not saved; leaving the tool empty (any) makes the rule apply to every shell tool. To write outside the workspace use "Authorized directories" — command rules cannot cover out-of-bounds writes.',
      'cmds.escalationHint': 'Experimental feature. A sandbox escalation happens when a command is refused by the sandbox and the AI retries it with sandbox_permissions, so the command would run outside the sandbox; such requests require manual approval by default. '
        + 'When this switch is on, an escalation is approved automatically (no prompt) if either condition holds: the command matches an allow rule, or it falls under the built-in capability baseline (read-only, or writing only inside the workspace and the authorized directories). '
        + 'Any other escalation (interpreters, network access, package managers, …) still prompts. Commands that hit deny/ask rules, write out of bounds, or reference read-restricted files are never auto-approved.',
      'cmds.baselineHint': 'When enabled, read-only commands (ls, git status, …) and commands that write only inside the workspace / the authorized directories run without an approval prompt even with no rule written — the engine ships with this built-in list of "safe commands". With "Sandbox escalation" also enabled, escalation requests for such commands are auto-approved too. When disabled there is no such list: only your written rules decide, and unmatched commands fall back to the "Default action" above.',
      'cmds.name': 'Command rules',
      'cmds.desc': 'Allow / ask / block shell commands by command pattern and action.',
      'cmds.defaultLabel': 'Default action when no rule matches',
      'cmds.defaultAria': 'Default action when no rule matches',
      'cmds.rulesLabel': 'Allow rules (matched in order; the last match wins)',
      'cmds.empty': 'No command rule yet. Click "Add rule" to create a row.',
      'cmds.patternAria': 'Command pattern',
      'cmds.patternPlaceholder': 'git *',
      'cmds.add': 'Add rule',
      'cmds.actionAria': 'Action',
      'cmds.removeAria': 'Delete rule',
      'cmds.removeTitle': 'Delete this rule',
      'cmds.escalationLabel': 'Sandbox escalation (experimental)',
      'cmds.escalationCheck': 'Auto-approve sandbox escalations',
      'cmds.advanced': 'Advanced',
      'cmds.baselineLabel': 'Built-in capability baseline',
      'cmds.save': 'Save command rules',
      'cmds.count': '{count} rule(s)',
      'cmds.countPending': ' · {count} unsaved',

      // ── Read restrictions card ──────────────────────────────────────────────
      'noread.hint': 'Patterns support <code>*</code> (any number of characters) and <code>?</code> (a single character). '
        + 'Without a path separator ⇒ matched against the file name at any depth (<code>*.pem</code>, <code>.env*</code>, <code>id_rsa*</code>); '
        + 'with a separator ⇒ matched against the full path (such as <code>D:\\Vault\\**\\*.key</code>). '
        + 'Directory-wide: write an absolute directory path (e.g. <code>D:\\Vault</code>) or append <code>/**</code> to deny the whole subtree, listing included.',
      'noread.tailHint': 'Rows with an empty pattern are not saved. There is no allow action — reading is permitted by default upstream; '
        + 'to grant one matching file temporarily, set that row to ask (which prompts once for manual approval).',
      'noread.name': 'Read restrictions',
      'noread.desc': 'Restrict reads by file name / path pattern: deny refuses outright, ask requests manual approval when matched.',
      'noread.fieldLabel': 'File patterns to restrict reading (a match is handled by the action)',
      'noread.empty': 'No read restriction yet. Click "Add rule" to create a row.',
      'noread.patternAria': 'Read-denied pattern',
      'noread.patternPlaceholder': '*.pem',
      'noread.add': 'Add rule',
      'noread.save': 'Save read restrictions',
      'noread.count': '{count} rule(s)',
      'noread.countPending': ' · {count} unsaved',
      'noread.actionAria': 'Read-restriction action',
      'noread.removeAria': 'Delete read restriction',
      'noread.removeTitle': 'Delete this read restriction',

      // ── Shared ──────────────────────────────────────────────────────────────
      'section.title': 'Sandbox authorization',
      'section.intro': 'Configure in-sandbox directory access, command execution and file-read restrictions; changes take effect on save.',
      'common.unsavedBadge': 'Unsaved changes',
      'common.discard': 'Discard changes',
      'common.saving': 'Saving…',
      'common.any': 'Any',
      'common.allowHint': 'allow: permit (including running it outside the sandbox)',
      'common.askHint': 'ask: prompt for approval',
      'common.denyHint': 'deny: block',

      // ── Validation and errors ───────────────────────────────────────────────
      'validate.notString': 'A directory must be a string.',
      'validate.empty': 'A directory cannot be empty.',
      'validate.notAbsolute': '"{value}" is not an absolute path (it must start with a drive letter or a root).',
      'validate.tooWide': '"{value}" is anchored too broadly (** needs at least one named directory level).',
      'error.validate': 'Validation failed: {message}',
      'error.validateMore': ' ({count} more)',

      // ── local extensions (this fork: 0.2.0-only surfaces absent in the contribution) ─
      'section.summary': 'Authorized directories / command allow-list / read restrictions — the same configuration as the "Sandbox authorization" section in the settings page.',
      'readonly.loading': 'Loading plugin settings…',
      'readonly.unavailable': 'The host does not serve this plugin\'s settings form (entry not mounted or settings service unavailable); this page is read-only for now.',
      'readonly.memory': 'The current connection runs in process-local (memory) mode: the official write path is read-only and changes are not written back to the host configuration. Edit on the host\'s own page or in its configuration file.',
      'error.notWritable': 'The current connection is not writable.',
      'error.saveRejected': 'The save was rejected: the configuration changed elsewhere (revision conflict) or the host did not accept the write. Reload and try again.',
      'error.resetRejected': 'Resetting to the default was rejected: the configuration changed elsewhere (revision conflict) or the host did not accept the write. Reload and try again.',
      'common.resetOverrideTitle': 'Clear the user-layer override and return to the deployment default',
      'common.resetNotOverrideTitle': 'The deployment default is not overridden',
      'common.reset': 'Reset to default',
      'provider.badge': 'Linux only',
      'provider.summary': 'Only takes effect on Linux (bwrap); on Windows this row is inert, and macOS ignores authorized directories.',
      'provider.notice': 'This row is a Linux-only extension: only on Linux (the bwrap runner) are authorized directories added to the sandbox write allow-list. On Windows the official ACL sandbox stays as-is and this row is inert even when enabled; macOS (seatbelt) and other runners cannot be extended — authorized directories are ignored with a one-time warning.',

      // ── Session authorization panel (utilities-slot popup) ──────────────────
      'status.panelTitle': 'Authorization state',
      'status.panelAria': 'View sandbox authorization state',
      'status.wsLabel': 'Workspace',
      'status.refresh': 'Refresh',
      'status.refreshAria': 'Refresh the authorization state',
      'status.close': 'Close',
      'status.filterAll': 'All',
      'status.filterGranted': 'Granted',
      'status.filterFailed': 'Failed',
      'status.filterPending': 'Reclaiming',
      'status.filterRevoked': 'Revoked',
      'status.colPath': 'Path',
      'status.colStatus': 'Status',
      'status.colTime': 'Time',
      'status.colReason': 'Failure reason',
      'status.colSource': 'Source',
      'status.colAction': 'Action',
      'status.stateGranted': 'Granted',
      'status.stateFailed': 'Failed',
      'status.statePending': 'Reclaiming',
      'status.stateRevoked': 'Revoked',
      'status.dotGranted': 'Granted directory: writable from inside the sandbox',
      'status.dotFailed': 'Failed directory: retried automatically on every resolve, or retry manually',
      'status.dotPending': 'Revocation in progress: reclaimed on the next reconcile',
      'status.dotRevoked': 'Revoked directory: can be restored',
      'status.actionRevoke': 'Revoke',
      'status.actionRevokeAria': 'Revoke the write grant on this directory',
      'status.actionRestore': 'Restore',
      'status.actionRestoreAria': 'Restore the write grant on this directory',
      'status.actionGrant': 'Retry grant',
      'status.actionGrantAria': 'Manually retry materializing the write grant on this directory',
      'status.confirmRevoke': 'Revoke the write grant on this directory? The standing disk access will be reclaimed (you can restore it anytime).',
      'status.confirmTitleRevoke': 'Revoke grant',
      'status.confirmRestore': 'Restore the write grant on this directory? The write ACE will be re-materialized.',
      'status.confirmTitleRestore': 'Restore grant',
      'status.confirmOk': 'Confirm',
      'status.actionCancel': 'Cancel',
      'status.busy': 'Working on it…',
      'status.empty': 'No authorization records for this workspace yet.',
      'status.loading': 'Loading…',
      'status.error': 'Failed to load: {message}',
      'status.actionFailed': 'The operation failed: {message}',
      'status.none': '—',
      'status.footnote': 'Failed grants and failed revocations retry automatically; after repairing the directory ACL, click "Retry grant" to retry immediately.',
    };

    /* 用户可见文案一律走词典键：这里只保存键名，渲染时用 t(key) 取值
     * （t 在 apply 闭包内，渲染时读取宿主当前语言）。词典见上方 zh/en。 */
    const CALL_WARN_DIRS_KEY = 'dirs.warn';
    const DIRS_HINT_KEY = 'dirs.hint';
    const DIRS_VALIDATE_HINT_KEY = 'dirs.validateHint';

    const COMMANDS_DEFAULT_HINT_KEY = 'cmd.defaultHint';
    const COMMANDS_HINT_KEY = 'cmds.hint';
    const COMMANDS_TAIL_HINT_KEY = 'cmds.tailHint';
    const COMMANDS_ESCALATION_HINT_KEY = 'cmds.escalationHint';

    const NOREAD_HINT_KEY = 'noread.hint';
    const NOREAD_TAIL_HINT_KEY = 'noread.tailHint';

    /** 工具选项（空 = 任意工具；方案 A：标签与值一致，不加“PowerShell”）。
     注：dsh 的 shell 工具只有 bash / pwsh 两个（dsh-tool-bash / dsh-tool-pwsh），
     加了别的值会被服务端 CommandRuleSchema（z.union(SHELL_TOOLS)）校验拒绝。 */
    const TOOL_OPTIONS = [
      { value: '', labelKey: 'common.any' },
      { value: 'bash', label: 'bash' },
      { value: 'pwsh', label: 'pwsh' },
    ];

    /** 规则动作（分段选择器，带语义色圆点）。 */
    const ACTION_OPTIONS = [
      { value: 'allow', dot: 'sabx-dot-allow', label: 'allow', cls: 'is-allow', hintKey: 'common.allowHint' },
      { value: 'ask', dot: 'sabx-dot-ask', label: 'ask', cls: 'is-ask', hintKey: 'common.askHint' },
      { value: 'deny', dot: 'sabx-dot-deny', label: 'deny', cls: 'is-deny', hintKey: 'common.denyHint' },
    ];

    /** 「高级」折叠区里的布尔开关（勾选框定义）。 */
    const BASELINE_OPTIONS = [
      { key: 'baseline', labelKey: 'cmds.baselineLabel', hintKey: 'cmds.baselineHint' },
    ];

    /** 禁读规则动作：只提供 deny / ask（allow 与默认行为无异，刻意不提供）。 */
    const NOREAD_ACTIONS = [
      { value: 'deny', dot: 'sabx-dot-deny' },
      { value: 'ask', dot: 'sabx-dot-ask' },
    ];

    /** 动作分段选项（标签与 title 提示在渲染时按当前语言解析）。 */
    function actionOptions(t, includeDelegate) {
      var options = ACTION_OPTIONS.map(function mapAction(option) {
        var copy = {};
        for (var k in option) copy[k] = option[k];
        copy.hint = t(option.hintKey);
        return copy;
      });
      return includeDelegate ? [{ value: 'delegate', dot: null }].concat(options) : options;
    }

    /** 工具下拉选项（空值 = 任意）。 */
    function toolOptions(t) {
      return TOOL_OPTIONS.map(function mapTool(option) {
        var copy = {};
        for (var k in option) copy[k] = option[k];
        copy.label = Object.prototype.hasOwnProperty.call(option, 'labelKey') ? t(option.labelKey) : option.label;
        return copy;
      });
    }

    /** 「高级」折叠区的布尔开关（标签与说明均为词典键）。 */
    function baselineOptions(t) {
      return BASELINE_OPTIONS.map(function mapBaseline(option) {
        return { key: option.key, label: t(option.labelKey), hint: t(option.hintKey) };
      });
    }

    /* ============================================================================
     * 读取配置表单（ctx.configForms.get(entryId) 返回的 controller）
     * ========================================================================== */

    /** 表单不可用时的降级快照（服务缺失 / 条目未挂载）：只读、无值。 */
    var UNAVAILABLE_SNAPSHOT = {
      status: 'unavailable',
      value: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'memory',
    };

    /**
     * 读取一次快照，并把任何异常/缺失收敛为 UNAVAILABLE_SNAPSHOT：设置页永远
     * 不能因表单服务不可用而崩溃。
     */
    function formSnapshot(form) {
      try {
        if (!form || typeof form.getSnapshot !== 'function') return UNAVAILABLE_SNAPSHOT;
        var snapshot = form.getSnapshot();
        if (!snapshot || typeof snapshot !== 'object') return UNAVAILABLE_SNAPSHOT;
        var status = snapshot.status === 'ready' || snapshot.status === 'loading' ? snapshot.status : 'unavailable';
        return {
          status: status,
          value: snapshot.value,
          user: snapshot.user,
          revision: snapshot.revision,
          writable: snapshot.writable === true,
          mode: snapshot.mode === 'host' ? 'host' : 'memory',
        };
      } catch (_ignored) {
        return UNAVAILABLE_SNAPSHOT;
      }
    }

    /** 订阅快照替换；表单不可用时返回空 disposer（不抛、不崩）。 */
    function subscribeForm(form, listener) {
      try {
        if (form && typeof form.subscribe === 'function') {
          var dispose = form.subscribe(listener);
          if (typeof dispose === 'function') return dispose;
        }
      } catch (_ignored) {
        // 订阅失败按不可用处理
      }
      return function noop() {};
    }

    /**
     * 表单当前是否可写。官方契约：memory 模式（远端连接的偏好进程本地）永不
     * 接受写入，status !== 'ready' 时也没有可用的原生通路。
     */
    function isWritable(form) {
      var snapshot = formSnapshot(form);
      return snapshot.status === 'ready' && snapshot.writable === true;
    }

    /** 只读原因（词典键，供页面说明），可写时为 null。 */
    function readOnlyReason(form, t) {
      var snapshot = formSnapshot(form);
      if (snapshot.status === 'loading') return t('readonly.loading');
      if (snapshot.status === 'unavailable') {
        return t('readonly.unavailable');
      }
      if (snapshot.writable !== true) {
        return t('readonly.memory');
      }
      return null;
    }

    /**
     * 该字段是否被用户层覆盖。官方语义：快照 user 里**键在场**即覆盖 —— 即使值
     * 恰好等于组合默认值也仍是覆盖，比较值看不出来。
     */
    function fieldOverridden(form, field) {
      var user = formSnapshot(form).user;
      return user !== null && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field);
    }

    /**
     * 原子写回一个字段。set 返回 false 表示被拒（revision 冲突 / 不可写），必须
     * 当作失败处理；传输层异常则直接抛出。
     */
    async function saveField(form, field, value, t) {
      if (!isWritable(form)) throw new Error(readOnlyReason(form, t) || t('error.notWritable'));
      var accepted = await form.set(field, value);
      if (accepted !== true) {
        throw new Error(t('error.saveRejected'));
      }
    }

    /** 清除用户层覆盖，让字段回退到组合默认值（「重置为默认」）。 */
    async function resetField(form, field, t) {
      if (!isWritable(form)) throw new Error(readOnlyReason(form, t) || t('error.notWritable'));
      var accepted = await form.unset(field);
      if (accepted !== true) {
        throw new Error(t('error.resetRejected'));
      }
    }

    /** 从表单快照读取当前授权目录列表。 */
    function currentDirs(form) {
      var value = formSnapshot(form).value;
      return Array.isArray(value && value.allowedDirs) ? value.allowedDirs : [];
    }

    /** 从表单快照读取当前命令规则与开关。 */
    function currentCommands(form) {
      var fallback = { default: 'delegate', rules: [], escalation: 'capability', baseline: true };
      var value = formSnapshot(form).value;
      var commands = value && value.commands;
      if (!commands) return fallback;
      var rules = Array.isArray(commands.rules)
        ? commands.rules.map(function mapRule(rule) {
            return {
              tool: rule && rule.tool ? rule.tool : '',
              pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
              action: rule && rule.action ? rule.action : 'ask',
            };
          })
        : [];
      return {
        default: commands.default !== undefined ? commands.default : 'delegate',
        rules: rules,
        escalation: commands.escalation !== undefined ? commands.escalation : 'capability',
        baseline: commands.baseline !== false,
      };
    }

    /** 从表单快照读取当前禁读规则（[{ pattern, action }]，动作归一为 deny/ask）。 */
    function currentNoRead(form) {
      var value = formSnapshot(form).value;
      var rules = Array.isArray(value && value.noRead) ? value.noRead : [];
      return rules.map(function mapRule(rule) {
        return {
          pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
          action: rule && rule.action === 'ask' ? 'ask' : 'deny',
        };
      });
    }

    /* ============================================================================
     * 校验（浏览器侧轻量镜像 lib/patterns.mjs 的拒绝规则；服务端仍然权威）
     * ========================================================================== */

    /** 返回非法原因（词典键 + 参数），null 表示通过。 */
    function validateDirPattern(raw) {
      if (typeof raw !== 'string') return { key: 'validate.notString' };
      var value = raw.trim();
      if (value.length === 0) return { key: 'validate.empty' };
      var isAbsolute = /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]/u.test(value);
      if (!isAbsolute) {
        return { key: 'validate.notAbsolute', params: { value: value } };
      }
      if (value.indexOf('**') !== -1) {
        var staticLevels = 0;
        var segments = value.split(/[\\/]/u).filter(function keep(s) { return s.length > 0; });
        for (var i = 0; i < segments.length; i += 1) {
          if (/[*?]/u.test(segments[i])) break;
          staticLevels += 1;
        }
        if (staticLevels <= 1) {
          return { key: 'validate.tooWide', params: { value: value } };
        }
      }
      return null;
    }

    /** 未保存改动计数：与已保存值逐条位置比较（比较到两列表较长一方，删除行
     * 形成的尾部差异也计入——只循环到 rows.length 会漏掉删除最后一行的情况）。 */
    function dirsDirtyCount(rows, saved) {
      var count = 0;
      var len = Math.max(rows.length, saved.length);
      for (var i = 0; i < len; i += 1) {
        var rowValue = i < rows.length ? String(rows[i].value || '') : '';
        var compared = i < saved.length ? String(saved[i] || '') : '';
        if (rowValue.trim() !== compared.trim()) count += 1;
      }
      return count;
    }

    /** 未保存改动计数：规则草稿与已保存值逐条位置比较（比较到两列表较长一方，
     * 删除行形成的尾部差异也计入——与 dirsDirtyCount 同语义）。 */
    function rulesDirtyCount(rows, saved) {
      var count = 0;
      var len = Math.max(rows.length, saved.length);
      for (var i = 0; i < len; i += 1) {
        var a = rows[i];
        var b = saved[i];
        if (a === undefined || b === undefined
          || (a.tool || '') !== (b.tool || '')
          || String(a.pattern || '').trim() !== String(b.pattern || '').trim()
          || (a.action || 'ask') !== (b.action || 'ask')) count += 1;
      }
      return count;
    }

    /** 未保存改动计数：禁读规则草稿与已保存值逐条位置比较（无 tool 维度）。 */
    function noReadDirtyCount(rows, saved) {
      var count = 0;
      var len = Math.max(rows.length, saved.length);
      for (var i = 0; i < len; i += 1) {
        var a = rows[i];
        var b = saved[i];
        if (a === undefined || b === undefined
          || String(a.pattern || '').trim() !== String(b.pattern || '').trim()
          || (a.action || 'deny') !== (b.action || 'deny')) count += 1;
      }
      return count;
    }

    /* ============================================================================
     * 小部件
     * ========================================================================== */

    /** 卡片标题里的折叠箭头。 */
    function createChevron(className) {
      return react.createElement('svg', { className: className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        react.createElement('path', {
          d: 'M4 6l4 4 4-4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /** 语义色圆点。 */
    function createDot(className) {
      return react.createElement('span', { key: 'dot', className: 'sabx-dot ' + className, 'aria-hidden': true });
    }

    /** 小 ✕ 图标（删除按钮）。 */
    function createXIcon() {
      return react.createElement('svg', { viewBox: '0 0 12 12', 'aria-hidden': true },
        react.createElement('path', {
          d: 'M2 2l8 8M10 2l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }));
    }

    /** 工具下拉的向下箭头。 */
    function createChevronSmall() {
      return react.createElement('svg', { className: 'sabx-tool-chevron', viewBox: '0 0 12 12', 'aria-hidden': true },
        react.createElement('path', {
          d: 'M3 4.5l3 3 3-3',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /** 工具下拉选项的绿色对勾。 */
    function createCheckIcon() {
      return react.createElement('svg', { className: 'sabx-tool-check', viewBox: '0 0 12 12', 'aria-hidden': true },
        react.createElement('path', {
          d: 'M2 6.5l2.5 2.5L10 3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /**
     * 分段选择器（原始按钮组，data-active 由 CSS 驱动）。
     * @param options - [{ value, dot? }]
     * @param selected - 当前值。
     * @param onSelect - (value) => void
     * @param compact  - 规则动作行使用更紧凑的间距。
     */
    function createSeg(options, selected, onSelect, ariaLabel, compact) {
      // 注意：必须用 .map 让每个选项按钮捕获各自的 option（循环 var 变量
      // 会被所有闭包共享，导致点击任何一项都选中最后一项）。
      var items = options.map(function mapOption(option) {
        var classes = ['sabx-seg-item'];
        if (option.cls) classes.push(option.cls);
        else if (option.value !== 'delegate') classes.push('is-' + option.value);
        var children = [];
        if (option.dot) children.push(createDot(option.dot));
        children.push(option.label || option.value);
        return react.createElement('button', {
          key: option.value,
          type: 'button',
          className: classes.join(' '),
          'data-active': option.value === selected ? 'true' : 'false',
          'aria-label': ariaLabel ? ariaLabel + ': ' + option.value : undefined,
          title: option.hint,
          onClick: function onPick() { onSelect(option.value); },
        }, children);
      });
      return react.createElement('div', { className: 'sabx-seg' + (compact ? ' sabx-seg--compact' : ''), role: 'group' }, items);
    }

    /**
     * 工具自绘下拉（v5）：原生 <select> 的展开面板由浏览器渲染、CSS 无法定制，
     * 故用触发按钮 + 自绘菜单实现，展开态/选中态完全可控。
     * @param props - { value, disabled, onSelect }
     */
    function ToolPicker(props) {
      var openState = react.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var triggerRef = react.useRef(null);
      var menuRef = react.useRef(null);

      react.useEffect(function onOpen() {
        if (!open) return;
        function onDoc(event) {
          var target = event.target;
          if ((triggerRef.current && triggerRef.current.contains(target)) ||
              (menuRef.current && menuRef.current.contains(target))) return;
          setOpen(false);
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return function cleanup() {
          document.removeEventListener('mousedown', onDoc);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      var t = props.t;
      var value = props.value || '';
      var label = value || t('common.any');
      var triggerClasses = ['sabx-tool-trigger'];
      if (!value) triggerClasses.push('is-any');
      var pickerClasses = ['sabx-tool-picker'];
      if (open) pickerClasses.push('is-open');

      // 注意：必须用 .map 让每个选项按钮捕获各自的 option（与 createSeg 同理，
      // 循环 var 变量会被所有闭包共享，导致点击任何一项都选中最后一项）。
      var optionNodes = toolOptions(t).map(function mapToolOption(option) {
        var selected = option.value === value;
        return react.createElement('button', {
          key: option.value,
          type: 'button',
          className: 'sabx-tool-option' + (selected ? ' is-selected' : ''),
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
          onClick: function onOption() {
            props.onSelect(option.value);
            setOpen(false);
          },
        }, option.label, createCheckIcon());
      });

      return react.createElement('div', { className: pickerClasses.join(' ') },
        react.createElement('button', {
          ref: triggerRef,
          className: triggerClasses.join(' '),
          type: 'button',
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          disabled: props.disabled,
          onClick: function onTrigger() { setOpen(!open); },
        },
          react.createElement('span', { className: 'sabx-tool-value' }, label),
          createChevronSmall(),
        ),
        open
          ? react.createElement('div', { ref: menuRef, className: 'sabx-tool-menu', role: 'listbox' }, optionNodes)
          : null,
      );
    }

    /**
     * 可折叠卡片外壳：标题（name + count + desc + 未保存徽章 + 箭头）+ 主体。
     * 收起态主体由 CSS .sabx-card-openable:not(.is-open) .sabx-card-body 隐藏。
     * @param spec - { id, name, count, desc, pendingCount, open, onToggle }
     * @param body  - React 节点（卡片内部内容，含页脚）。
     */
    function createCard(spec, body) {
      var classes = ['sabx-card-openable'];
      if (spec.open) classes.push('is-open');
      if (spec.pendingCount > 0) classes.push('has-pending');
      var countNode = null;
      if (typeof spec.count === 'string') {
        countNode = react.createElement('span', { key: 'count', className: 'sabx-count' }, spec.count);
      }
      return react.createElement('article', { className: classes.join(' '), id: spec.id },
        react.createElement('button', { className: 'sabx-card-header', type: 'button', onClick: spec.onToggle, 'aria-expanded': spec.open ? 'true' : 'false' },
          react.createElement('span', { className: 'sabx-card-head-text' },
            react.createElement('span', { key: 'name', className: 'sabx-card-name' }, spec.name, countNode),
            react.createElement('span', { key: 'desc', className: 'sabx-card-desc' }, spec.desc),
          ),
          react.createElement('span', { className: 'sabx-pending' }, spec.t('common.unsavedBadge')),
          createChevron('sabx-card-chevron'),
        ),
        body ? react.createElement('div', { className: 'sabx-card-body' }, body) : null,
      );
    }

    /* ============================================================================
     * 卡片 A：授权目录
     * ========================================================================== */

    function makeDirsCard(form, t) {
      return function DirsCard() {
        var rowsState = react.useState([]);
        var rows = rowsState[0];
        var setRows = rowsState[1];
        var openState = react.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        var invalidState = react.useState({});
        var invalid = invalidState[0];
        var setInvalid = invalidState[1];
        // 行标识发生器：key 用稳定 id 而非数组下标，删除行后焦点/临时 UI 状态
        // 不会落到平移后的相邻行上。
        var nextIdRef = react.useRef(1);
        // 草稿保护：存在未保存编辑时，外部快照更新（如另一客户端保存）不再
        // 静默覆盖本地草稿；「放弃修改」或保存成功后复位，外部变更才重新落地。
        var dirtyRef = react.useRef(false);

        react.useEffect(function syncFromForm() {
          var update = function updateRows() {
            try {
              if (dirtyRef.current) return; // 有未保存草稿，不覆盖
              setRows(currentDirs(form).map(function toRow(value) { return { id: nextIdRef.current++, value: value }; }));
            } catch (_ignored) {
              // a stale form must never break the section render
            }
          };
          update();
          return subscribeForm(form, update);
        }, []);

        var locked = !isWritable(form);
        var overridden = fieldOverridden(form, 'allowedDirs');
        var saved = currentDirs(form);
        var pendingCount = dirsDirtyCount(rows, saved);

        function setRow(index, value) {
          setError(null);
          dirtyRef.current = true;
          setInvalid(function dropFlags(previous) {
            if (!Object.prototype.hasOwnProperty.call(previous, index)) return previous;
            var next = {};
            for (var key in previous) {
              if (Object.prototype.hasOwnProperty.call(previous, key) && Number(key) !== index) next[key] = previous[key];
            }
            return next;
          });
          setRows(function mapRows(previous) {
            return previous.map(function mapOne(row, i) {
              if (i !== index) return row;
              var next = {};
              for (var key in row) { if (Object.prototype.hasOwnProperty.call(row, key)) next[key] = row[key]; }
              next.value = value;
              return next;
            });
          });
        }

        function addRow() {
          setError(null);
          dirtyRef.current = true;
          setRows(function append(previous) { return previous.concat([{ id: nextIdRef.current++, value: '' }]); });
        }

        function removeRow(index) {
          setError(null);
          dirtyRef.current = true;
          // 删除行后其上方的非法标记索引整体前移一位，标红不跟错行。
          setInvalid(function shiftFlags(previous) {
            var next = {};
            for (var key in previous) {
              if (!Object.prototype.hasOwnProperty.call(previous, key)) continue;
              var i = Number(key);
              if (i === index) continue;
              next[i > index ? i - 1 : i] = previous[key];
            }
            return next;
          });
          setRows(function drop(previous) { return previous.filter(function keep(row, i) { return i !== index; }); });
        }

        function restoreSaved() {
          setRows(currentDirs(form).map(function toRow(value) { return { id: nextIdRef.current++, value: value }; }));
          setError(null);
          setInvalid({});
          dirtyRef.current = false;
        }

        /** 清除用户层覆盖，回到组合（部署）默认值。 */
        var resetDefault = async function resetDefault() {
          setError(null);
          try {
            setSaving(true);
            await resetField(form, 'allowedDirs', t);
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var save = async function save() {
          setError(null);
          var values = [];
          var problems = [];
          rows.forEach(function validateOne(row, index) {
            var value = String(row.value || '').trim();
            if (value.length === 0) return; // 空行直接丢弃，不视为错误
            var issue = validateDirPattern(value);
            if (issue !== null) {
              problems.push({ index: index, message: t(issue.key, issue.params) });
            } else {
              values.push(value);
            }
          });
          if (problems.length > 0) {
            var flags = {};
            problems.forEach(function mark(p) { flags[p.index] = true; });
            setInvalid(flags);
            setError(t('error.validate', { message: problems[0].message })
              + (problems.length > 1 ? t('error.validateMore', { count: problems.length - 1 }) : ''));
            return;
          }
          try {
            setSaving(true);
            await saveField(form, 'allowedDirs', values, t);
            restoreSaved(); // 订阅回调也会同步，这里显式刷新一次
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var countText = t('dirs.count', { count: saved.length });
        if (pendingCount > 0) countText += t('dirs.countPending', { count: pendingCount });

        // 注意：必须用 .map（每行回调捕获各自的 row/index，循环 var 会被共享）。
        var dirRows = rows.map(function mapDirRow(row, index) {
          var isNewRow = index >= saved.length;
          return react.createElement('div', { key: row.id, className: 'sabx-dir-row' },
            isNewRow
              ? react.createElement('span', { className: 'sabx-dir-icon is-new', 'aria-hidden': true }, '＋')
              : react.createElement('span', { className: 'sabx-dir-icon', 'aria-hidden': true }, '📁'),
            react.createElement('input', {
              className: 'sabx-input sabx-mono' + (invalid[index] ? ' is-invalid' : ''),
              type: 'text',
              spellCheck: false,
              value: row.value,
              'aria-label': t('dirs.rowAria', { index: index + 1 }),
              placeholder: t('dirs.placeholder'),
              disabled: locked,
              onChange: function onChange(event) { setRow(index, event.target.value); },
            }),
            react.createElement('button', {
              className: 'sabx-icon-btn',
              type: 'button',
              'aria-label': t('dirs.delete'),
              title: t('dirs.deleteTitle'),
              disabled: locked,
              onClick: function onRemove() { removeRow(index); },
            }, createXIcon()),
          );
        });
        if (dirRows.length === 0) {
          dirRows.push(react.createElement('div', { key: 'empty', className: 'sabx-empty' },
            t('dirs.empty')));
        }

        var bodyChildren = [
          react.createElement('div', { key: 'callout', className: 'sabx-callout-warn', role: 'note' },
            createDot('sabx-dot-warn'),
            react.createElement('span', {
              dangerouslySetInnerHTML: { __html: t(CALL_WARN_DIRS_KEY) },
            }),
          ),
          react.createElement('div', { key: 'field', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, t('dirs.fieldLabel')),
              react.createElement('button', {
                className: 'sabx-field-reset',
                type: 'button',
                disabled: saving || locked || !overridden,
                title: overridden ? t('common.resetOverrideTitle') : t('common.resetNotOverrideTitle'),
                onClick: function onReset() { void resetDefault(); },
              }, t('common.reset')),
            ),
            react.createElement('p', { className: 'sabx-field-hint', dangerouslySetInnerHTML: { __html: t(DIRS_HINT_KEY).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;') } }),
            react.createElement('div', { className: 'sabx-dir-list' }, dirRows),
            react.createElement('button', { className: 'sabx-add-row', type: 'button', disabled: saving || locked, onClick: addRow },
              react.createElement('span', { 'aria-hidden': true }, '＋'), ' ' + t('dirs.add')),
            react.createElement('p', { className: 'sabx-dir-hint-inline' }, t(DIRS_VALIDATE_HINT_KEY)),
          ),
          react.createElement('div', { key: 'footer', className: 'sabx-card-footer' },
            error === null
              ? null
              : react.createElement('p', { className: 'sabx-card-error', role: 'alert' }, error),
            react.createElement('button', { className: 'sabx-btn sabx-btn-ghost', type: 'button', disabled: saving || pendingCount === 0, onClick: restoreSaved }, t('common.discard')),
            react.createElement('button', { className: 'sabx-btn sabx-btn-primary', type: 'button', disabled: saving || locked, onClick: function onSave() { void save(); } },
              saving ? t('common.saving') : t('dirs.save')),
          ),
        ];

        return createCard({
          id: 'sabx-card-dirs',
          name: t('dirs.name'),
          count: countText,
          desc: t('dirs.desc'),
          pendingCount: pendingCount,
          open: open,
          onToggle: function onToggle() { setOpen(!open); },
          t: t,
        }, bodyChildren);
      };
    }

    /* ============================================================================
     * 卡片 B：命令规则
     * ========================================================================== */

    function makeCommandsCard(form, t) {
      return function CommandsCard() {
        var rulesState = react.useState([]);
        var rules = rulesState[0];
        var setRules = rulesState[1];
        var defaultState = react.useState('delegate');
        var defaultAction = defaultState[0];
        var setDefaultAction = defaultState[1];
        var escalateState = react.useState(true);
        var escalateAuto = escalateState[0];
        var setEscalateAuto = escalateState[1];
        var baselineState = react.useState(true);
        var baseline = baselineState[0];
        var setBaseline = baselineState[1];
        var openState = react.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        // 行标识发生器与草稿保护标记（语义同授权目录卡片）。
        var nextIdRef = react.useRef(1);
        var dirtyRef = react.useRef(false);

        react.useEffect(function syncFromForm() {
          var update = function updateRules() {
            try {
              if (dirtyRef.current) return; // 有未保存草稿，不覆盖
              var cmds = currentCommands(form);
              setRules(cmds.rules.map(function toRow(rule) {
                var row = {};
                for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) row[key] = rule[key]; }
                row.id = nextIdRef.current++;
                return row;
              }));
              setDefaultAction(cmds.default);
              setEscalateAuto(cmds.escalation !== 'never');
              setBaseline(cmds.baseline);
            } catch (_ignored) {
              // a stale form must never break the section render
            }
          };
          update();
          return subscribeForm(form, update);
        }, []);

        var locked = !isWritable(form);
        var overridden = fieldOverridden(form, 'commands');
        var saved = currentCommands(form);
        // 未保存处数 = 改动的规则行数 + 改动的开关数（默认动作/升级/基线各计 1），
        // 与授权目录卡片的「N 处未保存」同语义。
        var pendingCount =
          rulesDirtyCount(rules, saved.rules)
          + (defaultAction !== (saved.default || 'delegate') ? 1 : 0)
          + (escalateAuto !== (saved.escalation !== 'never') ? 1 : 0)
          + (baseline !== saved.baseline ? 1 : 0);

        function setRule(index, patch) {
          setError(null);
          dirtyRef.current = true;
          setRules(function mapRules(previous) {
            return previous.map(function mapOne(rule, i) {
              if (i !== index) return rule;
              var next = {};
              for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) next[key] = rule[key]; }
              for (var pkey in patch) { if (Object.prototype.hasOwnProperty.call(patch, pkey)) next[pkey] = patch[pkey]; }
              return next;
            });
          });
        }

        function addRule() {
          setError(null);
          dirtyRef.current = true;
          setRules(function append(previous) {
            return previous.concat([{ id: nextIdRef.current++, tool: '', pattern: '', action: 'ask' }]);
          });
        }

        function removeRule(index) {
          setError(null);
          dirtyRef.current = true;
          setRules(function drop(previous) {
            return previous.filter(function keep(rule, i) { return i !== index; });
          });
        }

        function restoreSaved() {
          var cmds = currentCommands(form);
          setRules(cmds.rules.map(function toRow(rule) {
            var row = {};
            for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) row[key] = rule[key]; }
            row.id = nextIdRef.current++;
            return row;
          }));
          setDefaultAction(cmds.default || 'delegate');
          setEscalateAuto(cmds.escalation !== 'never');
          setBaseline(cmds.baseline);
          setError(null);
          dirtyRef.current = false;
        }

        /** 清除用户层覆盖，回到组合（部署）默认值。 */
        var resetDefault = async function resetDefault() {
          setError(null);
          try {
            setSaving(true);
            await resetField(form, 'commands', t);
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var save = async function save() {
          setError(null);
          // 空 pattern 的行不保存；历史 program/args 写法不再被 schema 接受。
          var cleanRules = rules
            .filter(function hasPattern(rule) {
              return rule && String(rule.pattern || '').trim().length > 0;
            })
            .map(function buildClean(rule) {
              var clean = { pattern: String(rule.pattern || '').trim(), action: rule.action || 'ask' };
              if (rule.tool) clean.tool = rule.tool;
              return clean;
            });
          try {
            setSaving(true);
            await saveField(form, 'commands', {
              default: defaultAction,
              escalation: escalateAuto ? 'capability' : 'never',
              baseline: baseline,
              rules: cleanRules,
            }, t);
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var actionOpts = actionOptions(t);
        var defaultOpts = actionOptions(t, true);

        var countText = t('cmds.count', { count: saved.rules.length });
        if (pendingCount > 0) countText += t('cmds.countPending', { count: pendingCount });

        // 注意：必须用 .map（每行回调捕获各自的 rule/index，循环 var 会被共享）。
        var ruleRows = rules.map(function mapRuleRow(rule, ruleIndex) {
          return react.createElement('div', { key: rule.id, className: 'sabx-rule-row' },
            react.createElement('div', { className: 'sabx-rule-tool' },
              react.createElement(ToolPicker, {
                t: t,
                value: rule.tool,
                disabled: saving || locked,
                onSelect: function onTool(value) { setRule(ruleIndex, { tool: value }); },
              }),
            ),
            react.createElement('div', { className: 'sabx-rule-pattern' },
              react.createElement('input', {
                className: 'sabx-input sabx-mono',
                type: 'text',
                spellCheck: false,
                placeholder: t('cmds.patternPlaceholder'),
                'aria-label': t('cmds.patternAria'),
                value: rule.pattern || '',
                disabled: saving || locked,
                onChange: function onPattern(event) { setRule(ruleIndex, { pattern: event.target.value }); },
              }),
            ),
            react.createElement('div', { className: 'sabx-rule-action' },
              createSeg(actionOpts, rule.action, function onAction(value) { setRule(ruleIndex, { action: value }); }, t('cmds.actionAria'), true),
            ),
            react.createElement('button', {
              className: 'sabx-icon-btn sabx-rule-remove',
              type: 'button',
              'aria-label': t('cmds.removeAria'),
              title: t('cmds.removeTitle'),
              disabled: saving || locked,
              onClick: function onRemove() { removeRule(ruleIndex); },
            }, createXIcon()),
          );
        });

        function createCheckField(key, option) {
          return react.createElement('div', { key: key, className: 'sabx-advanced-item' },
            react.createElement('label', { className: 'sabx-check' },
              react.createElement('input', {
                type: 'checkbox',
                checked: baseline,
                disabled: saving || locked,
                onChange: function onToggle(event) {
                  setBaseline(event.target.checked);
                },
              }),
              react.createElement('span', null, option.label),
            ),
            react.createElement('p', { className: 'sabx-field-hint' }, option.hint),
          );
        }

        var bodyChildren = [
          react.createElement('div', { key: 'field-default', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, t('cmds.defaultLabel')),
              react.createElement('button', {
                className: 'sabx-field-reset',
                type: 'button',
                disabled: saving || locked || !overridden,
                title: overridden ? t('common.resetOverrideTitle') : t('common.resetNotOverrideTitle'),
                onClick: function onReset() { void resetDefault(); },
              }, t('dirs.reset')),
            ),
            react.createElement('p', { className: 'sabx-field-hint' }, t(COMMANDS_DEFAULT_HINT_KEY)),
            createSeg(defaultOpts, defaultAction, setDefaultAction, t('cmds.defaultAria'), false),
          ),
          react.createElement('div', { key: 'field-rules', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, t('cmds.rulesLabel')),
            ),
            react.createElement('p', { className: 'sabx-field-hint', dangerouslySetInnerHTML: { __html: t(COMMANDS_HINT_KEY) } }),
            react.createElement('div', { className: 'sabx-rules-table' }, ruleRows.length > 0 ? ruleRows : [
              react.createElement('div', { key: 'empty', className: 'sabx-empty' }, t('cmds.empty')),
            ]),
            react.createElement('button', { className: 'sabx-add-row', type: 'button', disabled: saving || locked, onClick: addRule },
              react.createElement('span', { 'aria-hidden': true }, '＋'), ' ' + t('cmds.add')),
            react.createElement('p', { className: 'sabx-dir-hint-inline', style: { marginTop: 4 } }, t(COMMANDS_TAIL_HINT_KEY)),
          ),
          react.createElement('div', { key: 'field-escalation', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, t('cmds.escalationLabel')),
            ),
            react.createElement('label', { className: 'sabx-check' },
              react.createElement('input', {
                type: 'checkbox',
                checked: escalateAuto,
                disabled: saving || locked,
                onChange: function onEscalate(event) { setEscalateAuto(event.target.checked); },
              }),
              react.createElement('span', null, t('cmds.escalationCheck')),
            ),
            react.createElement('p', { className: 'sabx-field-hint' }, t(COMMANDS_ESCALATION_HINT_KEY)),
          ),
          react.createElement('details', { key: 'field-advanced', className: 'sabx-advanced' },
            react.createElement('summary', null, t('cmds.advanced')),
            baselineOptions(t).map(function mapAdvanced(option) {
              return createCheckField(option.key, option);
            }),
          ),
          react.createElement('div', { key: 'footer', className: 'sabx-card-footer' },
            error === null
              ? null
              : react.createElement('p', { className: 'sabx-card-error', role: 'alert' }, error),
            react.createElement('button', { className: 'sabx-btn sabx-btn-ghost', type: 'button', disabled: saving || pendingCount === 0, onClick: restoreSaved }, t('common.discard')),
            react.createElement('button', { className: 'sabx-btn sabx-btn-primary', type: 'button', disabled: saving || locked, onClick: function onSave() { void save(); } },
              saving ? t('common.saving') : t('cmds.save')),
          ),
        ];

        return createCard({
          id: 'sabx-card-cmds',
          name: t('cmds.name'),
          count: countText,
          desc: t('cmds.desc'),
          pendingCount: pendingCount,
          open: open,
          onToggle: function onToggle() { setOpen(!open); },
          t: t,
        }, bodyChildren);
      };
    }

    /**
     * 构建「命令规则」可视化编辑器（与授权目录编辑器并列）。保留原导出名，
     * 返回独立卡片组件。
     * @param form - ctx.configForms.get(SETTINGS_ENTRY_ID) 返回的表单 controller。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeCommandRulesEditor(form, t) {
      return makeCommandsCard(form, t);
    }

    /* ============================================================================
     * 卡片 C：禁读规则
     * ========================================================================== */

    /**
     * 构建「禁读规则」卡片（pattern 输入 + 紧凑 deny/ask 分段 + 删除/添加/保存/放弃）。
     * 动作刻意只有 deny / ask：官方默认本就允许读，allow 与默认行为无异，故不提供。
     * @param form - ctx.configForms.get(SETTINGS_ENTRY_ID) 返回的表单 controller。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeNoReadCard(form, t) {
      return function NoReadCard() {
        var rulesState = react.useState([]);
        var rules = rulesState[0];
        var setRules = rulesState[1];
        var openState = react.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        // 行标识发生器与草稿保护标记（语义同授权目录卡片）。
        var nextIdRef = react.useRef(1);
        var dirtyRef = react.useRef(false);

        react.useEffect(function syncFromForm() {
          var update = function updateRules() {
            try {
              if (dirtyRef.current) return; // 有未保存草稿，不覆盖
              setRules(currentNoRead(form).map(function toRow(rule) {
                var row = {};
                for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) row[key] = rule[key]; }
                row.id = nextIdRef.current++;
                return row;
              }));
            } catch (_ignored) {
              // a stale form must never break the section render
            }
          };
          update();
          return subscribeForm(form, update);
        }, []);

        var locked = !isWritable(form);
        var overridden = fieldOverridden(form, 'noRead');
        var saved = currentNoRead(form);
        var pendingCount = noReadDirtyCount(rules, saved);

        function setRule(index, patch) {
          setError(null);
          dirtyRef.current = true;
          setRules(function mapRules(previous) {
            return previous.map(function mapOne(rule, i) {
              if (i !== index) return rule;
              var next = {};
              for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) next[key] = rule[key]; }
              for (var pkey in patch) { if (Object.prototype.hasOwnProperty.call(patch, pkey)) next[pkey] = patch[pkey]; }
              return next;
            });
          });
        }

        function addRule() {
          setError(null);
          dirtyRef.current = true;
          setRules(function append(previous) {
            return previous.concat([{ id: nextIdRef.current++, pattern: '', action: 'deny' }]);
          });
        }

        function removeRule(index) {
          setError(null);
          dirtyRef.current = true;
          setRules(function drop(previous) {
            return previous.filter(function keep(rule, i) { return i !== index; });
          });
        }

        function restoreSaved() {
          setRules(currentNoRead(form).map(function toRow(rule) {
            var row = {};
            for (var key in rule) { if (Object.prototype.hasOwnProperty.call(rule, key)) row[key] = rule[key]; }
            row.id = nextIdRef.current++;
            return row;
          }));
          setError(null);
          dirtyRef.current = false;
        }

        /** 清除用户层覆盖，回到组合（部署）默认值。 */
        var resetDefault = async function resetDefault() {
          setError(null);
          try {
            setSaving(true);
            await resetField(form, 'noRead', t);
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var save = async function save() {
          setError(null);
          // 空 pattern 的行不保存；action 归一为 deny/ask（服务端 schema 同样拒绝 allow）。
          var cleanRules = rules
            .filter(function hasPattern(rule) {
              return rule && rule.pattern && String(rule.pattern).trim().length > 0;
            })
            .map(function buildClean(rule) {
              return {
                pattern: String(rule.pattern).trim(),
                action: rule.action === 'ask' ? 'ask' : 'deny',
              };
            });
          try {
            setSaving(true);
            await saveField(form, 'noRead', cleanRules, t);
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var countText = t('noread.count', { count: saved.length });
        if (pendingCount > 0) countText += t('noread.countPending', { count: pendingCount });

        // 注意：必须用 .map（每行回调捕获各自的 rule/index，循环 var 会被共享）。
        var ruleRows = rules.map(function mapNoReadRow(rule, ruleIndex) {
          return react.createElement('div', { key: rule.id, className: 'sabx-rule-row sabx-noread-row' },
            react.createElement('div', { className: 'sabx-rule-pattern' },
              react.createElement('input', {
                className: 'sabx-input sabx-mono',
                type: 'text',
                spellCheck: false,
                placeholder: t('noread.patternPlaceholder'),
                'aria-label': t('noread.patternAria'),
                value: rule.pattern,
                disabled: saving || locked,
                onChange: function onPattern(event) { setRule(ruleIndex, { pattern: event.target.value }); },
              }),
            ),
            react.createElement('div', { className: 'sabx-rule-action' },
              createSeg(NOREAD_ACTIONS, rule.action, function onAction(value) { setRule(ruleIndex, { action: value }); }, t('noread.actionAria'), true),
            ),
            react.createElement('button', {
              className: 'sabx-icon-btn sabx-rule-remove',
              type: 'button',
              'aria-label': t('noread.removeAria'),
              title: t('noread.removeTitle'),
              disabled: saving || locked,
              onClick: function onRemove() { removeRule(ruleIndex); },
            }, createXIcon()),
          );
        });

        var bodyChildren = [
          react.createElement('div', { key: 'field-rules', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, t('noread.fieldLabel')),
              react.createElement('button', {
                className: 'sabx-field-reset',
                type: 'button',
                disabled: saving || locked || !overridden,
                title: overridden ? t('common.resetOverrideTitle') : t('common.resetNotOverrideTitle'),
                onClick: function onReset() { void resetDefault(); },
              }, t('dirs.reset')),
            ),
            react.createElement('p', { className: 'sabx-field-hint', dangerouslySetInnerHTML: { __html: t(NOREAD_HINT_KEY) } }),
            react.createElement('div', { className: 'sabx-rules-table' }, ruleRows.length > 0 ? ruleRows : [
              react.createElement('div', { key: 'empty', className: 'sabx-empty' }, t('noread.empty')),
            ]),
            react.createElement('button', { className: 'sabx-add-row', type: 'button', disabled: saving || locked, onClick: addRule },
              react.createElement('span', { 'aria-hidden': true }, '＋'), ' ' + t('noread.add')),
            react.createElement('p', { className: 'sabx-dir-hint-inline', style: { marginTop: 4 } }, t(NOREAD_TAIL_HINT_KEY)),
          ),
          react.createElement('div', { key: 'footer', className: 'sabx-card-footer' },
            error === null
              ? null
              : react.createElement('p', { className: 'sabx-card-error', role: 'alert' }, error),
            react.createElement('button', { className: 'sabx-btn sabx-btn-ghost', type: 'button', disabled: saving || pendingCount === 0, onClick: restoreSaved }, t('common.discard')),
            react.createElement('button', { className: 'sabx-btn sabx-btn-primary', type: 'button', disabled: saving || locked, onClick: function onSave() { void save(); } },
              saving ? t('common.saving') : t('noread.save')),
          ),
        ];

        return createCard({
          id: 'sabx-card-noread',
          name: t('noread.name'),
          count: countText,
          desc: t('noread.desc'),
          pendingCount: pendingCount,
          open: open,
          onToggle: function onToggle() { setOpen(!open); },
          t: t,
        }, bodyChildren);
      };
    }

    /* ============================================================================
     * 分节组件
     * ========================================================================== */

    /**
     * 构建「沙箱授权」分节组件（闭包式，直接订阅配置表单 controller，不依赖
     * slots 的 props 转换契约，任何情况下都不会因 props 缺失而崩溃）。
     * 包含「授权目录」「命令规则」「禁读规则」三张可折叠卡片。
     * @param form - ctx.configForms.get(SETTINGS_ENTRY_ID) 返回的表单 controller（可为 null）。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeAllowlistSection(form, t) {
      var DirsCard = makeDirsCard(form, t);
      var CommandsCard = makeCommandsCard(form, t);
      var NoReadCard = makeNoReadCard(form, t);
      return function AllowlistSection() {
        var reason = readOnlyReason(form, t);
        return react.createElement('section', { className: 'sabx-section', 'aria-labelledby': 'sabx-section-title' },
          react.createElement('h2', { className: 'sabx-section-heading', id: 'sabx-section-title' }, t('section.title')),
          react.createElement('p', { className: 'sabx-section-intro' },
            t('section.intro'),
          ),
          reason === null
            ? null
            : react.createElement('div', { className: 'sabx-callout-note', role: 'status' }, reason),
          react.createElement(DirsCard, null),
          react.createElement(CommandsCard, null),
          react.createElement(NoReadCard, null),
        );
      };
    }

    /* ============================================================================
     * 插件面板扩展点（provider 行的平台提示）
     * ========================================================================== */

    /**
     * provider 行详情页标题旁的徽标。client 半件运行在浏览器侧拿不到宿主平台，
     * 文案用中性表述——具体平台行为由说明页与 provider.mjs 的宿主日志交代。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeProviderPlatformBadge(t) {
      return function ProviderPlatformBadge(props) {
        var subject = props && props.subject;
        if (!subject || subject.kind !== 'row' || !subject.row || subject.row.rowId !== PROVIDER_ROW_ID) return null;
        return react.createElement('span', { className: 'sabx-badge' }, t('provider.badge'));
      };
    }

    /**
     * provider 行说明页（行详情页经 row.config 槽位打开）：用一段人话交代平台
     * 边界，代替异常或沉默。Windows 上本行启用时宿主侧自动空转并记一次性日志
     * （见 lib/provider.mjs 的 InertProvider），界面可见的提示就在这里。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeProviderPlatformNotice(t) {
      return function ProviderPlatformNotice(props) {
        if (props && props.view === 'summary') {
          return t('provider.summary');
        }
        return react.createElement('div', { className: 'sabx-callout-note', role: 'note' },
          t('provider.notice'),
        );
      };
    }

    /* ============================================================================
     * 会话区授权状态面板（utilities 槽位弹层）。
     * 数据通道 = 自建 host 路由 + 统一信封（dsh-jenkins 实证路径）：POST
     * /sandbox-allowlist/api/<method>，信封 { ok, value } | { ok, error }，
     * 同源 fetch 认证桥自动携带凭据。不使用 connection.rpc（官方 wire 域
     * 不稳，真机实证 endpoint 实参形状不可依赖）。connection 不可达无妨。
     * ========================================================================== */
    var STATE_API = '/sandbox-allowlist/api';

    /**
     * 入口探测：状态路由可达 ⇒ 平台有账可查（win32），会话入口才注册。
     * host 半件在非 win32 不注册路由，因此「路由存在」本身就是平台信号。
     * 带重试（约 12s 窗口）：页面先刷新、插件后重载的版本差窗口里路由短暂
     * 404，重试让入口在服务端半件就绪后自动出现，而不是把入口掐死。
     */
    function probeStateSupported() {
      var ATTEMPT_TIMEOUT = 3000;
      var ATTEMPT_GAP = 1200;
      var DEADLINE = 12000;
      var started = Date.now();
      return new Promise(function (resolve) {
        var settled = false;
        var timer = null;
        function finish(value) {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          resolve(value);
        }
        function attempt(controller) {
          fetch(STATE_API + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal })
            .then(async function (response) {
              if (!response.ok) throw new Error('HTTP ' + response.status);
              var envelope = await response.json();
              finish(envelope && envelope.ok === true && envelope.value && typeof envelope.value === 'object');
            })
            .catch(function () {
              if (settled) return;
              if (Date.now() - started >= DEADLINE) { finish(false); return; }
              timer = setTimeout(function retry() { attempt(new AbortController()); }, ATTEMPT_GAP);
            });
        }
        attempt(new AbortController());
      });
    }

    /** 统一调用：POST 自建路由，解包 { ok, value } 信封；HTTP/网络错误入信封语义。 */
    async function postStateAction(method, payload) {
      var response = await fetch(STATE_API + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      var envelope = null;
      try {
        envelope = await response.json();
      } catch (error) {
        throw new Error('HTTP ' + response.status + '（非 JSON 响应）');
      }
      if (!response.ok || !envelope || envelope.ok !== true) {
        var reason = envelope && envelope.error ? (envelope.error.message || envelope.error.code) : ('HTTP ' + response.status);
        throw new Error(String(reason));
      }
      return envelope.value;
    }

    /** 三段记录 → 面板表格行（kind: granted | failed | pending | revoked）。 */
    function stateRowsOf(view, t) {
      var rows = [];
      if (!view) return rows;
      var roots = Array.isArray(view.roots) ? view.roots : [];
      var pending = Array.isArray(view.pendingRevoke) ? view.pendingRevoke : [];
      var history = Array.isArray(view.history) ? view.history : [];
      for (var i = 0; i < roots.length; i += 1) {
        var entry = roots[i] || {};
        var failed = entry.status === 'failed';
        rows.push({
          key: 'root:' + entry.path,
          path: entry.path,
          kind: entry.excluded ? 'pending' : (failed ? 'failed' : 'granted'),
          time: failed ? (entry.errorAt || entry.grantedAt) : entry.grantedAt,
          // 失败原因直接进列（失败行 = error 原文；待回收行也带 error）。
          reason: failed ? String(entry.error || '') : (entry.excluded ? t('status.dotPending') : ''),
          source: (entry.fromPatterns || []).join('  '),
        });
      }
      for (var p = 0; p < pending.length; p += 1) {
        var item = pending[p] || {};
        rows.push({
          key: 'pending:' + item.path,
          path: item.path,
          kind: 'pending',
          time: item.lastAttemptAt,
          reason: String(item.error || ''),
          source: (item.fromPatterns || []).join('  '),
        });
      }
      for (var h = 0; h < history.length; h += 1) {
        var audit = history[h] || {};
        rows.push({
          key: 'history:' + audit.path + ':' + h,
          path: audit.path,
          kind: 'revoked',
          time: audit.revokedAt,
          reason: '',
          source: (audit.fromPatterns || []).join('  '),
        });
      }
      return rows;
    }

    var STATE_KINDS = ['granted', 'failed', 'pending', 'revoked'];

    // 操作 busy 层的最短展示时长：亚秒完成的操作也要让加载反馈可感知
    //（一闪而过 ≈ 没点上）。
    var BUSY_MIN_MS = 700;

    /** 宽松路径同判（分隔符方向与大小写不敏感）：仅用于确认 host 返回的
     * current 是否真的解析到了本会话 cwd——host 端 realpath 后盘符/分隔符形态
     * 可能与客户端拿到的 cwd 字符串不同。 */
    function samePath(actual, expected) {
      if (typeof actual !== 'string' || actual === '' || typeof expected !== 'string' || expected === '') return false;
      return actual.replace(/[\\/]+/g, '/').toLowerCase() === expected.replace(/[\\/]+/g, '/').toLowerCase();
    }

    /** ISO(UTC) 时间串 → 本地时区 `YYYY-MM-DD HH:MM:SS`。清单存储保持 UTC ISO
     * （跨时区可移植、可排序），只有展示做转换：本地 getter 自动跟随机器时区，
     * 任何地区的用户看到的都是自己的墙钟时间。 */
    function localTimeText(value) {
      var date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      var pad = function pad(n) { return String(n).padStart(2, '0'); };
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /**
     * 面板组件工厂（闭包式 hooks 组件，语义同设置卡片：不依赖 slots 的 props
     * 转换契约）。打开时拉一次视图 + 手动刷新按钮，不建推送。
     * @param props - 槽位 props（按宿主契约 standardProps 读取：sessionId +
     *   useSessions 快照钩子，会话 cwd 只能经钩子读取，供 host 把「当前工作区」
     *   解析到激活会话。面板只看会话工作区：cwd 未命中清单键时选中空 + 空态，
     *   绝不回退到实例根/最近使用键；工作区控件保留下拉形态但禁切换）。
     *   撤销/恢复走面板内确认弹层（原生 window.confirm 在本宿主关闭后吞焦点）；
     *   操作期间显示带最短时长的 busy 层。
     * @param t - 词典翻译函数（ctx.locale.bind(LOCALE_NS)）。
     */
    function makeStatePanel(t) {
      return function StatePanel(props) {
        var openState = react.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var dataState = react.useState({ loading: false, error: null, view: null });
        var data = dataState[0];
        var setData = dataState[1];
        var filterState = react.useState('all');
        var filter = filterState[0];
        var setFilter = filterState[1];
        var busyState = react.useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];
        // 当前查看的工作区 = 会话工作区（host 在 sessionCwd 命中清单键时返回
        // 它）；未命中/无线索时恒为 ''——绝不回退到实例根/最近使用键。面板只看
        // 当前会话的授权，串显别的工作区的记录只会误导。
        var wsState = react.useState('');
        var ws = wsState[0];
        var setWs = wsState[1];
        // 撤销/恢复确认弹层（DOM 内模态）：原生 window.confirm 在本宿主
        //（Electron）关闭后不恢复输入焦点，会话输入框会因此点不进去
        //（electron#31917），绝不使用；in-place 按钮变形的误触率又高，故为弹层。
        var confirmState = react.useState(null);
        var confirm = confirmState[0];
        var setConfirm = confirmState[1];

        // 会话线索（宿主契约 standardProps）：条目收到 sessionId 与 useSessions
        // 快照钩子，cwd 只能经钩子读取（官方 open-in-app 条目同款读法）。
        // sessionId 是标识符不是路径，绝不能塞进 sessionCwd——host 会把它规范化
        // 成无效路径，current 永远回落实例工作区根。钩子存在性由宿主按槽位契约
        // 恒定提供（同一挂载期内不变），条件调用不会打乱 hooks 顺序。
        var propsAny = props || {};
        var sessionId = typeof propsAny.sessionId === 'string' ? propsAny.sessionId : '';
        var useSessions = typeof propsAny.useSessions === 'function' ? propsAny.useSessions : null;
        var sessionCwd = useSessions !== null
          ? useSessions(function selectSessionCwd(state) {
              var record = state && typeof state === 'object' && state.byId ? state.byId[sessionId] : null;
              return record && typeof record.cwd === 'string' ? record.cwd : '';
            })
          : '';

        // 采纳工作区选中项：仅当会话 cwd 确实命中清单键（host 的 current 经
        // loose 同判确认）时选中它，否则置空——数据区走「当前工作区暂无授权
        // 记录」空态，绝不默认选中别的工作区。
        var adoptWorkspaces = function adoptWorkspaces(view, sessionMatched) {
          var pool = view && view.workspaces ? view.workspaces : {};
          var current = view ? view.current : null;
          setWs(sessionMatched && typeof current === 'string' && Object.prototype.hasOwnProperty.call(pool, current) ? current : '');
        };
        var load = async function load() {
          setData({ loading: true, error: null, view: data.view });
          try {
            var sentCwd = sessionCwd !== '';
            var view = await postStateAction('state', sentCwd ? { sessionCwd: sessionCwd } : {});
            setData({ loading: false, error: null, view: view });
            adoptWorkspaces(view, sentCwd && samePath(view && view.current, sessionCwd));
            setConfirm(null);
          } catch (error) {
            setData({ loading: false, error: t('status.error', { message: String(error && error.message ? error.message : error) }), view: null });
          }
        };
        var openPanel = function openPanel() {
          setOpen(true);
          void load();
        };
        // 操作 busy 层的最短展示封装：act 与手动刷新共用，让亚秒完成的操作也有
        // 可感知的加载反馈（一闪而过 ≈ 没点上）。
        var withBusy = async function withBusy(job) {
          setBusy(true);
          var startedAt = Date.now();
          try {
            await job();
          } finally {
            var wait = Math.max(0, BUSY_MIN_MS - (Date.now() - startedAt));
            if (wait > 0) setTimeout(function () { setBusy(false); }, wait);
            else setBusy(false);
          }
        };
        var act = function act(method, payload) {
          return withBusy(async function () {
            try {
              var view = await postStateAction(method, payload);
              setData({ loading: false, error: null, view: view });
            } catch (error) {
              setData({ loading: false, error: t('status.actionFailed', { message: String(error && error.message ? error.message : error) }), view: data.view });
            }
          });
        };
        // 手动刷新与操作共用 busy 层（打开面板的首次载入仍走按钮内联的载入中态，
        // 不弹遮罩）。
        var refresh = function refresh() {
          return withBusy(load);
        };
        var closePanel = function closePanel() {
          setOpen(false);
          setConfirm(null);
        };

        // 悬停提示（自绘气泡，body 级单例 DOM）：本宿主的裁剪容器与层叠上下文
        // 会吞掉面板内 fixed 元素（官方 Tooltip 为此自带 portal 逃生门），单例
        // 直挂 body 彻底免疫；事件走 ref 上的原生监听，不依赖 React 合成
        // mouseover（合成 click 一直可用，但悬浮链路在真机从未生效）。气泡
        // 样式走 .sabx-tip（与面板模态同观感），display 由 JS 直接开关。
        var rootRef = react.useRef(null);
        react.useEffect(function () {
          var root = rootRef.current;
          if (root === null || typeof document === 'undefined' || !document.body) return;
          var box = document.getElementById('sabx-tip');
          var created = box === null;
          if (created) {
            box = document.createElement('div');
            box.id = 'sabx-tip';
            box.className = 'sabx-tip';
            box.setAttribute('role', 'tooltip');
            document.body.appendChild(box);
          }
          var hide = function hide() { box.style.display = 'none'; };
          var show = function show(anchor) {
            var text = anchor.getAttribute('data-tip');
            if (!text) { hide(); return; }
            var rect = anchor.getBoundingClientRect();
            var viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200;
            box.textContent = text;
            box.style.display = 'block'; // 先显示才能实测宽度（display:none 时量宽为 0）
            // 实测气泡宽度后按真实半宽钳制：短文案贴着锚点正下方居中——此前用
            // 最大宽一半做保守预算，右上角的按钮会被硬生生向左推开、气泡不再
            // 对准按钮；长文案（失败原因全文）贴视口边缘时才收进来（12px 边距）。
            var half = Math.min(box.offsetWidth / 2 + 12, viewportWidth / 2);
            var left = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, viewportWidth - half));
            box.style.left = left + 'px';
            box.style.top = rect.bottom + 8 + 'px';
          };
          var onOver = function onOver(event) {
            var target = event.target;
            var anchor = target instanceof Element && typeof target.closest === 'function' ? target.closest('[data-tip]') : null;
            if (anchor === null) hide();
            else show(anchor);
          };
          root.addEventListener('mouseover', onOver);
          root.addEventListener('mouseout', hide);
          // 任何点击都收起气泡：点击打开确认层/busy 层/关闭面板时，滞留的气泡
          // 会浮在这些层之上。
          root.addEventListener('click', hide, true);
          return function () {
            root.removeEventListener('mouseover', onOver);
            root.removeEventListener('mouseout', hide);
            root.removeEventListener('click', hide, true);
            if (created && box !== null && box.parentNode !== null) box.parentNode.removeChild(box);
          };
        }, []);

        // 视图 → 当前工作区切片：只认会话工作区（ws 未命中清单键即空态），
        // 绝不回退到实例根/最近使用键。
        var view = open ? data.view : null;
        var workspaces = view && view.workspaces && typeof view.workspaces === 'object' ? view.workspaces : {};
        var activeWs = ws !== '' && Object.prototype.hasOwnProperty.call(workspaces, ws) ? ws : '';
        var slice = activeWs !== '' ? workspaces[activeWs] : null;

        var rows = slice ? stateRowsOf(slice, t) : [];
        var filtered = rows.filter(function byFilter(row) { return filter === 'all' || row.kind === filter; });
        var kindMeta = {
          granted: { label: t('status.stateGranted'), dot: 'sabx-dot-allow', title: t('status.dotGranted') },
          failed: { label: t('status.stateFailed'), dot: 'sabx-dot-deny', title: t('status.dotFailed') },
          pending: { label: t('status.statePending'), dot: 'sabx-dot-ask', title: t('status.dotPending') },
          revoked: { label: t('status.stateRevoked'), dot: 'sabx-dot-revoked', title: t('status.dotRevoked') },
        };
        var filters = [{ key: 'all', label: t('status.filterAll') }].concat(STATE_KINDS.map(function (kind) {
          return { key: kind, label: kindMeta[kind].label };
        }));


        var rowNodes = filtered.map(function renderRow(row) {
          var meta = kindMeta[row.kind];
          var timeText = row.time ? localTimeText(row.time) : t('status.none');
          var payload = { path: row.path, workspace: activeWs };
          var action = null;
          if (row.kind === 'granted') {
            // 撤销是真实的 OS 状态变更：先弹确认层写明后果，确认后才发起。
            action = react.createElement('button', {
              key: 'act', className: 'sabx-panel-filter', type: 'button', disabled: busy,
              'aria-label': t('status.actionRevokeAria'), 'data-tip': t('status.actionRevokeAria'),
              onClick: function onRevoke() { setConfirm({ kind: 'revoke', payload: payload }); },
            }, t('status.actionRevoke'));
          } else if (row.kind === 'revoked') {
            action = react.createElement('button', {
              key: 'act', className: 'sabx-panel-filter', type: 'button', disabled: busy,
              'aria-label': t('status.actionRestoreAria'), 'data-tip': t('status.actionRestoreAria'),
              onClick: function onRestore() { setConfirm({ kind: 'restore', payload: payload }); },
            }, t('status.actionRestore'));
          } else if (row.kind === 'failed') {
            // 手动重试物化（自动重试每次解析都会做；修复目录 ACL 后可立即重试）。
            action = react.createElement('button', {
              key: 'act', className: 'sabx-panel-filter', type: 'button', disabled: busy,
              'aria-label': t('status.actionGrantAria'), 'data-tip': t('status.actionGrantAria'),
              onClick: function onGrant() { void act('grant', payload); },
            }, t('status.actionGrant'));
          }
          // 待回收行操作列为空：重试语义在表格下方的固定脚注说明。
          return react.createElement('tr', { key: row.key },
            react.createElement('td', { className: 'sabx-panel-cellpath', 'data-tip': row.path }, row.path),
            react.createElement('td', null,
              react.createElement('span', { className: 'sabx-panel-status', 'data-tip': meta.title },
                react.createElement('span', { className: 'sabx-dot ' + meta.dot, 'aria-hidden': true }),
                meta.label)),
            react.createElement('td', { className: 'sabx-panel-time' }, timeText),
            react.createElement('td', { className: 'sabx-panel-reason', 'data-tip': row.reason || undefined }, row.reason || t('status.none')),
            react.createElement('td', { className: 'sabx-panel-dim', 'data-tip': row.source || undefined }, row.source || t('status.none')),
            react.createElement('td', null, react.createElement('span', { className: 'sabx-panel-actions' }, action)),
          );
        });
        var headerLabels = [
          t('status.colPath'), t('status.colStatus'), t('status.colTime'), t('status.colReason'),
          t('status.colSource'), t('status.colAction'),
        ];

        if (!open) {
          return react.createElement('span', { ref: rootRef, className: 'sabx-panel-root' },
            react.createElement('button', {
              className: 'sabx-panel-btn', type: 'button',
              'aria-label': t('status.panelAria'), 'data-tip': t('status.panelAria'),
              onClick: openPanel,
            },
              react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
                react.createElement('path', {
                  d: 'M8 1.5l5.5 2v4c0 3.2-2.3 5.9-5.5 7-3.2-1.1-5.5-3.8-5.5-7v-4l5.5-2z',
                  fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linejoin': 'round',
                }),
                react.createElement('path', { d: 'M5.6 8l1.7 1.7 3.2-3.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
              )),
          );
        }
        // 居中模态（对齐官方「反馈」弹窗）：遮罩 flex 居中；标题/过滤胶囊在滚动
        // 容器外天然固定；表头在滚动容器内 sticky 吸顶；只有数据区滚动。横向滚动
        // 时首列（路径）与末列（操作）吸附。悬停提示为 body 级自绘气泡单例
        //（rootRef effect：原生监听 + body 门户，见组件头部注释）。
        return react.createElement('span', { ref: rootRef, className: 'sabx-panel-root' },
          react.createElement('button', {
            className: 'sabx-panel-btn', type: 'button',
            'aria-label': t('status.panelAria'), 'data-tip': t('status.panelAria'),
            onClick: function onClose() { closePanel(); },
          },
            react.createElement('svg', { viewBox: '0 0 16 16', 'aria-hidden': true },
              react.createElement('path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }))),
          react.createElement('div', { className: 'sabx-panel-overlay', onClick: function onOverlay() { closePanel(); } },
            react.createElement('div', {
              className: 'sabx-panel', role: 'dialog', 'aria-label': t('status.panelTitle'),
              onClick: function onPanelClick(event) { event.stopPropagation(); },
            },
              react.createElement('div', { className: 'sabx-panel-head' },
                react.createElement('span', { className: 'sabx-panel-title' }, t('status.panelTitle')),
                react.createElement('button', {
                  className: 'sabx-panel-filter', type: 'button', disabled: data.loading || busy,
                  'aria-label': t('status.refreshAria'), 'data-tip': t('status.refreshAria'),
                  onClick: function onRefresh() { void refresh(); },
                }, data.loading ? t('status.loading') : t('status.refresh')),
                react.createElement('button', {
                  className: 'sabx-panel-filter', type: 'button',
                  'aria-label': t('status.close'), 'data-tip': t('status.close'),
                  onClick: function onPanelClose() { closePanel(); },
                }, t('status.close'))),
              react.createElement('div', { className: 'sabx-panel-ws' },
              react.createElement('span', { className: 'sabx-panel-ws-label' }, t('status.wsLabel')),
              react.createElement('div', { className: 'sabx-panel-ws-picker', 'data-tip': activeWs || sessionCwd || t('status.none') },
                react.createElement('button', {
                  className: 'sabx-panel-ws-trigger', type: 'button', disabled: true,
                },
                  react.createElement('span', { className: 'sabx-panel-ws-value' }, activeWs || sessionCwd || t('status.none')),
                  react.createElement('svg', { className: 'sabx-panel-ws-chevron', viewBox: '0 0 12 12', 'aria-hidden': true },
                    react.createElement('path', { d: 'M3 4.5l3 3 3-3', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))))),
              react.createElement('div', { className: 'sabx-panel-filters' },
                filters.map(function renderFilter(entry) {
                  return react.createElement('button', {
                    key: entry.key, className: 'sabx-panel-filter', type: 'button',
                    'data-active': filter === entry.key ? 'true' : 'false',
                    onClick: function onFilter() { setFilter(entry.key); setConfirm(null); },
                  }, entry.label);
                })),
              data.error !== null ? react.createElement('p', { className: 'sabx-panel-error', role: 'alert' }, data.error) : null,
              react.createElement('div', { className: 'sabx-panel-scroll' },
                react.createElement('table', { className: 'sabx-panel-table' },
                  react.createElement('colgroup', null,
                    react.createElement('col', { key: 'c1', style: { width: '24%' } }),
                    react.createElement('col', { key: 'c2', style: { width: '96px' } }),
                    react.createElement('col', { key: 'c3', style: { width: '148px' } }),
                    react.createElement('col', { key: 'c4', style: { width: '26%' } }),
                    react.createElement('col', { key: 'c5', style: { width: '16%' } }),
                    react.createElement('col', { key: 'c6', style: { width: '80px' } })),
                  react.createElement('thead', null,
                    react.createElement('tr', null, headerLabels.map(function (label) {
                      return react.createElement('th', { key: label, scope: 'col' }, label);
                    }))),
                  react.createElement('tbody', null,
                    filtered.length === 0
                      ? [react.createElement('tr', { key: 'empty' },
                          react.createElement('td', { colSpan: 6 },
                            react.createElement('div', { className: 'sabx-empty' }, data.view === null ? t('status.loading') : t('status.empty'))))]
                      : rowNodes))),
              react.createElement('p', { className: 'sabx-panel-footnote' }, t('status.footnote')),
              // 撤销/恢复确认弹层：点遮罩 = 取消；卡片内阻止冒泡避免误关整个面板
              confirm !== null ? react.createElement('div', {
                className: 'sabx-confirm-overlay', role: 'alertdialog',
                'aria-label': confirm.kind === 'revoke' ? t('status.confirmTitleRevoke') : t('status.confirmTitleRestore'),
                onClick: function onConfirmOverlay() { setConfirm(null); },
              },
                react.createElement('div', { className: 'sabx-confirm', onClick: function onConfirmCard(event) { event.stopPropagation(); } },
                  react.createElement('div', { className: 'sabx-confirm-title' }, confirm.kind === 'revoke' ? t('status.confirmTitleRevoke') : t('status.confirmTitleRestore')),
                  react.createElement('p', { className: 'sabx-confirm-text' }, confirm.kind === 'revoke' ? t('status.confirmRevoke') : t('status.confirmRestore')),
                  react.createElement('div', { className: 'sabx-confirm-actions' },
                    react.createElement('button', {
                      className: 'sabx-panel-filter', type: 'button', disabled: busy,
                      onClick: function onConfirmOk() { var pending = confirm; setConfirm(null); void act(pending.kind, pending.payload); },
                    }, t('status.confirmOk')),
                    react.createElement('button', {
                      className: 'sabx-panel-filter', type: 'button', disabled: busy,
                      onClick: function onConfirmCancel() { setConfirm(null); },
                    }, t('status.actionCancel'))))) : null,
              // 操作 busy 层：最短展示 BUSY_MIN_MS，重试授权这类亚秒操作也有可感知的反馈
              busy ? react.createElement('div', { className: 'sabx-busy-overlay', role: 'status' },
                react.createElement('div', { className: 'sabx-busy' },
                  react.createElement('span', { className: 'sabx-busy-spin', 'aria-hidden': true }),
                  t('status.busy'))) : null)),
        );
      };
    }

    /** 客户端插件入口：注册设置页分节、插件面板配置界面，并取本插件条目的配置表单。
     * 词典注册先于分节注册：宿主按当前语言渲染，回退链末端永远是 en。 */
    function apply(ctx) {
      ctx.effect(function registerDictionaries() {
        return ctx.locale.register(LOCALE_NS, { zh: zh, en: en });
      }, 'sandbox-allowlist: dictionaries');
      // 每个 namespace 一个稳定翻译函数；渲染时读取宿主当前语言。
      var t = ctx.locale.bind(LOCALE_NS);
      var form = null;
      try {
        form = ctx.configForms.get(SETTINGS_ENTRY_ID);
      } catch (error) {
        // 表单不可用（服务缺失 / 条目未挂载）不能阻止分节注册 —— 组件会在无
        // form 时退化为只读空列表。
        form = null;
      }
      var section = makeAllowlistSection(form, t);
      ctx.slots.inject('settings.section', function registerSection() {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'sandbox-allowlist',
          order: 30,
          label: function label() { return t('section.title'); },
        }, section);
      });
      // 插件面板（Plugins 页）的配置界面：同一份三卡片分节挂到插件详情页。
      //   - plugins.bundle.config（key=包名）：包详情页在描述与行列表之间渲染；
      //   - plugins.row.config（key=「包名#行id」）：策略行获得「配置」入口，行详情页
      //     渲染（props.form 与本闭包的 form 是同一份 controller，忽略 props）。
      // 两个槽位由 Plugins 页主注册声明，ctx.slots.inject 会等待声明出现；页面离开
      // 后声明塌缩、注册随之下线，回到页面时随声明自动重挂。summary 视图给一行说明。
      var bundleConfig = function BundleConfig(props) {
        if (props && props.view === 'summary') return t('section.summary');
        return react.createElement(section, null);
      };
      ctx.slots.inject('plugins.bundle.config', function registerBundleConfig() {
        return ctx.slots.register({
          name: 'plugins.bundle.config',
          id: 'sandbox-allowlist-config',
          key: BUNDLE_CONFIG_KEY,
        }, bundleConfig);
      });
      ctx.slots.inject('plugins.row.config', function registerRowConfig() {
        return ctx.slots.register({
          name: 'plugins.row.config',
          id: 'sandbox-allowlist-policy-config',
          key: ROW_CONFIG_KEY,
        }, bundleConfig);
      });
      // provider 行的平台提示：详情页标题旁的「仅 Linux 生效」徽标 + 行说明页。
      // 行页的存在本身由这条 row.config 注册打开（没有配置页的行不生成详情页），
      // 页面里渲染平台边界说明——Windows 上即使启用也只是空转（见 provider.mjs）。
      ctx.slots.inject('plugins.detail.badge', function registerProviderBadge() {
        return ctx.slots.register({
          name: 'plugins.detail.badge',
          id: 'sandbox-allowlist-platform-badge',
        }, makeProviderPlatformBadge(t));
      });
      ctx.slots.inject('plugins.row.config', function registerProviderRowConfig() {
        return ctx.slots.register({
          name: 'plugins.row.config',
          id: 'sandbox-allowlist-provider-config',
          key: PROVIDER_ROW_CONFIG_KEY,
        }, makeProviderPlatformNotice(t));
      });
      // 会话区授权状态面板：conversation.session.header.utilities（list/加性，
      // 官方会话日志下载按钮同款）。入口按平台注册：host 半件仅在 win32 挂状态
      // 路由，client 探测可达才注册槽位——Linux/macOS 会话头部不出现任何入口，
      // 不只是空态。探测失败/超时同样不注册；槽位缺失（老宿主）try/catch 降级
      // no-op，绝不阻塞其余注册或 pending。
      probeStateSupported().then(function onProbe(supported) {
        if (supported !== true) return;
        try {
          ctx.slots.inject('conversation.session.header.utilities', function registerStatePanel() {
            return ctx.slots.register({
              name: 'conversation.session.header.utilities',
              id: 'sandbox-allowlist-panel',
              order: 90,
              label: function label() { return t('status.panelTitle'); },
            }, makeStatePanel(t));
          });
        } catch (error) {
          // 老宿主无该槽位：面板不可用即可，其余功能不受影响（降级 no-op）。
        }
      }).catch(function onProbeError() { /* 探测异常 = 无入口 */ });
    }

    exports.inject = ['slots', 'configForms', 'locale'];
    exports.apply = apply;
    return module.exports;
  },
});