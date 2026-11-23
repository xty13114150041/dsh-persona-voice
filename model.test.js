import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, formatTurn, trimStart } from './model.js';

const mk = n => Array.from({ length: n }, (_, i) => ({ turn: i, user: `u${i}`, raw: `RAW${i}`, voice: `v${i}` }));

test('current context sends only this turn while keeping the persona and rules', () => {
  const current = { turn: 10, user: 'new question', raw: 'new answer' };
  const { system, messages } = buildRequest({ persona: 'p', history: mk(10), current, contextScope: 'current' });
  assert.match(system, /^p\n\n<relay_rules>/);
  assert.deepEqual(messages, [{ role: 'user', content: formatTurn(current.user, current.raw) }]);
});

test('recent context is a five-turn window including the current turn without backfilling gaps', () => {
  const current = { turn: 10, user: 'u10', raw: 'RAW10' };
  const history = mk(10);
  const options = { persona: 'p', current, contextScope: 'recent5' };
  const voices = messages => messages.filter(m => m.role === 'assistant').map(m => m.content);
  assert.deepEqual(voices(buildRequest({ ...options, history }).messages), ['v6', 'v7', 'v8', 'v9']);
  assert.deepEqual(voices(buildRequest({ ...options, history: history.filter(t => t.turn !== 8) }).messages), ['v6', 'v7', 'v9']);
  assert.equal(buildRequest({ ...options, history: [] }).messages.length, 1);
});

test('all context includes every saved preceding turn regardless of the old cap', () => {
  const current = { turn: 42, user: 'u42', raw: 'RAW42' };
  const { messages } = buildRequest({ persona: 'p', current, history: mk(42), contextScope: 'all', maxTurns: 2 });
  assert.equal(messages.length, 85);
  assert.equal(messages[1].content, 'v0');
  assert.equal(messages.at(-2).content, 'v41');
  assert.match(messages.at(-1).content, /RAW42/);
});

test('builds alternating multi-turn messages ending with current turn', () => {
  const { system, messages } = buildRequest({
    persona: '你是 Aerith',
    history: [{ user: 'u1', raw: 'r1', voice: 'v1' }, { user: 'u2', raw: 'r2', voice: 'v2' }],
    current: { user: 'u3', raw: 'r3' },
  });
  assert.match(system, /你是 Aerith/);
  assert.match(system, /relay_rules/);
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(messages[1].content, 'v1');
  assert.match(messages[4].content, /u3[\s\S]*r3/);
});

test('keeps full raw output for every kept turn', () => {
  const { messages } = buildRequest({ persona: 'p', history: mk(6), current: { user: 'c', raw: 'cr' } });
  assert.match(messages[0].content, /RAW0/);
  assert.match(messages[10].content, /RAW5/);
});

test('trims in batches so the prefix stays stable between batches', () => {
  assert.equal(trimStart(10, 10), 0);
  assert.equal(trimStart(11, 10), 5);
  assert.equal(trimStart(15, 10), 5);
  assert.equal(trimStart(16, 10), 10);
  const a = buildRequest({ persona: 'p', history: mk(12), current: { user: 'c', raw: 'r' }, maxTurns: 10 });
  const b = buildRequest({ persona: 'p', history: mk(13), current: { user: 'c', raw: 'r' }, maxTurns: 10 });
  // 13 轮历史的前缀与 12 轮完全一致（都从第 5 轮开始）。
  assert.deepEqual(b.messages.slice(0, a.messages.length - 1), a.messages.slice(0, -1));
  assert.match(a.messages[0].content, /u5/);
});

test('reminder is attached identically to every user message so the previous request stays a prefix', () => {
  const a = buildRequest({ persona: 'p', history: mk(2), current: { user: 'u2', raw: 'RAW2' }, reminder: '保持口吻' });
  const b = buildRequest({ persona: 'p', history: mk(3), current: { user: 'c', raw: 'r' }, reminder: '保持口吻' });
  assert.match(a.messages.at(-1).content, /<reminder>保持口吻<\/reminder>/);
  assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages);
});

test('clips very long raw output keeping head and tail', () => {
  const raw = 'A'.repeat(100) + 'B'.repeat(100);
  const out = formatTurn('u', raw, 50);
  assert.match(out, /^<user>/);
  assert.match(out, /A{35}/);
  assert.match(out, /B{15}/);
  assert.match(out, /中间省略 150 字/);
});
