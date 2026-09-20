// Helpers shared by both agents.
import fs from 'node:fs';
import path from 'node:path';
import { costOf } from '../cost.js';
import { recordSpend } from '../security.js';

const promptCache = new Map();
/** Prompts live in /prompts as Markdown so non-developers can review them. Loaded once, byte-stable. */
export function prompt(name) {
  if (!promptCache.has(name)) promptCache.set(name, fs.readFileSync(path.resolve('prompts', `${name}.md`), 'utf8').trim());
  return promptCache.get(name);
}

/**
 * Build the `usage` SSE payload for one OpenAI call and add its cost to today's budget.
 * @param {string} step  e.g. "router", "answer", "agent · tool loop 2"
 */
export function usageEvent({ step, model, effort, usage, startedAt }) {
  const c = costOf(model, usage);
  recordSpend(c.usd);
  return {
    step,
    model,
    effort,
    latency_ms: Math.round(performance.now() - startedAt),
    tokens: {
      input: c.tokens.input || 0,
      cached: c.tokens.cached || 0,
      cache_write: c.tokens.cache_write || 0,
      output: c.tokens.output || 0,
      reasoning: c.tokens.reasoning || 0,
    },
    usd: c.usd,
    eur: c.eur,
  };
}

/** Parse the JSON text of a structured-output response defensively. */
export function parseJsonOutput(response) {
  const text = response.output_text ?? response.output?.find((o) => o.type === 'message')?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return null; }
}

/** Short context for routers: last ≤4 turns, each truncated to 400 chars. */
export function routerContext(turns) {
  return turns.slice(-4).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 400)}`).join('\n');
}

/** Conversation history as Responses API input messages (last `n` turns). */
export function historyMessages(turns, n = 8) {
  return turns.slice(-n).map((t) => ({ role: t.role, content: t.content }));
}

/** Escape text placed inside our pseudo-XML wrappers so article/user text can't close the tag. */
export function escapeTagText(s) {
  return String(s).replace(/<\/(article|plan_page|user_data)>/gi, '<\\/$1>');
}
