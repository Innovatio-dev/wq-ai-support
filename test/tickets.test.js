// Ticket forwarding to the main app: the signature contract and the category mapping it relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signTicketRequest, mainAppCategory } from '../src/tickets.js';
import { loadKnowledgeBases } from '../src/kb.js';

test('signature = hex HMAC-SHA256 of "<timestamp>.<raw body>" (the main app recomputes exactly this)', () => {
  const raw = '{"category":"Payments & billing","description":"Charged twice this month"}';
  const expected = crypto.createHmac('sha256', 'shared-secret').update(`1760000000.${raw}`).digest('hex');
  assert.equal(signTicketRequest(raw, '1760000000', 'shared-secret'), expected);
  // Any change to the body, the timestamp or the secret changes it.
  assert.notEqual(signTicketRequest(`${raw} `, '1760000000', 'shared-secret'), expected);
  assert.notEqual(signTicketRequest(raw, '1760000001', 'shared-secret'), expected);
  assert.notEqual(signTicketRequest(raw, '1760000000', 'other-secret'), expected);
});

test('every AI ticket category, "Something else" included, reaches the main app as one of its six', () => {
  const MAIN_APP = ['Payments & billing', 'Manage your account', 'WealthQuest membership', 'In-app features', 'Device & troubleshooting', 'Safety & privacy'];
  const kb = loadKnowledgeBases().support;
  for (const c of kb.ticketCategories()) {
    const sent = mainAppCategory(kb.ticketTopCategory(c));
    assert.ok(MAIN_APP.includes(sent), `${c} → ${sent}`);
  }
  assert.equal(mainAppCategory(kb.ticketTopCategory('Something else')), 'Manage your account');
  assert.equal(mainAppCategory(kb.ticketTopCategory('Logging in')), 'Manage your account');
  assert.equal(mainAppCategory('Payments & billing'), 'Payments & billing');
});
