// Compensation agent tools: strict function definitions + implementations.
// All tools are READ-ONLY and act on the signed-in distributor only: no tool takes a distributor id.
// The id comes from the server session (ctx.principal) — the model can't ask for someone else's data,
// and the mock API would answer 403 anyway.
// In AdonisJS: app/services/comp_tools.ts calling the real WealthQuest API client.
import { calculateRankGap, projectSitb, gmStatus, weeklySitb } from '../calc/plan.js';
import { loadKnowledgeBases } from '../kb.js';

const RANK_CODES = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12'];
const noParams = { type: 'object', properties: {}, required: [], additionalProperties: false };
const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Tool definitions sent to the model (Responses API function tools, strict mode). */
export function compToolDefinitions({ includePlanReader = false } = {}) {
  const tools = [
    { type: 'function', name: 'get_my_profile', strict: true, description: "The signed-in member's profile: name, status, rank, license, good standing, timezone.", parameters: noParams },
    {
      type: 'function', name: 'get_my_performance', strict: true,
      description: 'Period totals for the signed-in member: volume (USD and BV), commissions by stream, with previous-period comparison.',
      parameters: { type: 'object', additionalProperties: false, required: ['period'], properties: { period: { type: 'string', enum: ['7d', '30d', '3m', '6m', '12m'] } } },
    },
    { type: 'function', name: 'get_my_rank_status', strict: true, description: 'Today\'s rank, last 14 Daily Rank Snapshots with SITB accrual and leg BV, Weekly Rank, weak/strong leg BV (31 days), personally sponsored actives by leg and rank, leadership lines, recent leg events.', parameters: noParams },
    {
      type: 'function', name: 'get_my_commissions', strict: true,
      description: 'Commission ledger entries (amount, 90% cash / 10% Gold Points, status accrued|approved|paid) and wallet balances for a date range.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'type'],
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
          type: { type: ['string', 'null'], enum: ['all', 'direct', 'sitb', 'matching', 'customer_launch', 'fast5', 'leadership', null] },
        },
      },
    },
    {
      type: 'function', name: 'get_my_network_directs', strict: true,
      description: 'First level of the member\'s network: personally sponsored IBOs (sponsor mode) or left/right leg heads (placement mode).',
      parameters: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['sponsor', 'placement'] } } },
    },
    {
      type: 'function', name: 'calculate_rank_gap', strict: true,
      description: 'Deterministic calculator (§6.2–§6.4): exactly what is missing for the member to hold target_rank today — weak-leg BV, sponsored actives per leg, ranked directs, leadership lines — and whether every lower rank\'s requirements hold (no skipping). Also returns Generational Match availability/unlock status.',
      parameters: { type: 'object', additionalProperties: false, required: ['target_rank'], properties: { target_rank: { type: 'string', enum: RANK_CODES } } },
    },
    {
      type: 'function', name: 'project_sitb', strict: true,
      description: 'Deterministic SITB arithmetic (§9.3): daily accrual × days if the rank were held on every day, with the 90/10 split. rank null = the member\'s current Daily Rank Snapshot. Also returns this week\'s actual accruals so far. Always an illustration, never a projection of earnings (§21).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['days', 'rank'],
        properties: { days: { type: 'integer', minimum: 1, maximum: 31 }, rank: { type: ['string', 'null'], enum: [...RANK_CODES, null] } },
      },
    },
  ];
  if (includePlanReader) {
    tools.push({
      type: 'function', name: 'read_plan_pages', strict: true,
      description: 'Read up to 3 Compensation Plan wiki pages by slug (as listed in the plan index).',
      parameters: { type: 'object', additionalProperties: false, required: ['slugs'], properties: { slugs: { type: 'array', items: { type: 'string' } } } },
    });
  }
  return tools;
}

/** Human-readable status line shown in the UI while a tool runs. */
export const TOOL_STATUS = {
  get_my_profile: 'Checking your profile…',
  get_my_performance: 'Checking your performance…',
  get_my_rank_status: 'Checking your rank status…',
  get_my_commissions: 'Checking your commissions…',
  get_my_network_directs: 'Checking your network…',
  calculate_rank_gap: 'Calculating your rank gap…',
  project_sitb: 'Calculating SITB…',
  read_plan_pages: 'Reading the Compensation Plan…',
};

/** Data-set name (router output) → API path. Used for parallel prefetch. */
export function dataPath(name, id) {
  return {
    profile: '/me',
    rank_status: `/distributors/${id}/rank-status`,
    performance: `/distributors/${id}/performance?period=30d`,
    commissions: `/distributors/${id}/commissions?type=all`,
    network: `/network/${id}?mode=sponsor&depth=1`,
    products: `/distributors/${id}/products?period=30d`,
  }[name];
}

/**
 * Execute one tool call.
 * @param {string} name
 * @param {object} args  parsed JSON arguments (already schema-constrained by strict mode; re-validated here)
 * @param {{api: {get: Function}, principal: {distributor_id: string}}} ctx
 * @returns {Promise<object>} JSON-serialisable result
 */
export async function runCompTool(name, args, ctx) {
  const id = ctx.principal.distributor_id; // ALWAYS the session's id
  switch (name) {
    case 'get_my_profile':
      return ctx.api.get('/me');
    case 'get_my_performance': {
      const period = ['7d', '30d', '3m', '6m', '12m'].includes(args.period) ? args.period : '30d';
      return ctx.api.get(`/distributors/${id}/performance?period=${period}`);
    }
    case 'get_my_rank_status':
      return ctx.api.get(`/distributors/${id}/rank-status`);
    case 'get_my_commissions': {
      const q = new URLSearchParams();
      if (isoDate(args.from)) q.set('from', args.from);
      if (isoDate(args.to)) q.set('to', args.to);
      q.set('type', args.type || 'all');
      return ctx.api.get(`/distributors/${id}/commissions?${q}`);
    }
    case 'get_my_network_directs': {
      const mode = args.mode === 'placement' ? 'placement' : 'sponsor';
      return ctx.api.get(`/network/${id}?mode=${mode}&depth=1`);
    }
    case 'calculate_rank_gap': {
      const status = await ctx.api.get(`/distributors/${id}/rank-status`);
      const gap = calculateRankGap(status, args.target_rank);
      return {
        ...gap,
        generational_match_at_current_weekly_rank: gmStatus(status.weekly_rank.rank_code, status.personally_sponsored_active.by_rank),
        data_as_of: status.as_of,
      };
    }
    case 'project_sitb': {
      const status = await ctx.api.get(`/distributors/${id}/rank-status`);
      const rank = args.rank || status.current_rank.rank_code;
      const weekStart = status.weekly_rank.period.from;
      const thisWeek = weeklySitb(status.daily_rank_snapshots.filter((s) => s.date >= weekStart));
      return {
        ...projectSitb(args.days, rank),
        rank_source: args.rank ? 'requested' : 'current Daily Rank Snapshot',
        this_week_actual_so_far: { period: status.weekly_rank.period, ...thisWeek, days_counted: thisWeek.days.length },
      };
    }
    case 'read_plan_pages': {
      const kb = loadKnowledgeBases().compplan;
      const slugs = kb.resolvePaths(args.slugs, 3); // allow-list
      return { pages: slugs.map((s) => ({ slug: s, text: kb.articleForModel(s) })) };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
