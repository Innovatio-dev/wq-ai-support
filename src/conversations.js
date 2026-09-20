// Server-side conversation memory. The browser only holds an opaque conversation id; the
// history lives here, bound to the session cookie that created it (a stolen id is useless
// without the matching session). In AdonisJS: a Lucid model + table, or Redis.
import crypto from 'node:crypto';
import { config } from './config.js';

const store = new Map(); // id → { id, sid, agent, turns: [{role, content}], usage: [], createdAt, updatedAt }
const TTL_MS = 6 * 3600e3;

/** Get the caller's conversation or start a new one. Ids from another session are never reused. */
export function getOrCreateConversation({ id, sid, agent }) {
  const existing = id ? store.get(id) : null;
  if (existing && existing.sid === sid && existing.agent === agent) return { conv: existing, isNew: false };
  const conv = { id: crypto.randomUUID(), sid, agent, turns: [], createdAt: Date.now(), updatedAt: Date.now() };
  store.set(conv.id, conv);
  return { conv, isNew: true };
}

export function addTurn(conv, role, content) {
  conv.turns.push({ role, content: String(content).slice(0, 4000) });
  // Keep at most N messages (oldest dropped) — bounds memory and prompt size.
  if (conv.turns.length > config.limits.maxConversationTurns) conv.turns.splice(0, conv.turns.length - config.limits.maxConversationTurns);
  conv.updatedAt = Date.now();
}

/** True when a conversation has hit the turn cap; UI suggests starting a new one. */
export function isFull(conv) {
  return conv.turns.length >= config.limits.maxConversationTurns;
}

/** Periodic cleanup of idle conversations. */
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, c] of store) if (c.updatedAt < cutoff) store.delete(id);
}, 10 * 60e3).unref();

export function getConversation(id, sid) {
  const c = store.get(id);
  return c && c.sid === sid ? c : null;
}
