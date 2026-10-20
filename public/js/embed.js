// The chat panel the WealthQuest main app frames (/embed?surface=guest|member).
// guest  = sign-in page: Support only.
// member = member pages: Support + "My earnings" (disabled until the comp agent launches).
// The surface only changes the UI. The server decides who the user is (from a verified token,
// docs/embed-auth-plan.md §4), never from this parameter.
import { $, icons, fleur, ChatView, GREETING, getConfig } from './common.js';

const surface = new URLSearchParams(location.search).get('surface') === 'member' ? 'member' : 'guest';

$('#p-fleur').outerHTML = fleur({ gradient: false });
$('#p-close').innerHTML = icons.x;
$('#send').innerHTML = icons.arrowUp;
$('#mode').hidden = surface !== 'member';

const support = new ChatView({
  body: $('#body-support'), agent: 'support', surface: 'public',
  storageKey: `wq_embed_${surface}`, greeting: GREETING, onBusy: (b) => { $('#send').disabled = b; },
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#msg').value.trim();
  if (!t || support.busy) return;
  $('#msg').value = '';
  support.send(t);
});

// ---------- talking to the main app ----------
// postMessage only delivers when targetOrigin matches the parent, so posting to each allowed
// origin reaches the real parent and nobody else. Never '*'.
let parentOrigins = [];
getConfig().then((cfg) => { parentOrigins = cfg.embed_parent_origins || []; }).catch(() => {});

function postToParent(type, data = {}) {
  if (window.parent === window) return; // opened directly, not framed
  for (const origin of parentOrigins) window.parent.postMessage({ type, ...data }, origin);
}

$('#p-close').addEventListener('click', () => postToParent('wq-ai:close'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') postToParent('wq-ai:close'); });
$('#msg').focus({ preventScroll: true });
