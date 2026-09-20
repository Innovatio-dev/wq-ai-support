// Mock WealthQuest API: envelope conventions and the "own data only" rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, mockApiClient, MARIA_ID } from '../src/mock/wq-api.js';
import { runCompTool } from '../src/tools/comp-tools.js';

const me = { distributor_id: MARIA_ID };

test('403 for any other distributor id, 401 without a principal', () => {
  for (const p of ['/distributors/WQ-100733/performance', '/distributors/WQ-1/rank-status', '/distributors/WQ-1/commissions', '/network/WQ-100204']) {
    assert.equal(handle('GET', p, {}, me).status, 403, p);
  }
  assert.equal(handle('GET', '/me', {}, null).status, 401);
  assert.equal(handle('POST', '/me', {}, me).status, 405);
});

test('analytics responses carry the required envelope', () => {
  const r = handle('GET', `/distributors/${MARIA_ID}/performance`, { period: '30d' }, me).body;
  for (const k of ['generated_at', 'period', 'comparison_period', 'currency', 'amount_scale']) assert.ok(k in r, k);
  assert.equal(r.currency, 'USD');
  assert.equal(r.period.timezone, 'America/Los_Angeles');
  for (const m of Object.values(r.metrics)) assert.deepEqual(Object.keys(m), ['value', 'unit', 'previous_value', 'delta_value', 'delta_pct']);
  assert.equal(r.metrics.left_team_bv.value, 13480);
});

test('commission ledger: 90% cash / 10% Gold Points, Fast 5 $500, Direct Bonus = 10% of BV', () => {
  const r = handle('GET', `/distributors/${MARIA_ID}/commissions`, { type: 'all' }, me).body;
  for (const e of r.entries) {
    assert.ok(Math.abs(e.cash_usd - e.amount_usd * 0.9) < 0.011);
    assert.ok(Math.abs(e.gold_points - e.amount_usd * 0.1) < 0.011);
    if (e.commission_type === 'direct') assert.equal(e.amount_usd, e.source.bv / 10);
  }
  assert.ok(r.entries.some((e) => e.commission_type === 'fast5' && e.amount_usd === 500));
  assert.ok(r.wallet.cash_balance_usd > 0);
});

test('products reconcile to total_team_volume', () => {
  const r = handle('GET', `/distributors/${MARIA_ID}/products`, {}, me).body;
  const sum = r.products.reduce((a, p) => a + p.team_volume, 0);
  assert.ok(Math.abs(sum - r.total_team_volume) < 0.01);
});

test('tools never take an id: they always act on the session principal', async () => {
  const ctx = { api: mockApiClient(me), principal: me };
  const gap = await runCompTool('calculate_rank_gap', { target_rank: 'R5', distributor_id: 'WQ-100733' }, ctx);
  assert.equal(gap.requirements.weak_leg_bv.have, 13480);
  const sitb = await runCompTool('project_sitb', { days: 7, rank: null }, ctx);
  assert.equal(sitb.total_usd, 980);
  assert.equal(sitb.rank.code, 'R4');
  const other = { api: mockApiClient({ distributor_id: 'WQ-100733' }), principal: me };
  await assert.rejects(() => runCompTool('get_my_rank_status', {}, other), /403/);
});
