// Who is talking: a WealthQuest member (signed token from the main app) or a guest.
// The main app signs a short-lived JWT with its SSO Ed25519 key; we verify it against the key set it
// publishes (JWKS) — we can verify tokens but never mint one. docs/embed-auth-plan.md §4.2.
import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import { config } from './config.js';

/** JWT `typ` header the main app stamps on these tokens, so an SSO id_token can't be replayed here. */
export const TOKEN_TYPE = 'wq-ai+jwt';
/** Upper bounds on a token's age and lifetime, whatever its `exp` says (the main app issues 10-minute tokens). */
const MAX_TOKEN_AGE = '15 minutes';
const MAX_LIFETIME_S = 15 * 60;

export class TokenError extends Error {
  /** @param {'invalid_token'|'token_expired'|'auth_unavailable'|'not_configured'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let remoteKeySet = null;
/** The main app's JWKS, cached by jose and re-fetched when a token names an unknown key (rotation). */
function mainAppKeySet() {
  if (!config.wqJwksUrl) return null;
  remoteKeySet ??= createRemoteJWKSet(new URL(config.wqJwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutMs: 5_000 });
  return remoteKeySet;
}

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Verify a member token. Returns { sub, name, email }; throws TokenError.
 * `sub` is the main app's pairwise subject for this service — never its internal user id.
 */
export async function verifyMemberToken(token, { keySet = mainAppKeySet(), issuer = config.wqIssuer, audience = config.wqAudience } = {}) {
  if (!keySet || !issuer) throw new TokenError('not_configured', 'Member sign-in is not configured on this server.');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet, {
      issuer, audience, algorithms: ['EdDSA'], typ: TOKEN_TYPE,
      requiredClaims: ['sub', 'exp', 'iat'], maxTokenAge: MAX_TOKEN_AGE, clockTolerance: 30,
    }));
  } catch (err) {
    if (err instanceof errors.JWTExpired) throw new TokenError('token_expired', 'Your sign-in has expired.');
    // Fetching the key set failing (network, timeout, non-200 = jose's generic error, garbage JWKS) is our
    // problem, not the member's; every other JOSE error means the token itself is bad.
    const keySetFailed = !(err instanceof errors.JOSEError) || err instanceof errors.JWKSTimeout
      || err instanceof errors.JWKSInvalid || err.code === 'ERR_JOSE_GENERIC';
    if (keySetFailed) throw new TokenError('auth_unavailable', 'Sign-in can\'t be checked right now.');
    throw new TokenError('invalid_token', 'Your sign-in could not be verified.');
  }
  const sub = text(payload.sub, 128);
  if (!sub) throw new TokenError('invalid_token', 'Your sign-in could not be verified.');
  // maxTokenAge bounds how old a token is, not how long it was minted to live: refuse long-lived ones too.
  if (payload.exp - payload.iat > MAX_LIFETIME_S) throw new TokenError('invalid_token', 'Your sign-in could not be verified.');
  return { sub, name: text(payload.name, 80), email: text(payload.email, 254) };
}

/**
 * Express middleware: `Authorization: Bearer <token>` → req.member, else req.member = null (guest).
 * A token that is present but bad is refused (401), never silently downgraded to a guest.
 */
export async function identify(req, res, next) {
  req.member = null;
  const header = req.get('authorization');
  if (!header) return next();
  const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
  if (!m) return res.status(401).json({ error: 'invalid_token', message: 'Your sign-in could not be verified.' });
  try {
    req.member = await verifyMemberToken(m[1]);
    req.memberToken = m[1]; // forwarded to the main app later (tickets), never logged
    return next();
  } catch (err) {
    if (err.code === 'not_configured' || err.code === 'auth_unavailable') console.warn('[identity]', err.code, err.message);
    const status = err.code === 'auth_unavailable' ? 503 : 401;
    return res.status(status).json({ error: err.code === 'not_configured' ? 'invalid_token' : err.code, message: err.message });
  }
}

/** Stable key for "this person": the member, else the browser session. Used for conversations and limits. */
export function ownerKey(req) {
  return req.member ? `member:${req.member.sub}` : `sid:${req.sid}`;
}
