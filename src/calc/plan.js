// Deterministic Compensation Plan math (WealthQuest Compensation Plan Agreement, effective 10.08.2026).
// The comp agent MUST use these functions (via tools) for every amount — LLMs are not calculators.
// Every constant below is copied from kb/compplan (§6.2, §9.3, §10.7, §10.8, §8.1, §15).
// In AdonisJS this becomes app/services/comp_plan_calculator.ts and should be shared with the
// real commission engine so the agent and the payout run can never disagree.

/** §6.2 rank ladder. `sponsored` = personally sponsored Active IBOs (Enroller Tree). */
export const RANKS = [
  { code: 'R1', level: 1, name: 'Bronze Associate', tier: 'Associates', weak_leg_bv: 1600, sponsored: 2, left: 1, right: 1, ranked: [], lines: null },
  { code: 'R2', level: 2, name: 'Silver Associate', tier: 'Associates', weak_leg_bv: 3200, sponsored: 4, left: 2, right: 2, ranked: [], lines: null },
  { code: 'R3', level: 3, name: 'Gold Associate', tier: 'Associates', weak_leg_bv: 6000, sponsored: 6, left: 3, right: 3, ranked: [], lines: null },
  { code: 'R4', level: 4, name: 'Bronze Manager', tier: 'Managers', weak_leg_bv: 12000, sponsored: 8, left: 0, right: 0, ranked: [{ min_level: 2, count: 2 }], lines: null },
  { code: 'R5', level: 5, name: 'Silver Manager', tier: 'Managers', weak_leg_bv: 24000, sponsored: 10, left: 0, right: 0, ranked: [{ min_level: 2, count: 3 }], lines: null },
  { code: 'R6', level: 6, name: 'Gold Manager', tier: 'Managers', weak_leg_bv: 48000, sponsored: 12, left: 0, right: 0, ranked: [{ min_level: 3, count: 4 }], lines: null },
  { code: 'R7', level: 7, name: 'Bronze Executive', tier: 'Executives', weak_leg_bv: 90000, sponsored: 14, left: 0, right: 0, ranked: [{ min_level: 4, count: 2 }, { min_level: 3, count: 3 }], lines: null },
  { code: 'R8', level: 8, name: 'Silver Executive', tier: 'Executives', weak_leg_bv: 150000, sponsored: 16, left: 0, right: 0, ranked: [{ min_level: 4, count: 3 }, { min_level: 3, count: 3 }], lines: null },
  { code: 'R9', level: 9, name: 'Gold Executive', tier: 'Executives', weak_leg_bv: 240000, sponsored: 18, left: 0, right: 0, ranked: [], lines: { r7: 0, r6: 2 } },
  { code: 'R10', level: 10, name: 'Bronze Ambassador', tier: 'Ambassadors', weak_leg_bv: 360000, sponsored: 0, left: 0, right: 0, ranked: [], lines: { r7: 0, r6: 3 } },
  // §6.2 note: R11 needs five distinct lines and R12 six, because a Rank 7 line cannot double as a Rank 6 line.
  { code: 'R11', level: 11, name: 'Silver Ambassador', tier: 'Ambassadors', weak_leg_bv: 480000, sponsored: 0, left: 0, right: 0, ranked: [], lines: { r7: 2, r6: 3 } },
  { code: 'R12', level: 12, name: 'Gold Ambassador', tier: 'Ambassadors', weak_leg_bv: 600000, sponsored: 0, left: 0, right: 0, ranked: [], lines: { r7: 3, r6: 3 } },
];

/** §9.3 SITB Daily Accrual Amount by Rank (USD). */
export const SITB_DAILY = { R1: 15, R2: 35, R3: 70, R4: 140, R5: 285, R6: 570, R7: 1070, R8: 1785, R9: 2850, R10: 4285, R11: 5700, R12: 7150 };

/** §10.7 Generational Match percentages by Weekly Rank band (Gen 1..5; 0 = not available). */
export const GM_PERCENTAGES = [
  { from: 4, to: 5, gens: [5, 0, 0, 0, 0] },
  { from: 6, to: 7, gens: [5, 5, 0, 0, 0] },
  { from: 8, to: 9, gens: [5, 5, 4, 0, 0] },
  { from: 10, to: 12, gens: [5, 5, 4, 3, 2] },
];

/** §10.8 Generation unlock requirements: personally sponsored leaders at min rank. */
export const GM_UNLOCK = [
  { generation: 1, count: 2, min_level: 3 },
  { generation: 2, count: 3, min_level: 4 },
  { generation: 3, count: 4, min_level: 4 },
  { generation: 4, count: 5, min_level: 4 },
  { generation: 5, count: 6, min_level: 4 },
];

export const DIRECT_BONUS_RATE = 0.10; // §8.1
export const CASH_SHARE = 0.90; // §15: 90% cash
export const GOLD_POINTS_SHARE = 0.10; // §15: 10% Gold Points
export const FAST5_AWARD_USD = 500; // §11.3
export const CUSTOMER_LAUNCH_AWARD_USD = 200; // §11.2

export const ILLUSTRATION_NOTE = 'Illustration only: assumes the rank is held every day; not a projection of earnings (§9.3, §21).';

export function rankByCode(code) {
  return RANKS.find((r) => r.code === String(code).toUpperCase()) || null;
}

export function levelOf(code) {
  const r = rankByCode(code);
  return r ? r.level : 0;
}

/** Round to cents (money is kept in integer cents internally to avoid float drift). */
const cents = (usd) => Math.round(usd * 100) / 100;

/** How many personally sponsored actives sit at or above a given rank level. */
function countAtOrAbove(byRank, minLevel) {
  let n = 0;
  for (const [code, count] of Object.entries(byRank || {})) if (levelOf(code) >= minLevel) n += count;
  return n;
}

/**
 * Check the ranked-directs requirement with DISTINCT people, e.g. R7 "2 at Rank 4 and 3 at Rank 3":
 * the two R4+ people cannot also be counted as two of the three R3+ people.
 * Returns [{ min_level, required, have, missing }].
 */
function rankedCheck(byRank, ranked) {
  const out = [];
  let used = 0;
  // Most demanding requirement first, so higher-ranked people are allocated to it.
  for (const req of [...ranked].sort((a, b) => b.min_level - a.min_level)) {
    const available = Math.max(0, countAtOrAbove(byRank, req.min_level) - used);
    const have = Math.min(available, req.count);
    used += have;
    out.push({ min_level: req.min_level, required: req.count, have, missing: req.count - have });
  }
  return out;
}

/** Leadership Line check (§6.3): a line counted for a Rank 7 leader can't also count as a Rank 6 line. */
function linesCheck(lines, need) {
  const highs = (lines || []).map((l) => levelOf(l.highest_rank_in_line));
  const r7 = highs.filter((h) => h >= 7).length;
  const r7used = Math.min(r7, need.r7);
  const r6available = highs.filter((h) => h >= 6).length - r7used;
  return {
    r7: { required: need.r7, have: r7used, missing: need.r7 - r7used },
    r6: { required: need.r6, have: Math.min(r6available, need.r6), missing: Math.max(0, need.r6 - r6available) },
  };
}

/**
 * Evaluate one rank's own row of §6.2 against a rank-status payload.
 * @returns {{ code, met: boolean, gaps: object }}
 */
export function checkRankRow(status, rank) {
  const s = status.personally_sponsored_active || {};
  const weak = status.weak_leg?.bv_31d ?? 0;
  const gaps = {
    weak_leg_bv: { required: rank.weak_leg_bv, have: weak, missing: Math.max(0, rank.weak_leg_bv - weak) },
  };
  if (rank.sponsored) gaps.personally_sponsored = { required: rank.sponsored, have: s.total || 0, missing: Math.max(0, rank.sponsored - (s.total || 0)) };
  if (rank.left) gaps.left_leg_sponsored = { required: rank.left, have: s.left || 0, missing: Math.max(0, rank.left - (s.left || 0)) };
  if (rank.right) gaps.right_leg_sponsored = { required: rank.right, have: s.right || 0, missing: Math.max(0, rank.right - (s.right || 0)) };
  if (rank.ranked.length) gaps.ranked_directs = rankedCheck(s.by_rank, rank.ranked);
  if (rank.lines) gaps.leadership_lines = linesCheck(status.leadership_lines, rank.lines);

  const met = Object.values(gaps).every((g) => {
    if (Array.isArray(g)) return g.every((x) => x.missing === 0);
    if (g.r7) return g.r7.missing === 0 && g.r6.missing === 0;
    return g.missing === 0;
  });
  return { code: rank.code, met, gaps };
}

/** Highest rank whose row AND every lower row is met (§6.4 no skipping). 0 = Unranked. */
export function highestQualifyingLevel(status) {
  let level = 0;
  for (const r of RANKS) {
    if (!checkRankRow(status, r).met) break;
    level = r.level;
  }
  return level;
}

/**
 * calculate_rank_gap: what exactly is missing to hold `targetCode`.
 * Includes the §6.4 check that every lower rank's requirements also hold on the same day.
 */
export function calculateRankGap(status, targetCode) {
  const target = rankByCode(targetCode);
  if (!target) throw new Error(`Unknown rank ${targetCode}`);
  const own = checkRankRow(status, target);
  const lower = RANKS.filter((r) => r.level < target.level).map((r) => checkRankRow(status, r));
  const lowerFailing = lower.filter((c) => !c.met).map((c) => ({ code: c.code, gaps: c.gaps }));
  const currentLevel = highestQualifyingLevel(status);
  const current = RANKS[currentLevel - 1] || null;
  return {
    target: { code: target.code, name: target.name, level: target.level },
    current_qualifying_rank: current ? { code: current.code, name: current.name, level: current.level } : null,
    already_qualifies: own.met && lowerFailing.length === 0,
    requirements: own.gaps,
    lower_ranks_all_met: lowerFailing.length === 0,
    lower_rank_failures: lowerFailing,
    weak_leg_side: status.weak_leg?.side ?? null,
    note: 'Requirements are measured on a single day over the rolling 31-day Volume Window; volume expires on day 32 (§6.2, §6.4, §7.4).',
    sections: ['§6.2', '§6.3', '§6.4'],
  };
}

/** Weekly SITB (§9.4) = sum of each day's Daily Accrual Amount. */
export function weeklySitb(snapshots) {
  const days = snapshots.map((d) => ({ date: d.date ?? null, rank_code: d.rank_code, daily_accrual_usd: d.rank_code ? SITB_DAILY[d.rank_code] || 0 : 0 }));
  const total = days.reduce((a, d) => a + d.daily_accrual_usd, 0);
  return { days, total_usd: total };
}

/**
 * project_sitb: arithmetic illustration of SITB if `rankCode` were held on every one of `days` days.
 * If rankCode is null, the caller passes the current daily snapshot rank.
 */
export function projectSitb(days, rankCode) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error('days must be an integer 1–31');
  const r = rankByCode(rankCode);
  if (!r) throw new Error(`Unknown rank ${rankCode}`);
  const daily = SITB_DAILY[r.code];
  const total = daily * d;
  return {
    rank: { code: r.code, name: r.name },
    days: d,
    daily_accrual_usd: daily,
    total_usd: total,
    composition: { cash_usd: cents(total * CASH_SHARE), gold_points: cents(total * GOLD_POINTS_SHARE) },
    formula: `$${daily} × ${d} days = $${total.toLocaleString('en-US')}`,
    note: ILLUSTRATION_NOTE,
    sections: ['§9.3', '§9.4', '§15', '§21'],
  };
}

/** §10.7 match percentages available at a Weekly Rank (array for Gen 1..5). */
export function gmPercentages(rankCode) {
  const lvl = levelOf(rankCode);
  const band = GM_PERCENTAGES.find((b) => lvl >= b.from && lvl <= b.to);
  return band ? [...band.gens] : [0, 0, 0, 0, 0];
}

/**
 * Which generations are both AVAILABLE (by Weekly Rank, §10.7) and UNLOCKED (§10.8).
 * byRank = personally sponsored actives by rank code.
 */
export function gmStatus(weeklyRankCode, byRank) {
  const pcts = gmPercentages(weeklyRankCode);
  return GM_UNLOCK.map((u, i) => {
    const have = countAtOrAbove(byRank, u.min_level);
    return {
      generation: u.generation,
      percent: pcts[i],
      available: pcts[i] > 0,
      unlock_requirement: `${u.count} personally sponsored at Rank ${u.min_level} or above`,
      unlocked: have >= u.count,
      have,
      pays: pcts[i] > 0 && have >= u.count,
    };
  });
}

/** §8.1 Direct Bonus on a sale's BV, split per §15. */
export function directBonus(bv) {
  const amount = cents(bv * DIRECT_BONUS_RATE);
  return { amount_usd: amount, cash_usd: cents(amount * CASH_SHARE), gold_points: cents(amount * GOLD_POINTS_SHARE) };
}

/** §15 split of any money payment. */
export function splitPayment(usd) {
  return { cash_usd: cents(usd * CASH_SHARE), gold_points: cents(usd * GOLD_POINTS_SHARE) };
}
