// Support agent pipeline ("Obsidian brain" / Karpathy LLM-wiki method):
//   1. router (cheap model, structured output) reads index.md and picks ≤3 article paths
//   2. server resolves the paths against the allow-list and loads the articles
//   3. answerer (streams) answers only from those articles, or drafts a support ticket via a tool
// In AdonisJS: app/services/support_agent_service.ts, called from SupportMessagesController.
import { loadKnowledgeBases } from '../kb.js';
import { streamResponse, createResponse } from '../openai.js';
import { prompt, usageEvent, parseJsonOutput, routerContext, historyMessages, escapeTagText } from './common.js';
import { addTurn } from '../conversations.js';
import { config } from '../config.js';

export const TICKET_DRAFT_TEXT = 'We will get this sorted.\n\nPlease provide details below so the team can follow up via email.';
const REFUSAL_TEXT = "Sorry, I can't help with that. I can help with questions about your WealthQuest account, billing, membership and Back Office features.";

// Structured output schema for the router (strict: every property required, no extras).
const ROUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['answer', 'ticket', 'clarify', 'greeting', 'out_of_scope'] },
    paths: { type: 'array', items: { type: 'string' } }, // server keeps at most 3
    search_terms: { type: 'string' },
    reply_language: { type: 'string' },
    flagged: { type: 'boolean' }, // moderation verdict (OpenRouter has no /moderations endpoint)
  },
  required: ['intent', 'paths', 'search_terms', 'reply_language', 'flagged'],
};

/** The single function tool. Category enum is built from the KB so it can't drift from the help center. */
function ticketTool(categories) {
  return {
    type: 'function',
    name: 'create_support_ticket',
    description: 'Draft a support ticket for the WealthQuest Support team. The user reviews the pre-filled form and submits it; nothing is sent until they do.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: categories, description: 'Most specific matching help-center category or subcategory.' },
        subcategory: { type: ['string', 'null'], description: 'Article subcategory if any, else null.' },
        summary: { type: 'string', description: 'Neutral one-line summary, at most 80 characters.' },
        description: { type: 'string', description: 'At most 600 characters, first person, as the user would write it.' },
      },
      required: ['category', 'subcategory', 'summary', 'description'],
    },
  };
}

// Static prefixes, built once so they are byte-identical across calls → prompt caching kicks in.
let ROUTER_INSTRUCTIONS = null;
function routerInstructions() {
  ROUTER_INSTRUCTIONS ??= `${prompt('support-router')}\n\n${loadKnowledgeBases().support.indexText.trim()}`;
  return ROUTER_INSTRUCTIONS;
}

/**
 * Run one user turn. Emits SSE events through `sse.send`.
 * @param {object} p
 * @param {string} p.text           validated user text
 * @param {object} p.conv           server-side conversation
 * @param {object} p.combo          resolved model combination
 * @param {string} p.safetyId       sha256(session id)
 * @param {'public'|'backoffice'} p.surface
 * @param {{send:Function, closed:boolean}} p.sse
 */
export async function runSupportTurn({ text, conv, combo, safetyId, surface, sse }) {
  const kb = loadKnowledgeBases().support;
  const categories = kb.ticketCategories();
  const history = conv.turns.slice(); // snapshot before adding this turn
  addTurn(conv, 'user', text);

  // ---- 1. Router (its `flagged` field is the moderation check: OpenRouter has no moderation endpoint) ----
  sse.send('status', { text: 'Searching help articles…' });
  const t0 = performance.now();
  const routerInput = [
    { role: 'user', content: `${history.length ? `Conversation so far:\n${routerContext(history)}\n\n` : ''}Latest user message:\n${text}` },
  ];
  const routeRes = await createResponse({
    model: combo.router.model,
    instructions: routerInstructions(),
    input: routerInput,
    reasoning: { effort: combo.router.effort },
    text: { verbosity: 'low', format: { type: 'json_schema', name: 'support_route', schema: ROUTE_SCHEMA, strict: true } },
    max_output_tokens: 300,
    store: false,
    safety_identifier: safetyId,
    session_id: conv.id,
  });
  sse.send('usage', usageEvent({ step: 'router', model: combo.router.model, effort: combo.router.effort, usage: routeRes.usage, startedAt: t0 }));

  const route = parseJsonOutput(routeRes) || { intent: 'answer', paths: [], reply_language: 'English' };
  if (route.flagged === true) {
    sse.send('delta', { text: REFUSAL_TEXT });
    addTurn(conv, 'assistant', REFUSAL_TEXT);
    return;
  }

  // ---- 2. Allow-list: only paths present in index.md can be loaded ----
  const paths = kb.resolvePaths(route.paths, 3);
  const articles = paths.map((p) => ({ path: kb.get(p).path, title: kb.get(p).meta.title, text: kb.articleForModel(p) }));
  sse.send('status', { text: 'Writing your answer…', intent: route.intent, articles: articles.map(({ path, title }) => ({ path, title })) });

  // ---- 3. Answerer ----
  const dev = [
    `Router intent: ${route.intent}. Reply language: ${route.reply_language || 'English'}.`,
    surface === 'backoffice'
      ? `Surface: Back Office. The user is signed in as ${config.backofficeUser.display_name} (distributor ${config.backofficeUser.distributor_id}); a ticket is attached to their account automatically, so never ask for their email.`
      : 'Surface: public help center (user not signed in).',
    articles.length
      ? articles.map((a) => `<article path="${a.path}">\n${escapeTagText(a.text)}\n</article>`).join('\n\n')
      : 'No help-center article matched this message.',
  ].join('\n\n');

  const t1 = performance.now();
  let answer = '';
  let ticketDraft = null;
  let usage = null;
  for await (const ev of streamResponse({
    model: combo.answer.model,
    instructions: prompt('support-answer'),
    input: [{ role: 'developer', content: dev }, ...historyMessages(history, 8), { role: 'user', content: text }],
    tools: [ticketTool(categories)],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: combo.answer.effort },
    text: { verbosity: 'low' },
    max_output_tokens: 900,
    store: false,
    safety_identifier: safetyId,
    session_id: conv.id,
  })) {
    if (sse.closed) break; // client went away: stop streaming (and stop paying for output)
    if (ev.type === 'text') {
      answer += ev.delta;
      sse.send('delta', { text: ev.delta });
    } else if (ev.type === 'item' && ev.item.type === 'function_call' && ev.item.name === 'create_support_ticket') {
      ticketDraft = sanitizeDraft(ev.item.arguments, categories);
    } else if (ev.type === 'completed') {
      usage = ev.response.usage;
    }
  }
  if (usage) sse.send('usage', usageEvent({ step: 'answer', model: combo.answer.model, effort: combo.answer.effort, usage, startedAt: t1 }));

  // ---- 4. Ticket draft: shown as a pre-filled form; created only when the user presses Submit ----
  if (ticketDraft) {
    sse.send('ticket_draft', { ...ticketDraft, categories, intro: TICKET_DRAFT_TEXT, prefilled_user: surface === 'backoffice' ? config.backofficeUser.display_name : null });
    addTurn(conv, 'assistant', `${answer ? `${answer}\n\n` : ''}${TICKET_DRAFT_TEXT}\n[A support ticket form was shown, pre-filled with category "${ticketDraft.category}".]`);
  } else {
    addTurn(conv, 'assistant', answer || '(no answer)');
  }
}

/** Validate tool arguments from the model before they reach the browser. */
function sanitizeDraft(argsJson, categories) {
  let a = {};
  try { a = JSON.parse(argsJson); } catch { /* fall through with defaults */ }
  // Prefer the subcategory as the selectable option when it exists (the select lists subcategories).
  let category = categories.includes(a.subcategory) ? a.subcategory : a.category;
  if (!categories.includes(category)) category = 'Something else';
  return {
    category,
    summary: String(a.summary || '').slice(0, 80),
    description: String(a.description || '').slice(0, 600),
  };
}
