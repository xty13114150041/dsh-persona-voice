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
    async function load(sessionId, turnId, signal) {
      const key = sessionId + '\n' + turnId;
      if (cache.has(key)) return cache.get(key);
      const url = '/api/local-persona-voice?session=' + encodeURIComponent(sessionId) + '&turn=' + encodeURIComponent(turnId);
      const response = await fetch(url, { signal, headers: { 'cache-control': 'no-store' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (result.status !== 'pending') cache.set(key, result);
      return result;
    }

    function useVoice(sessionId, turnId, active) {
      const key = active ? `${sessionId}\n${turnId}` : null;
      const [result, setResult] = React.useState(null);
      const [attempt, setAttempt] = React.useState(null);
      React.useEffect(() => {
        if (!key) return undefined;
        const manual = attempt?.key === key;
        const setState = state => setResult({ key, state });
        const controller = new AbortController();
        let timer;
        const deadline = setTimeout(() => {
          clearTimeout(timer);
          controller.abort();
          setState({ status: 'timeout' });
        }, manual ? 10_000 : 120_000);
        const poll = async () => {
          try {
            const result = await load(sessionId, String(turnId), controller.signal);
            if (controller.signal.aborted) return;
            if (result.status === 'pending' && !manual) timer = setTimeout(poll, 1500);
            else clearTimeout(deadline);
            setState(result.status === 'pending' && manual ? { status: 'timeout' } : result);
          } catch (reason) {
            if (controller.signal.aborted) return;
            clearTimeout(deadline);
            setState(manual ? { status: 'timeout' } : { status: 'error', error: reason.message });
          }
        };
        poll();
        return () => { controller.abort(); clearTimeout(timer); clearTimeout(deadline); };
      }, [sessionId, turnId, key, attempt]);
      const recheck = () => {
        setResult({ key, state: { status: 'checking' } });
        setAttempt({ key });
      };
      return [key && result?.key === key ? result.state : null, recheck];
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
        const [state, recheck] = useVoice(sessionId, turn?.turn, isFinal && turn?.turn !== undefined && !processPart);
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
          if (status === 'timeout' || status === 'checking') return { node, row: status };
          if (status === 'error') return { node: { ...node, data: { ...data, blocks: [...blocks, { kind: 'text', text: '\n> 人设版生成失败：' + state.error }] } }, row: null };
          return { node, row: null };
        }, [node, data, blocks, maybeFinal, isFinal, enabled, state]);

        // 思考那一行：只负责把原文折叠进来，不挂任何附加界面。
        if (processPart) return h(Original, { ...props, node: view.node });

        if (view.row === 'pending') {
          return h(React.Fragment, null, h(Original, { ...props, node: view.node }),
            h('div', { className: 'av-process' }, h('span', { className: 'av-shimmer' }, '🌸 正在组织语言…')));
        }
        if (view.row === 'timeout' || view.row === 'checking') {
          const checking = view.row === 'checking';
          return h(React.Fragment, null, h(Original, { ...props, node: view.node }),
            h('div', { className: 'av-process', role: 'status' }, checking ? '正在检查人设版…' : '暂未取得人设版，已显示原文。'),
            h('div', { className: 'av-toggle' },
              h('button', { type: 'button', disabled: checking, onClick: recheck }, '重新检查')));
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
    const COSTS_URL = '/api/local-persona-voice/costs';
    const COST_LOCALE = 'persona-voice.costs';
    const RATE_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];
    const costCopy = {
      zh: {
        title: '转述费用估算', today: '今日', total: '日志累计', refresh: '刷新用量', loading: '正在读取用量…',
        empty: '暂无用量', unpriced: '未计价', calls: '{calls} 次调用', excluded: '{unpriced} 次未计入金额',
        about: '只算人设转述的额外调用，不含主模型。估算不等于渠道实际扣费。',
        periodNote: '今日按主机时区统计；修改单价会重算历史费用。',
        anthropic5m: 'Anthropic 官方参考价 · 5 分钟缓存写入', deepseekPeak: 'DeepSeek 官方参考价 · 全部按峰时估算',
        custom: '自定义单价', notSet: '这个模型还没有设置单价', pickHint: '先选择一个模型，再查看或编辑它的单价。',
        invalidRate: '单价无效', invalidRateHint: '这组单价不计入估算。请选择币种，填齐四项非负单价后保存，或清除这组单价。',
        invalidRatesHint: '部分模型单价无效。展开「模型单价」即可修正。',
        modelSection: '转述模型与上下文', personaSection: '人设预设', advancedSection: '高级设置',
        enableRelay: '启用人设转述', enableHint: '开启后，每轮会额外调用一次模型。设置保存后从下一轮生效。',
        relayModel: '转述用的模型', followSession: '跟随当前会话的模型', unavailableModel: '当前不可用',
        catalogRefresh: '刷新模型列表', catalogLoading: '正在读取模型目录…', catalogUpdated: '列表更新于 {at}',
        catalogError: '读取模型目录失败：{error}', catalogCached: '（显示上次的列表）',
        catalogHint: '与对话中的模型菜单一致。增删模型后，可以手动刷新列表。', catalogUnavailable: '暂时不可用：{names}',
        effort: '思考强度', effortAuto: '自动（能关就关，否则最低档）', effortUnsupported: '该模型不支持',
        effortFollow: '跟随会话模型时自动选择；指定模型后可手动设置。',
        effortNone: '这个模型没有可调的思考强度。', effortHint: '转述一般不需要深度思考；调高会更慢、更贵。',
        activePreset: '使用中的预设', noPresetName: '（未命名）', newPreset: '人设 {index}', addPreset: '新建', removePreset: '删除',
        confirmPreset: '删除预设「{name}」？', presetHint: '保存后，选中的预设从下一轮生效。切换人设后，前几轮可能还带着旧人设的说话习惯。',
        presetName: '预设名称', personaFile: '人设文件（可选）', personaFileHint: '填写后每轮从文件读取，优先使用其中的 {tag} 块。',
        personaText: '人设提示词', personaPlaceholder: '你是……（描述角色的性格、说话方式、称呼等）', personaFileOverride: '已填写人设文件，这里的文本不会被使用。',
        rules: '转述规则', resetRules: '恢复默认规则', reminder: '每轮提醒', reminderPlaceholder: '留空则不附加', resetReminder: '恢复默认提醒',
        reminderHint: '附在每条用户消息末尾，帮助保持人设。修改后会有一轮缓存失效。',
        contextScope: '转述上下文', contextCurrent: '仅本轮对话', contextRecent: '近 5 轮对话（含本轮）', contextAll: '全部对话',
        contextLegacy: '沿用旧设置（最多 {count} 轮历史）',
        contextHint: '只影响之后的转述，不改变主模型或已有费用估算。历史只取自当前会话已有的转述记录。',
        contextLongHint: '带入较多历史可能增加转述费用，或超过模型的上下文上限。',
        maxTokens: '输出上限（Token）',
        settingsLoading: '正在读取设置…', settingsLoadError: '读取设置失败：{error}',
        saveSettings: '保存转述设置', discard: '放弃修改', settingsSaved: '已保存，下一轮生效', unsaved: '有未保存的转述设置',
        pageTitle: '人设转述', pageIntro: '用你设定的人设口吻改写每轮最终回复。原文仍可在思考过程里查看。',
        edit: '模型单价', route: '计费模型', pick: '选择要查看单价的模型', used: '有用量或已设置单价', modelTotal: '该模型累计',
        unpricedHint: '缺少单价或用量的调用不计入估算。可在下方补充单价。', retry: '重试',
        currency: '币种', input: '未缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出',
        rates: '单位：每百万 Token。不收费或不适用的项填 0。单价需单独保存，不会改变转述用的模型。',
        save: '保存单价', saving: '保存中…', remove: '清除单价', saved: '单价已保存，估算已更新', removed: '单价已清除',
        missing: '请填写四项非负单价。', loadError: '读取转述费用失败，请重试。', saveError: '保存单价失败，请重试。',
      },
      en: {
        title: 'Relay cost estimate', today: 'Today', total: 'Log total', refresh: 'Refresh usage', loading: 'Loading usage…',
        empty: 'No usage yet', unpriced: 'Not priced', calls: 'Calls: {calls}', excluded: 'Excluded from estimate: {unpriced}',
        about: 'Only extra persona relay calls, not the main model. Estimates are not provider bills.',
        periodNote: 'Today uses the host time zone. New rates also reprice past usage.',
        anthropic5m: 'Anthropic API list price · 5-minute cache writes', deepseekPeak: 'DeepSeek API list price · all calls at peak rates',
        custom: 'Custom rates', notSet: 'No rates set for this model', pickHint: 'Choose a model to view or edit its rates.',
        invalidRate: 'Invalid rates', invalidRateHint: 'These rates are excluded from the estimate. Choose a currency and enter four non-negative rates, or clear these rates.',
        invalidRatesHint: 'Some model rates are invalid. Open Model rates to fix them.',
        modelSection: 'Relay model and context', personaSection: 'Persona presets', advancedSection: 'Advanced settings',
        enableRelay: 'Enable persona relay', enableHint: 'Adds one extra model call per turn. Saved settings take effect from the next turn.',
        relayModel: 'Model used for relay', followSession: 'Follow the session model', unavailableModel: 'Unavailable',
        catalogRefresh: 'Refresh models', catalogLoading: 'Loading models…', catalogUpdated: 'Updated {at}',
        catalogError: 'Could not load models: {error}', catalogCached: ' (showing the previous list)',
        catalogHint: 'Uses the same models as the chat picker. Refresh after adding or removing models.', catalogUnavailable: 'Temporarily unavailable: {names}',
        effort: 'Reasoning effort', effortAuto: 'Auto (off if available, otherwise lowest)', effortUnsupported: 'Not supported',
        effortFollow: 'Chosen automatically when following the session model. Select a model to set it manually.',
        effortNone: 'This model has no adjustable reasoning effort.', effortHint: 'Higher effort is slower and costs more. Relay usually needs little reasoning.',
        activePreset: 'Active preset', noPresetName: '(Unnamed)', newPreset: 'Persona {index}', addPreset: 'New', removePreset: 'Delete',
        confirmPreset: 'Delete the preset “{name}”?', presetHint: 'The selected preset takes effect on the next turn after saving. A few turns may still reflect the previous voice.',
        presetName: 'Preset name', personaFile: 'Persona file (optional)', personaFileHint: 'Read on each turn. If the file has a {tag} block, only that block is used.',
        personaText: 'Persona prompt', personaPlaceholder: 'Describe the persona’s voice, traits, and preferred forms of address.', personaFileOverride: 'The persona file takes precedence over this prompt.',
        rules: 'Relay rules', resetRules: 'Restore default rules', reminder: 'Per-turn reminder', reminderPlaceholder: 'Leave blank to omit', resetReminder: 'Restore default reminder',
        reminderHint: 'Appended to each user message to maintain the voice. Changing it invalidates the cache for one turn.',
        contextScope: 'Relay context', contextCurrent: 'Current turn only', contextRecent: 'Last 5 turns (including this one)', contextAll: 'All turns',
        contextLegacy: 'Previous setting (up to {count} earlier turns)',
        contextHint: 'Applies only to future relays, not the main model or past estimates. Earlier turns come from saved relay history in this conversation.',
        contextLongHint: 'Sending more history can increase relay costs or exceed the model’s context limit.',
        maxTokens: 'Output limit (tokens)',
        settingsLoading: 'Loading settings…', settingsLoadError: 'Could not load settings: {error}',
        saveSettings: 'Save relay settings', discard: 'Discard changes', settingsSaved: 'Saved for the next turn', unsaved: 'Unsaved relay settings',
        pageTitle: 'Persona relay', pageIntro: 'Rewrite each final reply in your persona’s voice. The original is still available in the thinking panel.',
        edit: 'Model rates', route: 'Model to price', pick: 'Choose a model to price', used: 'Models with usage or saved rates', modelTotal: 'Model total',
        unpricedHint: 'Calls with no rate or reported usage are excluded. Add missing rates below.', retry: 'Retry',
        currency: 'Currency', input: 'Uncached input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output',
        rates: 'Per million tokens. Use 0 for free or inapplicable categories. Save rates separately; they do not change the relay model.',
        save: 'Save rates', saving: 'Saving…', remove: 'Clear rates', saved: 'Rates saved and estimates updated', removed: 'Rates cleared',
        missing: 'Enter four non-negative rates.', loadError: 'Could not load relay costs. Try again.', saveError: 'Could not save the rates. Try again.',
      },
    };
    const css = `
.av-page{max-width:720px;padding:4px 0;color:var(--dsw-alias-label-primary)}
.av-page h2{margin:0 0 4px;font-size:20px;font-weight:600}
.av-page-intro{margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55}
.av-form{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;font-size:13px}
.av-card{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.av-card h3{margin:0;font-size:14px;font-weight:600}
.av-field{display:flex;min-width:0;flex-direction:column;gap:6px}
.av-field>label,.av-field>span{font-weight:500}
.av-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;overflow-wrap:anywhere}
.av-form input[type=text],.av-form input[type=number],.av-form select,.av-form textarea{box-sizing:border-box;min-width:0;width:100%;min-height:36px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
.av-form textarea{min-height:140px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.5;resize:vertical}
.av-form :is(button,summary,input,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.av-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:12px}
.av-overview,.av-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 16px;flex-wrap:wrap}
.av-overview{align-items:center}.av-overview .av-hint{margin-top:4px}
.av-switch{position:relative;display:flex;align-items:center;cursor:pointer}
.av-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.av-switch-track{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);border:1px solid var(--dsw-alias-border-l2);display:flex;align-items:center;padding:2px;box-sizing:border-box}
.av-switch-track::after{content:'';width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base)}
.av-switch input:checked + .av-switch-track{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);justify-content:flex-end}
.av-switch input:focus-visible + .av-switch-track{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.av-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.av-actions button{font:inherit;min-height:32px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);color:inherit;cursor:pointer}
.av-actions button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}
.av-actions .av-primary,.av-actions .av-primary:not(:disabled):hover{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base))}
.av-actions .av-primary:not(:disabled):hover{filter:brightness(.94)}
.av-actions button:disabled{opacity:.5;cursor:default}
.av-error{color:var(--dsw-alias-state-error-primary)}.av-ok{color:var(--dsw-alias-state-success-primary)}
.av-cost{container-type:inline-size}
.av-cost .av-card-head .av-hint{margin-top:4px}
.av-cost dl,.av-cost dd{margin:0}
.av-rate-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
@container (max-width:340px){.av-rate-grid{grid-template-columns:minmax(0,1fr)}}
.av-metric{min-width:0;padding:12px 14px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3)}
.av-metric dt{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.av-metric dd{margin-top:4px}
.av-amount{display:block;font-size:clamp(18px,3vw,24px);font-weight:650;line-height:1.25;letter-spacing:-.02em;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.av-amount-muted{font-size:14px;color:var(--dsw-alias-label-tertiary)}
.av-metric .av-hint{display:block;margin-top:4px}
.av-cost details{padding-top:10px;border-top:1px solid var(--dsw-alias-border-l3)}
.av-card.av-details{display:block}
.av-details>summary{width:fit-content;cursor:pointer;font-weight:600;line-height:1.75}
.av-details[open]>summary{margin-bottom:12px}
.av-rate-form,.av-advanced{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.av-rate-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.av-badge{padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.av-footer{padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l3)}
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

    function CostPanel({ groups, provider, model, t }) {
      const id = React.useId();
      const [summary, setSummary] = React.useState(null);
      const [selection, setSelection] = React.useState(null);
      const [edit, setEdit] = React.useState(null);
      const [phase, setPhase] = React.useState('load');
      const busy = phase !== null;
      const [message, setMessage] = React.useState(null);
      const request = React.useCallback(async (body, success) => {
        setPhase(body ? 'save' : 'load');
        setMessage(null);
        try {
          const response = await fetch(COSTS_URL, body ? {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          } : undefined);
          if (!response.ok) throw new Error(response.statusText);
          setSummary(await response.json());
          if (success) {
            if (!body.rate) setSelection(null);
            setEdit(null);
            setMessage({ key: success });
          }
        } catch {
          setMessage({ key: body ? 'saveError' : 'loadError', error: true });
        } finally {
          setPhase(null);
        }
      }, []);
      React.useEffect(() => { request(); }, [request]);

      const keyOf = (p, m) => JSON.stringify([p, m]);
      const rows = summary?.rows ?? [];
      const used = new Map(rows.map(row => [keyOf(row.provider, row.model), `${row.provider} / ${row.model}${row.rate ? '' : ` · ${t(row.rateInvalid ? 'invalidRate' : 'unpriced')}`}`]));
      const current = provider && keyOf(provider, model);
      if (current && !used.has(current) && !groups.some(p => p.id === provider && p.models.some(m => m.id === model))) {
        used.set(current, `${provider} / ${model}`);
      }
      const invalidRow = rows.find(row => row.rateInvalid);
      const defaultRow = rows.find(row => !row.rate) ?? rows[0];
      const route = selection ?? (invalidRow ? keyOf(invalidRow.provider, invalidRow.model) : current || (defaultRow ? keyOf(defaultRow.provider, defaultRow.model) : ''));
      const row = rows.find(r => keyOf(r.provider, r.model) === route);
      const saved = row?.rate;
      const rate = edit ?? saved ?? { currency: 'USD' };
      const change = (key, value) => { setSelection(route); setEdit({ ...rate, [key]: value }); setMessage(null); };
      const applyRate = next => {
        const [provider, model] = JSON.parse(route);
        if (next && !RATE_FIELDS.every(key => String(next[key] ?? '').trim() && Number.isFinite(Number(next[key])) && Number(next[key]) >= 0)) {
          setMessage({ key: 'missing', error: true });
          return;
        }
        setSelection(route);
        request({ provider, model, rate: next }, next ? 'saved' : 'removed');
      };
      const money = (amount, currency) => new Intl.NumberFormat(undefined, {
        style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: amount > 0 && amount < 0.01 ? 6 : 2,
      }).format(amount);
      const amountText = (amount, currency) => amount > 0 && amount < 0.000001 ? '< ' + money(0.000001, currency) : money(amount, currency);
      const callsText = totals => [t('calls', totals), totals.unpriced > 0 && t('excluded', totals)].filter(Boolean).join(' · ');
      const periodView = (label, totals) => {
        const amounts = Object.entries(totals.amounts);
        return h('div', { key: label, className: 'av-metric' },
          h('dt', null, t(label)),
          h('dd', null,
            amounts.length ? amounts.map(([currency, amount]) => h('span', { key: currency, className: 'av-amount' }, amountText(amount, currency)))
              : h('span', { className: 'av-amount av-amount-muted' }, t(totals.calls ? 'unpriced' : 'empty')),
            totals.calls > 0 && h('span', { className: 'av-hint' }, callsText(totals))));
      };
      const feedback = message && h('div', { role: message.error ? 'alert' : 'status', className: message.error ? 'av-error' : 'av-ok' }, t(message.key));
      return h('section', { className: 'av-card av-cost', 'aria-labelledby': `${id}-title` },
        h('div', { className: 'av-card-head' },
          h('div', null, h('h3', { id: `${id}-title` }, t('title')), h('div', { className: 'av-hint' }, t('about'))),
          h('div', { className: 'av-actions' }, h('button', { type: 'button', disabled: busy, onClick: () => request() },
            t(message?.key === 'loadError' ? 'retry' : 'refresh')))),
        phase === 'load' && h('div', { className: 'av-hint', role: 'status' }, t('loading')),
        summary && h('dl', { className: 'av-grid', 'aria-live': 'polite', 'aria-busy': busy }, periodView('today', summary.today), periodView('total', summary.total)),
        summary && h('div', { className: 'av-hint' }, t('periodNote'),
           summary.total.unpriced > 0 && h('div', null, t('unpricedHint')),
           invalidRow && h('div', { className: 'av-error', role: 'status' }, t('invalidRatesHint'))),
        message?.key === 'loadError' && feedback,
        summary && h('details', { className: 'av-details' },
          h('summary', null, t('edit')),
          h('form', { className: 'av-rate-form', onSubmit: e => { e.preventDefault(); if (route && !busy && edit) applyRate(rate); } },
            h('label', { className: 'av-field' }, h('span', null, t('route')),
              h('select', { value: route, disabled: busy, onChange: e => { setSelection(e.target.value); setEdit(null); setMessage(null); } },
                h('option', { value: '' }, t('pick')),
                used.size > 0 && h('optgroup', { label: t('used') }, [...used].map(([key, label]) => h('option', { key, value: key }, label))),
                groups.map(p => {
                  const models = p.models.filter(m => !used.has(keyOf(p.id, m.id)));
                  return models.length > 0 && h('optgroup', { key: p.id, label: p.name }, models.map(m => h('option', {
                    key: m.id, value: keyOf(p.id, m.id),
                  }, m.name === m.id ? m.id : `${m.name} (${m.id})`)));
                }))),
            route ? h(React.Fragment, null,
              h('div', { className: 'av-rate-meta' },
                h('span', { className: 'av-badge' }, t(row?.rateInvalid ? 'invalidRate' : saved?.source ?? (saved ? 'custom' : 'notSet'))),
                row?.total.calls > 0 && h('span', { className: 'av-hint' }, t('modelTotal'), ': ',
                  row.total.cost === null ? t('unpriced') : amountText(row.total.cost, saved.currency), ' · ', callsText(row.total))),
              row?.rateInvalid && h('div', { className: 'av-hint' }, t('invalidRateHint')),
               h('div', { className: 'av-hint', id: `${id}-units` }, t('rates')),
              h('label', { className: 'av-field' }, h('span', null, t('currency')),
                h('select', { value: rate.currency, disabled: busy, onChange: e => change('currency', e.target.value) },
                  h('option', { value: 'USD' }, 'USD'), h('option', { value: 'CNY' }, 'CNY'))),
              h('div', { className: 'av-grid av-rate-grid' }, RATE_FIELDS.map(key => h('label', { key, className: 'av-field' }, h('span', null, t(key)),
                h('input', { type: 'number', min: 0, step: 'any', required: true, 'aria-describedby': `${id}-units`, value: rate[key] ?? '', disabled: busy, onChange: e => change(key, e.target.value) })))),
              h('div', { className: 'av-actions' },
                h('button', { type: 'submit', disabled: busy || !edit }, t(phase === 'save' ? 'saving' : 'save')),
                (saved || row?.rateInvalid) && h('button', { type: 'button', disabled: busy, onClick: () => applyRate(null) }, t('remove'))))
              : h('div', { className: 'av-hint' }, t('pickHint')),
            message?.key !== 'loadError' && feedback)));
    }

    function SettingsPage({ t }) {
      const id = React.useId();
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
          ? h('div', { className: 'av-error' }, t('settingsLoadError', { error: status.message }))
          : h('div', { className: 'av-hint' }, t('settingsLoading')));
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
        while (draft.presets.some(p => p.name === t('newPreset', { index: n }))) n++;
        const name = t('newPreset', { index: n });
        setDraft(d => ({ ...d, presets: [...d.presets, { name, personaFile: '', persona: '' }], activePreset: name }));
        setSel(draft.presets.length);
        setStatus({ kind: 'idle' });
      };
      const removePreset = () => {
        if (!window.confirm(t('confirmPreset', { name: preset.name }))) return;
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
      return h('div', { className: 'av-form' },
        h('section', { className: 'av-card', 'aria-labelledby': `${id}-enabled` },
          h('div', { className: 'av-overview' },
            h('div', null,
              h('h3', { id: `${id}-enabled` }, t('enableRelay')),
              h('div', { className: 'av-hint', id: `${id}-enabled-hint` }, t('enableHint'))),
            h('label', { className: 'av-switch' },
              h('input', { type: 'checkbox', role: 'switch', checked: draft.enabled, 'aria-labelledby': `${id}-enabled`, 'aria-describedby': `${id}-enabled-hint`, onChange: e => set('enabled', e.target.checked) }),
              h('span', { className: 'av-switch-track', 'aria-hidden': 'true' })))),

        h('section', { className: 'av-card', 'aria-labelledby': `${id}-model-title` },
          h('h3', { id: `${id}-model-title` }, t('modelSection')),
          h('div', { className: 'av-field' },
            h('label', { htmlFor: `${id}-model` }, t('relayModel')),
            h('select', {
              id: `${id}-model`,
              value: routeValue,
              onChange: e => { const [provider = '', model = ''] = e.target.value.split('\n'); setDraft(d => ({ ...d, provider, model, effort: '' })); setStatus({ kind: 'idle' }); },
            },
              h('option', { value: '' }, t('followSession')),
              catalog && !known && draft.provider && h('option', { value: routeValue }, `${draft.provider} / ${draft.model} · ${t('unavailableModel')}`),
              groups.map(p => h('optgroup', { key: p.id, label: p.name },
                p.models.map(m => h('option', { key: m.id, value: p.id + '\n' + m.id }, m.name === m.id ? m.id : `${m.name} (${m.id})`))))),
            h('div', { className: 'av-actions' },
              h('button', { type: 'button', disabled: refreshing, onClick: refreshCatalog }, t(refreshing ? 'catalogLoading' : 'catalogRefresh')),
              h('span', { className: 'av-hint' }, catalog?.at ? t('catalogUpdated', { at: timeText(catalog.at) }) : '')),
            h('div', { className: 'av-hint' }, catalog === null ? t('catalogLoading')
              : catalog.error ? t('catalogError', { error: catalog.error }) + (catalog.groups.length ? t('catalogCached') : '')
              : t('catalogHint')),
            catalog?.failures?.length > 0 && h('div', { className: 'av-hint' }, t('catalogUnavailable', { names: catalog.failures.map(f => f.name).join(', ') }))),

          h('div', { className: 'av-field' },
            h('label', { htmlFor: `${id}-effort` }, t('effort')),
            h('select', { id: `${id}-effort`, value: draft.effort, disabled: !draft.provider || efforts.length === 0, onChange: e => set('effort', e.target.value) },
              h('option', { value: '' }, t('effortAuto')),
              draft.effort && !efforts.some(e => e.id === draft.effort) && h('option', { value: draft.effort }, `${draft.effort} · ${t('effortUnsupported')}`),
              efforts.map(e => h('option', { key: e.id, value: e.id }, e.name && e.name !== e.id ? `${e.name} (${e.id})` : e.id))),
            h('div', { className: 'av-hint' }, !draft.provider ? t('effortFollow')
              : efforts.length === 0 ? t('effortNone')
              : t('effortHint'))),

          h('div', { className: 'av-field' },
            h('label', { htmlFor: `${id}-context` }, t('contextScope')),
            h('select', {
              id: `${id}-context`, value: draft.contextScope, disabled: status.kind === 'saving',
              'aria-describedby': `${id}-context-hint`, onChange: e => set('contextScope', e.target.value),
            },
              data.settings.contextScope === 'legacy' && h('option', { value: 'legacy' }, t('contextLegacy', { count: draft.maxTurns })),
              h('option', { value: 'current' }, t('contextCurrent')),
              h('option', { value: 'recent5' }, t('contextRecent')),
              h('option', { value: 'all' }, t('contextAll'))),
            h('div', { className: 'av-hint', id: `${id}-context-hint` }, t('contextHint'),
              (draft.contextScope === 'all' || draft.contextScope === 'legacy') && h('div', null, t('contextLongHint'))))),
        h(CostPanel, { groups, provider: draft.provider, model: draft.model, t }),

        h('section', { className: 'av-card', 'aria-labelledby': `${id}-persona-title` },
          h('h3', { id: `${id}-persona-title` }, t('personaSection')),
          h('div', { className: 'av-field' },
            h('label', { htmlFor: `${id}-preset` }, t('activePreset')),
            h('div', { className: 'av-actions' },
              h('select', { id: `${id}-preset`, value: sel, style: { flex: '1 1 160px' }, onChange: e => { const i = Number(e.target.value); setSel(i); set('activePreset', draft.presets[i].name); } },
                draft.presets.map((p, i) => h('option', { key: i, value: i }, p.name || t('noPresetName')))),
              h('button', { type: 'button', onClick: addPreset }, t('addPreset')),
              h('button', { type: 'button', disabled: draft.presets.length < 2, onClick: removePreset }, t('removePreset'))),
            h('div', { className: 'av-hint' }, t('presetHint'))),

          h('div', { className: 'av-grid' },
            h('label', { className: 'av-field' },
              h('span', null, t('presetName')),
              h('input', { type: 'text', value: preset.name, onChange: e => updatePreset({ name: e.target.value }) })),
            h('label', { className: 'av-field' },
              h('span', null, t('personaFile')),
              h('input', { type: 'text', value: preset.personaFile, placeholder: '/path/to/AGENTS.md', 'aria-describedby': `${id}-persona-file-hint`, onChange: e => updatePreset({ personaFile: e.target.value }) }))),
          h('div', { className: 'av-hint', id: `${id}-persona-file-hint` }, t('personaFileHint', { tag: '<xxx_persona>…</xxx_persona>' })),
          h('div', { className: 'av-field' },
            h('label', { htmlFor: `${id}-persona` }, t('personaText')),
            h('textarea', { id: `${id}-persona`, value: preset.persona, disabled: Boolean(preset.personaFile), placeholder: t('personaPlaceholder'), onChange: e => updatePreset({ persona: e.target.value }) }),
            preset.personaFile && h('div', { className: 'av-hint' }, t('personaFileOverride')))),

        h('details', { className: 'av-card av-details' },
          h('summary', null, t('advancedSection')),
          h('div', { className: 'av-advanced' },
            h('div', { className: 'av-field' },
              h('label', { htmlFor: `${id}-rules` }, t('rules')),
              h('textarea', { id: `${id}-rules`, value: draft.rules, onChange: e => set('rules', e.target.value) }),
              h('div', { className: 'av-actions' }, h('button', { type: 'button', onClick: () => set('rules', data.defaultRules) }, t('resetRules')))),

            h('div', { className: 'av-field' },
              h('label', { htmlFor: `${id}-reminder` }, t('reminder')),
              h('input', { id: `${id}-reminder`, type: 'text', value: draft.reminder, placeholder: t('reminderPlaceholder'), onChange: e => set('reminder', e.target.value) }),
              h('div', { className: 'av-hint' }, t('reminderHint')),
              h('div', { className: 'av-actions' }, h('button', { type: 'button', onClick: () => set('reminder', data.defaultReminder) }, t('resetReminder')))),

            h('label', { className: 'av-field' },
              h('span', null, t('maxTokens')),
              h('input', { type: 'number', value: draft.maxTokens, onChange: e => set('maxTokens', e.target.value) })))),

        h('div', { className: 'av-actions av-footer' },
          h('button', { type: 'button', className: 'av-primary', disabled: !dirty || status.kind === 'saving', onClick: save }, t(status.kind === 'saving' ? 'saving' : 'saveSettings')),
          h('button', { type: 'button', disabled: !dirty || status.kind === 'saving', onClick: () => { resetDraft(data.settings); setStatus({ kind: 'idle' }); } }, t('discard')),
          status.kind === 'saved' && h('span', { className: 'av-ok', role: 'status' }, t('settingsSaved')),
          status.kind === 'error' && h('span', { className: 'av-error', role: 'alert' }, status.message),
          dirty && status.kind === 'idle' && h('span', { className: 'av-hint' }, t('unsaved'))));
    }

    function SettingsSection({ t }) {
      return h('div', { className: 'av-page' },
        h('h2', null, t('pageTitle')),
        h('p', { className: 'av-page-intro' }, t('pageIntro')),
        h(SettingsPage, { t }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(COST_LOCALE, costCopy));
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
          locale: COST_LOCALE,
          label: () => ctx.locale.bind(COST_LOCALE)('pageTitle'),
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
