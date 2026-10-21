// Ticket forwarding to the main app: the signature contract and the category mapping it relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signTicketRequest, mainAppCategory, checkAttachment, ticketPayload, ATTACHMENT_LIMITS } from '../src/tickets.js';
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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('attachments: jpg, png and pdf by name AND by content; the type comes from the content', () => {
  assert.deepEqual(checkAttachment('shot.PNG', PNG), { name: 'shot.PNG', type: 'image/png', buffer: PNG });
  assert.equal(checkAttachment('receipt.pdf', PDF).type, 'application/pdf');
  assert.equal(checkAttachment('photo.jpeg', JPG).type, 'image/jpeg');
  // A renamed file is refused: the name says pdf, the bytes don't.
  assert.equal(checkAttachment('invoice.pdf', Buffer.from('MZ\x90\x00 not a pdf')), null);
  assert.equal(checkAttachment('shot.png', PDF), null);
  // Only the three kinds, never empty, never over 10 MB.
  assert.equal(checkAttachment('page.html', Buffer.from('<html>')), null);
  assert.equal(checkAttachment('empty.pdf', Buffer.alloc(0)), null);
  assert.equal(checkAttachment('big.pdf', Buffer.concat([PDF, Buffer.alloc(ATTACHMENT_LIMITS.maxBytes)])), null);
  // A path in the name is dropped.
  assert.equal(checkAttachment('C:\\Users\\me\\..\\shot.png', PNG).name, 'shot.png');
});

test('the signed payload lists each file with its size and SHA-256, in order', () => {
  const files = [checkAttachment('a.png', PNG), checkAttachment('b.pdf', PDF)];
  const payload = JSON.parse(ticketPayload({ category: 'In-app features', description: 'It breaks', email: 'g@example.test', clientIp: '203.0.113.1', source: 'ai_chat', attachments: files }));
  assert.deepEqual(payload.attachments, [
    { name: 'a.png', type: 'image/png', size: PNG.length, sha256: crypto.createHash('sha256').update(PNG).digest('hex') },
    { name: 'b.pdf', type: 'application/pdf', size: PDF.length, sha256: crypto.createHash('sha256').update(PDF).digest('hex') },
  ]);
  // Text-only tickets keep exactly the body they had before.
  const plain = JSON.parse(ticketPayload({ category: 'In-app features', description: 'It breaks', email: null, clientIp: '203.0.113.1', source: 'help_center' }));
  assert.equal('attachments' in plain, false);
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
