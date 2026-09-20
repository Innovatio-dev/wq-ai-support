// Mock WealthQuest backend API, mounted at /mock/api/v1.
// Response shapes follow WEALTHQUEST_BACKEND_DATA_REQUIREMENTS.md: every analytics response carries
// generated_at, period{from,to,timezone}, comparison_period, currency "USD", amount_scale, and
// metrics use the envelope { value, unit, previous_value, delta_value, delta_pct }.
//
// Two endpoints are PROPOSED ADDITIONS FOR THE AI AGENT (not in the requirements doc):
//   GET /distributors/:id/rank-status   — daily rank snapshots, legs in BV, structure, lines
//   GET /distributors/:id/commissions   — commission ledger with the 90/10 cash / Gold Points split
//
// Access rule demonstrated here: a caller may only read the distributor it is authenticated as.
// Any other :id → 403. The AI tools never pass an id; the server injects the session's id.
import crypto from 'node:crypto';
import { Router } from 'express';
import { RANKS, SITB_DAILY, rankByCode, DIRECT_BONUS_RATE, CASH_SHARE, GOLD_POINTS_SHARE } from '../calc/plan.js';

/** Token the server's own services use for in-process / internal calls. Regenerated every boot. */
export const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');

export const MARIA_ID = 'WQ-100482';
const TZ = 'America/Los_Angeles';

// ---------- date helpers (all dates are YYYY-MM-DD in Pacific Time, the plan's business day §7.1) ----------
export function ptToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(dateStr) { return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); } // 0=Sun
/** Weekly Commission Period starts Tuesday 12:00 a.m. PT (§14.1). */
export function commissionWeekStart(dateStr) {
  const back = (weekday(dateStr) - 2 + 7) % 7;
  return addDays(dateStr, -back);
}

/** Small deterministic PRNG so the dataset is stable between restarts (and tests). */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const r2 = (n) => Math.round(n * 100) / 100;
function envelope(value, previous, unit) {
  const delta = r2(value - previous);
  return { value: r2(value), unit, previous_value: r2(previous), delta_value: delta, delta_pct: previous ? r2((delta / previous) * 100) : null };
}
const rankFields = (code) => { const r = rankByCode(code); return r ? { rank_code: r.code, rank_name: r.name, rank_level: r.level } : { rank_code: null, rank_name: 'Unranked', rank_level: 0 }; };

// Money per BV used to express "volume" as money (doc business rule #1 is unresolved: volume = money or BV?).
const USD_PER_BV = 1.25;

/**
 * Build Maria's dataset relative to `now`. Story that the data tells (coherent on purpose):
 * - R4 Bronze Manager today. Weak leg = LEFT 13,480 BV, strong = RIGHT 21,950 BV (31-day window).
 * - 9 personally sponsored Active IBOs (4 left, 5 right); 2 of them at R2+ (one R2, one R3).
 * - Three days ago an old 1,900 BV order in the left leg expired (day 32, §7.4): weak leg fell to
 *   11,580 BV (< 12,000) → Daily Rank Snapshot R3 for that day ($70 SITB instead of $140).
 *   The next day new left-leg sales brought it back above 12,000 → R4 again.
 */
export function buildDataset(now = new Date()) {
  const today = ptToday(now);
  const rand = rng(100482);
  const dipDay = addDays(today, -3);

  // --- 45 days of daily snapshots (enough for 30d + comparison) ---
  const snapshots = [];
  for (let i = 44; i >= 0; i--) {
    const date = addDays(today, -i);
    let weak = Math.round(12650 + (44 - i) * 18 + rand() * 260); // slow climb
    let strong = Math.round(20400 + (44 - i) * 34 + rand() * 400);
    let rank = 'R4';
    if (date === dipDay) { weak = 11580; rank = 'R3'; }
    if (i === 0) { weak = 13480; strong = 21950; }
    if (i === 1) { weak = 13320; strong = 21880; }
    if (i === 2) { weak = 12860; strong = 21790; }
    if (i > 38) rank = 'R3'; // she was promoted to R4 about 38 days ago
    snapshots.push({ date, rank_code: rank, rank_name: rankByCode(rank).name, daily_accrual_usd: SITB_DAILY[rank], weak_leg_bv: weak, strong_leg_bv: strong });
  }

  // --- personally sponsored IBOs (Enroller Tree) with placement side ---
  const directsRaw = [
    ['WQ-100733', 'Luka Novak', 'SI', 'left', 'R3', 'active', 2150, 6420],
    ['WQ-100751', 'Ana Horvat', 'HR', 'left', 'R1', 'active', 980, 2310],
    ['WQ-100802', 'Tomaž Zupan', 'SI', 'left', null, 'active', 610, 610],
    ['WQ-100845', 'Eva Kranjc', 'SI', 'left', 'R1', 'active', 720, 1880],
    ['WQ-100760', 'Marco Bianchi', 'IT', 'right', 'R2', 'active', 1640, 5320],
    ['WQ-100788', 'Sofia Petrova', 'BG', 'right', 'R1', 'active', 890, 2740],
    ['WQ-100812', 'Jan Müller', 'DE', 'right', null, 'active', 540, 540],
    ['WQ-100830', 'Nina Kos', 'SI', 'right', null, 'active', 460, 460],
    ['WQ-100871', 'David Silva', 'PT', 'right', null, 'active', 500, 500],
    ['WQ-100899', 'Petra Vidmar', 'SI', 'right', null, 'inactive', 0, 0],
  ];
  const directs = directsRaw.map(([id, name, cc, side, rank, status, pv, tv], i) => ({
    distributor_id: id,
    full_name: name,
    ...countryOf(cc),
    ...rankFields(rank),
    status,
    joined_at: addDays(today, -(150 - i * 11)),
    sponsor_id: MARIA_ID,
    placement_parent_id: MARIA_ID,
    placement_side: side,
    personal_volume: r2(pv * USD_PER_BV),
    personal_bv: pv,
    team_volume: r2(tv * USD_PER_BV),
    team_bv: tv,
    direct_count: rank ? Math.max(1, Math.round(rand() * 4)) : 0,
    downline_count: rank ? Math.round(3 + rand() * 18) : 0,
    child_count: rank ? Math.max(1, Math.round(rand() * 3)) : 0,
    has_more_children: Boolean(rank),
  }));
  const active = directs.filter((d) => d.status === 'active');
  const byRank = { unranked: 0 };
  for (const r of RANKS) byRank[r.code] = 0;
  for (const d of active) { if (d.rank_code) byRank[d.rank_code] += 1; else byRank.unranked += 1; }

  // --- commission ledger ---
  const ledger = [];
  let seq = 5000;
  const push = (type, amount, status, periodStart, source, date) => {
    ledger.push({
      commission_id: `cm_${++seq}`,
      distributor_id: MARIA_ID,
      commission_type: type,
      amount_usd: r2(amount),
      cash_usd: r2(amount * CASH_SHARE),
      gold_points: r2(amount * GOLD_POINTS_SHARE),
      currency: 'USD',
      status,
      period: { from: periodStart, to: addDays(periodStart, 6), timezone: TZ },
      earned_on: date,
      source,
    });
  };
  const thisWeek = commissionWeekStart(today);
  // SITB: daily accruals this week (status accrued), weekly totals for the 4 previous weeks (paid).
  for (const s of snapshots.filter((x) => x.date >= thisWeek)) {
    push('sitb', s.daily_accrual_usd, 'accrued', thisWeek, { type: 'daily_rank_snapshot', rank_code: s.rank_code, date: s.date }, s.date);
  }
  for (let w = 1; w <= 5; w++) {
    const start = addDays(thisWeek, -7 * w);
    const days = snapshots.filter((x) => x.date >= start && x.date <= addDays(start, 6));
    const total = days.reduce((a, d) => a + d.daily_accrual_usd, 0) || 140 * 7;
    push('sitb', total, 'paid', start, { type: 'weekly_sitb', days: days.length || 7 }, addDays(start, 10));
  }
  // Direct Bonus = 10% of BV of each personal retail sale (§8.1).
  const orders = [];
  for (let i = 0; i < 16; i++) {
    const date = addDays(today, -Math.round(i * 2.6 + rand()));
    const bv = [300, 450, 600, 250, 900][Math.floor(rand() * 5)];
    const orderId = `ord_${88100 + i}`;
    orders.push({ order_id: orderId, date, bv, amount_usd: r2(bv * USD_PER_BV), product_code: bv >= 600 ? 'WV-PRO' : 'WV-CORE' });
    const start = commissionWeekStart(date);
    push('direct', bv * DIRECT_BONUS_RATE, start === thisWeek ? 'accrued' : start === addDays(thisWeek, -7) ? 'approved' : 'paid', start,
      { type: 'order', order_id: orderId, bv }, date);
  }
  // One Fast 5 award (§11.3): five unique customers with a ≥500 BV first purchase.
  const fast5Date = addDays(today, -12);
  push('fast5', 500, 'paid', commissionWeekStart(fast5Date), { type: 'fast5_award', customers: 5 }, fast5Date);
  // One Customer Launch Bonus (§11.2) earned when Marco's first 4 customers were verified.
  const clDate = addDays(today, -26);
  push('customer_launch', 200, 'paid', commissionWeekStart(clDate), { type: 'customer_launch', sponsored_ibo: 'WQ-100760' }, clDate);
  ledger.sort((a, b) => (a.earned_on < b.earned_on ? 1 : -1));

  return {
    today,
    now: now.toISOString(),
    profile: {
      user_id: 'usr_7f3a91c2',
      distributor_id: MARIA_ID,
      display_name: 'Maria Kovač',
      avatar_url: null,
      account_status: 'qualified',
      roles: ['distributor'],
      permissions: ['self:read'],
      locale: 'en-US',
      timezone: TZ,
      unread_notification_count: 3,
      country_code: 'SI',
      country_name: 'Slovenia',
      joined_at: addDays(today, -212),
      license_current: true,
      good_standing: true,
      ...rankFields('R4'),
    },
    snapshots,
    directs,
    byRank,
    ledger,
    orders,
    wallet: { cash_balance_usd: 2145.6, gold_points_balance: 412.4, next_payout_date: nextFriday(today), last_payout_date: addDays(nextFriday(today), -7) },
  };
}

function nextFriday(dateStr) {
  const back = (5 - weekday(dateStr) + 7) % 7 || 7;
  return addDays(dateStr, back);
}

function countryOf(cc) {
  const names = { SI: 'Slovenia', HR: 'Croatia', IT: 'Italy', BG: 'Bulgaria', DE: 'Germany', PT: 'Portugal', US: 'United States', ZA: 'South Africa', MY: 'Malaysia', SE: 'Sweden', GB: 'United Kingdom' };
  return { country_code: cc, country_name: names[cc] || cc };
}

// ---------------------------------------------------------------------------------------------
// Handlers — pure functions (path, query, principal) → { status, body }.
// The Express router and the in-process client both go through `handle`, so the same auth applies.
// ---------------------------------------------------------------------------------------------

const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30, '3m': 91, '6m': 182, '12m': 365 };

function periodFrom(query, today) {
  if (query.from && query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.from) && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
    const days = Math.round((Date.parse(query.to) - Date.parse(query.from)) / 864e5) + 1;
    return { from: query.from, to: query.to, days: Math.max(1, days) };
  }
  const days = PERIOD_DAYS[query.period] || 30;
  return { from: addDays(today, -(days - 1)), to: today, days };
}

function analyticsHeader(ds, p, amountScale = 'money_major_units') {
  const len = p.days;
  return {
    generated_at: new Date().toISOString(),
    period: { from: p.from, to: p.to, timezone: TZ, bounds: 'inclusive' },
    comparison_period: { from: addDays(p.from, -len), to: addDays(p.from, -1), timezone: TZ },
    currency: 'USD',
    amount_scale: amountScale,
  };
}

/** Scale a 30-day figure to another period length (mock only — real backend aggregates the ledger). */
function sumLedger(ds, from, to, types) {
  return ds.ledger.filter((e) => e.earned_on >= from && e.earned_on <= to && (!types || types.includes(e.commission_type)) && !(e.source.type === 'weekly_sitb'))
    .reduce((a, e) => a + e.amount_usd, 0);
}

function sitbFor(ds, from, to) {
  // SITB actually accrued per day in range (from snapshots; for older periods assume R4/R3 history).
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = ds.snapshots.find((x) => x.date === d);
    total += s ? s.daily_accrual_usd : 70;
  }
  return total;
}

function performance(ds, query) {
  const p = periodFrom(query, ds.today);
  const cmp = { from: addDays(p.from, -p.days), to: addDays(p.from, -1) };
  const last = ds.snapshots.at(-1);
  // Leg BV is a rolling 31-day figure (§4.2); for ~1-month periods report today's window exactly.
  const scale = p.days >= 28 && p.days <= 31 ? 1 : p.days / 31;
  const leftBv = Math.round(last.weak_leg_bv * Math.max(scale, 0.25));
  const rightBv = Math.round(last.strong_leg_bv * Math.max(scale, 0.25));
  const prevLeft = Math.round(leftBv * 0.93);
  const prevRight = Math.round(rightBv * 0.95);
  const personal = ds.orders.filter((o) => o.date >= p.from && o.date <= p.to);
  const prevPersonal = ds.orders.filter((o) => o.date >= cmp.from && o.date <= cmp.to);
  const personalValue = personal.reduce((a, o) => a + o.amount_usd, 0);
  const prevPersonalValue = prevPersonal.reduce((a, o) => a + o.amount_usd, 0) || personalValue * 0.9;
  const direct = personal.reduce((a, o) => a + o.bv * DIRECT_BONUS_RATE, 0);
  const prevDirect = prevPersonal.reduce((a, o) => a + o.bv * DIRECT_BONUS_RATE, 0) || direct * 0.9;
  const sitb = sitbFor(ds, p.from, p.to);
  const prevSitb = sitbFor(ds, cmp.from, cmp.to);
  const other = sumLedger(ds, p.from, p.to, ['fast5', 'customer_launch']);
  const prevOther = sumLedger(ds, cmp.from, cmp.to, ['fast5', 'customer_launch']);
  const orderCount = personal.length + Math.round(38 * scale);
  const totalVolume = (leftBv + rightBv) * USD_PER_BV + personalValue;
  const prevTotalVolume = (prevLeft + prevRight) * USD_PER_BV + prevPersonalValue;
  return {
    ...analyticsHeader(ds, p),
    distributor_id: MARIA_ID,
    period_days: p.days,
    ...rankFields(last.rank_code),
    eligible_order_count: orderCount,
    commission_status_scope: 'accrued',
    volume_unit_note: 'Volume metrics are money (USD). BV equivalents are provided in *_bv metrics because the Compensation Plan measures rank on BV (§4.2). Doc business rule #1 must be resolved.',
    metrics: {
      total_volume: envelope(totalVolume, prevTotalVolume, 'USD'),
      total_commissions: envelope(direct + sitb + other, prevDirect + prevSitb + prevOther, 'USD'),
      left_team_volume: envelope(leftBv * USD_PER_BV, prevLeft * USD_PER_BV, 'USD'),
      right_team_volume: envelope(rightBv * USD_PER_BV, prevRight * USD_PER_BV, 'USD'),
      left_team_bv: envelope(leftBv, prevLeft, 'BV'),
      right_team_bv: envelope(rightBv, prevRight, 'BV'),
      unilevel_volume: envelope(ds.directs.reduce((a, d) => a + d.team_volume, 0) * Math.max(scale, 0.25), ds.directs.reduce((a, d) => a + d.team_volume, 0) * Math.max(scale, 0.25) * 0.92, 'USD'),
      direct_bonus: envelope(direct, prevDirect, 'USD'),
      stable_income_team_bonus: envelope(sitb, prevSitb, 'USD'),
      matching_bonus: envelope(0, 0, 'USD'),
      average_deal_value: envelope(orderCount ? totalVolume / Math.max(orderCount, 1) / 10 : 0, prevTotalVolume / Math.max(orderCount, 1) / 10, 'USD/order'),
      personal_order_value: envelope(personalValue, prevPersonalValue, 'USD'),
    },
    series: {
      granularity: p.days <= 31 ? 'day' : 'week',
      personal_order_value: personal.map((o) => ({ bucket_start: o.date, bucket_end: o.date, value: o.amount_usd, unit: 'USD' })),
      weak_leg_bv: ds.snapshots.filter((s) => s.date >= p.from).map((s) => ({ bucket_start: s.date, bucket_end: s.date, value: s.weak_leg_bv, unit: 'BV' })),
    },
  };
}

function products(ds, query) {
  const p = periodFrom(query, ds.today);
  const rows = [
    { product_id: 'prd_wv_core', product_code: 'WV-CORE', product_name: 'WealthVentures Core', share: 0.46 },
    { product_id: 'prd_wv_pro', product_code: 'WV-PRO', product_name: 'WealthVentures Pro', share: 0.38 },
    { product_id: 'prd_wv_academy', product_code: 'WV-ACAD', product_name: 'WealthVentures Academy', share: 0.16 },
  ];
  const last = ds.snapshots.at(-1);
  const totalTeam = r2((last.weak_leg_bv + last.strong_leg_bv) * USD_PER_BV * Math.max(p.days / 31, 0.25));
  const personal = ds.orders.filter((o) => o.date >= p.from && o.date <= p.to);
  let allocated = 0;
  const products = rows.map((r, i) => {
    const team = i === rows.length - 1 ? r2(totalTeam - allocated) : r2(totalTeam * r.share);
    allocated += team;
    const mine = personal.filter((o) => o.product_code === r.product_code);
    return {
      product_id: r.product_id,
      product_code: r.product_code,
      product_name: r.product_name,
      personal_order_value: r2(mine.reduce((a, o) => a + o.amount_usd, 0)),
      personal_order_count: mine.length,
      team_volume: team,
      team_order_count: Math.round(team / 310),
      share_pct: r2((team / totalTeam) * 100),
    };
  });
  return { ...analyticsHeader(ds, p), distributor_id: MARIA_ID, total_team_volume: totalTeam, products,
    note: 'WealthVentures is the only live product line at launch (§2.3); GoldMind and Liquid Gold are not live.' };
}

function network(ds, query) {
  const mode = query.mode === 'placement' ? 'placement' : 'sponsor';
  const root = {
    distributor_id: MARIA_ID, full_name: 'Maria Kovač', ...countryOf('SI'), ...rankFields('R4'), status: 'active',
    joined_at: ds.profile.joined_at, sponsor_id: 'WQ-100011', placement_parent_id: 'WQ-100011', placement_side: 'left',
    personal_volume: r2(ds.orders.reduce((a, o) => a + o.amount_usd, 0)),
    team_volume: r2((ds.snapshots.at(-1).weak_leg_bv + ds.snapshots.at(-1).strong_leg_bv) * USD_PER_BV),
    direct_count: ds.directs.length, downline_count: 64, child_count: mode === 'sponsor' ? ds.directs.length : 2, has_more_children: true,
  };
  let children;
  if (mode === 'sponsor') {
    children = ds.directs.map(({ personal_bv, team_bv, ...n }) => n);
  } else {
    // Placement: one first-level node per leg (the leg heads); personally sponsored IBOs sit deeper.
    const head = (side) => ds.directs.find((d) => d.placement_side === side);
    children = ['left', 'right'].map((side) => {
      const { personal_bv, team_bv, ...n } = head(side);
      return { ...n, team_volume: r2((side === 'left' ? ds.snapshots.at(-1).weak_leg_bv : ds.snapshots.at(-1).strong_leg_bv) * USD_PER_BV), has_more_children: true };
    });
  }
  return {
    generated_at: new Date().toISOString(), as_of: ds.now, currency: 'USD', amount_scale: 'money_major_units',
    mode, depth: 1, root, children, next_cursor: null,
  };
}

/** PROPOSED ADDITION for the AI agent: everything §6/§7/§9 need, in BV. */
function rankStatus(ds) {
  const last = ds.snapshots.at(-1);
  const recent = ds.snapshots.slice(-14);
  const week = ds.snapshots.filter((s) => s.date >= commissionWeekStart(ds.today));
  const weekly = week.reduce((best, s) => (rankByCode(s.rank_code).level > rankByCode(best).level ? s.rank_code : best), week[0].rank_code);
  const active = ds.directs.filter((d) => d.status === 'active');
  return {
    _proposed_endpoint: true,
    generated_at: new Date().toISOString(),
    as_of: `${ds.today}T00:00:00-07:00`,
    distributor_id: MARIA_ID,
    period: { from: addDays(ds.today, -30), to: ds.today, timezone: TZ, note: 'rolling 31-day Volume Window (§4.2)' },
    currency: 'USD',
    amount_scale: 'BV points for volume; USD major units for accruals',
    current_rank: rankFields(last.rank_code),
    daily_rank_snapshots: recent.map((s) => ({ date: s.date, rank_code: s.rank_code, rank_name: s.rank_name, daily_accrual_usd: s.daily_accrual_usd, weak_leg_bv: s.weak_leg_bv, strong_leg_bv: s.strong_leg_bv })),
    weekly_rank: { ...rankFields(weekly), period: { from: commissionWeekStart(ds.today), to: addDays(commissionWeekStart(ds.today), 6), timezone: TZ } },
    weak_leg: { side: 'left', bv_31d: last.weak_leg_bv },
    strong_leg: { side: 'right', bv_31d: last.strong_leg_bv },
    volume_expiring_next_7_days: { left_bv: 1240, right_bv: 2100, note: 'BV leaves the window on day 32 (§7.4)' },
    recent_leg_events: [
      { date: addDays(ds.today, -3), side: 'left', type: 'volume_expired', bv: -1900, note: 'Order from 32 days earlier left the Volume Window' },
      { date: addDays(ds.today, -2), side: 'left', type: 'new_volume', bv: 1280, note: 'New retail sales in left leg (Luka Novak team)' },
      { date: addDays(ds.today, -1), side: 'left', type: 'new_volume', bv: 460 },
      { date: ds.today, side: 'left', type: 'new_volume', bv: 160 },
    ],
    personally_sponsored_active: {
      left: active.filter((d) => d.placement_side === 'left').length,
      right: active.filter((d) => d.placement_side === 'right').length,
      total: active.length,
      by_rank: ds.byRank,
    },
    personally_sponsored_inactive: ds.directs.length - active.length,
    leadership_lines: ds.directs.filter((d) => d.rank_code).map((d) => ({ line_root_id: d.distributor_id, line_root_name: d.full_name, highest_rank_in_line: d.rank_code })),
    qualified: true,
    good_standing: true,
    license_current: true,
  };
}

/** PROPOSED ADDITION for the AI agent: commission ledger. */
function commissions(ds, query) {
  const today = ds.today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : addDays(today, -30);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : today;
  const type = query.type && query.type !== 'all' ? query.type : null;
  const entries = ds.ledger.filter((e) => e.earned_on >= from && e.earned_on <= to && (!type || e.commission_type === type));
  const totals = {};
  for (const e of entries) totals[e.commission_type] = r2((totals[e.commission_type] || 0) + e.amount_usd);
  return {
    _proposed_endpoint: true,
    generated_at: new Date().toISOString(),
    period: { from, to, timezone: TZ },
    comparison_period: null,
    currency: 'USD',
    amount_scale: 'money_major_units',
    distributor_id: MARIA_ID,
    commission_status_scope: 'accrued+approved+paid',
    entries,
    totals_by_type: totals,
    total_usd: r2(entries.reduce((a, e) => a + e.amount_usd, 0)),
    wallet: ds.wallet,
    notes: ['Every money payment is 90% cash / 10% Gold Points (§15).', 'Accrued amounts are provisional until verified (§9.9).'],
  };
}

function leaderboard(ds, query) {
  const p = periodFrom(query, ds.today);
  const people = [
    ['WQ-100204', 'Alex King', 'US', 'R9', 341122], ['WQ-100377', 'Priya Nair', 'MY', 'R8', 298400], ['WQ-100129', 'Johan Berg', 'SE', 'R7', 214900],
    ['WQ-100288', 'Thandi Mokoena', 'ZA', 'R7', 198250], ['WQ-100415', 'Oliver Grant', 'GB', 'R6', 142300], ['WQ-100482', 'Maria Kovač', 'SI', 'R4', 44290],
  ];
  const limit = Math.min(Number(query.limit) || 6, 20);
  return {
    ...analyticsHeader(ds, p), metric: query.metric || 'volume', scope_type: 'global',
    rows: people.slice(0, limit).map(([id, name, cc, rank, vol], i) => ({
      position: i + 1, previous_position: i === 1 ? 3 : i === 2 ? 2 : i + 1, movement: i === 1 ? 1 : i === 2 ? -1 : 0,
      distributor_id: id, full_name: name, avatar_url: null, ...countryOf(cc), continent: cc === 'US' ? 'North America' : cc === 'MY' ? 'Asia' : cc === 'ZA' ? 'Africa' : 'Europe', region: null,
      ...rankFields(rank), volume: vol, new_customer_count: Math.round(vol / 3100), average_deal_value: 300, personal_order_value: Math.round(vol / 60),
    })),
    next_cursor: null,
  };
}

/**
 * Route + authorise one request. `principal` = { distributor_id } of the authenticated caller.
 * Every :id route checks :id === principal.distributor_id → otherwise 403.
 */
export function handle(method, pathname, query, principal, now = new Date()) {
  if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
  if (!principal || !principal.distributor_id) return { status: 401, body: { error: 'unauthenticated' } };
  const ds = buildDataset(now);
  const own = (id) => id === principal.distributor_id;
  const forbidden = { status: 403, body: { error: 'forbidden', message: 'You can only access your own distributor data.' } };

  if (pathname === '/me') return { status: 200, body: { generated_at: new Date().toISOString(), ...ds.profile } };
  if (pathname === '/leaderboard') return { status: 200, body: leaderboard(ds, query) };

  let m = pathname.match(/^\/distributors\/([\w-]+)\/(performance|products|rank-status|commissions)$/);
  if (m) {
    if (!own(m[1])) return forbidden;
    const fn = { performance, products, 'rank-status': rankStatus, commissions }[m[2]];
    return { status: 200, body: fn(ds, query) };
  }
  m = pathname.match(/^\/network\/([\w-]+)$/);
  if (m) {
    if (!own(m[1])) return forbidden;
    return { status: 200, body: network(ds, query) };
  }
  return { status: 404, body: { error: 'not_found' } };
}

/** In-process client used by the AI tools (same handler + auth as the HTTP router). */
export function mockApiClient(principal) {
  return {
    async get(pathWithQuery) {
      const url = new URL(pathWithQuery, 'http://internal');
      const res = handle('GET', url.pathname, Object.fromEntries(url.searchParams), principal);
      if (res.status !== 200) {
        const err = new Error(`${res.status} ${res.body.error}`);
        err.status = res.status;
        throw err;
      }
      return res.body;
    },
  };
}

/**
 * Express router. Accepted credentials:
 *  - `Authorization: Bearer <INTERNAL_TOKEN>` + `X-Distributor-Id` (server-to-server), or
 *  - the signed Back Office session cookie (browser), which maps to the session's distributor.
 */
export function mockApiRouter({ principalFromRequest }) {
  const router = Router();
  router.use((req, res) => {
    let principal = null;
    const auth = req.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && token.length === INTERNAL_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(INTERNAL_TOKEN))) {
      principal = { distributor_id: String(req.get('x-distributor-id') || '') };
    } else {
      principal = principalFromRequest(req);
    }
    const { status, body } = handle(req.method, req.path, req.query, principal);
    res.status(status).json(body);
  });
  return router;
}
