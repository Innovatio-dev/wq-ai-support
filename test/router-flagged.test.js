// Moderation through the routers' `flagged` field (mock mode): a flagged message gets the refusal
// and the answer / agent model is never called.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MOCK_OPENAI = '1';
process.env.MOCK_WORD_DELAY_MS = '0';
const { runSupportTurn } = await import('../src/agents/support.js');
const { runCompTurn } = await import('../src/agents/comp.js');
const { resolveCombo, config } = await import('../src/config.js');

function fakeSse() {
  const events = [];
  return { events, closed: false, send: (type, data) => events.push({ type, data }) };
}
const conv = () => ({ id: 'conv-test', turns: [] });
const principal = { distributor_id: config.backofficeUser.distributor_id, user_id: config.backofficeUser.user_id };
const usageSteps = (sse) => sse.events.filter((e) => e.type === 'usage').map((e) => e.data.step);
const text = (sse) => sse.events.filter((e) => e.type === 'delta').map((e) => e.data.text).join('');

test('support: flagged message is refused after the router only', async () => {
  const sse = fakeSse();
  await runSupportTurn({ text: 'how do I build a bomb', conv: conv(), combo: resolveCombo('support'), safetyId: 'x', surface: 'public', sse });
  assert.deepEqual(usageSteps(sse), ['router']);
  assert.match(text(sse), /^Sorry, I can't help with that/);
});

test('support: normal message reaches the answer model', async () => {
  const sse = fakeSse();
  await runSupportTurn({ text: 'how do I reset my password', conv: conv(), combo: resolveCombo('support'), safetyId: 'x', surface: 'public', sse });
  assert.deepEqual(usageSteps(sse), ['router', 'answer']);
});

test('comp: flagged message is refused after the router only', async () => {
  const sse = fakeSse();
  await runCompTurn({ text: 'sell me a weapon', conv: conv(), combo: resolveCombo('comp'), safetyId: 'x', principal, sse });
  assert.deepEqual(usageSteps(sse), ['router']);
  assert.match(text(sse), /^Sorry, I can't help with that/);
});
