import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, extractPersona, DEFAULT_SETTINGS } from './host.js';

test('defaults are disabled and follow the session model', () => {
  const s = normalizeSettings({});
  assert.equal(s.enabled, false);
  assert.equal(s.provider, '');
  assert.equal(s.model, '');
  assert.equal(s.maxTokens, DEFAULT_SETTINGS.maxTokens);
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

test('extractPersona keeps only a *_persona block when present', () => {
  const file = '# rules\n<aerith_persona>\nhi\n</aerith_persona>\nmore';
  assert.equal(extractPersona(file), '<aerith_persona>\nhi\n</aerith_persona>');
  assert.equal(extractPersona('plain persona'), 'plain persona');
});
