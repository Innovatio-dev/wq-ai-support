// WealthQuest Support Agent + Compensation Plan Agent — prototype server.
// Express 5 (ESM). Structure mirrors an AdonisJS app: this file ≈ start/routes.ts + start/kernel.ts,
// the controllers are the small handlers below, business logic lives in src/ services.
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, COMBOS, DEFAULT_COMBO, resolveCombo } from './src/config.js';
import {
  sessionMiddleware, demoGate, checkPassword, setGateCookie, setBackofficeCookie, backofficePrincipal,
  requireBackoffice, sameOrigin, aiRateLimit, ticketRateLimit, budgetExceeded, budgetStatus, BUDGET_MESSAGE,
  validateText, cleanText, verifyTurnstile, securityHeaders, safetyIdentifier,
} from './src/security.js';
import { loadKnowledgeBases } from './src/kb.js';
import { getClient, hasKey, NO_KEY_MESSAGE } from './src/openai.js';
import { openSse } from './src/sse.js';
import { getOrCreateConversation, isFull } from './src/conversations.js';
import { runSupportTurn } from './src/agents/support.js';
import { runCompTurn } from './src/agents/comp.js';
import { createTicket } from './src/tickets.js';
import { mockApiRouter, mockApiClient } from './src/mock/wq-api.js';

const app = express();
const PUBLIC = path.resolve('public');
const kb = loadKnowledgeBases(); // loads + validates both vaults at boot

app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway / one reverse proxy in front → real client IP for rate limits
app.use(securityHeaders);
app.use(cookieParser(config.sessionSecret));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

// ---------- health (no gate) ----------
app.get('/healthz', (req, res) => res.json({ ok: true, mock: config.mock, uptime_s: Math.round(process.uptime()) }));

// ---------- demo password gate ----------
app.get('/login', (req, res) => {
  if (!config.demoPassword) return res.redirect('/');
  res.sendFile(path.join(PUBLIC, 'login.html'));
});
app.post('/login', sameOrigin, (req, res) => {
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/';
  if (config.demoPassword && checkPassword(req.body?.password)) {
    setGateCookie(res);
    return res.redirect(303, next);
  }
  return res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}`);
});
app.use(demoGate);
app.use(sessionMiddleware);
app.use(sameOrigin);

// ---------- pages ----------
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get('/', page('index.html'));
app.get('/ai', page('ai.html'));
app.get('/chat', page('chat.html'));
app.get('/ticket', page('ticket.html'));
app.get('/help/{*path}', (req, res) => {
  const p = [].concat(req.params.path || []).join('/');
  if (!kb.support.has(p)) return res.status(404).sendFile(path.join(PUBLIC, '404.html'));
  res.sendFile(path.join(PUBLIC, 'article.html'));
});
app.get('/backoffice', (req, res) => {
  // Simulated login: visiting the Back Office "signs in" Maria. In production = real auth session.
  setBackofficeCookie(res);
  res.sendFile(path.join(PUBLIC, 'backoffice.html'));
});
app.use(express.static(PUBLIC, { index: false, maxAge: config.isProduction ? '1h' : 0 }));

// ---------- mock WealthQuest API ----------
app.use('/mock/api/v1', mockApiRouter({ principalFromRequest: backofficePrincipal }));

// ---------- read-only APIs ----------
app.get('/api/config', (req, res) => {
  res.json({
    mock: config.mock,
    has_key: hasKey(),
    provider: config.mock ? 'mock' : 'openrouter',
    combos: Object.fromEntries(Object.entries(COMBOS).map(([agent, t]) => [agent, Object.entries(t).map(([key, c]) => ({
      key, label: c.label, router: c.router, main: c.answer || c.agent,
    }))])),
    default_combo: DEFAULT_COMBO,
    turnstile_site_key: config.turnstileSecret ? config.turnstileSiteKey : null,
    ticket_categories: kb.support.ticketCategories(),
    max_input_chars: config.limits.maxInputChars,
    budget: budgetStatus(),
  });
});
app.get('/api/kb/tree', (req, res) => res.json({ categories: kb.support.tree() }));
app.get('/api/kb/article', (req, res) => {
  const data = kb.support.articleRenderData(String(req.query.path || ''));
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});
app.get('/api/backoffice/summary', requireBackoffice, async (req, res) => {
  const principal = backofficePrincipal(req);
  const api = mockApiClient(principal);
  const id = principal.distributor_id;
  const [me, rank, perf, commissions, products] = await Promise.all([
    api.get('/me'), api.get(`/distributors/${id}/rank-status`), api.get(`/distributors/${id}/performance?period=30d`),
    api.get(`/distributors/${id}/commissions?type=all`), api.get(`/distributors/${id}/products?period=30d`),
  ]);
  res.json({ me, rank, perf, commissions, products });
});

// ---------- AI endpoints (SSE) ----------
/** Shared controller for both agents: validation → guards → SSE → agent service. */
function agentEndpoint(agent) {
  return async (req, res) => {
    const body = req.body || {};
    const err = validateText(body.text);
    if (err) return res.status(400).json({ error: 'invalid_input', message: err });
    if (!getClient()) return res.status(503).json({ error: 'no_key', message: NO_KEY_MESSAGE });
    if (budgetExceeded()) return res.status(429).json({ error: 'budget', message: BUDGET_MESSAGE });

    const { conv, isNew } = getOrCreateConversation({ id: typeof body.conversation_id === 'string' ? body.conversation_id : null, sid: req.sid, agent });
    if (isNew && !(await verifyTurnstile(body.turnstile_token, req.ip))) {
      return res.status(403).json({ error: 'turnstile', message: 'Please complete the verification and try again.' });
    }
    if (isFull(conv)) return res.status(409).json({ error: 'conversation_full', message: 'This conversation is getting long. Please start a new one.' });

    // Optional `combo` key from the client; unknown or missing keys resolve to the default (allow-list).
    const combo = resolveCombo(agent, typeof body.combo === 'string' ? body.combo : null);
    const sse = openSse(res);
    sse.send('status', { text: 'Working on your answer', conversation_id: conv.id, combo: combo.key });
    const t0 = performance.now();
    try {
      const args = { text: cleanText(body.text), conv, combo, safetyId: safetyIdentifier(req.sid), sse };
      if (agent === 'support') await runSupportTurn({ ...args, surface: body.surface === 'backoffice' ? 'backoffice' : 'public' });
      else await runCompTurn({ ...args, principal: backofficePrincipal(req) });
      sse.send('done', { conversation_id: conv.id, total_ms: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`[${agent}]`, e.status || '', e.message);
      sse.send('error', { message: friendlyError(e) });
    } finally {
      sse.end();
    }
  };
}

function friendlyError(e) {
  if (e.status === 401) return 'AI provider key invalid: the server\'s OpenRouter API key was rejected. Please check OPENROUTER_API_KEY.';
  if (e.status === 402) return 'AI credits exhausted. Please try again later.';
  if (e.status === 403) return 'The AI request was blocked by the provider\'s guardrails.';
  if (e.status === 429) return 'The AI service is busy right now. Please try again in a moment.';
  if (e.status === 400) return 'The AI request was rejected. Please rephrase and try again.';
  if (e.status >= 500) return 'The AI service is temporarily unavailable. Please try again in a moment.';
  return 'Something went wrong while generating the answer. Please try again.';
}

app.post('/api/support/message', aiRateLimit, agentEndpoint('support'));
app.post('/api/comp/message', requireBackoffice, aiRateLimit, agentEndpoint('comp'));

// ---------- tickets ----------
app.post('/api/tickets', ticketRateLimit, (req, res) => {
  const { category, description, conversation_id: conversationId, attachments, surface } = req.body || {};
  const categories = kb.support.ticketCategories();
  if (typeof category !== 'string' || !categories.includes(category)) return res.status(400).json({ error: 'invalid_category', message: 'Please choose a category.' });
  if (typeof description !== 'string' || description.trim().length < 5) return res.status(400).json({ error: 'invalid_description', message: 'Please describe the problem.' });
  if (description.length > config.limits.maxInputChars) return res.status(400).json({ error: 'too_long', message: 'Description is too long.' });
  const files = Array.isArray(attachments) ? attachments.slice(0, 3).map((f) => ({ name: String(f?.name || '').slice(0, 120), size: Number(f?.size) || 0, type: String(f?.type || '').slice(0, 40) })) : [];
  const bo = surface === 'backoffice' ? backofficePrincipal(req) : null;
  const ticket = createTicket({
    category, description: cleanText(description), sid: req.sid, conversationId: typeof conversationId === 'string' ? conversationId : null,
    user: bo ? { distributor_id: bo.distributor_id, name: config.backofficeUser.display_name } : null, surface: bo ? 'backoffice' : 'public', attachments: files,
  });
  res.status(201).json({ ticket_number: ticket.ticket_number });
});

// ---------- 404 ----------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).sendFile(path.join(PUBLIC, '404.html'));
});
// Express 5 forwards async errors here.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[server]', err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: 'server_error', message: 'Unexpected server error.' });
});

app.listen(config.port, () => {
  const mode = config.mock ? 'MOCK_OPENAI (no real API calls)' : hasKey() ? 'live OpenRouter' : 'NO OPENROUTER KEY (AI endpoints will return an error)';
  console.log(`WealthQuest agents demo on http://localhost:${config.port} — ${mode}${config.demoPassword ? ', password gate ON' : ''}`);
});
