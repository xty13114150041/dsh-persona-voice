import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, extractPersona, DEFAULT_SETTINGS } from './host.js';

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
