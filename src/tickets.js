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

// ---------------------------------------------------------------------------------------------
// Attachments: the main app's own limits (3 files, 10 MB each, jpg/png/pdf)
// ---------------------------------------------------------------------------------------------
export const ATTACHMENT_LIMITS = { maxFiles: 3, maxBytes: 10 * 1024 * 1024 };

// What a file must start with, whatever its name says: a renamed .exe isn't a .pdf.
const ATTACHMENT_KINDS = [
  { exts: ['jpg', 'jpeg'], type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { exts: ['png'], type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { exts: ['pdf'], type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
];

/**
 * An uploaded file, checked: `{ name, type, buffer }`, or null when its extension or its first bytes
 * aren't jpg / png / pdf. The type comes from the content, never from the browser.
 */
export function checkAttachment(originalName, buffer) {
  // Strip any path and control characters; the main app stores it under a random key anyway.
  const name = String(originalName || '').split(/[/\\]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const kind = ATTACHMENT_KINDS.find((k) => k.exts.includes(ext));
  if (!name || !kind || !Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > ATTACHMENT_LIMITS.maxBytes) return null;
  if (!kind.magic.every((byte, i) => buffer[i] === byte)) return null;
  return { name, type: kind.type, buffer };
}

/**
 * The JSON the signature covers. Files can't be signed inside a multipart body, so the payload lists each
 * one's name, type, size and SHA-256, and the main app re-hashes what it receives: a swapped or edited
 * file fails like an edited description.
 */
export function ticketPayload({ category, description, email, memberToken, conversationRef, clientIp, source, attachments = [] }) {
  return JSON.stringify({
    category, description, email: email ?? null, member_token: memberToken ?? null,
    conversation_ref: conversationRef ?? null, client_ip: clientIp, source,
    ...(attachments.length ? {
      attachments: attachments.map((a) => ({
        name: a.name, type: a.type, size: a.buffer.length,
        sha256: crypto.createHash('sha256').update(a.buffer).digest('hex'),
      })),
    } : {}),
  });
}

/**
 * The request signature the main app checks: hex HMAC-SHA256 over "<timestamp>.<payload>" with the
 * shared secret. The payload is the JSON body, or the `payload` field when files are attached. The
 * timestamp is in the header too, so a captured request can't be replayed later (the main app refuses
 * anything older than 5 minutes, and each signature once) and the payload can't be edited.
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
 * @param {{name: string, type: string, buffer: Buffer}[]} [t.attachments] checked files (checkAttachment)
 */
export async function forwardTicket({ attachments = [], ...ticket }) {
  const payload = ticketPayload({ ...ticket, attachments });
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    Accept: 'application/json',
    'X-WQ-AI-Timestamp': ts,
    'X-WQ-AI-Signature': `sha256=${signTicketRequest(payload, ts)}`,
  };
  // Text only: the JSON body itself. With files: multipart, the signed JSON as the `payload` field and the
  // files in the same order as its list (fetch sets the multipart Content-Type and boundary).
  let requestBody = payload;
  if (attachments.length) {
    requestBody = new FormData();
    requestBody.append('payload', payload);
    attachments.forEach((a, i) => requestBody.append(`attachments[${i}]`, new Blob([a.buffer], { type: a.type }), a.name));
  } else {
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`${config.mainAppUrl}/internal/ai/tickets`, {
      method: 'POST', headers, body: requestBody,
      // Files take longer to send than a line of text.
      signal: AbortSignal.timeout(attachments.length ? 60_000 : 10_000),
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
