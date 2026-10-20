// Provider adaptation: OpenRouter gets prefixed models + provider prefs + session_id; the mock gets none of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toProviderParams, providerModel } from '../src/openai.js';

const base = { model: 'gpt-5.6-terra', input: [{ role: 'user', content: 'hi' }], store: false, safety_identifier: 'abc', session_id: 'conv-1' };

test('model prefixing', () => {
  assert.equal(providerModel('gpt-5.6-luna', 'openrouter'), 'openai/gpt-5.6-luna');
  assert.equal(providerModel('openai/gpt-5.6-luna', 'openrouter'), 'openai/gpt-5.6-luna');
  assert.equal(providerModel('gpt-5.6-luna', 'mock'), 'gpt-5.6-luna');
});

test('OpenRouter: prefixed model, provider prefs and session_id', () => {
  const p = toProviderParams(base, { provider: 'openrouter', dataCollection: 'deny', zdr: false });
  assert.equal(p.model, 'openai/gpt-5.6-terra');
  assert.deepEqual(p.provider, { data_collection: 'deny' });
  assert.equal(p.session_id, 'conv-1');
  assert.equal(p.store, false);
  assert.equal(p.safety_identifier, 'abc');
  assert.equal(base.model, 'gpt-5.6-terra', 'input params are not mutated');
});

test('OpenRouter: zdr only when enabled, no session_id when absent', () => {
  const { session_id: _, ...noSession } = base;
  const p = toProviderParams(noSession, { provider: 'openrouter', dataCollection: 'deny', zdr: true });
  assert.deepEqual(p.provider, { data_collection: 'deny', zdr: true });
  assert.ok(!('session_id' in p));
});

test('mock: nothing added, session_id stripped', () => {
  const { session_id: _, ...expected } = base;
  assert.deepEqual(toProviderParams(base, { provider: 'mock' }), expected);
});
