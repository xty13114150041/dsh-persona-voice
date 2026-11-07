import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, formatTurn } from './model.js';

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

test('drops raw output for older turns beyond fullTurns', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ user: `u${i}`, raw: `RAW${i}`, voice: `v${i}` }));
  const { messages } = buildRequest({ persona: 'p', history, current: { user: 'c', raw: 'cr' }, fullTurns: 2 });
  assert.doesNotMatch(messages[0].content, /RAW0/);
  assert.match(messages[0].content, /原文已省略/);
  assert.match(messages[10].content, /RAW5/);
});

test('caps history at maxTurns', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ user: `u${i}`, raw: 'r', voice: 'v' }));
  const { messages } = buildRequest({ persona: 'p', history, current: { user: 'c', raw: 'r' }, maxTurns: 3 });
  assert.equal(messages.length, 7);
  assert.match(messages[0].content, /u7/);
});

test('clips very long raw output keeping head and tail', () => {
  const raw = 'A'.repeat(100) + 'B'.repeat(100);
  const out = formatTurn('u', raw, 50);
  assert.match(out, /^<user>/);
  assert.match(out, /A{35}/);
  assert.match(out, /B{15}/);
  assert.match(out, /中间省略 150 字/);
});
