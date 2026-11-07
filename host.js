// 宿主端：每轮结束后，后台调用一次"人设 agent"（B），把执行 agent（A）的最终回答转述成人设口吻，
// 结果按会话存成 JSON 文件；设置保存在 settings.json，由插件设置页读写，改完下一轮即生效。
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildRequest, DEFAULT_RULES, DEFAULT_REMINDER } from './model.js';

export const inject = ['llm', 'connection'];

const DATA_DIR = path.join(homedir(), '.dsh', 'persona-voice');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  enabled: false,
  provider: '',        // provider 与 model 都留空：沿用该会话 A 正在用的模型
  model: '',
  effort: '',          // 思考强度：留空=自动（有 off 用 off，否则最低档）
  personaFile: '',     // 填了就从文件读人设（优先），否则用 persona 文本
  persona: '',
  rules: DEFAULT_RULES,
  reminder: DEFAULT_REMINDER,  // 附在每条用户消息末尾的固定提醒
  maxTokens: 2048,
  maxTurns: 40,
};

const INT_LIMITS = { maxTokens: [256, 32768], maxTurns: [2, 200] };

/** 校验并规整设置；不合法时抛错，提示给设置页。 */
export function normalizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const out = {
    enabled: Boolean(s.enabled),
    provider: String(s.provider ?? '').trim(),
    model: String(s.model ?? '').trim(),
    personaFile: String(s.personaFile ?? '').trim(),
    persona: String(s.persona ?? ''),
    rules: String(s.rules ?? ''),
    reminder: String(s.reminder ?? ''),
    effort: String(s.effort ?? '').trim(),
  };
  if (Boolean(out.provider) !== Boolean(out.model)) throw new Error('provider 和 model 要么都填，要么都留空');
  for (const [key, [min, max]] of Object.entries(INT_LIMITS)) {
    const value = Number(s[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} 需要是 ${min}–${max} 之间的整数`);
    out[key] = value;
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
  const pending = new Map();   // `${sessionId}:${turn}` -> 生成代次
  const queues = new Map();    // sessionId -> 串行队列，保证同一会话按顺序写

  // 首次运行：用 cordis 配置（如有）作为初始设置。
  async function readSettings() {
    try {
      return normalizeSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') debug(`settings unreadable, using defaults: ${error.message}`);
      return normalizeSettings({ ...config });
    }
  }
  async function writeJson(file, value) {
    await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 1));
    await fs.rename(file + '.tmp', file);
  }

  const fileOf = sessionId => path.join(DATA_DIR, sessionId.replace(/[^\w.-]/g, '_') + '.json');
  async function readTurns(sessionId) {
    try { return JSON.parse(await fs.readFile(fileOf(sessionId), 'utf8')); } catch { return []; }
  }

  async function loadPersona(settings) {
    if (settings.personaFile) return extractPersona(await fs.readFile(settings.personaFile, 'utf8'));
    return settings.persona;
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

  async function generate(agent, turn, key, generation, settings) {
    const sessionId = agent.id;
    const messages = agent.session.deriveMessages();
    const user = textOf(messages.findLast(m => m.role === 'user' && m.source?.kind === 'user'));
    const raw = textOf(messages.findLast(m => m.role === 'assistant'));
    if (!raw) { pending.delete(key); return; }

    const persona = (await loadPersona(settings)).trim();
    if (!persona) { debug('skip: persona empty'); pending.delete(key); return; }
    const route = settings.provider ? { provider: settings.provider, model: settings.model } : agent.session.requestContext();
    const history = (await readTurns(sessionId)).filter(t => t.turn !== turn && t.voice);
    const request = buildRequest({
      persona, rules: settings.rules || DEFAULT_RULES, reminder: settings.reminder, history, current: { user, raw },
      maxTurns: settings.maxTurns,
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
    for await (const chunk of call.stream({ ...call.config, system: request.system, messages: wire, purpose: 'persona-voice' })) {
      if (chunk.type === 'text-delta') voice += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    debug(`usage ${key} in=${usage?.inputTokens ?? '?'} cacheRead=${usage?.cacheReadTokens ?? 0} cacheWrite=${usage?.cacheWriteTokens ?? 0} out=${usage?.outputTokens ?? '?'} finish=${finish?.kind ?? '?'}`);
    if (pending.get(key) !== generation) return;   // 同一轮被 steer 又触发，旧结果作废
    const ok = finish?.kind === 'stop' || finish?.kind === 'max-tokens';
    const record = ok && voice.trim()
      ? { turn, user, raw, voice: voice.trim(), at: new Date().toISOString() }
      : { turn, user, raw, error: `生成失败：${finish?.kind ?? 'unknown'}`, at: new Date().toISOString() };
    const turns = (await readTurns(sessionId)).filter(t => t.turn !== turn);
    turns.push(record);
    await writeJson(fileOf(sessionId), turns);
    pending.delete(key);
  }

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent.session?.header?.origin === 'subagent') return;
    const key = `${agent.id}:${turn}`;
    // 不能 await：循环会等这个监听器结束才写 turn/end。先同步占位 pending，界面才能显示"组织语言中"。
    const generation = (pending.get(key) ?? 0) + 1;
    pending.set(key, generation);
    const prev = queues.get(agent.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const settings = await readSettings();
      if (!settings.enabled) { pending.delete(key); return; }
      await generate(agent, turn, key, generation, settings);
    }).catch(async error => {
      debug(`failed ${key}: ${error?.stack ?? error}`);
      if (pending.get(key) !== generation) return;
      // 失败也落盘，界面能显示失败原因而不是悄悄没反应。
      try {
        const turns = (await readTurns(agent.id)).filter(t => t.turn !== turn);
        turns.push({ turn, error: String(error?.message ?? error), at: new Date().toISOString() });
        await writeJson(fileOf(agent.id), turns);
      } catch {}
      pending.delete(key);
    });
    queues.set(agent.id, next);
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
