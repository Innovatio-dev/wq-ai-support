// The chat panel the WealthQuest main app frames (/embed?surface=guest|member).
// guest  = sign-in page: Support only, no token.
// member = member pages: Support + "My earnings" (disabled until the comp agent launches). The main app
//          hands us a short-lived signed token over postMessage; the server verifies it (src/identity.js).
// The surface only changes the UI — the server decides who the user is, from the token.
//
// Messages (docs/embed-auth-plan.md §4.2), all { type, ... }, never posted to '*':
//   to parent:   wq-ai:ready {surface} · wq-ai:token-request · wq-ai:close
//   from parent: wq-ai:token {token}   · wq-ai:signed-out
import { $, icons, fleur, ChatView, GREETING, getConfig, setAuthSource, store } from './common.js';

const surface = new URLSearchParams(location.search).get('surface') === 'member' ? 'member' : 'guest';
const TOKEN_WAIT_MS = 10_000;
const REFRESH_EARLY_S = 60; // treat a token as used up a minute before it expires (clock skew, slow requests)

$('#p-fleur').outerHTML = fleur({ gradient: false });
$('#p-close').innerHTML = icons.x;
$('#send').innerHTML = icons.arrowUp;
$('#mode').hidden = surface !== 'member';

// ---------- transcripts: one per identity, cleared when the identity changes ----------
const GUEST_KEY = 'wq_embed_guest';
const MEMBER_PREFIX = 'wq_embed_member_';
function clearMemberTranscripts(keep = null) {
  try { for (const k of Object.keys(sessionStorage)) if (k.startsWith(MEMBER_PREFIX) && k !== keep) store.del(k); } catch { /* storage blocked */ }
}

let chat = null;
let identity = null; // 'guest' | 'member:<sub>'
function useIdentity(next, storageKey, askEmail) {
  if (next === identity) return;
  identity = next;
  chat?.controller?.abort();
  chat = new ChatView({ body: $('#body-support'), agent: 'support', surface: 'public', storageKey, greeting: GREETING, askEmail, onBusy: (b) => { $('#send').disabled = b || !composerOpen; } });
}

// ---------- composer ----------
let composerOpen = false;
function setComposer(open) {
  composerOpen = open;
  $('#msg').disabled = !open;
  $('#send').disabled = !open || Boolean(chat?.busy);
}
function notice(text, { retry = false } = {}) {
  $('#notice').hidden = !text;
  $('#notice-text').textContent = text || '';
  $('#notice-retry').hidden = !retry;
}
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#msg').value.trim();
  if (!t || !composerOpen || !chat || chat.busy) return;
  $('#msg').value = '';
  chat.send(t);
});

// ---------- links ----------
// Inside the frame a same-site link (the cited /help/... article) would load in the panel, where every page
// but /embed refuses to be framed. Every link opens in a new tab instead.
document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!a || a.target === '_blank') return;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
});

// ---------- talking to the main app ----------
// postMessage only delivers when targetOrigin matches the parent, so posting to each allowed origin
// reaches the real parent and nobody else.
let parentOrigins = [];
function postToParent(type, data = {}) {
  if (window.parent === window) return; // opened directly, not framed
  for (const origin of parentOrigins) window.parent.postMessage({ type, ...data }, origin);
}
$('#p-close').addEventListener('click', () => postToParent('wq-ai:close'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') postToParent('wq-ai:close'); });

/** Read (never trust) a JWT's payload: the server verifies; we only need sub/exp for UX. */
function peek(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch { return null; }
}

/**
 * Member token source: asks the parent, caches until shortly before expiry, rejects once signed out.
 * Tokens are fetched on demand only (before a request), never on a timer: every fetch hits the main app
 * with its session cookie, so a timer would keep an idle member's session alive forever.
 */
function memberAuth() {
  let token = null;
  let exp = 0;
  let signedOut = false;
  let waiters = [];

  const fail = (userMessage) => Object.assign(new Error(userMessage), { userMessage });
  const settle = (fn) => { const w = waiters; waiters = []; w.forEach(fn); };

  function request() {
    if (signedOut) return Promise.reject(fail('Your session has ended. Please sign in again.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w.resolve !== resolve);
        reject(fail('We couldn\'t confirm your sign-in. Please try again.'));
        if (!token) { notice('We couldn\'t confirm your sign-in.', { retry: true }); setComposer(false); }
      }, TOKEN_WAIT_MS);
      waiters.push({ resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      postToParent('wq-ai:token-request');
    });
  }

  function onToken(t) {
    const claims = peek(t);
    if (!claims?.sub || !claims.exp) return;
    signedOut = false;
    token = t;
    exp = claims.exp;
    // First token of this page, or a different member: any other member's transcript (and the guest's)
    // goes; this member's own stays, so a page change in the main app (which reloads the frame) keeps it.
    if (identity !== `member:${claims.sub}`) {
      const key = `${MEMBER_PREFIX}${claims.sub}`;
      clearMemberTranscripts(key);
      store.del(GUEST_KEY);
      useIdentity(`member:${claims.sub}`, key, false);
    }
    notice('');
    setComposer(true);
    settle((w) => w.resolve(t));
  }

  function onSignedOut() {
    signedOut = true;
    token = null;
    // Wipe the member's conversation from the screen as well as from storage: on a shared computer the
    // next person must not see it. Whoever signs in next starts a fresh transcript.
    chat?.reset();
    identity = null;
    clearMemberTranscripts();
    notice('Your session has ended. Please sign in again to keep chatting.');
    setComposer(false);
    settle((w) => w.reject(fail('Your session has ended. Please sign in again.')));
  }

  return {
    onToken, onSignedOut,
    getToken: () => (token && exp - REFRESH_EARLY_S > Date.now() / 1000 ? Promise.resolve(token) : request()),
    refresh: () => { token = null; return request(); },
  };
}

const auth = surface === 'member' ? memberAuth() : null;

window.addEventListener('message', (e) => {
  if (e.source !== window.parent || !parentOrigins.includes(e.origin)) return; // only the main app
  const msg = e.data;
  if (!auth || !msg || typeof msg !== 'object') return;
  if (msg.type === 'wq-ai:token' && typeof msg.token === 'string') auth.onToken(msg.token);
  else if (msg.type === 'wq-ai:signed-out') auth.onSignedOut();
});

$('#notice-retry').addEventListener('click', () => {
  notice('Checking your sign-in…');
  auth?.refresh().catch(() => {});
});

// ---------- start ----------
if (auth) {
  setAuthSource(auth);
  setComposer(false);
  notice('Checking your sign-in…');
} else {
  // Guest panel (the sign-in page): whoever was signed in in this tab has left, so their transcript goes.
  clearMemberTranscripts();
  useIdentity('guest', GUEST_KEY, true);
  setComposer(true);
}

getConfig().then((cfg) => {
  parentOrigins = cfg.embed_parent_origins || [];
  postToParent('wq-ai:ready', { surface });
  if (auth) auth.getToken().catch(() => {});
}).catch(() => notice('The chat could not load. Please try again later.'));

$('#msg').focus({ preventScroll: true });
