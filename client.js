// 浏览器端：把每轮"最终回答"的正文换成人设版，A 的原文折叠进思考过程（过程链里的一行）；
// 运行中的候选回答也先折叠，生成期间在过程里显示"正在组织语言…"，完成后给出"查看原文"切换。
// 做法同 dsh-session-tags：找到官方 assistant-step 条目，原地替换其 component，
// 改写 node.data.blocks 后交还给官方组件渲染（Markdown、文件链接等保持官方效果）。
window.__ModuleLoader__.load({
  id: '@local/dsh-persona-voice',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const SLOT = 'conversation.chat.node';

    // 只缓存终态结果；pending 每次重新查。
    const cache = new Map();
    async function load(sessionId, turnId) {
      const key = sessionId + '\n' + turnId;
      if (cache.has(key)) return cache.get(key);
      const url = '/api/local-persona-voice?session=' + encodeURIComponent(sessionId) + '&turn=' + encodeURIComponent(turnId);
      const response = await fetch(url, { headers: { 'cache-control': 'no-store' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (result.status !== 'pending') cache.set(key, result);
      return result;
    }

    function useVoice(sessionId, turnId, active) {
      const [state, setState] = React.useState(null);
      React.useEffect(() => {
        if (!active) return undefined;
        let alive = true;
        let timer;
        const poll = async left => {
          try {
            const result = await load(sessionId, String(turnId));
            if (!alive) return;
            setState(result);
            if (result.status === 'pending' && left > 0) timer = setTimeout(() => poll(left - 1), 1500);
          } catch (reason) {
            if (alive) setState({ status: 'error', error: reason.message });
          }
        };
        poll(80);
        return () => { alive = false; clearTimeout(timer); };
      }, [sessionId, turnId, active]);
      return active ? state : null;
    }

    // 是否启用：启用时运行中的回答也先折叠，避免"先显示原文再消失"。
    const enabledStore = { value: false, listeners: new Set() };
    async function refreshEnabled() {
      try {
        const response = await fetch('/api/local-persona-voice/status', { headers: { 'cache-control': 'no-store' } });
        const result = await response.json();
        if (response.ok && result.enabled !== enabledStore.value) {
          enabledStore.value = result.enabled;
          for (const fn of enabledStore.listeners) fn();
        }
      } catch {}
    }
    const useEnabled = () => React.useSyncExternalStore(
      fn => { enabledStore.listeners.add(fn); return () => enabledStore.listeners.delete(fn); },
      () => enabledStore.value);

    const textOf = blocks => blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n');
    // 把正文移进思考过程（像过程链里的一行），保留其余块。
    function foldOriginal(blocks) {
      const others = blocks.filter(b => b.kind !== 'text');
      return [...others, { kind: 'reasoning', text: '【执行原文】\n\n' + textOf(blocks) }];
    }

    function wrap(Original) {
      return function PersonaAssistantNodeView(props) {
        const { node, useTurnData, sessionId, groupPart } = props;
        const data = node.data;
        // 0.2.2-rc.1 起，同一条 assistant 节点会按 groupPart 拆成两行各渲染一次：
        // 'reasoning' 只画思考块，'response' 只画正文。两边共用同一份改写后的 blocks
        // （官方渲染器会各自只取自己那一类），附加界面只挂在正文那一行，避免重复。
        const processPart = groupPart === 'reasoning';
        const enabled = useEnabled();
        const turn = node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn : undefined;
        const tail = useTurnData('turn-tail');
        const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
        const hasText = blocks.some(b => b.kind === 'text' && b.text.trim());
        const closed = turn?.status === 'closed';
        // 与官方 AssistantNodeView 相同的"本轮最终回答"判定。
        const isFinal = closed && data?.finalNode !== undefined
          && tail?.closing?.finalNode.seq === data.finalNode.seq && hasText;
        // 运行中、只有文字没有工具调用的步骤，可能就是最终回答：先折叠进过程。
        const maybeFinal = enabled && !closed && hasText && !blocks.some(b => b.kind === 'tool-call');
        const state = useVoice(sessionId, turn?.turn, isFinal && turn?.turn !== undefined && !processPart);
        const [showRaw, setShowRaw] = React.useState(false);

        const view = React.useMemo(() => {
          if (maybeFinal) return { node: { ...node, data: { ...data, blocks: foldOriginal(blocks) } }, row: null };
          if (!isFinal) return { node, row: null };
          const status = state?.status ?? (enabled ? 'pending' : 'none');
          if (status === 'pending') return { node: { ...node, data: { ...data, blocks: foldOriginal(blocks) } }, row: 'pending' };
          if (status === 'ok') {
            const voiced = [...foldOriginal(blocks), { kind: 'text', text: state.voice }];
            return { node: { ...node, data: { ...data, blocks: voiced } }, row: 'toggle' };
          }
          if (status === 'error') return { node: { ...node, data: { ...data, blocks: [...blocks, { kind: 'text', text: '\n> 人设版生成失败：' + state.error }] } }, row: null };
          return { node, row: null };
        }, [node, data, blocks, maybeFinal, isFinal, enabled, state]);

        // 思考那一行：只负责把原文折叠进来，不挂任何附加界面。
        if (processPart) return h(Original, { ...props, node: view.node });

        if (view.row === 'pending') {
          return h(React.Fragment, null, h(Original, { ...props, node: view.node }),
            h('div', { className: 'av-process' }, h('span', { className: 'av-shimmer' }, '🌸 正在组织语言…')));
        }
        if (view.row === 'toggle') {
          return h(React.Fragment, null,
            h(Original, { ...props, node: showRaw ? node : view.node }),
            h('div', { className: 'av-toggle' },
              h('button', { type: 'button', onClick: () => setShowRaw(v => !v) }, showRaw ? '查看人设版' : '查看原文')));
        }
        return h(Original, { ...props, node: view.node });
      };
    }

    // ---------- 官方「设置」面板中的分区 ----------
    const SETTINGS_URL = '/api/local-persona-voice/settings';
    const css = `
.av-form{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary);max-width:720px}
.av-field{display:flex;flex-direction:column;gap:6px}
.av-field>label{font-weight:500}
.av-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.av-form input[type=text],.av-form input[type=number],.av-form select,.av-form textarea{box-sizing:border-box;width:100%;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
.av-form textarea{min-height:160px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.5;resize:vertical}
.av-row{display:flex;gap:12px}.av-row>.av-field{flex:1}
.av-check{display:flex;align-items:center;gap:8px;font-weight:500}
.av-actions{display:flex;gap:8px;align-items:center}
.av-actions button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer}
.av-actions .av-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.av-actions button:disabled{opacity:.5;cursor:default}
.av-error{color:var(--dsw-alias-state-error-primary)}.av-ok{color:var(--dsw-alias-state-success-primary)}
.av-process{margin:2px 0 6px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.av-shimmer{background:linear-gradient(90deg,currentColor 0%,currentColor 40%,var(--dsw-alias-label-primary) 50%,currentColor 60%,currentColor 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:av-shimmer 1.6s linear infinite}
@keyframes av-shimmer{from{background-position:100% 0}to{background-position:-100% 0}}
.av-toggle{margin:4px 0 2px}
.av-toggle button{font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:6px;padding:2px 6px;cursor:pointer}
.av-toggle button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`;

    const CATALOG_KEY = 'dsh-persona-voice.catalog';
    function readCachedCatalog() {
      try { const value = JSON.parse(localStorage.getItem(CATALOG_KEY)); return Array.isArray(value?.groups) ? value : null; } catch { return null; }
    }
    const timeText = at => at ? new Date(at).toLocaleString() : '';

    // 官方模型目录（与输入框模型菜单、/model 同源），apply 时注入。
    let loadCatalog = async () => ({ groups: [], failures: [] });

    function SettingsPage() {
      const [data, setData] = React.useState(null);      // { settings, defaultRules, defaultReminder }
      // 模型目录读一次就缓存（localStorage），之后打开直接用；需要时点"刷新模型列表"。
      const [catalog, setCatalog] = React.useState(readCachedCatalog); // { groups, failures, at } | { error } | null
      const [refreshing, setRefreshing] = React.useState(false);
      const refreshCatalog = React.useCallback(async () => {
        setRefreshing(true);
        try {
          const value = await loadCatalog();
          const stored = { groups: value.groups ?? [], failures: value.failures ?? [], at: Date.now() };
          try { localStorage.setItem(CATALOG_KEY, JSON.stringify(stored)); } catch {}
          setCatalog(stored);
        } catch (reason) {
          // 刷新失败时保留上次的列表，只提示错误。
          setCatalog(c => ({ groups: c?.groups ?? [], failures: c?.failures ?? [], at: c?.at, error: reason.message }));
        } finally {
          setRefreshing(false);
        }
      }, []);
      React.useEffect(() => { if (catalog === null) refreshCatalog(); }, []);
      const [draft, setDraft] = React.useState(null);
      const [sel, setSel] = React.useState(0);           // 正在编辑的预设下标
      const [status, setStatus] = React.useState({ kind: 'idle' });
      const resetDraft = settings => {
        setDraft(settings);
        setSel(Math.max(0, settings.presets.findIndex(p => p.name === settings.activePreset)));
      };
      const reload = React.useCallback(async () => {
        setStatus({ kind: 'loading' });
        try {
          const response = await fetch(SETTINGS_URL, { headers: { 'cache-control': 'no-store' } });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          setData(result);
          resetDraft(result.settings);
          setStatus({ kind: 'idle' });
        } catch (reason) {
          setStatus({ kind: 'error', message: reason.message });
        }
      }, []);
      React.useEffect(() => { reload(); }, [reload]);

      if (!draft) {
        return h('div', { className: 'av-form' }, status.kind === 'error'
          ? h('div', { className: 'av-error' }, '读取设置失败：' + status.message)
          : h('div', { className: 'av-hint' }, '正在读取设置…'));
      }
      const set = (key, value) => { setDraft(d => ({ ...d, [key]: value })); setStatus({ kind: 'idle' }); };
      const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
      const routeValue = draft.provider ? draft.provider + '\n' + draft.model : '';
      const groups = catalog?.groups ?? [];
      const selectedModel = groups.find(p => p.id === draft.provider)?.models.find(m => m.id === draft.model);
      const known = selectedModel !== undefined;
      const efforts = selectedModel?.reasoning?.efforts ?? [];
      // 正在编辑（也是正在使用）的预设；按下标跟踪，改名时不会跟丢。
      const preset = draft.presets[sel] ?? draft.presets[0];
      const updatePreset = patch => {
        setDraft(d => {
          const presets = d.presets.map((p, i) => i === sel ? { ...p, ...patch } : p);
          return { ...d, presets, activePreset: presets[sel].name };
        });
        setStatus({ kind: 'idle' });
      };
      const addPreset = () => {
        let n = draft.presets.length + 1;
        while (draft.presets.some(p => p.name === '人设 ' + n)) n++;
        const name = '人设 ' + n;
        setDraft(d => ({ ...d, presets: [...d.presets, { name, personaFile: '', persona: '' }], activePreset: name }));
        setSel(draft.presets.length);
        setStatus({ kind: 'idle' });
      };
      const removePreset = () => {
        if (!window.confirm(`删除预设「${preset.name}」？`)) return;
        const presets = draft.presets.filter((_, i) => i !== sel);
        setDraft(d => ({ ...d, presets, activePreset: presets[0].name }));
        setSel(0);
        setStatus({ kind: 'idle' });
      };
      async function save() {
        setStatus({ kind: 'saving' });
        try {
          const response = await fetch(SETTINGS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          setData(d => ({ ...d, settings: result.settings }));
          resetDraft(result.settings);
          setStatus({ kind: 'saved' });
          refreshEnabled();
        } catch (reason) {
          setStatus({ kind: 'error', message: reason.message });
        }
      }
      const number = (key, label, hint) => h('div', { className: 'av-field' },
        h('label', null, label),
        h('input', { type: 'number', value: draft[key], onChange: e => set(key, e.target.value) }),
        hint && h('div', { className: 'av-hint' }, hint));

      return h('div', { className: 'av-form' },
        h('label', { className: 'av-check' },
          h('input', { type: 'checkbox', checked: draft.enabled, onChange: e => set('enabled', e.target.checked) }),
          '启用人设转述'),
        h('div', { className: 'av-hint' }, '每轮结束后再调用一次模型，把最终回答改写成人设口吻；原文折叠进思考过程。每轮会多一次模型调用。保存后下一轮生效，无需重启。'),

        h('div', { className: 'av-field' },
          h('label', null, '转述用的模型'),
          h('select', {
            value: routeValue,
            onChange: e => { const [provider = '', model = ''] = e.target.value.split('\n'); setDraft(d => ({ ...d, provider, model, effort: '' })); setStatus({ kind: 'idle' }); },
          },
            h('option', { value: '' }, '跟随当前会话的模型'),
            catalog && !known && draft.provider && h('option', { value: routeValue }, `${draft.provider} / ${draft.model}（当前不可用）`),
            groups.map(p => h('optgroup', { key: p.id, label: p.name },
              p.models.map(m => h('option', { key: m.id, value: p.id + '\n' + m.id }, m.name === m.id ? m.id : `${m.name}（${m.id}）`))))),
          h('div', { className: 'av-actions' },
            h('button', { type: 'button', disabled: refreshing, onClick: refreshCatalog }, refreshing ? '刷新中…' : '刷新模型列表'),
            h('span', { className: 'av-hint' }, catalog?.at ? '列表更新于 ' + timeText(catalog.at) : '')),
          h('div', { className: 'av-hint' }, catalog === null ? '正在读取模型目录…'
            : catalog.error ? '读取模型目录失败：' + catalog.error + (catalog.groups.length ? '（显示的是上次的列表）' : '')
            : '列表与输入框的模型菜单一致，读取一次后会记住；在官方设置里增删模型后点"刷新模型列表"。推荐选一个便宜、快的模型。'),
          catalog?.failures?.length > 0 && h('div', { className: 'av-hint' }, '暂时不可用：' + catalog.failures.map(f => f.name).join('、'))),

        h('div', { className: 'av-field' },
          h('label', null, '思考强度'),
          h('select', { value: draft.effort, disabled: !draft.provider || efforts.length === 0, onChange: e => set('effort', e.target.value) },
            h('option', { value: '' }, '自动（最省：能关就关，否则最低档）'),
            draft.effort && !efforts.some(e => e.id === draft.effort) && h('option', { value: draft.effort }, `${draft.effort}（该模型不支持）`),
            efforts.map(e => h('option', { key: e.id, value: e.id }, e.name && e.name !== e.id ? `${e.name}（${e.id}）` : e.id))),
          h('div', { className: 'av-hint' }, !draft.provider ? '跟随会话模型时自动选择；指定模型后可手动设置。'
            : efforts.length === 0 ? '这个模型没有可调的思考强度。'
            : '转述一般不需要深度思考；调高会更慢、更贵。')),

        h('div', { className: 'av-field' },
          h('label', null, '人设预设'),
          h('div', { className: 'av-actions' },
            h('select', { value: sel, style: { flex: 1 }, onChange: e => { const i = Number(e.target.value); setSel(i); set('activePreset', draft.presets[i].name); } },
              draft.presets.map((p, i) => h('option', { key: i, value: i }, p.name || '（未命名）'))),
            h('button', { type: 'button', onClick: addPreset }, '新建'),
            h('button', { type: 'button', disabled: draft.presets.length < 2, onClick: removePreset }, '删除')),
          h('div', { className: 'av-hint' }, '下拉框选中的预设就是正在使用的人设，保存后下一轮生效。切换人设后，前几轮可能还带着上一个人设的说话习惯。')),

        h('div', { className: 'av-field' },
          h('label', null, '预设名称'),
          h('input', { type: 'text', value: preset.name, onChange: e => updatePreset({ name: e.target.value }) })),

        h('div', { className: 'av-field' },
          h('label', null, '人设文件（可选）'),
          h('input', { type: 'text', value: preset.personaFile, placeholder: '/path/to/AGENTS.md', onChange: e => updatePreset({ personaFile: e.target.value }) }),
          h('div', { className: 'av-hint' }, '填写后优先从这个文件读取人设，每轮重新读取，改文件即生效。文件里有 <xxx_persona>…</xxx_persona> 块时只取这一块。')),

        h('div', { className: 'av-field' },
          h('label', null, '人设提示词'),
          h('textarea', { value: preset.persona, disabled: Boolean(preset.personaFile), placeholder: '你是……（描述角色的性格、说话方式、称呼等）', onChange: e => updatePreset({ persona: e.target.value }) }),
          preset.personaFile && h('div', { className: 'av-hint' }, '已填写人设文件，这里的文本不会被使用。')),

        h('div', { className: 'av-field' },
          h('label', null, '转述规则'),
          h('textarea', { value: draft.rules, onChange: e => set('rules', e.target.value) }),
          h('div', { className: 'av-actions' }, h('button', { type: 'button', onClick: () => set('rules', data.defaultRules) }, '恢复默认规则'))),

        h('div', { className: 'av-field' },
          h('label', null, '每轮提醒'),
          h('input', { type: 'text', value: draft.reminder, placeholder: '留空则不附加', onChange: e => set('reminder', e.target.value) }),
          h('div', { className: 'av-hint' }, '附在每条用户消息末尾的一句固定提醒，防止聊久了人设走样；文本固定，不影响缓存（修改后会有一轮缓存失效）。'),
          h('div', { className: 'av-actions' }, h('button', { type: 'button', onClick: () => set('reminder', data.defaultReminder) }, '恢复默认提醒'))),

        h('div', { className: 'av-row' },
          number('maxTurns', '最多记忆轮数', '超出后一次删掉最早的一半，方便命中缓存'),
          number('maxTokens', '输出上限 (tokens)')),

        h('div', { className: 'av-actions' },
          h('button', { type: 'button', className: 'av-primary', disabled: !dirty || status.kind === 'saving', onClick: save }, status.kind === 'saving' ? '保存中…' : '保存'),
          h('button', { type: 'button', disabled: !dirty || status.kind === 'saving', onClick: () => { resetDraft(data.settings); setStatus({ kind: 'idle' }); } }, '放弃修改'),
          status.kind === 'saved' && h('span', { className: 'av-ok' }, '已保存，下一轮生效'),
          status.kind === 'error' && h('span', { className: 'av-error' }, status.message)));
    }

    function SettingsSection() {
      return h('div', { style: { padding: '4px 0' } },
        h('h2', { style: { margin: '0 0 4px', fontSize: '18px', fontWeight: 600 } }, '人设转述'),
        h('div', { className: 'av-hint', style: { marginBottom: '16px' } }, '把每轮最终回答改写成你设定的人设口吻'),
        h(SettingsPage));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 同官方 model-selection 插件：同时声明 remote 和 remote.session，才能访问 ctx.remote.session。
        ctx.inject(['remote', 'remote.session'], inner => {
          loadCatalog = async () => {
            const response = await inner.remote.session.modelCatalog();
            if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
            return response.value;
          };
          inner.effect(() => () => { loadCatalog = async () => { throw new Error('模型目录服务不可用'); }; });
        });
        refreshEnabled();
        const onFocus = () => refreshEnabled();
        window.addEventListener('focus', onFocus);
        ctx.effect(() => () => window.removeEventListener('focus', onFocus));
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove());
        // 官方「设置」面板里的一个分区（左侧导航显示"人设转述"）。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'persona-voice',
          order: 60,
          label: () => '人设转述',
        }, SettingsSection));

        ctx.slots.inject(SLOT, () => {
          let installed;
          let installedEntry;
          const install = () => {
            const entry = ctx.slots.entries(SLOT).find(e => e.options.key === 'assistant-step');
            if (entry === installedEntry) return;
            installed?.();
            installed = undefined;
            installedEntry = entry;
            if (!entry) return;
            const Original = entry.component;
            const Wrapped = wrap(Original);
            // 保留官方注册：子 slot（思考正文、图片）绑定在该条目上，不能复制到新注册。
            entry.component = Wrapped;
            installed = () => { if (entry.component === Wrapped) entry.component = Original; };
          };
          const unsubscribe = ctx.slots.subscribe(SLOT, install);
          try { install(); } catch (reason) { unsubscribe(); installed?.(); throw reason; }
          return () => { unsubscribe(); installed?.(); };
        });
      },
    };
  },
});
