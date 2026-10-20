// Security layer (demo-level but real). In AdonisJS these map to middleware:
//   demoGate → app/middleware/demo_gate_middleware.ts, sameOrigin → same_origin_middleware.ts,
//   rate limiters → @adonisjs/limiter, budget guard → app/services/budget_service.ts,
//   securityHeaders → @adonisjs/shield (CSP) configuration.
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';

// ---------- cookies & session ----------
export const COOKIE = { session: 'wq_sid', gate: 'wq_gate', backoffice: 'wq_bo' };

const cookieBase = () => ({ httpOnly: true, sameSite: 'lax', secure: config.isProduction, signed: true, path: '/' });

/** Ensure every visitor has a random, signed, HttpOnly session id (req.sid). */
export function sessionMiddleware(req, res, next) {
  let sid = req.signedCookies?.[COOKIE.session];
  if (!sid || !/^[a-f0-9]{32}$/.test(sid)) {
    sid = crypto.randomBytes(16).toString('hex');
    res.cookie(COOKIE.session, sid, { ...cookieBase(), maxAge: 7 * 864e5 });
  }
  req.sid = sid;
  next();
}

/** OpenAI `safety_identifier`: a stable hash of the session id (never the raw id or any PII). */
export function safetyIdentifier(sid) {
  return crypto.createHash('sha256').update(`wq:${sid}`).digest('hex');
}

// ---------- demo password gate ----------
const GATE_EXEMPT = [/^\/login$/, /^\/js\/login\.js$/, /^\/healthz$/, /^\/fonts\//, /^\/css\//, /^\/img\//, /^\/favicon/];

export function demoGate(req, res, next) {
  if (!config.demoPassword) return next();
  if (GATE_EXEMPT.some((re) => re.test(req.path))) return next();
  if (req.signedCookies?.[COOKIE.gate] === 'ok') return next();
  if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') {
    return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: 'locked', message: 'Demo is password protected.' });
}

/** Constant-time password comparison. */
export function checkPassword(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(config.demoPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

export function setGateCookie(res) {
  res.cookie(COOKIE.gate, 'ok', { ...cookieBase(), maxAge: 7 * 864e5 });
}

/** Back Office "session": set when /backoffice is visited. In production this is the real auth session. */
export function setBackofficeCookie(res) {
  res.cookie(COOKIE.backoffice, config.backofficeUser.distributor_id, { ...cookieBase(), maxAge: 864e5 });
}
export function backofficePrincipal(req) {
  const id = req.signedCookies?.[COOKIE.backoffice];
  return id === config.backofficeUser.distributor_id ? { distributor_id: id } : null;
}
export function requireBackoffice(req, res, next) {
  if (backofficePrincipal(req)) return next();
  return res.status(403).json({ error: 'backoffice_only', message: 'The Compensation agent is only available inside the Back Office.' });
}

// ---------- same-origin check (CSRF defence for cookie-authenticated POSTs) ----------
/**
 * True when the Origin (or, failing that, the Referer) host equals the Host header.
 * Requests with neither header are rejected: every modern browser sends Origin on POST.
 */
export function isSameOrigin({ origin, referer, host }) {
  if (!host) return false;
  const src = origin && origin !== 'null' ? origin : referer;
  if (!src) return false;
  try {
    return new URL(src).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Behind Railway's proxy the Host header is preserved, so this works without trust-proxy host rewriting.
  const ok = isSameOrigin({ origin: req.get('origin'), referer: req.get('referer'), host: req.get('host') });
  if (!ok) return res.status(403).json({ error: 'bad_origin', message: 'Cross-origin request blocked.' });
  next();
}

// ---------- rate limits ----------
const limitHandler = (message) => (req, res) => res.status(429).json({ error: 'rate_limited', message });

function limiter(windowMs, limit, keyGenerator, message) {
  return rateLimit({
    windowMs, limit, keyGenerator, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: limitHandler(message),
  });
}
const byIp = (req) => `ip:${req.ip}`;
const bySession = (req) => `sid:${req.sid}`;

/** Per-IP AND per-session limits on every AI endpoint: 20/min, 150/day (config.limits). */
export const aiRateLimit = [
  limiter(60_000, config.limits.aiPerMinute, byIp, 'Too many requests — please wait a minute.'),
  limiter(60_000, config.limits.aiPerMinute, bySession, 'Too many requests — please wait a minute.'),
  limiter(864e5, config.limits.aiPerDay, byIp, 'Daily message limit reached for this network. Try again tomorrow.'),
  limiter(864e5, config.limits.aiPerDay, bySession, 'Daily message limit reached for this session. Try again tomorrow.'),
];
export const ticketRateLimit = [
  limiter(60_000, 5, byIp, 'Too many tickets — please wait a minute.'),
  limiter(864e5, 30, byIp, 'Daily ticket limit reached.'),
];

// ---------- daily budget guard ----------
const spend = { day: '', usd: 0 };
const utcDay = () => new Date().toISOString().slice(0, 10);

export function recordSpend(usd) {
  if (spend.day !== utcDay()) { spend.day = utcDay(); spend.usd = 0; }
  spend.usd += usd;
}
export function budgetExceeded() {
  if (spend.day !== utcDay()) return false;
  return spend.usd >= config.dailyBudgetUsd;
}
export function budgetStatus() {
  return { day: utcDay(), spent_usd: spend.day === utcDay() ? spend.usd : 0, limit_usd: config.dailyBudgetUsd };
}
export const BUDGET_MESSAGE = 'The demo has reached its daily AI budget. Please try again tomorrow, or open a ticket and our team will reply by email.';

// ---------- input validation ----------
/** Returns an error message, or null when the text is acceptable. */
export function validateText(text) {
  if (typeof text !== 'string') return 'Message must be text.';
  const t = text.trim();
  if (!t) return 'Please type a question.';
  if (t.length > config.limits.maxInputChars) return `Please keep your message under ${config.limits.maxInputChars.toLocaleString('en-US')} characters.`;
  return null;
}

/** Strip control characters (except newline/tab) before anything reaches a prompt. */
export function cleanText(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

// ---------- Cloudflare Turnstile (optional) ----------
/** When TURNSTILE_SECRET is set, the first message of a conversation must carry a valid token. */
export async function verifyTurnstile(token, ip) {
  if (!config.turnstileSecret) return true;
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: config.turnstileSecret, response: token, remoteip: ip || '' });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await r.json();
    return Boolean(data.success);
  } catch (err) {
    console.warn('[turnstile] verification failed:', err.message);
    return false;
  }
}

// ---------- security headers (written by hand, helmet-like) ----------
export function securityHeaders(req, res, next) {
  const turnstile = config.turnstileSecret ? ' https://challenges.cloudflare.com' : '';
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' https://cdn.jsdelivr.net${turnstile}`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      `frame-src 'self'${turnstile}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (config.isProduction) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}
