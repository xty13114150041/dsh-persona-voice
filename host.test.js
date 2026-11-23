import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { apply, normalizeSettings, extractPersona, DEFAULT_SETTINGS } from './host.js';

test('defaults are disabled and follow the session model', () => {
  const s = normalizeSettings({});
  assert.equal(s.enabled, false);
  assert.equal(s.provider, '');
  assert.equal(s.model, '');
  assert.equal(s.maxTokens, DEFAULT_SETTINGS.maxTokens);
  assert.equal(s.effort, '');
  assert.equal(normalizeSettings({ effort: ' high ' }).effort, 'high');
});

test('provider and model must be set together', () => {
  assert.throws(() => normalizeSettings({ provider: 'p' }), /provider 和 model/);
  assert.equal(normalizeSettings({ provider: ' p ', model: 'm' }).provider, 'p');
});

test('three context choices save, and old limits are preserved until a new choice is made', () => {
  assert.equal(normalizeSettings({}).contextScope, 'recent5');
  const legacy = normalizeSettings({ maxTurns: '23', enabled: true });
  assert.equal(legacy.contextScope, 'legacy');
  assert.equal(legacy.maxTurns, 23);
  assert.deepEqual(normalizeSettings(legacy), legacy);
  for (const contextScope of ['current', 'recent5', 'all']) {
    assert.equal(normalizeSettings({ ...legacy, contextScope }).contextScope, contextScope);
  }
  assert.throws(() => normalizeSettings({ contextScope: 'maybe' }), /context scope/);
});

test('integer fields are range checked', () => {
  assert.throws(() => normalizeSettings({ maxTurns: 0 }), /maxTurns/);
  assert.throws(() => normalizeSettings({ maxTurns: 2.5 }), /maxTurns/);
  assert.equal(normalizeSettings({ maxTokens: '4096' }).maxTokens, 4096);
});

test('legacy persona settings become a single default preset', () => {
  const s = normalizeSettings({ personaFile: ' /a.md ', persona: 'x' });
  assert.deepEqual(s.presets, [{ name: '默认', personaFile: '/a.md', persona: 'x' }]);
  assert.equal(s.activePreset, '默认');
});

test('presets: names must be unique and non-empty; unknown active falls back to first', () => {
  const presets = [{ name: 'A', persona: 'a' }, { name: 'B', personaFile: '/b.md' }];
  assert.equal(normalizeSettings({ presets, activePreset: 'B' }).activePreset, 'B');
  assert.equal(normalizeSettings({ presets, activePreset: 'Z' }).activePreset, 'A');
  assert.throws(() => normalizeSettings({ presets: [{ name: 'A' }, { name: 'A' }] }), /重复/);
  assert.throws(() => normalizeSettings({ presets: [{ name: ' ' }] }), /不能为空/);
});

test('extractPersona keeps only a *_persona block when present', () => {
  const file = '# rules\n<aerith_persona>\nhi\n</aerith_persona>\nmore';
  assert.equal(extractPersona(file), '<aerith_persona>\nhi\n</aerith_persona>');
  assert.equal(extractPersona('plain persona'), 'plain persona');
});

test('relay freezes each turn before queueing and does not recycle prior human input', { timeout: 2000 }, async t => {
  const files = new Map();
  t.mock.method(fs, 'mkdir', async () => {});
  t.mock.method(fs, 'readFile', async file => {
    if (files.has(file)) return files.get(file);
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  });
  t.mock.method(fs, 'appendFile', async () => {});
  t.mock.method(fs, 'writeFile', async (file, text) => { files.set(file, text); });
  t.mock.method(fs, 'rename', async (from, to) => { files.set(to, files.get(from)); files.delete(from); });

  const listeners = new Map();
  const api = new Map();
  const calls = [];
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  t.after(() => releaseFirst.resolve());
  await apply({
    on: (event, callback) => listeners.set(event, callback),
    connection: { fetch: { register: route => api.set(route.path, route.fetch) } },
    llm: {
      resolveModelInfo: async () => ({}),
      prepareCall: async config => ({ config, async *stream({ messages }) {
        calls.push({ config, messages });
        if (calls.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        yield { type: 'text-delta', text: 'rewritten' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } }),
    },
  }, { enabled: true, persona: 'persona', contextScope: 'all' });

  let model = 'model-1';
  const session = { requestContext: () => ({ provider: 'provider', model }) };
  const agent = { id: 'example', session };
  const event = (type, data) => listeners.get('session/event')(session, { type, data });
  const content = text => [{ type: 'text', text }];
  const human = text => event('user/message', { source: { kind: 'user' }, content: content(text) });
  const assistant = (turn, text) => event('assistant/message', { turn, message: { content: content(text) } });
  const stop = turn => listeners.get('agent/turn-stopping')({ agent, turn });
  const end = turn => { stop(turn); event('turn/end', { turn }); };

  event('turn/start', { turn: 1 });
  human('asked once');
  event('compact/checkpoint', {});
  assistant(1, 'first answer');
  end(1);
  await firstStarted.promise;

  model = 'model-2';
  event('turn/start', { turn: 2 });
  event('user/message', { source: { kind: 'subagent-settled' }, content: content('internal notice') });
  assistant(2, 'second answer');
  end(2);

  model = 'model-3';
  event('turn/start', { turn: 3 });
  human('third question');
  human('follow-up within the same turn');
  assistant(3, 'draft');
  stop(3);
  assistant(3, 'third answer');
  end(3);
  releaseFirst.resolve();

  const get = async turn => (await api.get('/api/local-persona-voice')(new Request(`http://localhost/api/local-persona-voice?session=example&turn=${turn}`))).json();
  let final;
  for (let i = 0; i < 100; i++) {
    final = await get(3);
    if (final.status !== 'pending') break;
    await delay(5);
  }
  assert.deepEqual(final, { status: 'ok', voice: 'rewritten', raw: 'third answer' });
  assert.deepEqual(calls.map(call => call.config.model), ['model-1', 'model-2', 'model-3']);
  assert.equal((await get(2)).raw, 'second answer');
  const secondInput = calls[1].messages.at(-1).content[0].text;
  assert.match(secondInput, /本轮没有新的用户消息/);
  assert.doesNotMatch(secondInput, /asked once|internal notice|third question/);
  assert.equal(calls[1].messages.filter(message => message.content[0].text.includes('asked once')).length, 1);
  const thirdInput = calls[2].messages.at(-1).content[0].text;
  assert.match(thirdInput, /third question[\s\S]*follow-up within the same turn[\s\S]*third answer/);
  assert.doesNotMatch(thirdInput, /draft/);

  event('turn/start', { turn: 4 });
  human('no model answer');
  end(4);
  assert.deepEqual(await get(4), { status: 'none' });
  assert.equal(calls.length, 3);
});
