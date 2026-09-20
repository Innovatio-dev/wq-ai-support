// In-memory ticket store (+ append-only data/tickets.jsonl so tickets survive a look at the logs).
// In production this is a call to the helpdesk (Zendesk/Freshdesk/...) — never created by the model
// directly: the model only DRAFTS a ticket; the user reviews and presses Submit.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const tickets = new Map();
const FILE = path.resolve('data/tickets.jsonl');

function newNumber() {
  let n;
  do n = String(crypto.randomInt(1_000_000, 10_000_000)); while (tickets.has(n));
  return n;
}

export function createTicket({ category, description, sid, conversationId = null, user = null, surface = 'public', attachments = [] }) {
  const ticket = {
    ticket_number: newNumber(),
    category,
    description,
    surface,
    conversation_id: conversationId,
    user, // Back Office tickets carry the signed-in distributor; public ones are matched by email later
    attachments, // metadata only (name, size, type) — files are never sent to OpenAI
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
