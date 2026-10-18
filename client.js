window.__ModuleLoader__.load({
  id: '@dsd486/dsh-sync',
  factory: require => {
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;
    async function api(tool, args = {}) {
      const response = await fetch('/api/dsh-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.detail || `HTTP ${response.status}`);
      return result;
    }
    function Settings() {
      const [form, setForm] = useState({ repo: '', branch: 'main', remotePrefix: 'dsh-sync', tokenRef: '' });
      const [categories, setCategories] = useState([]);
      const [chosen, setChosen] = useState(['core']);
      const [approved, setApproved] = useState([]);
      const [busy, setBusy] = useState(false);
      const [loaded, setLoaded] = useState(false);
      const [notice, setNotice] = useState('');
      const [warning, setWarning] = useState('');
      const [previewed, setPreviewed] = useState(false);
      useEffect(() => {
        let active = true;
        Promise.all([api('sync_catalog'), api('sync_config').catch(error => {
          if (error.message.includes('尚无配置')) return { config: null };
          throw error;
        })]).then(([catalog, result]) => {
          if (!active) return;
          setCategories(catalog.categories); setWarning(catalog.detail);
          setChosen(catalog.categories.filter(c => c.selected).map(c => c.id));
          const cfg = result.config;
          if (cfg) { setForm({ repo: cfg.repo, branch: cfg.branch, remotePrefix: cfg.remotePrefix, tokenRef: cfg.tokenRef || '' }); setApproved(cfg.confirmedSensitive || []); }
          setLoaded(true);
        }).catch(error => active && setNotice(error.message));
        return () => { active = false; };
      }, []);
      const save = () => api('sync_config', { ...form, ...(form.tokenRef ? {} : { tokenRef: undefined }), categories: chosen, confirmSensitive: chosen.filter(id => categories.find(c => c.id === id)?.sensitive).every(id => approved.includes(id)) });
      async function run(action) {
        setBusy(true); setNotice('');
        try {
          await save();
          if (action === 'save') { setNotice('设置已保存。'); return; }
          if (action === 'pull' && !window.confirm('将按 GitHub 内容覆盖选中类别；旧文件会先备份。确认拉取？')) return;
          const result = await api(action === 'status' ? 'sync_status' : action === 'push' ? 'sync_push' : 'sync_pull', action === 'preview' ? { dryRun: true } : {});
          if (action === 'preview') setPreviewed(true);
          if (action === 'pull') setPreviewed(false);
          const detail = result.diff || (action === 'preview' ? { 覆盖: result.toWrite, 新增: result.toAdd, 删除: result.toDelete } : null);
          setNotice(result.detail + (detail ? '\n' + JSON.stringify(detail, null, 2) : ''));
        } catch (error) { setNotice(error.message + '\n可以询问 Agent：“请帮我排查 DSH 同步失败原因。” 不要粘贴 API Key。'); }
        finally { setBusy(false); }
      }
      function toggle(category, checked) {
        setPreviewed(false);
        if (checked && category.sensitive) {
          if (!window.confirm(category.label + '\n\n' + warning)) return;
          setApproved(previous => [...new Set([...previous, category.id])]);
        }
        if (!checked) setApproved(previous => previous.filter(id => id !== category.id));
        setChosen(previous => checked ? [...previous, category.id] : previous.filter(id => id !== category.id));
      }
      const button = (label, action, disabled = false) => h('button', { type: 'button', disabled: busy || !loaded || disabled, onClick: () => run(action), style: { padding: '7px 12px', cursor: 'pointer' } }, label);
      return h('section', { style: { maxWidth: 720, display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)', padding: 12 } },
        h('h2', { style: { margin: 0, fontSize: 18 } }, 'DSH 同步'),
        h('p', null, '按用途选择当前 DSH Profile 的同步内容。推送以本机为准，拉取以 GitHub 为准。'),
        ...[['repo', 'GitHub 仓库', 'owner/repo'], ['branch', '分支', 'main'], ['remotePrefix', '仓库内保存位置', 'dsh-sync'], ['tokenRef', 'GitHub 令牌引用', 'env:DSH_SYNC_TOKEN 或 file:本机路径']].map(([key, label, placeholder]) =>
          h('label', { key, style: { display: 'grid', gap: 6 } }, label, h('input', { value: form[key] || '', placeholder, disabled: busy || !loaded, onChange: event => { setForm({ ...form, [key]: event.target.value }); setPreviewed(false); }, style: { padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-layer-3)', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 6 } }))),
        h('fieldset', { disabled: busy || !loaded, style: { display: 'grid', gap: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l4)' } },
          h('legend', null, '同步内容'),
          ...categories.map(c => h('label', { key: c.id, style: { display: 'flex', gap: 8, alignItems: 'center' } }, h('input', { type: 'checkbox', checked: chosen.includes(c.id), onChange: event => toggle(c, event.target.checked) }), `${c.label}${c.sensitive ? '（敏感）' : ''}`, h('small', { style: { opacity: 0.6 } }, `${c.count} 个文件 · ${(c.bytes / 1024).toFixed(1)} KB`)))),
        h('small', null, '敏感项默认关闭。GitHub 令牌请存本机环境变量或文件；插件自身令牌、备份、Git 元数据及符号链接不参与同步。单文件上限 50MB。'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, button('保存设置', 'save'), button('检查状态', 'status'), button('推送到 GitHub', 'push', !chosen.length), button('预览拉取', 'preview', !chosen.length), button('确认拉取', 'pull', !previewed)),
        h('pre', { role: 'status', 'aria-live': 'polite', style: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', opacity: 0.85 } }, busy ? '处理中…' : notice));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-sync', order: 101, label: () => 'DSH 同步' }, Settings));
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-sync', order: 101, label: () => 'DSH 同步' }, Settings));
      },
    };
  },
});
