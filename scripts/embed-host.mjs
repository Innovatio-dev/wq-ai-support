// Local stand-in for the WealthQuest main app — everything step 6 of docs/embed-auth-plan.md builds there:
//   · the launcher + panel (the reference for <AiSupportLauncher>) and the postMessage token handshake
//   · GET  /ai/session-token        a 10-minute EdDSA token for the signed-in user (here: a cookie, alice|bob)
//   · GET  /.well-known/jwks.json   the public key the AI server verifies tokens with
//   · POST /internal/ai/tickets     signed tickets from the AI server (HMAC + the member's token); text only:
//                                   tickets with files (multipart, docs/embed-auth-plan.md §6.1) need the real main app
//
//   npm run embed:host → http://localhost:3334
// Run the AI server with:  WQ_ISSUER=http://localhost:3334  MAIN_APP_URL=http://localhost:3334
//                          AI_SUPPORT_SERVICE_SECRET=dev-ai-secret   (TOKEN_TTL_S=90 here to watch refreshes)
import http from 'node:http';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT, jwtVerify, createLocalJWKSet } from 'jose';

const PORT = Number(process.env.EMBED_HOST_PORT) || 3334;
const SELF = `http://localhost:${PORT}`;
const AI_URL = new URL(process.env.AI_URL || 'http://localhost:3000').origin;
const SECRET = process.env.AI_SUPPORT_SERVICE_SECRET || 'dev-ai-secret';
const TTL_S = Number(process.env.TOKEN_TTL_S) || 600;
const USERS = {
  alice: { id: 101, name: 'Alice Member', email: 'alice@example.test' },
  bob: { id: 102, name: 'Bob Member', email: 'bob@example.test' },
};

// ---------- signing key (the main app reuses its SSO Ed25519 key) ----------
const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
const pub = await exportJWK(publicKey);
const kid = await calculateJwkThumbprint(pub, 'sha256');
const jwks = { keys: [{ ...pub, kid, alg: 'EdDSA', use: 'sig' }] };
const localKeys = createLocalJWKSet(jwks);
const SUBJECT_SALT = crypto.randomBytes(16);
// Pairwise subject: the AI service sees a stable per-user id that isn't the database id.
const subjectFor = (user) => crypto.createHmac('sha256', SUBJECT_SALT).update(`wq-ai-support:${user.id}`).digest('base64url');
// The main app encrypts the user id with its app key; here a reversible stand-in.
const uidEnc = (user) => Buffer.from(String(user.id)).toString('base64url');

function mintToken(user) {
  return new SignJWT({ name: user.name, email: user.email, uid_enc: uidEnc(user) })
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'wq-ai+jwt' })
    .setIssuer(SELF).setAudience('wq-ai-support').setSubject(subjectFor(user))
    .setIssuedAt().setExpirationTime(`${TTL_S}s`).setJti(crypto.randomUUID())
    .sign(privateKey);
}

// ---------- tickets received from the AI server ----------
const tickets = [];
let seq = 0;
const TICKET_CATEGORIES = ['Payments & billing', 'Manage your account', 'WealthQuest membership', 'In-app features', 'Device & troubleshooting', 'Safety & privacy'];

function verifySignature(raw, ts, sig) {
  if (!/^\d+$/.test(ts || '') || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
  const expected = `sha256=${crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex')}`;
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function receiveTicket(req, res, raw) {
  const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (!verifySignature(raw, req.headers['x-wq-ai-timestamp'], req.headers['x-wq-ai-signature'])) return json(401, { error: 'bad_signature' });
  let t;
  try { t = JSON.parse(raw); } catch { return json(422, { message: 'Malformed ticket.' }); }
  let userId = null;
  let email = typeof t.email === 'string' ? t.email : null;
  if (t.member_token) {
    // The member's own token, re-verified with our own key → which user (never trust a user id in the body).
    try {
      const { payload } = await jwtVerify(t.member_token, localKeys, { issuer: SELF, audience: 'wq-ai-support', typ: 'wq-ai+jwt', algorithms: ['EdDSA'] });
      userId = Number(Buffer.from(payload.uid_enc, 'base64url').toString());
      email = Object.values(USERS).find((u) => u.id === userId)?.email ?? null; // the account's address, not the form's
    } catch {
      return json(401, { message: 'Your session has ended. Please sign in again.' });
    }
  }
  if (!email) return json(422, { message: 'Please enter the email address we should reply to.' });
  if (!TICKET_CATEGORIES.includes(t.category)) return json(422, { message: 'Please choose a category.' });
  if (typeof t.description !== 'string' || t.description.trim().length < 10) return json(422, { message: 'Please describe the problem.' });
  const d = new Date();
  const reference = `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(2)}-${++seq}`;
  tickets.push({ reference, userId, email, category: t.category, description: t.description, source: t.source, conversation_ref: t.conversation_ref, client_ip: t.client_ip, at: d.toISOString() });
  console.log(`[ticket] ${reference} ${userId ? `user ${userId}` : `guest ${email}`} · ${t.category}`);
  return json(201, { reference });
}

// ---------- pages ----------
const page = (surface, user) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Main app stand-in (${surface})</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1c1c; background: #f4f4f4; }
  main { max-width: 760px; margin: 48px auto; padding: 0 16px; }
  nav a, nav button { margin-right: 12px; }
  .ai-launcher { position: fixed; right: 24px; bottom: 24px; z-index: 40; width: 58px; height: 58px; border-radius: 50%;
    border: 1px solid #ececec; background: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.14); cursor: pointer; font-size: 22px; }
  .ai-panel { position: fixed; right: 24px; bottom: 96px; z-index: 41; width: 460px; height: min(640px, calc(100vh - 120px));
    border: 0; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.2); background: #fff; }
  .ai-panel[hidden] { display: none; }
  .ai-panel iframe { width: 100%; height: 100%; border: 0; display: block; }
  @media (max-width: 640px) { .ai-panel { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; } }
</style></head>
<body>
<main>
  <h1>Main app stand-in · ${surface}</h1>
  <p>${surface === 'member' ? (user ? `Signed in as <b>${user.name}</b>.` : 'Not signed in — the chat should say the session ended.') : 'The sign-in page: the chat is Support only, for guests.'}
     The chat comes from <code>${AI_URL}/embed</code>.</p>
  <nav>
    <a href="/">Sign-in page (guest)</a>
    <a href="/login?as=alice">Sign in as Alice</a>
    <a href="/login?as=bob">Sign in as Bob</a>
    ${surface === 'member' ? '<button type="button" id="logout">Sign out (page stays open)</button>' : ''}
    <a href="/tickets" target="_blank">Received tickets</a>
  </nav>
</main>
<button class="ai-launcher" id="ai-launcher" type="button" aria-label="Open support chat" aria-expanded="false" aria-controls="ai-panel">💬</button>
<div class="ai-panel" id="ai-panel" hidden></div>
<script>
  const AI = ${JSON.stringify(AI_URL)};
  const SURFACE = ${JSON.stringify(surface)};
  const launcher = document.getElementById('ai-launcher');
  const panel = document.getElementById('ai-panel');
  let frame = null;
  const toFrame = (msg) => frame && frame.contentWindow.postMessage(msg, AI); // exact origin, never '*'

  function open() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.title = 'WealthQuest support chat';
      frame.src = AI + '/embed?surface=' + SURFACE; // no token in the URL
      panel.append(frame);
    }
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    frame.focus();
  }
  function close() { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));

  async function sendToken() {
    // Same-origin call with the main app's own session cookie; the token is never put in a URL or storage.
    const r = await fetch('/ai/session-token', { credentials: 'same-origin' });
    if (r.status === 401) return toFrame({ type: 'wq-ai:signed-out' });
    if (!r.ok) return; // the chat times out and offers "Try again"
    const { token } = await r.json();
    toFrame({ type: 'wq-ai:token', token });
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== AI || !frame || e.source !== frame.contentWindow) return; // only our iframe
    const type = e.data && e.data.type;
    if (type === 'wq-ai:close') close();
    // 'wq-ai:ready' is informational; the chat asks for a token explicitly, once per need.
    if (SURFACE === 'member' && type === 'wq-ai:token-request') sendToken();
  });

  document.getElementById('logout')?.addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST', credentials: 'same-origin' });
    toFrame({ type: 'wq-ai:signed-out' });
    document.querySelector('main p').textContent = 'Signed out (page left open on purpose).';
  });
</script>
</body></html>`;

const cookieUser = (req) => {
  const m = /(?:^|;\s*)host_user=(alice|bob)/.exec(req.headers.cookie || '');
  return m ? USERS[m[1]] : null;
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF);
  const html = (body) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

  if (req.method === 'GET' && url.pathname === '/') {
    const surface = url.searchParams.get('surface') === 'member' ? 'member' : 'guest';
    return html(page(surface, cookieUser(req)));
  }
  if (req.method === 'GET' && url.pathname === '/login') {
    const who = USERS[url.searchParams.get('as')] ? url.searchParams.get('as') : 'alice';
    return res.writeHead(302, { 'Set-Cookie': `host_user=${who}; Path=/; HttpOnly; SameSite=Lax`, Location: '/?surface=member' }).end();
  }
  if (req.method === 'POST' && url.pathname === '/logout') {
    return res.writeHead(204, { 'Set-Cookie': 'host_user=; Path=/; Max-Age=0' }).end();
  }
  if (req.method === 'GET' && url.pathname === '/ai/session-token') {
    const user = cookieUser(req);
    if (!user) return json(401, { error: 'unauthenticated' });
    return json(200, { token: await mintToken(user) });
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(200, jwks);
  if (req.method === 'GET' && url.pathname === '/tickets') return json(200, tickets);
  if (req.method === 'POST' && url.pathname === '/internal/ai/tickets') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 64_000) req.destroy(); });
    req.on('end', () => { receiveTicket(req, res, raw).catch((e) => json(500, { error: e.message })); });
    return undefined;
  }
  return res.writeHead(404).end('Not found');
}).listen(PORT, () => {
  console.log(`Main app stand-in on ${SELF} — guest: /  · member: /login?as=alice  · tickets: /tickets`);
  console.log(`Run the AI server with WQ_ISSUER=${SELF} MAIN_APP_URL=${SELF} AI_SUPPORT_SERVICE_SECRET=${SECRET === 'dev-ai-secret' ? 'dev-ai-secret' : '<yours>'}`);
});
