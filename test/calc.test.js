// Plan calculator: the numbers the Compensation agent relies on. Every expected value comes from kb/compplan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRankGap, highestQualifyingLevel, weeklySitb, projectSitb, gmPercentages, gmStatus, directBonus, SITB_DAILY, RANKS } from '../src/calc/plan.js';
import { mockApiClient, MARIA_ID } from '../src/mock/wq-api.js';

const maria = await mockApiClient({ distributor_id: MARIA_ID }).get(`/distributors/${MARIA_ID}/rank-status`);

test("Maria's mock data is coherent: R4, weak left 13,480 BV, strong right 21,950 BV, 9 actives (4/5), 2 at R2+", () => {
  assert.equal(maria.current_rank.rank_code, 'R4');
  assert.deepEqual(maria.weak_leg, { side: 'left', bv_31d: 13480 });
  assert.deepEqual(maria.strong_leg, { side: 'right', bv_31d: 21950 });
  const s = maria.personally_sponsored_active;
  assert.equal(s.total, 9); assert.equal(s.left, 4); assert.equal(s.right, 5);
  const r2plus = Object.entries(s.by_rank).filter(([k]) => /^R\d+$/.test(k) && +k.slice(1) >= 2).reduce((a, [, v]) => a + v, 0);
  assert.equal(r2plus, 2);
  assert.equal(highestQualifyingLevel(maria), 4);
  const codes = maria.daily_rank_snapshots.map((d) => d.rank_code);
  assert.equal(codes.filter((c) => c === 'R3').length, 1, 'exactly one R3 day in the last 14');
  for (const d of maria.daily_rank_snapshots) assert.equal(d.daily_accrual_usd, SITB_DAILY[d.rank_code]);
});

test('R4 → R5 gap for Maria (§6.2): 10,520 BV, 1 sponsored active, 1 more at Rank 2+; lower ranks all met', () => {
  const gap = calculateRankGap(maria, 'R5');
  assert.equal(gap.already_qualifies, false);
  assert.equal(gap.current_qualifying_rank.code, 'R4');
  assert.deepEqual(gap.requirements.weak_leg_bv, { required: 24000, have: 13480, missing: 10520 });
  assert.deepEqual(gap.requirements.personally_sponsored, { required: 10, have: 9, missing: 1 });
  assert.deepEqual(gap.requirements.ranked_directs, [{ min_level: 2, required: 3, have: 2, missing: 1 }]);
  assert.equal(gap.lower_ranks_all_met, true);
  assert.equal(gap.weak_leg_side, 'left');
});

test('no skipping (§6.4): meeting only R4 headcount without R3 left/right balance does not give R4', () => {
  const lopsided = {
    weak_leg: { side: 'left', bv_31d: 13000 },
    personally_sponsored_active: { left: 1, right: 8, total: 9, by_rank: { R2: 2 } },
    leadership_lines: [],
  };
  const gap = calculateRankGap(lopsided, 'R4');
  assert.equal(gap.requirements.weak_leg_bv.missing, 0);
  assert.equal(gap.requirements.personally_sponsored.missing, 0);
  assert.equal(gap.already_qualifies, false);
  assert.ok(gap.lower_rank_failures.some((f) => f.code === 'R2'), 'fails R2 left-leg requirement');
  assert.equal(highestQualifyingLevel(lopsided), 1);
});

test('distinct people for combined requirements (R7: 2 at R4 and 3 at R3)', () => {
  const status = {
    weak_leg: { bv_31d: 95000 },
    personally_sponsored_active: { left: 7, right: 7, total: 14, by_rank: { R4: 2, R3: 2 } },
  };
  const row = calculateRankGap(status, 'R7').requirements.ranked_directs;
  assert.deepEqual(row, [{ min_level: 4, required: 2, have: 2, missing: 0 }, { min_level: 3, required: 3, have: 2, missing: 1 }]);
});

test('Ambassador lines: R11 needs five distinct lines, R12 six (§6.2 note)', () => {
  const lines = (r7, r6) => [...Array(r7).fill('R7'), ...Array(r6).fill('R6')].map((r, i) => ({ line_root_id: `L${i}`, highest_rank_in_line: r }));
  const base = { weak_leg: { bv_31d: 700000 }, personally_sponsored_active: { left: 9, right: 9, total: 18, by_rank: { R4: 3, R3: 3 } } };
  assert.equal(calculateRankGap({ ...base, leadership_lines: lines(2, 3) }, 'R11').requirements.leadership_lines.r6.missing, 0);
  assert.equal(calculateRankGap({ ...base, leadership_lines: lines(2, 2) }, 'R11').requirements.leadership_lines.r6.missing, 1);
  const r12 = calculateRankGap({ ...base, leadership_lines: lines(3, 2) }, 'R12').requirements.leadership_lines;
  assert.equal(r12.r7.missing, 0);
  assert.equal(r12.r6.missing, 1, '3 R7 lines + 2 R6 lines = 5, R12 needs 6');
});

test('SITB worked example §9.5 totals $2,560', () => {
  const week = ['R4', 'R4', 'R5', 'R5', 'R6', 'R6', 'R6'].map((rank_code) => ({ rank_code }));
  assert.equal(weeklySitb(week).total_usd, 2560);
});

test('SITB table §9.3: 7-day and 30-day columns are daily × 7 / × 30', () => {
  const table = { R1: [105, 450], R4: [980, 4200], R8: [12495, 53550], R12: [50050, 214500] };
  for (const [rank, [d7, d30]] of Object.entries(table)) {
    assert.equal(projectSitb(7, rank).total_usd, d7);
    assert.equal(projectSitb(30, rank).total_usd, d30);
  }
  const p = projectSitb(7, 'R4');
  assert.deepEqual(p.composition, { cash_usd: 882, gold_points: 98 });
  assert.match(p.note, /not a projection/);
  assert.throws(() => projectSitb(32, 'R4'));
  assert.throws(() => projectSitb(0, 'R4'));
});

test('Generational Match percentages §10.7', () => {
  assert.deepEqual(gmPercentages('R3'), [0, 0, 0, 0, 0]);
  assert.deepEqual(gmPercentages('R4'), [5, 0, 0, 0, 0]);
  assert.deepEqual(gmPercentages('R5'), [5, 0, 0, 0, 0]);
  assert.deepEqual(gmPercentages('R6'), [5, 5, 0, 0, 0]);
  assert.deepEqual(gmPercentages('R7'), [5, 5, 0, 0, 0]);
  assert.deepEqual(gmPercentages('R8'), [5, 5, 4, 0, 0]);
  assert.deepEqual(gmPercentages('R9'), [5, 5, 4, 0, 0]);
  assert.deepEqual(gmPercentages('R10'), [5, 5, 4, 3, 2]);
  assert.deepEqual(gmPercentages('R12'), [5, 5, 4, 3, 2]);
});

test("Generational Match unlock §10.8: Maria's Gen 1 is available at R4 but locked (1 of 2 at Rank 3+)", () => {
  const gm = gmStatus('R4', maria.personally_sponsored_active.by_rank);
  assert.equal(gm[0].available, true);
  assert.equal(gm[0].unlocked, false);
  assert.equal(gm[0].have, 1);
  assert.equal(gm[1].available, false);
});

test('Direct Bonus §8.1 = 10% of BV, split 90/10 (§15)', () => {
  assert.deepEqual(directBonus(600), { amount_usd: 60, cash_usd: 54, gold_points: 6 });
});

test('rank ladder has 12 ranks with increasing BV', () => {
  assert.equal(RANKS.length, 12);
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i].weak_leg_bv > RANKS[i - 1].weak_leg_bv);
});
