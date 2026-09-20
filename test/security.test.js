// Security helpers: same-origin check, input validation, safety identifier, combo allow-list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameOrigin, validateText, cleanText, safetyIdentifier } from '../src/security.js';
import { resolveCombo } from '../src/config.js';

test('same-origin: Origin must match Host', () => {
  assert.equal(isSameOrigin({ origin: 'https://demo.up.railway.app', host: 'demo.up.railway.app' }), true);
  assert.equal(isSameOrigin({ origin: 'http://localhost:3000', host: 'localhost:3000' }), true);
  assert.equal(isSameOrigin({ origin: 'https://evil.example', host: 'demo.up.railway.app' }), false);
  assert.equal(isSameOrigin({ origin: 'https://demo.up.railway.app.evil.example', host: 'demo.up.railway.app' }), false);
  assert.equal(isSameOrigin({ origin: 'http://localhost:3001', host: 'localhost:3000' }), false, 'port matters');
});

test('same-origin: falls back to Referer; rejects missing, null and garbage', () => {
  assert.equal(isSameOrigin({ referer: 'https://demo.up.railway.app/chat?x=1', host: 'demo.up.railway.app' }), true);
  assert.equal(isSameOrigin({ origin: 'null', referer: 'https://demo.up.railway.app/', host: 'demo.up.railway.app' }), true);
  assert.equal(isSameOrigin({ host: 'demo.up.railway.app' }), false);
  assert.equal(isSameOrigin({ origin: 'null', host: 'demo.up.railway.app' }), false);
  assert.equal(isSameOrigin({ origin: 'not a url', host: 'demo.up.railway.app' }), false);
  assert.equal(isSameOrigin({ origin: 'https://demo.up.railway.app' }), false, 'no Host header');
});

test('input validation: empty, too long, non-string', () => {
  assert.equal(validateText('How do I reset my password?'), null);
  assert.match(validateText('   '), /type a question/);
  assert.match(validateText('x'.repeat(2001)), /2,000/);
  assert.equal(validateText('x'.repeat(2000)), null);
  assert.ok(validateText(undefined));
  assert.ok(validateText({ text: 'hi' }));
});

test('control characters are stripped before prompting', () => {
  assert.equal(cleanText('  hi\u0000 there\u0007\n  '), 'hi there');
  assert.equal(cleanText('line1\nline2\tx'), 'line1\nline2\tx');
});

test('safety_identifier is a stable sha256 hex, not the raw session id', () => {
  const a = safetyIdentifier('abc');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, safetyIdentifier('abc'));
  assert.notEqual(a, safetyIdentifier('abd'));
  assert.ok(!a.includes('abc'));
});

test('model combos resolve only from the allow-list', () => {
  assert.equal(resolveCombo('support', 'luna-luna-fast').answer.model, 'gpt-5.6-luna');
  assert.equal(resolveCombo('support', 'gpt-6-astra').key, 'luna-terra', 'unknown key → default');
  assert.equal(resolveCombo('support', '__proto__').key, 'luna-terra');
  assert.equal(resolveCombo('comp', 'sol-only').router, null);
  assert.equal(resolveCombo('comp', undefined).agent.model, 'gpt-5.6-sol');
});
