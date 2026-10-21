// Tickets. The model only DRAFTS one; a ticket exists once the user reviews it and presses Submit.
// - Main app configured (MAIN_APP_URL + AI_SUPPORT_SERVICE_SECRET): forwarded to its support_tickets, so it
//   gets the same reference, confirmation mail and support inbox as its own "Open a ticket" form
//   (docs/embed-auth-plan.md §6). The main app's reference is what the user sees.
// - Otherwise (development / demo): kept in memory + append-only data/tickets.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const tickets = new Map();
const FILE = path.resolve('data/tickets.jsonl');

/** Where tickets go: 'main_app' when configured, 'local' otherwise. */
export function ticketDestination() {
  return config.mainAppUrl && config.aiServiceSecret ? 'main_app' : 'local';
}

function newNumber() {
  let n;
  do n = String(crypto.randomInt(1_000_000, 10_000_000)); while (tickets.has(n));
  return n;
}

export function createTicket({ category, description, sid, conversationId = null, user = null, email = null, surface = 'public', attachments = [] }) {
  const ticket = {
    ticket_number: newNumber(),
    category,
    description,
    email,
    surface,
    conversation_id: conversationId,
    user, // the signed-in member or demo user; guests are reached by email
    attachments, // metadata only (name, size, type) — files are never sent to the model provider
    session_hash: crypto.createHash('sha256').update(String(sid)).digest('hex').slice(0, 16),
    created_at: new Date().toISOString(),
    status: 'open',
  };
  tickets.set(ticket.ticket_number, ticket);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, `${JSON.stringify(ticket)}\n`);
  } catch (err) {
    console.warn('[tickets] could not persist:', err.message);
  }
  return ticket;
}

export function ticketCount() { return tickets.size; }

// ---------------------------------------------------------------------------------------------
// Forwarding to the main app
// ---------------------------------------------------------------------------------------------

/**
 * The main app's ticket categories have no "Something else" (its TICKET_CATEGORIES are the six help-center
 * categories), so tickets filed under it go to its broadest one (decided 2026-10-20).
 */
export const SOMETHING_ELSE_CATEGORY = 'Manage your account';
export function mainAppCategory(topCategory) {
  return topCategory === 'Something else' ? SOMETHING_ELSE_CATEGORY : topCategory;
}

/**
 * The request signature the main app checks: hex HMAC-SHA256 over "<timestamp>.<raw body>" with the
 * shared secret. The timestamp is in the header too, so a captured request can't be replayed later
 * (the main app refuses anything older than 5 minutes) and the body can't be edited.
 */
export function signTicketRequest(rawBody, timestamp, secret = config.aiServiceSecret) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export class TicketForwardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * POST the ticket to the main app. Returns its reference ("ddmmyy-N").
 * @param {object} t
 * @param {string} t.category        one of the main app's six ticket categories (see mainAppCategory)
 * @param {string} t.description
 * @param {string|null} t.email      guests only; for members the main app uses the account's own address
 * @param {string|null} t.memberToken the member's current token, re-verified by the main app to find the user
 * @param {string|null} t.conversationRef
 * @param {string} t.clientIp        the member's IP, for the main app's per-person cooldown
 * @param {'ai_chat'|'help_center'} t.source
 */
export async function forwardTicket({ category, description, email, memberToken, conversationRef, clientIp, source }) {
  const raw = JSON.stringify({
    category, description, email: email ?? null, member_token: memberToken ?? null,
    conversation_ref: conversationRef ?? null, client_ip: clientIp, source,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  let res;
  try {
    res = await fetch(`${config.mainAppUrl}/internal/ai/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-WQ-AI-Timestamp': ts,
        'X-WQ-AI-Signature': `sha256=${signTicketRequest(raw, ts)}`,
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('[tickets] main app unreachable:', err.message);
    throw new TicketForwardError(502, 'We couldn\'t send your ticket right now. Please try again in a moment.');
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok && typeof body.reference === 'string') return body.reference;
  // The main app's own validation / cooldown messages are written for members — pass those through.
  if (res.status === 422 || res.status === 429) throw new TicketForwardError(res.status === 422 ? 400 : 429, body.message || 'Please check the ticket and try again.');
  if (res.status === 401) throw new TicketForwardError(401, body.message || 'Your session has ended. Please sign in again.');
  console.error('[tickets] main app refused:', res.status, body.error || '');
  throw new TicketForwardError(502, 'We couldn\'t send your ticket right now. Please try again in a moment.');
}
