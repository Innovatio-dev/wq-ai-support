// LLM client factory + small helpers around the Responses API.
// - Real mode: official SDK (openai@7.20.0) pointed at OpenRouter's OpenAI-compatible Responses API
//   (see docs/openrouter-plan.md). The key is read from env and never sent to the browser.
// - MOCK_OPENAI=1: a deterministic fake client with the same surface (`responses.create`) that streams
//   canned answers and returns realistic usage numbers, so the whole UI (including the cost inspector)
//   can be tested without a key.
// In AdonisJS this becomes app/services/llm_service.ts (+ a fake bound in tests via the IoC container).
import OpenAI from 'openai';
import { config } from './config.js';
import { loadKnowledgeBases, normalizePath } from './kb.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

let client = null;

/** Returns the client, or null when no key is configured (UI then shows a clear inline error). */
export function getClient() {
  if (client) return client;
  if (config.mock) client = createMockClient();
  else if (config.openrouterKey) {
    const defaultHeaders = {};
    if (config.openrouterAppUrl) defaultHeaders['HTTP-Referer'] = config.openrouterAppUrl;
    if (config.openrouterAppName) defaultHeaders['X-Title'] = config.openrouterAppName;
    client = new OpenAI({ apiKey: config.openrouterKey, baseURL: OPENROUTER_BASE_URL, defaultHeaders, maxRetries: 1, timeout: 60_000 });
  }
  return client;
}

/** True when AI calls can be made (mock, or an OpenRouter key is set). */
export function hasKey() {
  return config.mock || Boolean(config.openrouterKey);
}

export const NO_KEY_MESSAGE = 'Server has no OpenRouter API key configured';

/** Model id as OpenRouter names it: `gpt-5.6-terra` → `openai/gpt-5.6-terra`. The mock keeps plain names. */
export function providerModel(name, provider = activeProvider()) {
  return provider === 'openrouter' && !name.includes('/') ? `openai/${name}` : name;
}

function activeProvider() {
  return config.mock ? 'mock' : 'openrouter';
}

/**
 * Adapt our request body for OpenRouter. Callers may pass `session_id` (the conversation id);
 * OpenRouter uses it to pin a conversation to one upstream provider for cache hits. The mock gets neither.
 */
export function toProviderParams(params, {
  provider = activeProvider(),
  dataCollection = config.openrouterDataCollection,
  zdr = config.openrouterZdr,
} = {}) {
  const { session_id: sessionId, ...rest } = params;
  if (provider !== 'openrouter') return rest;
  return {
    ...rest,
    model: providerModel(rest.model, provider),
    provider: { data_collection: dataCollection, ...(zdr ? { zdr: true } : {}) },
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/**
 * Stream a Responses API call and yield normalised events:
 *   { type: 'text', delta } | { type: 'item', item } | { type: 'completed', response }
 * `response.incomplete` (e.g. max_output_tokens reached) is reported as completed so usage is still recorded.
 * Throws on `response.failed` / `error` events.
 */
export async function* streamResponse(params) {
  const stream = await getClient().responses.create({ ...toProviderParams(params), stream: true });
  for await (const ev of stream) {
    switch (ev.type) {
      case 'response.output_text.delta':
        yield { type: 'text', delta: ev.delta };
        break;
      case 'response.output_item.done':
        yield { type: 'item', item: ev.item };
        break;
      case 'response.completed':
      case 'response.incomplete':
        yield { type: 'completed', response: ev.response };
        return;
      case 'response.failed':
        throw new Error(ev.response?.error?.message || 'OpenRouter response failed');
      case 'error':
        throw new Error(ev.message || ev.error?.message || 'OpenRouter stream error');
      default:
        break; // reasoning deltas, argument deltas etc. are not needed by the UI
    }
  }
}

/** Non-streaming call (router, structured output). */
export async function createResponse(params) {
  return getClient().responses.create({ ...toProviderParams(params), stream: false });
}

// =============================================================================================
// Mock client
// =============================================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORD_DELAY_MS = Number(process.env.MOCK_WORD_DELAY_MS ?? 25);

function usage(input, cached, output, reasoning = 0, write = 0) {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

/** Pull plain text of the last user message out of a Responses `input` array. */
function lastUserText(input) {
  const msgs = (Array.isArray(input) ? input : []).filter((m) => m.role === 'user');
  const last = msgs.at(-1);
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : (last.content || []).map((c) => c.text || '').join(' ');
}

const STOP = new Set('the a an to of and or i my me is it how do can what in on for with you your we our this that be are am not have has was'.split(' '));
function words(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)); }

// Test phrases the fake routers mark as `flagged` (the moderation check).
const MOCK_FLAGGED = /\b(kill|bomb|weapons?)\b/i;

/** Fake router: keyword overlap between the question and each article's title/summary/aliases. */
function mockSupportRoute(text) {
  const kb = loadKnowledgeBases().support;
  const q = new Set(words(text));
  const scored = kb.paths.map((p) => {
    const d = kb.get(p);
    const hay = words([d.meta.title, d.meta.summary, ...(d.meta.aliases || []), p.replace(/[-/]/g, ' ')].join(' '));
    let score = 0;
    for (const w of hay) if (q.has(w)) score += 1;
    return { p: d.path, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const lower = text.toLowerCase();
  let intent = 'answer';
  if (/\b(ticket|human|agent|person)\b/.test(lower)) intent = 'ticket';
  else if (/^(hi|hello|hey)\b/.test(lower) && scored.length === 0) intent = 'greeting';
  else if (scored.length === 0) intent = 'clarify';
  return { intent, paths: scored.slice(0, 2).map((x) => x.p), search_terms: [...q].slice(0, 5).join(' '), reply_language: 'en', flagged: MOCK_FLAGGED.test(text) };
}

function mockCompRoute(text) {
  const t = text.toLowerCase();
  const pages = [];
  const data = new Set(['rank_status']);
  let intent = 'my_status';
  if (/silver|rank|close|gap|next/.test(t)) pages.push('rank-ladder');
  if (/sitb|week|daily|team bonus/.test(t)) { pages.push('sitb'); intent = 'projection'; data.add('commissions'); }
  if (/weak leg|leg|volume|bv/.test(t)) { pages.push('definitions-volume-bv-weak-leg', 'rank-determination'); intent = 'history'; data.add('performance'); }
  if (/generational|match/.test(t)) { pages.push('generational-match'); intent = 'explain_rule'; }
  if (!pages.length) { pages.push('overview-and-principles'); intent = 'other'; data.add('profile'); }
  return { plan_pages: [...new Set(pages)].slice(0, 4), data_needed: [...data], intent, flagged: MOCK_FLAGGED.test(text) };
}

/** Extract `<article path="...">body</article>` blocks from the developer message. */
function articlesFromInput(input) {
  const dev = (input || []).find((m) => m.role === 'developer');
  const text = typeof dev?.content === 'string' ? dev.content : (dev?.content || []).map((c) => c.text).join('');
  const out = [];
  for (const m of String(text).matchAll(/<article path="([^"]+)">\n?([\s\S]*?)<\/article>/g)) out.push({ path: m[1], body: m[2] });
  return out;
}

/** Compose a short Markdown answer from an article's intro + first section. */
function composeSupportAnswer(article) {
  const kb = loadKnowledgeBases().support;
  const d = kb.get(article.path);
  const body = d.body.replace(/^# .*\n+/, '').split('\n## Related')[0];
  const parts = body.split(/\n(?=## )/);
  const intro = parts[0].trim();
  const sections = parts.slice(1, 3).map((s) => s.replace(/^## /, '### ').trim());
  const md = [intro, ...sections, `For more information, see [${d.meta.title}](/help/${d.path}).`].join('\n\n');
  return kb.linkify(md);
}

function mockTicketArgs(text, articles) {
  const kb = loadKnowledgeBases().support;
  const d = articles[0] ? kb.get(articles[0].path) : null;
  const category = d ? (d.meta.subcategory ? 'Manage your account' : d.meta.category) : 'Something else';
  const subcategory = d?.meta.subcategory || null;
  return {
    category,
    subcategory,
    summary: (d ? `Help needed: ${d.meta.title}` : 'Support request').slice(0, 80),
    description: `I tried the steps in the help center but I still need help. ${text}`.slice(0, 600),
  };
}

/** Deterministic comp-agent behaviour: first turn → tool calls; after tool outputs → canned answer. */
function mockCompTurn(input) {
  const outputs = (input || []).filter((i) => i.type === 'function_call_output');
  const q = lastUserText(input).toLowerCase();
  if (!outputs.length) {
    const calls = [];
    if (/silver|close|next rank|gap/.test(q)) calls.push(['calculate_rank_gap', { target_rank: 'R5' }]);
    if (/sitb|this week|daily/.test(q)) calls.push(['project_sitb', { days: 7, rank: null }]);
    if (/generational|match/.test(q)) calls.push(['calculate_rank_gap', { target_rank: 'R5' }]);
    if (!calls.length && !/weak leg/.test(q)) calls.push(['get_my_profile', {}]);
    if (calls.length) return { calls };
  }
  const results = Object.fromEntries(outputs.map((o) => { try { return [o.call_id, JSON.parse(o.output)]; } catch { return [o.call_id, {}]; } }));
  const all = Object.values(results);
  const gap = all.find((r) => r.requirements);
  const sitb = all.find((r) => r.daily_accrual_usd);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  if (gap) {
    const r = gap.requirements;
    const rd = (r.ranked_directs || [])[0];
    return { text: [
      `You currently hold **${gap.current_qualifying_rank?.code} ${gap.current_qualifying_rank?.name}**. To hold **${gap.target.code} ${gap.target.name}** on a given day you would need, on that same day (§6.2):`,
      '',
      `- **Weak-leg BV:** ${fmt(r.weak_leg_bv.have)} of ${fmt(r.weak_leg_bv.required)} BV — **${fmt(r.weak_leg_bv.missing)} BV missing** in your ${gap.weak_leg_side} leg (rolling 31 days, §4.2).`,
      `- **Personally sponsored Active IBOs:** ${r.personally_sponsored.have} of ${r.personally_sponsored.required} — **${r.personally_sponsored.missing} missing**.`,
      rd ? `- **Sponsored IBOs at Rank ${rd.min_level}+:** ${rd.have} of ${rd.required} — **${rd.missing} missing**.` : '',
      '',
      gap.lower_ranks_all_met ? 'All lower-rank requirements (R1–R4, including the left/right balance) are met, so nothing else blocks you (§6.4).' : 'Some lower-rank requirements are not met (§6.4).',
      '',
      'Volume leaves the window on day 32 (§7.4), so these gaps can change daily. Figures are illustrations, not income projections (§21).',
    ].filter((l) => l !== null).join('\n') };
  }
  if (sitb) {
    return { text: [
      `Your Daily Rank Snapshot is currently **${sitb.rank.code} ${sitb.rank.name}**, which accrues **$${fmt(sitb.daily_accrual_usd)} per day** (§9.3).`,
      '',
      `If you held ${sitb.rank.code} on every day of a 7-day Weekly Commission Period, the arithmetic is ${sitb.formula}, paid as $${fmt(sitb.composition.cash_usd)} cash and ${fmt(sitb.composition.gold_points)} Gold Points (§15).`,
      '',
      'SITB is summed day by day (§9.4): this week you had one R3 day, which accrued $70 instead of $140.',
      '',
      '_Illustration only; assumes the rank is held every day; not a projection of earnings (§21)._',
    ].join('\n') };
  }
  return { text: 'Your weak leg is your **left** leg. Three days ago a 1,900 BV order left the 31-day Volume Window (it expires on day 32, §7.4), so your left leg fell to **11,580 BV**, below the 12,000 BV that R4 requires. That day your Daily Rank Snapshot was **R3** (§7.1). New left-leg sales since then brought it back to **13,480 BV** today, so you hold R4 again (§6.2).' };
}

/** Wrap a finished response into an async iterable of SSE-shaped events (word-by-word text). */
async function* fakeStream(response, text) {
  yield { type: 'response.created', response: { ...response, status: 'in_progress' } };
  if (text) {
    const tokens = text.split(/(\s+)/);
    for (const tok of tokens) {
      if (!tok) continue;
      yield { type: 'response.output_text.delta', delta: tok };
      if (/\S/.test(tok)) await sleep(WORD_DELAY_MS);
    }
  }
  for (const item of response.output) yield { type: 'response.output_item.done', item };
  yield { type: 'response.completed', response };
}

function createMockClient() {
  let n = 0;
  const id = (p) => `${p}_mock_${Date.now().toString(36)}_${++n}`;
  return {
    _mock: true,
    responses: {
      async create(params) {
        const fmt = params.text?.format;
        const tools = (params.tools || []).map((t) => t.name);
        const q = lastUserText(params.input);
        let output = [];
        let text = '';
        let u;
        await sleep(fmt ? 120 : 60); // simulate network + time-to-first-token

        if (fmt?.type === 'json_schema' && fmt.name === 'support_route') {
          text = JSON.stringify(mockSupportRoute(q));
          u = usage(3100, 2900, 60);
        } else if (fmt?.type === 'json_schema' && fmt.name === 'comp_route') {
          text = JSON.stringify(mockCompRoute(q));
          u = usage(2400, 2200, 55);
        } else if (tools.includes('create_support_ticket')) {
          const articles = articlesFromInput(params.input);
          if (/\b(ticket|human)\b/i.test(q) || !articles.length) {
            const args = mockTicketArgs(q, articles);
            output.push({ type: 'function_call', id: id('fc'), call_id: id('call'), name: 'create_support_ticket', arguments: JSON.stringify(args), status: 'completed' });
            u = usage(2400, 1700, 95);
          } else {
            text = composeSupportAnswer(articles[0]);
            u = usage(2400, 1700, 380);
          }
        } else if (tools.includes('calculate_rank_gap')) {
          const turn = mockCompTurn(params.input);
          if (turn.calls) {
            output = turn.calls.map(([name, args]) => ({ type: 'function_call', id: id('fc'), call_id: id('call'), name, arguments: JSON.stringify(args), status: 'completed' }));
            u = usage(5200, 3900, 90, 40);
          } else {
            text = turn.text;
            u = usage(6100, 4700, 420, 120);
          }
        } else {
          text = 'Mock response.';
          u = usage(100, 0, 5);
        }
        if (text) output.unshift({ type: 'message', id: id('msg'), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
        const response = { id: id('resp'), object: 'response', model: params.model, status: 'completed', output, output_text: text, usage: u };
        return params.stream ? fakeStream(response, text) : response;
      },
    },
  };
}

export { normalizePath };
