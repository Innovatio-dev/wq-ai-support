// Server-side conversation memory. The browser only holds an opaque conversation id; the
// history lives here, bound to its owner — the signed-in member, else the session cookie
// (identity.js ownerKey). A stolen id is useless to anyone else. In AdonisJS: a Lucid model + table, or Redis.
import crypto from 'node:crypto';
import { config } from './config.js';

const store = new Map(); // id → { id, owner, agent, turns: [{role, content}], createdAt, updatedAt }
const TTL_MS = 6 * 3600e3;

/**
 * Get the caller's conversation or start a new one. An id owned by someone else — another session, or
 * another member, or the same browser before/after signing in — is never reused.
 */
export function getOrCreateConversation({ id, owner, agent }) {
  const existing = id ? store.get(id) : null;
  if (existing && existing.owner === owner && existing.agent === agent) return { conv: existing, isNew: false };
  const conv = { id: crypto.randomUUID(), owner, agent, turns: [], createdAt: Date.now(), updatedAt: Date.now() };
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

export function getConversation(id, owner) {
  const c = store.get(id);
  return c && c.owner === owner ? c : null;
}
