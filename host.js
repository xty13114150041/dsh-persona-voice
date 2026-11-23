// 宿主端：每轮结束后，后台调用一次"人设 agent"（B），把执行 agent（A）的最终回答转述成人设口吻，
// 结果按会话存成 JSON 文件；设置保存在 settings.json，由插件设置页读写，改完下一轮即生效。
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildRequest, DEFAULT_RULES, DEFAULT_REMINDER } from './model.js';
import { normalizeRate, summarizeCosts } from './cost.js';

const readIfPresent = file => fs.readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});

export async function costResponse(request, dir) {
  const file = path.join(dir, 'rates.json');
  const saved = await readIfPresent(file);
  const rates = saved ? JSON.parse(saved) : {};
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('Invalid rates file.');
  const valid = Object.fromEntries(Object.entries(rates).map(([key, value]) => {
    try { return [key, normalizeRate(value)]; } catch { return [key, null]; }
  }));
  if (request.method === 'POST') {
    const { provider, model, rate } = await request.json();
    if (![provider, model].every(id => typeof id === 'string' && id.trim())) throw new Error('Choose a provider and model.');
    const key = JSON.stringify([provider, model]);
    if (rate === null) {
      delete rates[key];
      delete valid[key];
    } else {
      const next = normalizeRate({ ...rate, source: undefined });
      const previous = valid[key];
      if (!previous || Object.keys(next).some(field => next[field] !== previous[field])) rates[key] = valid[key] = next;
    }
  }
  const summary = summarizeCosts(await readIfPresent(path.join(dir, 'debug.log')), valid);
  if (request.method === 'POST') await writeJson(file, rates);
  return summary;
}

async function writeJson(file, value) {
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 1));
  await fs.rename(file + '.tmp', file);
}

export const inject = ['llm', 'connection'];

const dshHome = process.env.DSH_HOME?.trim();
const DATA_DIR = path.resolve(dshHome || path.join(homedir(), '.dsh'), 'persona-voice');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  enabled: false,
  provider: '',        // provider 与 model 都留空：沿用该会话 A 正在用的模型
  model: '',
  effort: '',          // 思考强度：留空=自动（有 off 用 off，否则最低档）
  // 人设预设：每个预设可填文件路径（优先）或直接粘贴提示词；activePreset 是当前使用的预设名。
  presets: [{ name: '默认', personaFile: '', persona: '' }],
  activePreset: '默认',
  rules: DEFAULT_RULES,
  reminder: DEFAULT_REMINDER,  // 附在每条用户消息末尾的固定提醒
  maxTokens: 2048,
  contextScope: 'recent5',
  maxTurns: 40,       // 只用于沿用旧版设置
};

const INT_LIMITS = { maxTokens: [256, 32768], maxTurns: [2, 200] };

/** 校验并规整设置；不合法时抛错，提示给设置页。 */
export function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const contextScope = input?.contextScope ?? (input?.maxTurns !== undefined ? 'legacy' : DEFAULT_SETTINGS.contextScope);
  if (!['current', 'recent5', 'all', 'legacy'].includes(contextScope)) throw new Error('Invalid relay context scope');
  const out = {
    contextScope,
    enabled: Boolean(s.enabled),
    provider: String(s.provider ?? '').trim(),
    model: String(s.model ?? '').trim(),
    presets: normalizePresets(input?.presets, s),
    rules: String(s.rules ?? ''),
    reminder: String(s.reminder ?? ''),
    effort: String(s.effort ?? '').trim(),
  };
  const active = String(s.activePreset ?? '').trim();
  out.activePreset = out.presets.some(p => p.name === active) ? active : out.presets[0].name;
  if (Boolean(out.provider) !== Boolean(out.model)) throw new Error('provider 和 model 要么都填，要么都留空');
  for (const [key, [min, max]] of Object.entries(INT_LIMITS)) {
    const value = Number(s[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 需要是 ${min}–${max} 之间的整数`);
    out[key] = value;
  }
  return out;
}

/** 规整人设预设；旧版设置（顶层 personaFile/persona）迁移成一个"默认"预设。 */
function normalizePresets(presets, legacy) {
  if (!Array.isArray(presets) || presets.length === 0) {
    return [{ name: '默认', personaFile: String(legacy.personaFile ?? '').trim(), persona: String(legacy.persona ?? '') }];
  }
  const out = presets.map(p => ({
    name: String(p?.name ?? '').trim(),
    personaFile: String(p?.personaFile ?? '').trim(),
    persona: String(p?.persona ?? ''),
  }));
  const names = new Set();
  for (const p of out) {
    if (!p.name) throw new Error('预设名称不能为空');
    if (names.has(p.name)) throw new Error(`预设名称重复：${p.name}`);
    names.add(p.name);
  }
  return out;
}

/** 文件里有 <xxx_persona>…</xxx_persona> 这样的块时只取这一块，否则取全文。 */
export function extractPersona(text) {
  const match = text.match(/<(\w*persona)>[\s\S]*?<\/\1>/);
  return match ? match[0] : text;
}

export async function apply(ctx, config = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const pending = new Map();   // `${sessionId}:${turn}` -> 本次生成的标记
  const queues = new Map();    // sessionId -> 串行队列，保证同一会话按顺序写
  const activeTurns = new WeakMap();

  // 首次运行：用 cordis 配置（如有）作为初始设置。
  async function readSettings() {
    try {
      return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') debug(`settings unreadable, using defaults: ${error.message}`);
      return normalizeSettings({ ...config });
    }
  }
  const fileOf = sessionId => path.join(DATA_DIR, sessionId.replace(/[^\w.-]/g, '_') + '.json');
  async function readTurns(sessionId) {
    try { return JSON.parse(await fs.readFile(fileOf(sessionId), 'utf8')); } catch { return []; }
  }

  async function loadPersona(settings) {
    const preset = settings.presets.find(p => p.name === settings.activePreset);
    if (preset.personaFile) return extractPersona(await fs.readFile(preset.personaFile, 'utf8'));
    return preset.persona;
  }

  // 调试日志：~/.dsh/persona-voice/debug.log
  function debug(line) {
    fs.appendFile(path.join(DATA_DIR, 'debug.log'), `${new Date().toISOString()} ${line}\n`).catch(() => {});
  }

  // 推理强度：设置了且该模型支持就用设置值；否则自动选最省的（有 off 用 off，没有就第一档）；模型不支持推理强度则不传。
  async function pickEffort(providerId, modelId, wanted = '') {
    try {
      // 与官方模型目录相同的来源：resolveModelInfo 给出该模型的推理强度。
      const info = await withTimeout(ctx.llm.resolveModelInfo(providerId, modelId), 5000, `resolveModelInfo(${providerId}/${modelId}) timed out`);
      const efforts = info?.reasoning?.efforts?.map(e => e.id);
      if (!efforts?.length) return undefined;
      if (wanted && efforts.includes(wanted)) return wanted;
      if (wanted) debug(`effort "${wanted}" not supported by ${providerId}/${modelId}; using auto`);
      return efforts.includes('off') ? 'off' : efforts[0];
    } catch (error) {
      debug(`resolveModelInfo failed: ${error?.message ?? error}`);
      return undefined;
    }
  }

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
      .finally(() => clearTimeout(timer));
  }

  function textOf(message) {
    return (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  // 真人消息事件没有 turn 字段；只在明确的 turn/start、turn/end 之间收集。
  // 压缩会改变模型可见历史，但不会改变已经提交的本轮事件。
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      if (session.header?.origin === 'subagent') return;
      activeTurns.set(session, { turn: event.data.turn, user: '', raw: '' });
      return;
    }
    const current = activeTurns.get(session);
    if (!current) return;
    if (event.type === 'turn/end' && event.data.turn === current.turn) {
      activeTurns.delete(session);
    } else if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const text = textOf(event.data);
      if (text) current.user = current.user ? `${current.user}\n\n${text}` : text;
    } else if (event.type === 'assistant/message' && event.data.turn === current.turn) {
      current.raw = textOf(event.data.message);
    }
  });

  async function generate(sessionId, current, sessionRoute, key, generation, settings) {
    const { turn, user, raw } = current;
    const persona = (await loadPersona(settings)).trim();
    if (!persona) { debug('skip: persona empty'); return; }
    const route = settings.provider ? { provider: settings.provider, model: settings.model } : sessionRoute;
    const history = settings.contextScope === 'current' ? [] : (await readTurns(sessionId))
      .filter(t => t.turn < turn && t.voice).sort((a, b) => a.turn - b.turn);
    const request = buildRequest({
      persona, rules: settings.rules || DEFAULT_RULES, reminder: settings.reminder, history,
      current, contextScope: settings.contextScope, maxTurns: settings.maxTurns,
    });

    const reasoningEffort = await pickEffort(route.provider, route.model, settings.effort);
    debug(`turn ${key} route=${route.provider}/${route.model} effort=${reasoningEffort ?? '(none)'}`);
    const call = await ctx.llm.prepareCall({
      provider: route.provider, model: route.model, maxTokens: settings.maxTokens,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
    const source = { kind: 'model', provider: route.provider, model: route.model };
    const wire = request.messages.map(m => m.role === 'user'
      ? { role: 'user', content: [{ type: 'text', text: m.content }] }
      : { role: 'assistant', content: [{ type: 'text', text: m.content }], source });

    let voice = '';
    let finish;
    let usage;
    try {
      for await (const chunk of call.stream({ ...call.config, system: request.system, messages: wire, purpose: 'persona-voice' })) {
        if (chunk.type === 'text-delta') voice += chunk.text;
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') finish = chunk.reason;
      }
    } finally {
      // 失败或结果被后续生成替换，也可能已经产生费用。每次用量独立附上实际调用的渠道与模型。
      debug(`usage ${key} in=${usage?.inputTokens ?? '?'} cacheRead=${usage?.cacheReadTokens ?? 0} cacheWrite=${usage?.cacheWriteTokens ?? 0} out=${usage?.outputTokens ?? '?'} finish=${finish?.kind ?? '?'} route=${JSON.stringify([call.config.provider, call.config.model])}`);
    }
    if (pending.get(key) !== generation) return;   // 同一轮被 steer 又触发，旧结果作废
    const ok = finish?.kind === 'stop' || finish?.kind === 'max-tokens';
    const record = ok && voice.trim()
      ? { turn, user, raw, voice: voice.trim(), at: new Date().toISOString() }
      : { turn, user, raw, error: `生成失败：${finish?.kind ?? 'unknown'}`, at: new Date().toISOString() };
    const turns = (await readTurns(sessionId)).filter(t => t.turn !== turn);
    turns.push(record);
    if (pending.get(key) === generation) await writeJson(fileOf(sessionId), turns);
  }

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent.session?.header?.origin === 'subagent') return;
    const tracked = activeTurns.get(agent.session);
    if (tracked?.turn !== turn) return;
    const sessionId = agent.id;
    const key = `${sessionId}:${turn}`;
    if (!tracked.raw) { pending.delete(key); return; }
    // 进队列前固定本轮输入；不能等待转述，否则会阻塞主 agent 写 turn/end。
    const current = { ...tracked };
    const { provider, model } = agent.session.requestContext();
    const generation = Symbol();
    pending.set(key, generation);
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (pending.get(key) !== generation) return;
      const settings = await readSettings();
      if (!settings.enabled || pending.get(key) !== generation) return;
      await generate(sessionId, current, { provider, model }, key, generation, settings);
    }).catch(async error => {
      debug(`failed ${key}: ${error?.stack ?? error}`);
      if (pending.get(key) !== generation) return;
      // 失败也落盘，界面能显示失败原因而不是悄悄没反应。
      try {
        const turns = (await readTurns(sessionId)).filter(t => t.turn !== turn);
        turns.push({ turn, error: String(error?.message ?? error), at: new Date().toISOString() });
        if (pending.get(key) === generation) await writeJson(fileOf(sessionId), turns);
      } catch {}
    }).finally(() => {
      if (pending.get(key) === generation) pending.delete(key);
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    queues.set(sessionId, next);
  });

  const headers = { 'cache-control': 'no-store' };

  ctx.connection.fetch.register({
    path: '/api/local-persona-voice',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const params = new URL(request.url).searchParams;
      const sessionId = params.get('session') ?? '';
      const turn = Number(params.get('turn'));
      if (pending.has(`${sessionId}:${turn}`)) return Response.json({ status: 'pending' }, { headers });
      const record = (await readTurns(sessionId)).find(t => t.turn === turn);
      if (!record) return Response.json({ status: 'none' }, { headers });
      if (record.error) return Response.json({ status: 'error', error: record.error }, { headers });
      return Response.json({ status: 'ok', voice: record.voice, raw: record.raw }, { headers });
    },
  });

  // 浏览器端用来判断是否启用（轻量，不列模型）。
  ctx.connection.fetch.register({
    path: '/api/local-persona-voice/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json({ enabled: (await readSettings()).enabled }, { headers }),
  });

  // 费用与转述配置分开保存；多个设置窗口写单价时逐个合并。
  let rateWrites = Promise.resolve();
  ctx.connection.fetch.register({
    path: '/api/local-persona-voice/costs',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      const result = rateWrites.then(() => costResponse(request, DATA_DIR));
      if (request.method === 'POST') rateWrites = result.catch(() => {});
      try {
        return Response.json(await result, { headers });
      } catch (error) {
        debug(`costs unreadable: ${error.message}`);
        return Response.json({ error: 'Could not load or save relay costs.' }, { status: 400, headers });
      }
    },
  });

  // 设置页：GET 读设置和可选模型，POST 保存。
  ctx.connection.fetch.register({
    path: '/api/local-persona-voice/settings',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        if (request.method === 'POST') {
          const settings = normalizeSettings(await request.json());
          await writeJson(SETTINGS_FILE, settings);
          return Response.json({ settings }, { headers });
        }
        // 模型列表由浏览器端直接读官方目录（session.modelCatalog），这里不再列举。
        return Response.json({ settings: await readSettings(), defaultRules: DEFAULT_RULES, defaultReminder: DEFAULT_REMINDER }, { headers });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400, headers });
      }
    },
  });
}
