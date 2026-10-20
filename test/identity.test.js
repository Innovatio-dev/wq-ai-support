// Member tokens: only short-lived EdDSA tokens from the main app, for this audience, with our typ, verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verifyMemberToken, identify, ownerKey, TOKEN_TYPE } from '../src/identity.js';

const ISSUER = 'https://app.example.test';
const AUDIENCE = 'wq-ai-support';

async function issuer() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  return { privateKey, keySet: createLocalJWKSet({ keys: [jwk] }) };
}
const main = await issuer();
const other = await issuer();
const opts = { keySet: main.keySet, issuer: ISSUER, audience: AUDIENCE };

/** A token as the main app will mint it; override any part to break it. */
function mint({ key = main.privateKey, typ = TOKEN_TYPE, alg = 'EdDSA', iss = ISSUER, aud = AUDIENCE, sub = 'pairwise-sub-1', iat, exp = '10m', claims = {} } = {}) {
  const jwt = new SignJWT({ name: 'Maria K.', email: 'maria@example.test', ...claims })
    .setProtectedHeader({ alg, kid: 'k1', ...(typ ? { typ } : {}) })
    .setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp);
  if (sub) jwt.setSubject(sub);
  return jwt.sign(key);
}

const code = async (promise) => { try { await promise; return 'ok'; } catch (e) { return e.code; } };

test('a valid token gives the member, with only the claims we use', async () => {
  const m = await verifyMemberToken(await mint({ claims: { uid_enc: 'opaque', role: 'admin' } }), opts);
  assert.deepEqual(m, { sub: 'pairwise-sub-1', name: 'Maria K.', email: 'maria@example.test' });
});

test('wrong issuer, audience, typ, signing key or subject is refused', async () => {
  assert.equal(await code(verifyMemberToken(await mint({ iss: 'https://evil.test' }), opts)), 'invalid_token');
  assert.equal(await code(verifyMemberToken(await mint({ aud: 'wealthventures' }), opts)), 'invalid_token');
  assert.equal(await code(verifyMemberToken(await mint({ typ: null }), opts)), 'invalid_token'); // e.g. an SSO id_token
  assert.equal(await code(verifyMemberToken(await mint({ typ: 'JWT' }), opts)), 'invalid_token');
  assert.equal(await code(verifyMemberToken(await mint({ key: other.privateKey }), opts)), 'invalid_token');
  assert.equal(await code(verifyMemberToken(await mint({ sub: null }), opts)), 'invalid_token');
  assert.equal(await code(verifyMemberToken('not.a.jwt', opts)), 'invalid_token');
});

test('HS256 (shared-secret) tokens are refused even with a matching claim set', async () => {
  const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: TOKEN_TYPE }).setIssuer(ISSUER)
    .setAudience(AUDIENCE).setSubject('x').setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode('s'.repeat(32)));
  assert.equal(await code(verifyMemberToken(hs, opts)), 'invalid_token');
});

test('expired, stale or long-lived tokens are refused', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await code(verifyMemberToken(await mint({ iat: now - 700, exp: now - 100 }), opts)), 'token_expired');
  // Too old (iat over 15 min ago): jose reports it as expired, which makes the chat fetch a fresh one.
  assert.equal(await code(verifyMemberToken(await mint({ iat: now - 3600, exp: now + 600 }), opts)), 'token_expired');
  assert.equal(await code(verifyMemberToken(await mint({ exp: '30d' }), opts)), 'invalid_token'); // minted to live too long
});

test('no issuer configured = members cannot sign in', async () => {
  assert.equal(await code(verifyMemberToken(await mint(), { keySet: main.keySet, issuer: '' })), 'not_configured');
  assert.equal(await code(verifyMemberToken(await mint(), { keySet: null, issuer: ISSUER })), 'not_configured');
});

function run(mw, headers = {}) {
  return new Promise((resolve) => {
    const req = { get: (h) => headers[h.toLowerCase()], sid: 'abc' };
    const res = { status(s) { this.code = s; return this; }, json(body) { resolve({ req, status: this.code, body }); } };
    mw(req, res, () => resolve({ req, status: null }));
  });
}

test('identify: no header is a guest; a malformed or unverifiable header is a 401, never a guest', async () => {
  const guest = await run(identify);
  assert.equal(guest.status, null);
  assert.equal(guest.req.member, null);
  assert.equal(ownerKey(guest.req), 'sid:abc');

  const bad = await run(identify, { authorization: 'Basic dXNlcjpwYXNz' });
  assert.equal(bad.status, 401);
  // No WQ_ISSUER in the test environment: a well-formed token can't be verified → refused, not downgraded.
  const unconfigured = await run(identify, { authorization: `Bearer ${await mint()}` });
  assert.equal(unconfigured.status, 401);
  assert.equal(unconfigured.body.error, 'invalid_token');
});

test('ownerKey prefers the member over the session', () => {
  assert.equal(ownerKey({ member: { sub: 's1' }, sid: 'abc' }), 'member:s1');
});
