/**
 * dsh-sandbox-allowlist — 客户端半件（手写 __ModuleLoader__ bundle）。
 *
 * 在设置页注册「沙箱授权目录」分节：
 *   - 通过 ctx.slots 在 settings.section 槽位注册（与官方设置分节一致）；
 *   - 通过 ctx.settingsScope.bind({ namespace: 'sandbox-allowlist' }) 绑定
 *     lib/policy.mjs 注册的设置 namespace；
 *   - 组件在 apply 闭包内直接订阅 scope（不依赖 slots 对 register inject
 *     返回 props 的转换契约），保存调用 scope.set('allowedDirs', [...])，
 *     写入用户设置文档（$DSH_HOME/settings.yaml），服务端策略实时生效。
 *
 * 构建说明：这是运行时实际加载的产物。src/client/index.tsx 是等价 TS 源码
 * 参考，用于在 dsh 开发工具链下重建（tsc + tsdown）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sandbox-allowlist',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require('react');

    const NAMESPACE = 'sandbox-allowlist';

    const WARNING = [
      '⚠️ 安全警示：以下目录是「沙箱授权目录」——沙箱内的 AI 代理被授权在这些目录（工作区之外）执行修改操作，无需审批。',
      '请只添加你完全信任的目录；目录必须已存在且归当前用户所有。',
      '支持通配符：D:\\Shared\\**（子树）、D:\\Data\\*（一级子目录）、D:\\Work\\202?（单字符）。',
      '撤销授权请删除对应条目（Windows 上旧目录的 ACE 用 scripts/revoke.mjs 清理）。',
    ].join(' ');

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

    /**
     * 构建「沙箱授权目录」分节组件。组件定义在 apply 的闭包里，直接订阅
     * 绑定的 scope —— 不依赖 slots 系统向组件注入 props 的方式，任何情况下
     * 都不会因 props 缺失而崩溃（渲染失败只会退化为空列表 + 可编辑表单）。
     * @param scope - ctx.settingsScope.bind 返回的 controller。
     */
    function makeAllowlistSection(scope) {
      return function AllowlistSection() {
        var state = react.useState('');
        var draft = state[0];
        var setDraft = state[1];
        var savingState = react.useState(false);
        var saving = savingState[0];
        var setSaving = savingState[1];
        var errorState = react.useState(null);
        var error = errorState[0];
        var setError = errorState[1];

        react.useEffect(function syncFromScope() {
          var update = function updateDraft() {
            try {
              setDraft(currentDirs(scope).join('\n'));
            } catch (_ignored) {
              // a stale scope must never break the section render
            }
          };
          update();
          return scope.subscribe(update);
        }, []);

        var parseDraft = function parseDraft() {
          return draft
            .split(/\r?\n/)
            .map(function trimLine(line) { return line.trim(); })
            .filter(function keep(line) { return line.length > 0; });
        };

        var save = async function save() {
          setSaving(true);
          setError(null);
          try {
            await scope.set('allowedDirs', parseDraft());
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setSaving(false);
          }
        };

        var sectionStyle = { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' };
        var warningStyle = { color: 'var(--dsw-alias-state-error-primary, #c0392b)', lineHeight: 1.6, margin: 0 };
        var textareaStyle = { width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 8, boxSizing: 'border-box' };
        var rowStyle = { display: 'flex', gap: 8 };

        return react.createElement('section', { style: sectionStyle },
          react.createElement('h2', { style: { margin: 0 } }, '沙箱授权目录'),
          react.createElement('p', { role: 'alert', style: warningStyle }, WARNING),
          react.createElement('p', { style: { margin: 0, color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, lineHeight: 1.6 } },
            '当前授权 ' + currentDirs(scope).length + ' 个目录（每行一个，可编辑后保存；保存即生效，无需重启 dsh）。'),
          react.createElement('textarea', {
            'aria-label': '沙箱授权目录列表（每行一个）',
            rows: 8,
            spellCheck: false,
            style: textareaStyle,
            value: draft,
            onChange: function onChange(event) { setDraft(event.target.value); },
            placeholder: 'D:\\Shared\\Tools\nD:\\Shared\\**\nD:\\Data\\logs\\*',
          }),
          error === null
            ? null
            : react.createElement('p', { role: 'alert', style: warningStyle }, '保存失败：' + error),
          react.createElement('div', { style: rowStyle },
            react.createElement('button', { type: 'button', disabled: saving, onClick: function onSave() { void save(); } },
              saving ? '保存中…' : '保存'),
            react.createElement('button', {
              type: 'button',
              disabled: saving,
              onClick: function onClear() { setDraft(''); setError(null); },
            }, '清空'),
          ),
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
          label: function label() { return '沙箱授权目录'; },
        }, section);
      });
    }

    exports.inject = ['slots', 'connection', 'settingsScope'];
    exports.apply = apply;
    return module.exports;
  },
});
