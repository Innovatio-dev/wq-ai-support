// Back Office shell (Figma frame 11) + Maria's dashboard (from the mock WealthQuest API)
// + floating Athena panel with two modes: Support agent and Compensation ("My earnings") agent.
import { $, $$, icons, fleur, el, escapeHtml, ChatView, GREETING, COMP_GREETING, mountCostInspector } from './common.js';

mountCostInspector({ agents: ['support', 'comp'] });

// ---------- shell ----------
$('#bo-logo').insertAdjacentHTML('afterbegin', fleur());
$('#bo-mlogo').innerHTML = fleur();
$('#pt').outerHTML = icons.panel.replace('<svg', '<svg class="pt"');
const NAV = [
  ['Dashboard', 'home', true], ['Earnings', 'earnings'], ['Rank Progress', 'diamond'], ['Bonuses', 'bonus'], ['Transactions', 'transactions'], ['Billing', 'billing'], null,
  ['Products', 'products'], ['Memberships', 'vip'], ['Shop', 'cart'], null,
  ['Binary tree', 'tree'], ['Network', 'network'], ['Members', 'members'], null,
  ['Referral links', 'link'], ['Assets', 'assets'], ['Enroll member', 'userPlus'],
];
$('#nav').innerHTML = NAV.map((n) => (n ? `<a href="${n[2] ? '/backoffice' : '#'}"${n[2] ? ' aria-current="page"' : ''}>${icons[n[1]]}${n[0]}</a>` : '<hr>')).join('');
$('#s-ico').outerHTML = icons.search;
$('#enroll').innerHTML = `${icons.plus} Enroll member`;
$('#share').innerHTML = `${icons.share} Share link`;
$('#bell').innerHTML = `${icons.bell}<span class="red"></span>`;
$('#flag').innerHTML = icons.flagUS.replace('<svg', '<svg class="flag"');

// "Mon, Sep 21 • Week 39" — today's date and ISO week number.
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}
const now = new Date();
$('#date').innerHTML = `${icons.calendar}<span>${now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="dot"></span><span>Week ${isoWeek(now)}</span>`;

// ---------- dashboard ----------
const usd = (n, d = 0) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const n0 = (n) => Number(n).toLocaleString('en-US');
const pct = (a, b) => Math.max(2, Math.min(100, Math.round((a / b) * 100)));
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
const dateLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const TYPE = { sitb: 'SITB', direct: 'Direct Bonus', fast5: 'Fast 5 Bonus', customer_launch: 'Customer Launch Bonus', matching: 'Generational Match', leadership: 'Leadership Rank Bonus' };

async function loadDashboard() {
  const r = await fetch('/api/backoffice/summary', { credentials: 'same-origin' });
  if (!r.ok) { $('#grid').innerHTML = '<div class="card span3">Could not load your dashboard.</div>'; return; }
  const { me, rank, perf, commissions, products } = await r.json();
  $('#who').textContent = `Welcome back, ${me.display_name.split(' ')[0]} · ${me.distributor_id}`;
  const s = rank.personally_sponsored_active;
  const r2plus = Object.entries(s.by_rank).filter(([k]) => /^R\d+$/.test(k) && +k.slice(1) >= 2).reduce((a, [, v]) => a + v, 0);

  // Weekly SITB (Tue–Mon): days so far from snapshots, the rest greyed out.
  const weekFrom = rank.weekly_rank.period.from;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(`${weekFrom}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, snap: rank.daily_rank_snapshots.find((x) => x.date === iso) });
  }
  const weekTotal = days.reduce((a, d) => a + (d.snap?.daily_accrual_usd || 0), 0);

  // Sparkline of weak-leg BV (last 14 days) with the R4 threshold (12,000 BV).
  const pts = rank.daily_rank_snapshots.map((x) => x.weak_leg_bv);
  const lo = Math.min(11000, ...pts) - 300; const hi = Math.max(...pts) + 300;
  const X = (i) => (i / (pts.length - 1)) * 300; const Y = (v) => 80 - ((v - lo) / (hi - lo)) * 72;
  const line = pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const dipIdx = rank.daily_rank_snapshots.findIndex((x) => x.rank_code !== rank.current_rank.rank_code);

  const m = perf.metrics;
  const deltaHtml = (e) => (e.delta_pct == null ? '' : `<span class="delta${e.delta_pct < 0 ? ' neg' : ''}">${e.delta_pct >= 0 ? '▲' : '▼'} ${Math.abs(e.delta_pct).toFixed(1)}% vs previous 30 days</span>`);

  $('#grid').innerHTML = `
    <section class="card">
      <h3>Current rank <span class="muted">as of today</span></h3>
      <div class="rank-row"><span class="rank-badge">${rank.current_rank.rank_code}</span><div><b>${escapeHtml(rank.current_rank.rank_name)}</b><span>Next: Silver Manager (R5)</span></div></div>
      <div class="bars">
        <div><div class="bar-l"><span>Weak-leg BV (31 days)</span><b>${n0(rank.weak_leg.bv_31d)} / 24,000</b></div><div class="bar"><i style="width:${pct(rank.weak_leg.bv_31d, 24000)}%"></i></div></div>
        <div><div class="bar-l"><span>Personally sponsored actives</span><b>${s.total} / 10</b></div><div class="bar"><i style="width:${pct(s.total, 10)}%"></i></div></div>
        <div><div class="bar-l"><span>Sponsored at Rank 2+</span><b>${r2plus} / 3</b></div><div class="bar"><i style="width:${pct(r2plus, 3)}%"></i></div></div>
      </div>
      <button class="ask-link" type="button" data-ask="How close am I to Silver Manager?">Ask Athena how close I am ${icons.arrowRight}</button>
    </section>

    <section class="card">
      <h3>Leg volume <span class="muted">rolling 31 days</span></h3>
      <div class="legs">
        <div class="leg"><span>Weak leg · ${rank.weak_leg.side}</span><b>${n0(rank.weak_leg.bv_31d)} BV</b></div>
        <div class="leg"><span>Strong leg · ${rank.strong_leg.side}</span><b>${n0(rank.strong_leg.bv_31d)} BV</b></div>
      </div>
      <svg class="spark" viewBox="0 0 300 86" preserveAspectRatio="none" role="img" aria-label="Weak-leg BV over the last 14 days">
        <line x1="0" x2="300" y1="${Y(12000).toFixed(1)}" y2="${Y(12000).toFixed(1)}" stroke="#D8BE86" stroke-dasharray="4 4" stroke-width="1"/>
        <polyline points="${line}" fill="none" stroke="#1F4A44" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        ${dipIdx >= 0 ? `<circle cx="${X(dipIdx)}" cy="${Y(pts[dipIdx])}" r="3.5" fill="#B8955A"/>` : ''}
      </svg>
      <div class="spark-cap"><span>${dateLabel(rank.daily_rank_snapshots[0].date)}</span><span>- - R4 requirement 12,000 BV</span><span>Today</span></div>
      <button class="ask-link" type="button" data-ask="Why did my weak leg change?">Why did my weak leg change? ${icons.arrowRight}</button>
    </section>

    <section class="card">
      <h3>This week’s SITB <span class="muted">${dateLabel(weekFrom)} – ${dateLabel(days[6].iso)}</span></h3>
      <div class="big">${usd(weekTotal)}<small>accrued so far</small></div>
      <div class="days">${days.map((d) => `<div class="day${d.snap ? (d.snap.rank_code !== rank.current_rank.rank_code ? ' dip' : '') : ' future'}"><div class="d">${dayLabel(d.iso)}</div><div class="r">${d.snap ? d.snap.rank_code : '–'}</div><div class="a">${d.snap ? usd(d.snap.daily_accrual_usd) : '—'}</div></div>`).join('')}</div>
      <p class="note">Accrues daily at each day’s rank, paid weekly on ${dateLabel(commissions.wallet.next_payout_date)} as 90% cash / 10% Gold Points (§9, §15). Provisional until verified.</p>
    </section>

    <section class="card">
      <h3>Direct Bonus <span class="muted">last 30 days</span></h3>
      <div class="big">${usd(m.direct_bonus.value)}</div>
      ${deltaHtml(m.direct_bonus)}
      <p class="note">10% of BV on each of your personal retail sales (§8.1).</p>
    </section>

    <section class="card">
      <h3>Wallet</h3>
      <div class="big">${usd(commissions.wallet.cash_balance_usd, 2)}<small>cash</small></div>
      <div class="kv"><div><span>Gold Points</span><b>${n0(commissions.wallet.gold_points_balance)} GP</b></div><div><span>Next payout</span><b>Fri, ${dateLabel(commissions.wallet.next_payout_date)}</b></div></div>
    </section>

    <section class="card">
      <h3>Product share <span class="muted">team volume, 30 days</span></h3>
      <div class="share">${products.products.map((p) => `<div><div class="bar-l"><span>${escapeHtml(p.product_name)}</span><b>${p.share_pct.toFixed(0)}%</b></div><div class="bar gold"><i style="width:${p.share_pct}%"></i></div></div>`).join('')}</div>
    </section>

    <section class="card span3">
      <h3>Recent commissions <span class="muted">accrued, approved and paid</span></h3>
      <div style="overflow-x:auto"><table class="ptable"><thead><tr><th>Date</th><th>Type</th><th>Source</th><th>Status</th><th class="r">Amount</th><th class="r">Cash (90%)</th><th class="r">Gold Points (10%)</th></tr></thead><tbody>
      ${commissions.entries.slice(0, 8).map((e) => `<tr><td>${dateLabel(e.earned_on)}</td><td>${TYPE[e.commission_type] || e.commission_type}</td><td>${escapeHtml(sourceLabel(e.source))}</td><td><span class="status ${e.status}">${e.status}</span></td><td class="r">${usd(e.amount_usd, 2)}</td><td class="r">${usd(e.cash_usd, 2)}</td><td class="r">${n0(e.gold_points)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>`;
  $('#grid').setAttribute('aria-busy', 'false');
  $$('[data-ask]').forEach((b) => b.addEventListener('click', () => { openPanel('comp'); comp.send(b.dataset.ask); }));
}
function sourceLabel(src) {
  if (src.type === 'order') return `Order ${src.order_id} · ${n0(src.bv)} BV`;
  if (src.type === 'daily_rank_snapshot') return `Daily snapshot ${src.rank_code}`;
  if (src.type === 'weekly_sitb') return `Weekly SITB (${src.days} days)`;
  if (src.type === 'fast5_award') return '5 qualifying customers';
  if (src.type === 'customer_launch') return `Sponsored IBO ${src.sponsored_ibo}`;
  return src.type;
}
loadDashboard();

// ---------- Athena panel ----------
$('#launcher').innerHTML = icons.chat;
$('#p-fleur').outerHTML = fleur({ gradient: false });
$('#p-close').innerHTML = icons.x;
$('#send').innerHTML = icons.arrowUp;

const SUGGESTIONS = ['How close am I to Silver Manager?', 'What will my SITB be this week?', 'Why did my weak leg change?', 'Explain Generational Match with my numbers'];
const support = new ChatView({ body: $('#body-support'), agent: 'support', surface: 'backoffice', storageKey: 'wq_chat_bo_support', greeting: GREETING, onBusy: (b) => busy(b) });
const comp = new ChatView({ body: $('#body-comp'), agent: 'comp', surface: 'backoffice', storageKey: 'wq_chat_bo_comp', greeting: COMP_GREETING, onBusy: (b) => busy(b), onChange: () => chips() });
let mode = 'support';

function busy(b) { $('#send').disabled = b; }
function chips() {
  $$('.suggestions', $('#body-comp')).forEach((x) => x.remove());
  if (comp.state.messages.length) return;
  const box = el(`<div class="suggestions">${SUGGESTIONS.map((q) => `<button type="button">${escapeHtml(q)}</button>`).join('')}</div>`);
  $$('button', box).forEach((b) => b.addEventListener('click', () => { box.remove(); comp.send(b.textContent); }));
  $('#body-comp').append(box);
}
chips();

function setMode(m) {
  mode = m;
  $$('.mode button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $('#body-support').hidden = m !== 'support';
  $('#body-comp').hidden = m !== 'comp';
  $('#p-role').textContent = m === 'comp' ? 'Compensation Agent' : 'Support Agent';
  $('#msg').placeholder = m === 'comp' ? 'Ask about your rank, volume or bonuses...' : 'Ask a detailed question...';
  (m === 'comp' ? comp : support).scroll(false);
}
$$('.mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function openPanel(m) {
  $('#panel').hidden = false;
  $('#launcher').setAttribute('aria-expanded', 'true');
  if (m) setMode(m);
  $('#msg').focus({ preventScroll: true });
}
function closePanel() { $('#panel').hidden = true; $('#launcher').setAttribute('aria-expanded', 'false'); }
$('#launcher').addEventListener('click', () => ($('#panel').hidden ? openPanel() : closePanel()));
$('#p-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#panel').hidden) closePanel(); });

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#msg').value.trim();
  const view = mode === 'comp' ? comp : support;
  if (!t || view.busy) return;
  $('#msg').value = '';
  view.send(t); // (comp suggestion chips disappear via onChange once the conversation has messages)
});

// Deep link for demos/screenshots: /backoffice?chat=support|comp
const open = new URLSearchParams(location.search).get('chat');
if (open === 'support' || open === 'comp') openPanel(open);
