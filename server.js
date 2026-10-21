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
import { identify, ownerKey } from './src/identity.js';
import { runSupportTurn } from './src/agents/support.js';
import { runCompTurn } from './src/agents/comp.js';
import multer from 'multer';
import { createTicket, forwardTicket, ticketDestination, mainAppCategory, checkAttachment, ATTACHMENT_LIMITS } from './src/tickets.js';
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
app.get('/embed', page('embed.html')); // the chat panel the main app frames (?surface=guest|member)
app.get('/help/{*path}', (req, res) => {
  const p = [].concat(req.params.path || []).join('/');
  if (!kb.support.has(p)) return res.status(404).sendFile(path.join(PUBLIC, '404.html'));
  res.sendFile(path.join(PUBLIC, 'article.html'));
});
if (config.demoMode) {
  app.get('/backoffice', (req, res) => {
    // Simulated login: visiting the demo Back Office "signs in" Maria.
    setBackofficeCookie(res);
    res.sendFile(path.join(PUBLIC, 'backoffice.html'));
  });
} else {
  // Outside demo mode the demo Back Office's files aren't served either.
  app.use(['/backoffice.html', '/js/backoffice.js'], (req, res) => res.status(404).sendFile(path.join(PUBLIC, '404.html')));
}
app.use(express.static(PUBLIC, { index: false, maxAge: config.isProduction ? '1h' : 0 }));

// ---------- mock WealthQuest API (demo only) ----------
if (config.demoMode) app.use('/mock/api/v1', mockApiRouter({ principalFromRequest: backofficePrincipal }));

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
    embed_parent_origins: config.allowedParentOrigins,
    demo: config.demoMode,
    ticket_attachments: true,
    main_app_url: config.mainAppUrl || null,
    budget: budgetStatus(),
  });
});
app.get('/api/kb/tree', (req, res) => res.json({ categories: kb.support.tree() }));
app.get('/api/kb/article', (req, res) => {
  const data = kb.support.articleRenderData(String(req.query.path || ''));
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});
if (config.demoMode) app.get('/api/backoffice/summary', requireBackoffice, async (req, res) => {
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

    const owner = ownerKey(req);
    const { conv, isNew } = getOrCreateConversation({ id: typeof body.conversation_id === 'string' ? body.conversation_id : null, owner, agent });
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
      const args = { text: cleanText(body.text), conv, combo, safetyId: safetyIdentifier(owner), sse };
      if (agent === 'support') await runSupportTurn({ ...args, user: signedInUser(req, body.surface) });
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

/**
 * Who the agent may treat as signed in — decided here, never by the client: a verified member token, or
 * (demo mode only) the simulated Back Office user when the request comes from the demo Back Office.
 */
function signedInUser(req, surface) {
  if (req.member) return { name: req.member.name };
  const demo = surface === 'backoffice' ? backofficePrincipal(req) : null;
  return demo ? { name: config.backofficeUser.display_name, distributorId: demo.distributor_id } : null;
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

app.post('/api/support/message', identify, aiRateLimit, agentEndpoint('support'));
// The Compensation agent runs on the mock API's demo data, so it exists only in demo mode
// ("My earnings" is "Coming soon" in the main app).
if (config.demoMode) app.post('/api/comp/message', requireBackoffice, aiRateLimit, agentEndpoint('comp'));

// ---------- tickets ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A ticket with files arrives as multipart (`attachments` + the text fields); without, as JSON. Files stay
// in memory only long enough to be forwarded, and never reach the model provider.
const uploadAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { files: ATTACHMENT_LIMITS.maxFiles, fileSize: ATTACHMENT_LIMITS.maxBytes, fields: 10, fieldSize: 8 * 1024 },
}).array('attachments', ATTACHMENT_LIMITS.maxFiles);
function receiveAttachments(req, res, next) {
  uploadAttachments(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10MB or smaller.'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? `You can attach up to ${ATTACHMENT_LIMITS.maxFiles} files.`
        : 'The files could not be uploaded. Please try again.';
    return res.status(400).json({ error: 'invalid_attachment', message });
  });
}

app.post('/api/tickets', identify, ticketRateLimit, receiveAttachments, async (req, res) => {
  const { category, description, email: rawEmail, conversation_id: conversationId, surface } = req.body || {};
  const categories = kb.support.ticketCategories();
  if (typeof category !== 'string' || !categories.includes(category)) return res.status(400).json({ error: 'invalid_category', message: 'Please choose a category.' });
  if (typeof description !== 'string' || description.trim().length < 10) return res.status(400).json({ error: 'invalid_description', message: 'Please describe the problem (at least 10 characters).' });
  if (description.length > config.limits.maxInputChars) return res.status(400).json({ error: 'too_long', message: 'Description is too long.' });

  // Members (and the demo user) are known to the main app; a guest must leave a reply address.
  const user = signedInUser(req, surface);
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!user && !(EMAIL_RE.test(email) && email.length <= 254)) return res.status(400).json({ error: 'invalid_email', message: 'Please enter the email address we should reply to.' });
  const convRef = typeof conversationId === 'string' && conversationId ? conversationId.slice(0, 64) : null;
  const files = [];
  for (const f of req.files || []) {
    const checked = checkAttachment(f.originalname, f.buffer);
    if (!checked) return res.status(400).json({ error: 'invalid_attachment', message: `${String(f.originalname || 'A file').slice(0, 80)}: only jpg, png or pdf files are allowed.` });
    files.push(checked);
  }

  if (ticketDestination() === 'main_app' && !backofficePrincipal(req)) {
    try {
      const reference = await forwardTicket({
        category: mainAppCategory(kb.support.ticketTopCategory(category)), description: cleanText(description).trim(),
        email: req.member ? null : email, memberToken: req.memberToken ?? null, conversationRef: convRef,
        clientIp: req.ip, source: convRef ? 'ai_chat' : 'help_center', attachments: files,
      });
      return res.status(201).json({ ticket_number: reference });
    } catch (err) {
      return res.status(err.status || 502).json({ error: 'ticket_failed', message: err.message });
    }
  }
  if (config.isProduction && !config.demoMode) {
    // A ticket nobody will read is worse than a clear "not available": production must forward.
    return res.status(503).json({ error: 'tickets_unavailable', message: 'Tickets can\'t be sent right now. Please email support@wealthquest.com.' });
  }
  // Local (development / demo) tickets keep only the files' names, sizes and types.
  const ticket = createTicket({
    category, description: cleanText(description), sid: req.sid, conversationId: convRef, email: user ? null : email,
    user: user ? { member_sub: req.member?.sub ?? null, distributor_id: user.distributorId ?? null, name: user.name } : null,
    surface: req.member ? 'member' : user ? 'backoffice' : 'public',
    attachments: files.map((f) => ({ name: f.name, size: f.buffer.length, type: f.type })),
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
  const extras = [
    config.demoMode ? 'demo mode ON' : 'demo mode off',
    config.demoPassword && 'password gate ON',
    `member sign-in ${config.wqIssuer ? `via ${config.wqIssuer}` : 'off'}`,
    `tickets → ${ticketDestination() === 'main_app' ? config.mainAppUrl : 'data/tickets.jsonl'}`,
  ].filter(Boolean);
  if (config.isProduction && ticketDestination() !== 'main_app') console.warn('[tickets] production without MAIN_APP_URL + AI_SUPPORT_SERVICE_SECRET: tickets are refused');
  console.log(`WealthQuest agents on http://localhost:${config.port} — ${mode}, ${extras.join(', ')}`);
});
