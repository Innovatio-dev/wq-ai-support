// Athena chat (Figma frames 07–10): pill with the first question (× = new conversation),
// chat card with streaming answers and the in-chat ticket form.
import { $, icons, fleur, mountHeader, ChatView, GREETING } from './common.js';

mountHeader();
$('#hdr-fleur').outerHTML = fleur({ gradient: false });
$('#clear').innerHTML = icons.x;
$('#send').innerHTML = icons.arrowUp;

const pill = $('#first');
const msg = $('#msg');

// Size the card so the input sits at the bottom of the viewport (min 520px tall).
function fit() {
  const card = $('#card');
  const top = card.getBoundingClientRect().top + window.scrollY;
  card.style.height = `${Math.max(520, window.innerHeight - top - 24)}px`;
}
fit();
window.addEventListener('resize', fit);

const chat = new ChatView({
  body: $('#body'), agent: 'support', surface: 'public', storageKey: 'wq_chat_support', greeting: GREETING,
  onBusy: (b) => { $('#send').disabled = b; },
  onChange: (s) => syncPill(s),
});

function syncPill(s = chat.state) {
  if (s.first_q) { pill.value = s.first_q; pill.readOnly = true; $('#clear').hidden = false; }
  else { pill.value = ''; pill.readOnly = false; $('#clear').hidden = true; }
}
syncPill();

// The pill starts a conversation (its text becomes the first question); × clears everything.
$('#pill').addEventListener('submit', (e) => {
  e.preventDefault();
  if (pill.readOnly) return;
  const t = pill.value.trim();
  if (t) chat.send(t);
});
$('#clear').addEventListener('click', () => { chat.reset(); pill.focus(); });

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = msg.value.trim();
  if (!t || chat.busy) return;
  msg.value = '';
  chat.send(t);
});

// Arriving from /ai with a follow-up (?followup=…) or from a link with ?q=…
const params = new URLSearchParams(location.search);
const followup = params.get('followup') || params.get('q');
if (followup) {
  history.replaceState(null, '', '/chat');
  chat.send(followup);
} else {
  (chat.state.first_q ? msg : pill).focus({ preventScroll: true });
}
