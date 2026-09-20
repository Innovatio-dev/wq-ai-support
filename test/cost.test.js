// Cost function: fresh / cached / cache-write / output buckets priced separately (pricing.json, USD per 1M).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, FX } from '../src/cost.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('mock router usage on gpt-5.6-luna', () => {
  // 200 fresh × $0.20 + 2,900 cached × $0.02 + 60 out × $1.20 per 1M
  const c = costOf('gpt-5.6-luna', { input_tokens: 3100, input_tokens_details: { cached_tokens: 2900 }, output_tokens: 60 });
  close(c.usd, (200 * 0.2 + 2900 * 0.02 + 60 * 1.2) / 1e6);
  close(c.eur, c.usd * FX);
  assert.deepEqual(c.tokens, { input: 3100, cached: 2900, cache_write: 0, fresh: 200, output: 60, reasoning: 0 });
});

test('cache writes and reasoning tokens on gpt-5.6-terra', () => {
  const c = costOf('gpt-5.6-terra', {
    input_tokens: 5000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 2000 },
    output_tokens: 500, output_tokens_details: { reasoning_tokens: 200 },
  });
  // fresh 2,000 × $2 + cached 1,000 × $0.20 + write 2,000 × $2.50 + out 500 × $12 (reasoning already inside output)
  close(c.usd, (2000 * 2 + 1000 * 0.2 + 2000 * 2.5 + 500 * 12) / 1e6);
  assert.equal(c.tokens.reasoning, 200);
});

test('sol pricing and unknown model', () => {
  close(costOf('gpt-5.6-sol', { input_tokens: 1e6, output_tokens: 1e6 }).usd, 24);
  assert.deepEqual(costOf('nope', { input_tokens: 10 }), { usd: 0, eur: 0, tokens: {} });
  assert.equal(costOf('gpt-5.6-luna', null).usd, 0);
  assert.equal(FX, 0.8726);
});
