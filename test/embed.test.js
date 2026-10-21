// /embed framing: only the main app's origins may frame it, and nothing else on the site is frameable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrigins } from '../src/config.js';
import { frameAncestors, securityHeaders } from '../src/security.js';

test('parseOrigins normalises and drops junk', () => {
  assert.deepEqual(
    parseOrigins(' https://app.wealthquest.com/dashboard , http://localhost:3333 ,not a url,, javascript:alert(1)'),
    ['https://app.wealthquest.com', 'http://localhost:3333'],
  );
  assert.deepEqual(parseOrigins(''), []);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('frame-ancestors: allow-list on /embed only, and never an empty allow-list', () => {
  const origins = ['https://app.wealthquest.com', 'https://app-staging.wealthquest.com'];
  assert.equal(frameAncestors('/embed', origins), 'https://app.wealthquest.com https://app-staging.wealthquest.com');
  assert.equal(frameAncestors('/embed', []), "'none'");
  for (const p of ['/', '/chat', '/embed.html', '/embed/', '/backoffice', '/api/config']) {
    assert.equal(frameAncestors(p, origins), "'none'", p);
  }
});

function headersFor(path) {
  const set = {};
  const res = { set: (k, v) => (typeof k === 'object' ? Object.assign(set, k) : (set[k] = v)) };
  securityHeaders({ path }, res, () => {});
  return set;
}

test('X-Frame-Options DENY everywhere except an embeddable /embed', () => {
  assert.equal(headersFor('/chat')['X-Frame-Options'], 'DENY');
  assert.match(headersFor('/chat')['Content-Security-Policy'], /frame-ancestors 'none'/);
  // Default dev allow-list (no ALLOWED_PARENT_ORIGINS, not production): the local main app + test host.
  const embed = headersFor('/embed');
  assert.equal(embed['X-Frame-Options'], undefined);
  assert.match(embed['Content-Security-Policy'], /frame-ancestors http:\/\/localhost:3333 http:\/\/localhost:3334/);
});
