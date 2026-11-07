// 浏览器端：把每轮"最终回答"的正文换成人设版，A 的原文折叠进思考过程。
// 做法同 dsh-session-tags：找到官方 assistant-step 条目，原地替换其 component，
// 改写 node.data.blocks 后交还给官方组件渲染（Markdown、文件链接等保持官方效果）。
window.__ModuleLoader__.load({
  id: '@local/dsh-persona-voice',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const SLOT = 'conversation.chat.node';
    const PENDING_TEXT = '*正在组织语言…*';

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

    function rewrite(blocks, state) {
      const raw = blocks.filter(b => b.kind === 'text').map(b => b.text).join('\n');
      const others = blocks.filter(b => b.kind !== 'text');
      const original = { kind: 'reasoning', text: '【执行原文】\n\n' + raw };
      if (state.status === 'pending') return [...others, original, { kind: 'text', text: PENDING_TEXT }];
      if (state.status === 'ok') return [...others, original, { kind: 'text', text: state.voice }];
      if (state.status === 'error') return [...blocks, { kind: 'text', text: '\n> 人设版生成失败：' + state.error }];
      return blocks;
    }

    function wrap(Original) {
      return function PersonaAssistantNodeView(props) {
        const { node, useTurnData, sessionId } = props;
        const data = node.data;
        const turn = node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn : undefined;
        const tail = useTurnData('turn-tail');
        // 与官方 AssistantNodeView 相同的"本轮最终回答"判定。
        const isFinal = turn?.status === 'closed' && data?.finalNode !== undefined
          && tail?.closing?.finalNode.seq === data.finalNode.seq
          && Array.isArray(data.blocks) && data.blocks.some(b => b.kind === 'text' && b.text.trim());
        const state = useVoice(sessionId, turn?.turn, isFinal && turn?.turn !== undefined);
        const [showRaw, setShowRaw] = React.useState(false);
        const patched = React.useMemo(() => {
          if (!isFinal || !state || state.status === 'none') return node;
          return { ...node, data: { ...data, blocks: rewrite(data.blocks, state) } };
        }, [node, data, isFinal, state]);
        // 人设版生成成功后，在回答下方给一个切换按钮；原文仍交给官方组件渲染（Markdown 照常）。
        if (!isFinal || state?.status !== 'ok') return h(Original, { ...props, node: patched });
        return h(React.Fragment, null,
          h(Original, { ...props, node: showRaw ? node : patched }),
          h('div', { className: 'av-toggle' },
            h('button', { type: 'button', onClick: () => setShowRaw(v => !v) }, showRaw ? '查看人设版' : '查看原文')));
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
.av-toggle{margin:4px 0 2px}
.av-toggle button{font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:6px;padding:2px 6px;cursor:pointer}
.av-toggle button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
`;

    function SettingsPage() {
      const [data, setData] = React.useState(null);      // { settings, providers, defaultRules }
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState({ kind: 'idle' });
      const reload = React.useCallback(async () => {
        setStatus({ kind: 'loading' });
        try {
          const response = await fetch(SETTINGS_URL, { headers: { 'cache-control': 'no-store' } });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          setData(result);
          setDraft(result.settings);
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
      const known = data.providers.some(p => p.id === draft.provider && p.models.some(m => m.id === draft.model));
      async function save() {
        setStatus({ kind: 'saving' });
        try {
          const response = await fetch(SETTINGS_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || response.statusText);
          setData(d => ({ ...d, settings: result.settings }));
          setDraft(result.settings);
          setStatus({ kind: 'saved' });
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
            onChange: e => { const [provider = '', model = ''] = e.target.value.split('\n'); setDraft(d => ({ ...d, provider, model })); setStatus({ kind: 'idle' }); },
          },
            h('option', { value: '' }, '跟随当前会话的模型'),
            !known && draft.provider && h('option', { value: routeValue }, `${draft.provider} / ${draft.model}（当前不可用）`),
            data.providers.map(p => h('optgroup', { key: p.id, label: p.name },
              p.models.map(m => h('option', { key: m.id, value: p.id + '\n' + m.id }, m.name === m.id ? m.id : `${m.name}（${m.id}）`))))),
          h('div', { className: 'av-hint' }, '推荐选一个便宜、快的模型；会自动使用该模型最低的思考强度。')),

        h('div', { className: 'av-field' },
          h('label', null, '人设文件（可选）'),
          h('input', { type: 'text', value: draft.personaFile, placeholder: '/path/to/AGENTS.md', onChange: e => set('personaFile', e.target.value) }),
          h('div', { className: 'av-hint' }, '填写后优先从这个文件读取人设，每轮重新读取，改文件即生效。文件里有 <xxx_persona>…</xxx_persona> 块时只取这一块。')),

        h('div', { className: 'av-field' },
          h('label', null, '人设提示词'),
          h('textarea', { value: draft.persona, disabled: Boolean(draft.personaFile), placeholder: '你是……（描述角色的性格、说话方式、称呼等）', onChange: e => set('persona', e.target.value) }),
          draft.personaFile && h('div', { className: 'av-hint' }, '已填写人设文件，这里的文本不会被使用。')),

        h('div', { className: 'av-field' },
          h('label', null, '转述规则'),
          h('textarea', { value: draft.rules, onChange: e => set('rules', e.target.value) }),
          h('div', { className: 'av-actions' }, h('button', { type: 'button', onClick: () => set('rules', data.defaultRules) }, '恢复默认规则'))),

        h('div', { className: 'av-row' },
          number('fullTurns', '带原文的轮数', '最近几轮附带执行助手的原文'),
          number('maxTurns', '最多记忆轮数', '更早的对话不再发送'),
          number('maxTokens', '输出上限 (tokens)')),

        h('div', { className: 'av-actions' },
          h('button', { type: 'button', className: 'av-primary', disabled: !dirty || status.kind === 'saving', onClick: save }, status.kind === 'saving' ? '保存中…' : '保存'),
          h('button', { type: 'button', disabled: !dirty || status.kind === 'saving', onClick: () => { setDraft(data.settings); setStatus({ kind: 'idle' }); } }, '放弃修改'),
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
