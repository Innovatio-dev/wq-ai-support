// Compensation Plan agent (Back Office only).
//   1. router (cheap model, structured output) picks plan pages + which of the member's data is needed
//   2. server loads those pages (allow-list) and PREFETCHES the data in parallel — this saves
//      tool-call round trips, so answers are faster and cheaper
//   3. agent (streams) answers with section citations; calls read-only tools / calculators for
//      anything missing (max 4 iterations)
// In AdonisJS: app/services/comp_agent_service.ts, called from CompMessagesController.
import { loadKnowledgeBases } from '../kb.js';
import { streamResponse, createResponse } from '../openai.js';
import { prompt, usageEvent, parseJsonOutput, routerContext, historyMessages, escapeTagText } from './common.js';
import { compToolDefinitions, runCompTool, TOOL_STATUS, dataPath } from '../tools/comp-tools.js';
import { addTurn } from '../conversations.js';
import { mockApiClient, ptToday } from '../mock/wq-api.js';
import { config } from '../config.js';

const DATA_SETS = ['profile', 'rank_status', 'performance', 'commissions', 'network', 'products'];
const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan_pages: { type: 'array', items: { type: 'string' } },
    data_needed: { type: 'array', items: { type: 'string', enum: DATA_SETS } },
    intent: { type: 'string', enum: ['explain_rule', 'my_status', 'projection', 'history', 'other'] },
    flagged: { type: 'boolean' }, // moderation verdict (OpenRouter has no /moderations endpoint)
  },
  required: ['plan_pages', 'data_needed', 'intent', 'flagged'],
};

let ROUTER_INSTRUCTIONS = null;
const routerInstructions = () => (ROUTER_INSTRUCTIONS ??= `${prompt('comp-router')}\n\n${loadKnowledgeBases().compplan.indexText.trim()}`);

/**
 * Run one user turn of the compensation agent.
 * @param {object} p  { text, conv, combo, safetyId, principal, sse }
 */
export async function runCompTurn({ text, conv, combo, safetyId, principal, sse }) {
  const kb = loadKnowledgeBases().compplan;
  const api = mockApiClient(principal); // production: real WealthQuest API client with the user's token
  const ctx = { api, principal };
  const history = conv.turns.slice();
  addTurn(conv, 'user', text);

  // ---- 1. Router (optional per combo; its `flagged` field is the moderation check) ----
  // Without a router (sol-only) the agent prompt's own refusal rules apply.
  let route = { plan_pages: [], data_needed: [], intent: 'other' };
  if (combo.router) {
    sse.send('status', { text: 'Reading the Compensation Plan…' });
    const t0 = performance.now();
    const res = await createResponse({
      model: combo.router.model,
      instructions: routerInstructions(),
      input: [{ role: 'user', content: `${history.length ? `Conversation so far:\n${routerContext(history)}\n\n` : ''}Latest user message:\n${text}` }],
      reasoning: { effort: combo.router.effort },
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'comp_route', schema: ROUTE_SCHEMA, strict: true } },
      max_output_tokens: 300,
      store: false,
      safety_identifier: safetyId,
      session_id: conv.id,
    });
    sse.send('usage', usageEvent({ step: 'router', model: combo.router.model, effort: combo.router.effort, usage: res.usage, startedAt: t0 }));
    route = parseJsonOutput(res) || route;
    if (route.flagged === true) return refuse(conv, sse);
  }

  // ---- 2. Load plan pages (allow-list) + prefetch member data in parallel ----
  const slugs = kb.resolvePaths(route.plan_pages, 4);
  const wanted = [...new Set((route.data_needed || []).filter((d) => DATA_SETS.includes(d)))];
  if (wanted.length) sse.send('status', { text: 'Checking your numbers…' });
  const prefetched = await Promise.all(wanted.map(async (name) => {
    const p = dataPath(name, principal.distributor_id);
    try { return { name, source: `GET /api/v1${p}`, data: await api.get(p) }; } catch (err) { return { name, source: `GET /api/v1${p}`, error: err.message }; }
  }));

  const dev = [
    `Today is ${ptToday()} (America/Los_Angeles, the plan's business day). Signed-in member: ${config.backofficeUser.display_name}. Router intent: ${route.intent}.`,
    slugs.length
      ? slugs.map((s) => `<plan_page slug="${s}" section="${kb.get(s).meta.section}">\n${escapeTagText(kb.articleForModel(s))}\n</plan_page>`).join('\n\n')
      : combo.router
        ? 'No plan page was preselected.'
        : `No pages were preselected. Plan index (use read_plan_pages to open pages):\n${kb.indexText}`,
    ...prefetched.map((d) => (d.error
      ? `<user_data source="${d.source}" error="${d.error}"></user_data>`
      : `<user_data source="${d.source}">\n${escapeTagText(JSON.stringify(d.data))}\n</user_data>`)),
  ].join('\n\n');

  // ---- 3. Agent with tool loop ----
  const input = [{ role: 'developer', content: dev }, ...historyMessages(history, 8), { role: 'user', content: text }];
  const tools = compToolDefinitions({ includePlanReader: !combo.router });
  let answer = '';
  for (let i = 1; i <= config.limits.maxToolIterations + 1; i++) {
    const lastChance = i > config.limits.maxToolIterations; // force a text answer after max iterations
    if (i > 1) sse.send('status', { text: 'Putting it together…' });
    const t = performance.now();
    const calls = [];
    let completed = null;
    for await (const ev of streamResponse({
      model: combo.agent.model,
      instructions: prompt('comp-agent'),
      input,
      tools,
      tool_choice: lastChance ? 'none' : 'auto',
      reasoning: { effort: combo.agent.effort },
      text: { verbosity: 'low' },
      max_output_tokens: 1400,
      store: false,
      include: ['reasoning.encrypted_content'], // lets us replay reasoning items statelessly
      safety_identifier: safetyId,
      session_id: conv.id,
    })) {
      if (sse.closed) return;
      if (ev.type === 'text') { answer += ev.delta; sse.send('delta', { text: ev.delta }); }
      else if (ev.type === 'item' && ev.item.type === 'function_call') calls.push(ev.item);
      else if (ev.type === 'completed') completed = ev.response;
    }
    if (completed) {
      sse.send('usage', usageEvent({ step: i === 1 ? 'agent' : `agent · tool loop ${i - 1}`, model: combo.agent.model, effort: combo.agent.effort, usage: completed.usage, startedAt: t }));
    }
    if (!calls.length || lastChance) break;

    // Replay the model's output items (reasoning + function calls), then append each tool result.
    input.push(...(completed?.output || calls));
    for (const call of calls) {
      sse.send('status', { text: TOOL_STATUS[call.name] || 'Working…', tool: call.name });
      let output;
      try {
        output = await runCompTool(call.name, JSON.parse(call.arguments || '{}'), ctx);
      } catch (err) {
        output = { error: err.message };
      }
      input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) });
    }
  }
  addTurn(conv, 'assistant', answer || '(no answer)');
}

function refuse(conv, sse) {
  const msg = "Sorry, I can't help with that. Ask me about the Compensation Plan or your own rank, volume and bonuses.";
  sse.send('delta', { text: msg });
  addTurn(conv, 'assistant', msg);
}
