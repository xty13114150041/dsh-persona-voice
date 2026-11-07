import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, formatTurn, trimStart } from './model.js';

const mk = n => Array.from({ length: n }, (_, i) => ({ user: `u${i}`, raw: `RAW${i}`, voice: `v${i}` }));

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

test('reminder only goes into the current message', () => {
  const { messages } = buildRequest({ persona: 'p', history: mk(2), current: { user: 'c', raw: 'r' }, reminder: '保持口吻' });
  assert.match(messages.at(-1).content, /<reminder>保持口吻<\/reminder>/);
  assert.doesNotMatch(messages[0].content, /reminder/);
});

test('clips very long raw output keeping head and tail', () => {
  const raw = 'A'.repeat(100) + 'B'.repeat(100);
  const out = formatTurn('u', raw, 50);
  assert.match(out, /^<user>/);
  assert.match(out, /A{35}/);
  assert.match(out, /B{15}/);
  assert.match(out, /中间省略 150 字/);
});
