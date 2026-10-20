// "Search with AI" answer page (Figma frames 03/04 + loading state).
// Streams the Support agent's answer; a follow-up question continues the SAME server-side
// conversation in the chat view (/chat), per the client's request.
import { $, icons, mountHeader, postStream, renderMarkdown, enterToSubmit, store, ticketForm, ticketSubmittedText, escapeHtml, turnstileToken } from './common.js';

mountHeader();
$('#back').innerHTML = icons.arrowLeft;
$('#send').innerHTML = icons.arrowUp;
$('#fu-send').innerHTML = icons.arrowUp;

const q = $('#q');
const params = new URLSearchParams(location.search);
let conversationId = null;
let transcript = []; // [{role, text, md}] handed over to /chat for follow-ups
let controller = null;

function autosize() { q.style.height = 'auto'; q.style.height = `${Math.max(100, q.scrollHeight)}px`; }
q.addEventListener('input', autosize);

async function ask(text) {
  const question = text.trim();
  if (!question) return;
  controller?.abort();
  controller = new AbortController();
  conversationId = null; // a new question from the top box = a new conversation
  transcript = [{ role: 'user', text: question }];
  history.replaceState(null, '', `/ai?q=${encodeURIComponent(question)}`);

  $('#answer').hidden = true;
  $('#error').hidden = true;
  $('#followup').hidden = true;
  $('#ticket').innerHTML = '';
  $('#md').innerHTML = '';
  $('#working').hidden = false;
  $('#status').textContent = 'Working on your answer';
  $('#send').disabled = true;

  let answer = '';
  let raf = 0;
  const paint = () => { raf = 0; $('#md').innerHTML = renderMarkdown(answer); $('#md').classList.add('cursor'); };

  const turnstile_token = await turnstileToken();
  await postStream('/api/support/message', { text: question, surface: 'public', turnstile_token }, (ev, data) => {
    if (ev === 'status') {
      if (data.conversation_id) conversationId = data.conversation_id;
    } else if (ev === 'delta') {
      if (!answer) { $('#working').hidden = true; $('#answer').hidden = false; }
      answer += data.text;
      if (!raf) raf = requestAnimationFrame(paint);
    } else if (ev === 'ticket_draft') {
      showTicket(data, answer);
    } else if (ev === 'error') {
      $('#working').hidden = true;
      $('#error').hidden = false;
      $('#error').textContent = data.message;
    }
  }, { signal: controller.signal });

  cancelAnimationFrame(raf);
  $('#md').classList.remove('cursor');
  if (answer) {
    $('#md').innerHTML = renderMarkdown(answer);
    transcript.push({ role: 'assistant', text: answer, md: true });
  }
  $('#working').hidden = true;
  $('#send').disabled = false;
  if (answer || $('#ticket').childElementCount) { $('#answer').hidden = false; $('#followup').hidden = false; }
}

/** The agent decided a human is needed: show the intro + pre-filled ticket form inline. */
function showTicket(data, answerSoFar) {
  $('#working').hidden = true;
  $('#answer').hidden = false;
  const intro = document.createElement('p');
  intro.style.whiteSpace = 'pre-wrap';
  intro.textContent = data.intro;
  $('#md').innerHTML = answerSoFar ? renderMarkdown(answerSoFar) : '';
  $('#md').append(intro);
  transcript.push({ role: 'assistant', text: data.intro });
  const holder = $('#ticket');
  holder.style.marginTop = '16px';
  holder.append(ticketForm({
    draft: data, categories: data.categories, conversationId, surface: 'public',
    onClose: (f) => f.remove(),
    onSubmitted: ({ ticket_number: n, form }) => {
      form.remove();
      holder.innerHTML = `<p style="white-space:pre-wrap;margin:0">${escapeHtml(ticketSubmittedText(n))}</p>`;
    },
  }));
}

// Top box: Enter submits, Shift+Enter newline.
enterToSubmit(q, () => ask(q.value));
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); ask(q.value); });

// Follow-up → hand the conversation to the chat view and continue there.
$('#followup').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#fu').value.trim();
  if (!text) return;
  store.set('wq_chat_support', { conversation_id: conversationId, first_q: transcript[0]?.text || text, messages: transcript });
  location.href = `/chat?followup=${encodeURIComponent(text.slice(0, 2000))}`;
});

// Start from ?q=
const initial = params.get('q');
if (initial) { q.value = initial.slice(0, 2000); autosize(); ask(q.value); }
else q.focus();
