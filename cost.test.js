import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeRate, summarizeCosts } from './cost.js';
import { costResponse } from './host.js';

const rate = { currency: 'USD', input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 };
const key = (...ids) => JSON.stringify(ids);
const before = '2026-02-02T15:59:59.000Z';
const today = '2026-02-02T16:00:00.000Z';
const now = new Date(today);
const usage = (at, id, counts, route = '', finish = 'stop') => {
  const [i, r, w, o] = counts;
  return `${at} usage ${id} in=${i} cacheRead=${r} cacheWrite=${w} out=${o} finish=${finish}${route ? ` route=${route}` : ''}`;
};
const tokens = [1_000_000, 1_000_000, 1_000_000, 1_000_000];
const summarize = (lines, rates) => summarizeCosts(lines.join('\n'), rates, now, 'Asia/Shanghai');

test('rate fields require explicit finite non-negative numbers, including legitimate zero', () => {
  assert.deepEqual(normalizeRate({ ...rate, input: '1.25', cacheRead: '0' }), { ...rate, input: 1.25, cacheRead: 0 });
  for (const invalid of ['', ' ', undefined, null, false, -1, NaN, Infinity]) {
    assert.throws(() => normalizeRate({ ...rate, cacheRead: invalid }), /four non-negative/);
  }
  assert.throws(() => normalizeRate({ ...rate, currency: '' }), /USD or CNY/);
});

test('disjoint token rates, exact provider route, host day boundary, and separate currencies', () => {
  const log = [
    `${before} turn session:1 route=a/org/model effort=low`,
    `${before} turn other:1 route=another/org/model effort=low`,
    usage(before, 'session:1', tokens),
    usage(today, 'other:1', tokens),
    usage(today, 'session:1', tokens, key('a', 'org/model'), 'error'),
    usage(today, 'session:1', ['?', 0, 0, '?'], key('a', 'org/model'), '?'),
    usage(today, 'session:2', tokens, key('unconfigured', 'org/model')),
    usage(today, 'orphan:1', tokens),
    `${today} some unrelated debug line`,
  ];
  const summary = summarize(log, { [key('a', 'org/model')]: rate, [key('another', 'org/model')]: { ...rate, currency: 'CNY', input: 12 } });
  assert.deepEqual(summary.today, { calls: 5, unpriced: 3, amounts: { USD: 14.6, CNY: 24.6 } });
  assert.deepEqual(summary.total, { calls: 6, unpriced: 3, amounts: { USD: 29.2, CNY: 24.6 } });
  const [a, another, unconfigured] = summary.rows;
  assert.equal(a.total.calls, 3);
  assert.equal(a.today.cost, 14.6);
  assert.equal(a.today.unpriced, 1);
  assert.equal(another.provider, 'another');
  assert.equal(unconfigured.total.cost, null);
});

test('new records do not need a turn-start line and saved prices revalue history', () => {
  const route = key('p', 'm with space');
  const log = [usage(today, 'session:2', [1, 0, 0, 0], route)];
  assert.deepEqual(summarize(log).total, { calls: 1, unpriced: 1, amounts: {} });
  assert.deepEqual(summarize(log, { [route]: rate }).total.amounts, { USD: 0.000002 });
  assert.deepEqual(summarize(log, { [route]: { ...rate, input: 0 } }).total.amounts, { USD: 0 });
  assert.deepEqual(summarize([], { [route]: rate }).total, { calls: 0, unpriced: 0, amounts: {} });
});

test('cost settings read legacy usage, save and clear a rate without touching relay settings', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'persona-cost-test-'));
  t.after(() => rm(dir, { recursive: true }));
  const url = 'http://localhost/api/local-persona-voice/costs';
  const get = () => costResponse(new Request(url), dir);
  const post = value => costResponse(new Request(url, { method: 'POST', body: JSON.stringify(value) }), dir);
  assert.equal((await get()).total.calls, 0);
  const settingsFile = path.join(dir, 'settings.json');
  await writeFile(settingsFile, '{"enabled":true}');
  await writeFile(path.join(dir, 'debug.log'), `${today} turn s:1 route=p/m effort=off\n${usage(today, 's:1', tokens)}\n`);
  assert.equal((await get()).total.unpriced, 1);
  await assert.rejects(post({ provider: 'p', model: 'm', rate: { ...rate, input: '' } }), /non-negative/);
  await writeFile(path.join(dir, 'rates.json'), JSON.stringify({ [key('p', 'm')]: { ...rate, source: 'anthropic5m' } }));
  await post({ provider: 'other', model: 'other', rate });
  const saved = await get();
  assert.equal(saved.total.amounts.USD, 14.6);
  assert.equal(saved.rows[0].rate.source, 'anthropic5m');
  const unchanged = await post({ provider: 'p', model: 'm', rate });
  assert.equal(unchanged.rows[0].rate.source, 'anthropic5m');
  const edited = await post({ provider: 'p', model: 'm', rate: { ...saved.rows[0].rate, input: 3 } });
  assert.equal(edited.rows[0].rate.source, undefined);
  assert.equal(edited.total.amounts.USD, 15.6);
  await post({ provider: 'p', model: 'm', rate: null });
  const summary = await get();
  assert.equal(summary.total.unpriced, 1);
  assert.equal(summary.rows.find(r => r.provider === 'other').rate.output, 10);
  assert.equal(await readFile(settingsFile, 'utf8'), '{"enabled":true}');
});

test('invalid saved rates do not block other estimates and can be replaced or cleared', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'persona-cost-test-'));
  t.after(() => rm(dir, { recursive: true }));
  const url = 'http://localhost/api/local-persona-voice/costs';
  const post = (model, rate) => costResponse(new Request(url, { method: 'POST', body: JSON.stringify({ provider: 'p', model, rate }) }), dir);
  const ratesFile = path.join(dir, 'rates.json');
  const broken = { ...rate, cacheRead: -1 };
  await writeFile(ratesFile, JSON.stringify({ [key('p', 'ok')]: rate, [key('p', 'bad')]: broken, [key('p', 'unused')]: null }));
  await writeFile(path.join(dir, 'debug.log'), [usage(today, 's:1', tokens, key('p', 'ok')), usage(today, 's:2', tokens, key('p', 'bad'))].join('\n'));
  const summary = await costResponse(new Request(url), dir);
  assert.deepEqual(summary.total, { calls: 2, unpriced: 1, amounts: { USD: 14.6 } });
  assert.deepEqual(summary.rows.filter(row => row.rateInvalid).map(row => row.model), ['bad', 'unused']);
  assert.equal(summary.rows.find(row => row.model === 'bad').rate, null);
  await post('ok', { ...rate, input: 3 });
  assert.deepEqual(JSON.parse(await readFile(ratesFile, 'utf8'))[key('p', 'bad')], broken);
  assert.equal((await post('unused', null)).rows.some(row => row.model === 'unused'), false);
  const fixed = await post('bad', rate);
  assert.equal(fixed.total.unpriced, 0);
  assert.equal(fixed.rows.some(row => row.rateInvalid), false);
  assert.equal(fixed.total.amounts.USD, 30.2);
});
