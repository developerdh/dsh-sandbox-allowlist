/**
 * dsh-sandbox-allowlist — 客户端半件（手写 __ModuleLoader__ bundle）。
 *
 * 设置页「沙箱授权」分节（v5，对齐 docs/config-ui-prototype.html v5）：
 *
 *   - 分节 = 标题 + 导语 + 两个可折叠配置卡片（授权目录 / 命令规则），视觉与
 *     交互对齐 dsh 官方插件配置卡片（dsh-client-ui-settings-plugins）的设计语言
 *     —— 全部使用 dsw 运行时令牌（--dsw-alias-* / --dsw-specific-*，带十六进制
 *     fallback），样式由本 bundle 注入一份作用域化 <style>（.sabx-* 前缀）。
 *   - 卡片可折叠：收起态主体真正隐藏（CSS :not(.is-open)），头部计数与
 *     「未保存修改」徽章保留。
 *   - 授权目录卡片：结构化目录行（📁 或新增行的绿色「＋」圆形徽章 + 等宽输入 +
 *     小 ✕ 图标按钮），焦点只高亮输入框本身（行边框不高亮），非法条目标红输入框。
 *   - 命令规则卡片：未命中默认动作分段选择（delegate/allow/ask/deny，
 *     选中项=语义色浅底+语义色文字+粗体+内描边，未选中统一中性色）；
 *     规则行 = 自绘工具下拉（原生 <select> 展开态无法定制，故为自绘菜单：
 *     胶囊触发按钮 + 圆角阴影浮层 + 选中绿色对勾）+ 命令模式输入 + expose
 *     allow/ask/deny 紧凑分段 + 小 ✕ 图标按钮。
 *   - 数据流不变：绑定 `sandbox-allowlist` 设置 namespace（服务端由
 *     lib/policy.mjs 通过 ctx.settings 注册）→ scope.set('allowedDirs', [...]) /
 *     scope.set('commands', {...}) → 写入用户设置文档（$DSH_HOME/settings.yaml）
 *     → 服务端策略实时生效，无需重启。
 *
 * 构建说明：这是运行时实际加载的产物。src/client/index.tsx 是等价 TS 源码
 * 参考，用于在 dsh 开发工具链下重建（tsc + tsdown）。两处必须保持一致。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sandbox-allowlist',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require('react');

    const NAMESPACE = 'sandbox-allowlist';
    const STYLE_ID = 'dsh-sandbox-allowlist-ui';

    /* ============================================================================
     * 作用域化样式（dsw 令牌 + fallback）。结构与 docs/config-ui-prototype.html
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
      '.sabx-rule-pattern{flex:1 1 0;min-width:0;}',
      '.sabx-rule-pattern .sabx-mono{width:100%;}',
      '.sabx-rule-action{flex:0 0 auto;min-width:0;white-space:nowrap;}',
      '.sabx-rule-remove{flex:0 0 22px;}',
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
      '.sabx-callout-warn .sabx-dot{margin-top:6px;flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d9a53f);}',
      /* ---- 卡片页脚 ---- */
      '.sabx-card-footer{border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.11));display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;margin-top:8px;}',
      '.sabx-card-error{min-width:0;color:var(--dsw-alias-state-error-primary,#f85149);flex:1;margin:0;font-size:12px;line-height:1.5;}',
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
     * 文案
     * ========================================================================== */

    /** 卡片 A 里的克制式安全警示 callout（译自 lib/policy.mjs 的 WARNING_COPY）。 */
    const CALL_WARN_DIRS = '安全警示：授权目录会被沙箱内的 AI 代理<b>无审批</b>写入（工作区之外），请勿配置存储重要文件的目录。';
    const DIRS_HINT = '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。';
    const DIRS_VALIDATE_HINT = '校验规则：Windows 路径或通配符；非法条目会在保存前标红提示，不会静默丢弃。';

    const COMMANDS_DEFAULT_HINT = 'delegate 表示维持 dsh 现有行为（按需询问）；allow / ask / deny 会覆盖未命中命令的处理。';
    const COMMANDS_HINT = 'pattern 支持 <code>*</code>（任意多个字符）与 <code>?</code>（单个字符）；<code>git *</code> 忽略 <code>git</code> 后任意参数。allow=免询问（仍受文件沙箱约束）、ask=弹审批、deny=拦截。';
    const COMMANDS_TAIL_HINT = '空 pattern 的行不会保存；工具留空（任意）时规则对所有 shell 工具生效。';

    /** 工具选项（空 = 任意工具；方案 A：标签与值一致，不加“PowerShell”）。
     注：dsh 的 shell 工具只有 bash / pwsh 两个（dsh-tool-bash / dsh-tool-pwsh），
     加了别的值会被服务端 CommandRuleSchema（z.union(SHELL_TOOLS)）校验拒绝。 */
    const TOOL_OPTIONS = [
      { value: '', label: '任意' },
      { value: 'bash', label: 'bash' },
      { value: 'pwsh', label: 'pwsh' },
    ];

    /** 规则动作（分段选择器，带语义色圆点）。 */
    const ACTION_OPTIONS = [
      { value: 'allow', dot: 'sabx-dot-allow' },
      { value: 'ask', dot: 'sabx-dot-ask' },
      { value: 'deny', dot: 'sabx-dot-deny' },
    ];

    /** 未命中规则时的默认动作（delegate 无圆点）。 */
    const DEFAULT_OPTIONS = [
      { value: 'delegate', dot: null },
      { value: 'allow', dot: 'sabx-dot-allow' },
      { value: 'ask', dot: 'sabx-dot-ask' },
      { value: 'deny', dot: 'sabx-dot-deny' },
    ];

    /* ============================================================================
     * 读取 scope
     * ========================================================================== */

    /** 从设置 scope 快照读取当前授权目录列表。 */
    function currentDirs(scope) {
      var snapshot;
      try {
        snapshot = scope.getSnapshot();
      } catch (_error) {
        return [];
      }
      var value = snapshot && snapshot.value;
      return Array.isArray(value && value.allowedDirs) ? value.allowedDirs : [];
    }

    /** 从设置 scope 快照读取当前命令规则（{ default, rules }）。 */
    function currentCommands(scope) {
      var snapshot;
      try {
        snapshot = scope.getSnapshot();
      } catch (_error) {
        return { default: 'delegate', rules: [] };
      }
      var value = snapshot && snapshot.value;
      var commands = value && value.commands;
      var defaultValue = commands && commands.default !== undefined ? commands.default : 'delegate';
      var rules = Array.isArray(commands && commands.rules)
        ? commands.rules.map(function mapRule(rule) {
            return {
              tool: rule && rule.tool ? rule.tool : '',
              pattern: rule && typeof rule.pattern === 'string' ? rule.pattern : '',
              action: rule && rule.action ? rule.action : 'ask',
            };
          })
        : [];
      return { default: defaultValue, rules: rules };
    }

    /* ============================================================================
     * 校验（浏览器侧轻量镜像 lib/patterns.mjs 的拒绝规则；服务端仍然权威）
     * ========================================================================== */

    /** 返回非法原因，null 表示通过。 */
    function validateDirPattern(raw) {
      if (typeof raw !== 'string') return '目录必须是字符串。';
      var value = raw.trim();
      if (value.length === 0) return '目录不能为空。';
      var isAbsolute = /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]/u.test(value);
      if (!isAbsolute) {
        return '「' + value + '」不是绝对路径（需要盘符或根开始的路径）。';
      }
      if (value.indexOf('**') !== -1) {
        var staticLevels = 0;
        var segments = value.split(/[\\/]/u).filter(function keep(s) { return s.length > 0; });
        for (var i = 0; i < segments.length; i += 1) {
          if (/[*?]/u.test(segments[i])) break;
          staticLevels += 1;
        }
        if (staticLevels <= 1) {
          return '「' + value + '」锚定过宽（** 需要锚定至少一级具名目录）。';
        }
      }
      return null;
    }

    /** 未保存改动计数：与已保存值逐条位置比较。 */
    function dirsDirtyCount(rows, saved) {
      var count = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var compared = i < saved.length ? String(saved[i] || '') : '';
        if (String(rows[i].value || '').trim() !== compared.trim()) count += 1;
      }
      return count;
    }

    /** 命令规则草稿与已保存值是否不同。 */
    function rulesDirty(rules, saved) {
      if (rules.length !== saved.length) return true;
      for (var i = 0; i < rules.length; i += 1) {
        var a = rules[i];
        var b = saved[i];
        if ((a.tool || '') !== (b.tool || '')) return true;
        if (String(a.pattern || '').trim() !== String(b.pattern || '').trim()) return true;
        if ((a.action || 'ask') !== (b.action || 'ask')) return true;
      }
      return false;
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
        if (option.value !== 'delegate') classes.push('is-' + option.value);
        var children = [];
        if (option.dot) children.push(createDot(option.dot));
        children.push(option.value);
        return react.createElement('button', {
          key: option.value,
          type: 'button',
          className: classes.join(' '),
          'data-active': option.value === selected ? 'true' : 'false',
          'aria-label': ariaLabel ? ariaLabel + '：' + option.value : undefined,
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

      var value = props.value || '';
      var label = value || '任意';
      var triggerClasses = ['sabx-tool-trigger'];
      if (!value) triggerClasses.push('is-any');
      var pickerClasses = ['sabx-tool-picker'];
      if (open) pickerClasses.push('is-open');

      // 注意：必须用 .map 让每个选项按钮捕获各自的 option（与 createSeg 同理，
      // 循环 var 变量会被所有闭包共享，导致点击任何一项都选中最后一项）。
      var optionNodes = TOOL_OPTIONS.map(function mapToolOption(option) {
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
          react.createElement('span', { className: 'sabx-pending' }, '未保存修改'),
          createChevron('sabx-card-chevron'),
        ),
        body ? react.createElement('div', { className: 'sabx-card-body' }, body) : null,
      );
    }

    /* ============================================================================
     * 卡片 A：授权目录
     * ========================================================================== */

    function makeDirsCard(scope) {
      return function DirsCard() {
        var rowsState = react.useState([]);
        var rows = rowsState[0];
        var setRows = rowsState[1];
        var openState = react.useState(true);
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

        react.useEffect(function syncFromScope() {
          var update = function updateRows() {
            try {
              setRows(currentDirs(scope).map(function toRow(value) { return { value: value }; }));
            } catch (_ignored) {
              // a stale scope must never break the section render
            }
          };
          update();
          return scope.subscribe(update);
        }, []);

        var saved = currentDirs(scope);
        var pendingCount = dirsDirtyCount(rows, saved);

        function setRow(index, value) {
          setError(null);
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
          setRows(function append(previous) { return previous.concat([{ value: '' }]); });
        }

        function removeRow(index) {
          setError(null);
          setRows(function drop(previous) { return previous.filter(function keep(row, i) { return i !== index; }); });
        }

        function restoreSaved() {
          setRows(currentDirs(scope).map(function toRow(value) { return { value: value }; }));
          setError(null);
          setInvalid({});
        }

        var save = async function save() {
          setError(null);
          var values = [];
          var problems = [];
          rows.forEach(function validateOne(row, index) {
            var value = String(row.value || '').trim();
            if (value.length === 0) return; // 空行直接丢弃，不视为错误
            var issue = validateDirPattern(value);
            if (issue !== null) {
              problems.push({ index: index, message: issue });
            } else {
              values.push(value);
            }
          });
          if (problems.length > 0) {
            var flags = {};
            problems.forEach(function mark(p) { flags[p.index] = true; });
            setInvalid(flags);
            setError('校验失败：' + problems[0].message + (problems.length > 1 ? '（另有 ' + (problems.length - 1) + ' 处）' : ''));
            return;
          }
          try {
            setSaving(true);
            await scope.set('allowedDirs', values);
            restoreSaved(); // 订阅回调也会同步，这里显式刷新一次
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var countText = String(saved.length) + ' 个目录';
        if (pendingCount > 0) countText += ' · ' + pendingCount + ' 处未保存';

        // 注意：必须用 .map（每行回调捕获各自的 row/index，循环 var 会被共享）。
        var dirRows = rows.map(function mapDirRow(row, index) {
          var isNewRow = index >= saved.length;
          return react.createElement('div', { key: index, className: 'sabx-dir-row' },
            isNewRow
              ? react.createElement('span', { className: 'sabx-dir-icon is-new', 'aria-hidden': true }, '＋')
              : react.createElement('span', { className: 'sabx-dir-icon', 'aria-hidden': true }, '📁'),
            react.createElement('input', {
              className: 'sabx-input sabx-mono' + (invalid[index] ? ' is-invalid' : ''),
              type: 'text',
              spellCheck: false,
              value: row.value,
              'aria-label': '授权目录 ' + (index + 1),
              placeholder: 'D:\\Shared\\Tools',
              onChange: function onChange(event) { setRow(index, event.target.value); },
            }),
            react.createElement('button', {
              className: 'sabx-icon-btn',
              type: 'button',
              'aria-label': '删除',
              title: '删除该目录',
              onClick: function onRemove() { removeRow(index); },
            }, createXIcon()),
          );
        });
        if (dirRows.length === 0) {
          dirRows.push(react.createElement('div', { key: 'empty', className: 'sabx-empty' },
            '尚未授权任何目录。点击「添加目录」新增一行。'));
        }

        var bodyChildren = [
          react.createElement('div', { key: 'callout', className: 'sabx-callout-warn', role: 'note' },
            createDot('sabx-dot-warn'),
            react.createElement('span', {
              dangerouslySetInnerHTML: { __html: CALL_WARN_DIRS },
            }),
          ),
          react.createElement('div', { key: 'field', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, '工作区外的受信可写目录'),
              react.createElement('button', { className: 'sabx-field-reset', type: 'button', disabled: saving, onClick: restoreSaved }, '重置为默认'),
            ),
            react.createElement('p', { className: 'sabx-field-hint', dangerouslySetInnerHTML: { __html: DIRS_HINT.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;') } }),
            react.createElement('div', { className: 'sabx-dir-list' }, dirRows),
            react.createElement('button', { className: 'sabx-add-row', type: 'button', disabled: saving, onClick: addRow },
              react.createElement('span', { 'aria-hidden': true }, '＋'), ' 添加目录'),
            react.createElement('p', { className: 'sabx-dir-hint-inline' }, DIRS_VALIDATE_HINT),
          ),
          react.createElement('div', { key: 'footer', className: 'sabx-card-footer' },
            error === null
              ? null
              : react.createElement('p', { className: 'sabx-card-error', role: 'alert' }, error),
            react.createElement('button', { className: 'sabx-btn sabx-btn-ghost', type: 'button', disabled: saving || pendingCount === 0, onClick: restoreSaved }, '放弃修改'),
            react.createElement('button', { className: 'sabx-btn sabx-btn-primary', type: 'button', disabled: saving, onClick: function onSave() { void save(); } },
              saving ? '保存中…' : '保存目录'),
          ),
        ];

        return createCard({
          id: 'sabx-card-dirs',
          name: '授权目录',
          count: countText,
          desc: '允许沙箱内代理直接写入的工作区外目录；仍受文件沙箱约束，写入无需审批。',
          pendingCount: pendingCount,
          open: open,
          onToggle: function onToggle() { setOpen(!open); },
        }, bodyChildren);
      };
    }

    /* ============================================================================
     * 卡片 B：命令规则
     * ========================================================================== */

    function makeCommandsCard(scope) {
      return function CommandsCard() {
        var rulesState = react.useState([]);
        var rules = rulesState[0];
        var setRules = rulesState[1];
        var defaultState = react.useState('delegate');
        var defaultAction = defaultState[0];
        var setDefaultAction = defaultState[1];
        var openState = react.useState(true);
        var open = openState[0];
        var setOpen = openState[1];
        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];

        react.useEffect(function syncFromScope() {
          var update = function updateRules() {
            try {
              var cmds = currentCommands(scope);
              setRules(cmds.rules);
              setDefaultAction(cmds.default);
            } catch (_ignored) {
              // a stale scope must never break the section render
            }
          };
          update();
          return scope.subscribe(update);
        }, []);

        var saved = currentCommands(scope);
        var isDirty = defaultAction !== (saved.default || 'delegate') || rulesDirty(rules, saved.rules);
        var pendingCount = isDirty ? 1 : 0;

        function setRule(index, patch) {
          setError(null);
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
          setRules(function append(previous) {
            return previous.concat([{ tool: '', pattern: '', action: 'ask' }]);
          });
        }

        function removeRule(index) {
          setError(null);
          setRules(function drop(previous) {
            return previous.filter(function keep(rule, i) { return i !== index; });
          });
        }

        function restoreSaved() {
          var cmds = currentCommands(scope);
          setRules(cmds.rules);
          setDefaultAction(cmds.default || 'delegate');
          setError(null);
        }

        function resetDefault() {
          setError(null);
          setDefaultAction(saved.default || 'delegate');
        }

        var save = async function save() {
          setError(null);
          // 空 pattern 的行不保存；tool 为空时不写 tool 字段（= 任意工具）。
          var cleanRules = rules
            .filter(function hasPattern(rule) {
              return rule && rule.pattern && String(rule.pattern).trim().length > 0;
            })
            .map(function buildClean(rule) {
              var clean = { pattern: String(rule.pattern).trim(), action: rule.action || 'ask' };
              if (rule.tool) clean.tool = rule.tool;
              return clean;
            });
          try {
            setSaving(true);
            await scope.set('commands', { default: defaultAction, rules: cleanRules });
            restoreSaved();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var countText = String(saved.rules.length) + ' 条规则';
        if (pendingCount > 0) countText += ' · 未保存修改';

        // 注意：必须用 .map（每行回调捕获各自的 rule/index，循环 var 会被共享）。
        var ruleRows = rules.map(function mapRuleRow(rule, ruleIndex) {
          return react.createElement('div', { key: ruleIndex, className: 'sabx-rule-row' },
            react.createElement('div', { className: 'sabx-rule-tool' },
              react.createElement(ToolPicker, {
                value: rule.tool,
                disabled: saving,
                onSelect: function onTool(value) { setRule(ruleIndex, { tool: value }); },
              }),
            ),
            react.createElement('div', { className: 'sabx-rule-pattern' },
              react.createElement('input', {
                className: 'sabx-input sabx-mono',
                type: 'text',
                spellCheck: false,
                placeholder: 'git *',
                'aria-label': '命令模式',
                value: rule.pattern,
                disabled: saving,
                onChange: function onPattern(event) { setRule(ruleIndex, { pattern: event.target.value }); },
              }),
            ),
            react.createElement('div', { className: 'sabx-rule-action' },
              createSeg(ACTION_OPTIONS, rule.action, function onAction(value) { setRule(ruleIndex, { action: value }); }, '动作', true),
            ),
            react.createElement('button', {
              className: 'sabx-icon-btn sabx-rule-remove',
              type: 'button',
              'aria-label': '删除规则',
              title: '删除该规则',
              disabled: saving,
              onClick: function onRemove() { removeRule(ruleIndex); },
            }, createXIcon()),
          );
        });

        var bodyChildren = [
          react.createElement('div', { key: 'field-default', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, '未命中任何规则时的默认动作'),
              react.createElement('button', { className: 'sabx-field-reset', type: 'button', disabled: saving, onClick: resetDefault }, '重置为默认'),
            ),
            react.createElement('p', { className: 'sabx-field-hint' }, COMMANDS_DEFAULT_HINT),
            createSeg(DEFAULT_OPTIONS, defaultAction, setDefaultAction, '未命中规则时的默认动作', false),
          ),
          react.createElement('div', { key: 'field-rules', className: 'sabx-field' },
            react.createElement('div', { className: 'sabx-field-head' },
              react.createElement('span', { className: 'sabx-field-label' }, '放行规则（按顺序匹配，最后一条命中生效）'),
            ),
            react.createElement('p', { className: 'sabx-field-hint', dangerouslySetInnerHTML: { __html: COMMANDS_HINT } }),
            react.createElement('div', { className: 'sabx-rules-table' }, ruleRows.length > 0 ? ruleRows : [
              react.createElement('div', { key: 'empty', className: 'sabx-empty' }, '尚无命令规则。点击「添加规则」新增一行。'),
            ]),
            react.createElement('button', { className: 'sabx-add-row', type: 'button', disabled: saving, onClick: addRule },
              react.createElement('span', { 'aria-hidden': true }, '＋'), ' 添加规则'),
            react.createElement('p', { className: 'sabx-dir-hint-inline', style: { marginTop: 4 } }, COMMANDS_TAIL_HINT),
          ),
          react.createElement('div', { key: 'footer', className: 'sabx-card-footer' },
            error === null
              ? null
              : react.createElement('p', { className: 'sabx-card-error', role: 'alert' }, error),
            react.createElement('button', { className: 'sabx-btn sabx-btn-ghost', type: 'button', disabled: saving || pendingCount === 0, onClick: restoreSaved }, '放弃修改'),
            react.createElement('button', { className: 'sabx-btn sabx-btn-primary', type: 'button', disabled: saving, onClick: function onSave() { void save(); } },
              saving ? '保存中…' : '保存命令规则'),
          ),
        ];

        return createCard({
          id: 'sabx-card-cmds',
          name: '命令规则',
          count: countText,
          desc: '按「命令模式 + 动作」放行 / 询问 / 拦截 shell 命令。',
          pendingCount: pendingCount,
          open: open,
          onToggle: function onToggle() { setOpen(!open); },
        }, bodyChildren);
      };
    }

    /**
     * 构建「命令规则」可视化编辑器（与授权目录编辑器并列）。保留原导出名，
     * 返回独立卡片组件。
     * @param scope - ctx.settingsScope.bind 返回的 controller。
     */
    function makeCommandRulesEditor(scope) {
      return makeCommandsCard(scope);
    }

    /* ============================================================================
     * 分节组件
     * ========================================================================== */

    /**
     * 构建「沙箱授权」分节组件（闭包式，直接订阅 scope，不依赖 slots 的
     * props 转换契约，任何情况下都不会因 props 缺失而崩溃）。
     * @param scope - ctx.settingsScope.bind 返回的 controller。
     */
    function makeAllowlistSection(scope) {
      var DirsCard = makeDirsCard(scope);
      var CommandsCard = makeCommandsCard(scope);
      return function AllowlistSection() {
        return react.createElement('section', { className: 'sabx-section', 'aria-labelledby': 'sabx-section-title' },
          react.createElement('h2', { className: 'sabx-section-heading', id: 'sabx-section-title' }, '沙箱授权'),
          react.createElement('p', { className: 'sabx-section-intro' },
            '配置沙箱内的目录操作权限及命令执行权限，保存后立即生效',
          ),
          react.createElement(DirsCard, null),
          react.createElement(CommandsCard, null),
        );
      };
    }

    /** 客户端插件入口：注册设置页分节并绑定设置 namespace。 */
    function apply(ctx) {
      var scope;
      try {
        scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      } catch (error) {
        // bind 失败（如设置服务缺失）不能阻止分节注册 —— 组件会在无 scope
        // 时退化为空列表编辑。
        scope = {
          getSnapshot: function getSnapshot() { return { value: {} }; },
          subscribe: function subscribe() { return function noop() {}; },
          set: function set() { return Promise.reject(new Error('settings scope unavailable')); },
        };
      }
      var section = makeAllowlistSection(scope);
      ctx.slots.inject('settings.section', function registerSection() {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'sandbox-allowlist',
          order: 30,
          label: function label() { return '沙箱授权'; },
        }, section);
      });
    }

    exports.inject = ['slots', 'connection', 'settingsScope'];
    exports.apply = apply;
    return module.exports;
  },
});