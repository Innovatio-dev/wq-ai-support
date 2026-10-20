// Shared browser code: header, API + SSE client, KB tree, ticket form, chat view.
// Plain ES modules, no build step.
import { icons, fleur, CATEGORY_ICON } from './icons.js';
import { renderMarkdown, escapeHtml } from './markdown.js';

export { icons, fleur, CATEGORY_ICON, renderMarkdown, escapeHtml };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Safe sessionStorage/localStorage access (private mode, blocked storage…). */
export const store = {
  get(key, fallback = null, area = 'session') {
    try { const v = (area === 'local' ? localStorage : sessionStorage).getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value, area = 'session') {
    try { (area === 'local' ? localStorage : sessionStorage).setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key, area = 'session') { try { (area === 'local' ? localStorage : sessionStorage).removeItem(key); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------
export function mountHeader(target = $('#site-header')) {
  if (!target) return;
  target.outerHTML = `<header class="site-header">
    <a class="logo" href="/" aria-label="WealthQuest Support home">${fleur()}<span>WealthQuest</span></a>
    <a class="btn btn-login" href="/backoffice">Log in</a>
  </header>`;
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------
let configPromise = null;
export function getConfig() {
  configPromise ??= fetch('/api/config', { credentials: 'same-origin' }).then((r) => r.json());
  return configPromise;
}

// ---------------------------------------------------------------------------------------------
// Optional Cloudflare Turnstile: only when the server has TURNSTILE_SECRET (config exposes the site key).
// The first message of each conversation carries a token; the server verifies it with siteverify.
// ---------------------------------------------------------------------------------------------
let turnstileLoad = null;
export async function turnstileToken() {
  const cfg = await getConfig().catch(() => null);
  if (!cfg?.turnstile_site_key) return null;
  turnstileLoad ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    sc.async = true; sc.onload = resolve; sc.onerror = reject;
    document.head.append(sc);
  });
  await turnstileLoad;
  return new Promise((resolve) => {
    const holder = el('<div style="position:fixed;right:16px;bottom:90px;z-index:70"></div>');
    document.body.append(holder);
    window.turnstile.render(holder, {
      sitekey: cfg.turnstile_site_key, appearance: 'interaction-only',
      callback: (token) => { setTimeout(() => holder.remove(), 300); resolve(token); },
      'error-callback': () => { holder.remove(); resolve(null); },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// SSE over fetch (POST). Events: status | delta | ticket_draft | usage | done | error
// ---------------------------------------------------------------------------------------------
export async function postStream(url, body, onEvent, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err.name !== 'AbortError') onEvent('error', { message: 'Network error — please check your connection and try again.' });
    return;
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) {
    let message = 'Something went wrong. Please try again.';
    try { const j = await res.json(); if (j.message) message = j.message; } catch { /* not JSON */ }
    onEvent('error', { message, status: res.status });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { continue; }
        onEvent(event, parsed);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') onEvent('error', { message: 'The connection was interrupted. Please try again.' });
  }
}

// ---------------------------------------------------------------------------------------------
// KB tree (help-center categories), cached per page load
// ---------------------------------------------------------------------------------------------
let treePromise = null;
export function getTree() {
  treePromise ??= fetch('/api/kb/tree', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => j.categories);
  return treePromise;
}

/** Flatten the tree for client-side Basic search. */
export function flattenTree(cats) {
  const out = [];
  for (const c of cats) {
    for (const a of c.articles) out.push({ ...a, category: c.name });
    for (const s of c.subcategories) for (const a of s.articles) out.push({ ...a, category: `${c.name} › ${s.name}` });
  }
  return out;
}

/** Keyword search over titles, summaries and aliases (all terms must match somewhere; title hits rank higher). */
export function searchArticles(items, query) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const scored = [];
  for (const a of items) {
    const title = a.title.toLowerCase();
    const hay = `${title} ${a.summary.toLowerCase()} ${a.aliases.join(' ').toLowerCase()}`;
    if (!terms.every((t) => hay.includes(t))) continue;
    let score = 0;
    for (const t of terms) { if (title.includes(t)) score += 3; if (a.aliases.some((x) => x.toLowerCase().includes(t))) score += 2; score += 1; }
    scored.push({ a, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, 8).map((x) => x.a);
}

export function highlight(text, query) {
  let html = escapeHtml(text);
  for (const t of query.split(/\s+/).filter((x) => x.length > 1)) {
    html = html.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
  }
  return html;
}

/** Mount the Basic-search results list under an input. */
export function mountBasicSearch(input, list) {
  let items = [];
  getTree().then((cats) => { items = flattenTree(cats); render(); });
  let active = -1;
  function render() {
    const q = input.value.trim();
    if (!q) { list.hidden = true; list.innerHTML = ''; return; }
    const res = searchArticles(items, q);
    list.hidden = false;
    active = -1;
    list.innerHTML = res.length
      ? res.map((a) => `<li><a href="/help/${a.path}"><div class="t">${highlight(a.title, q)}</div><div class="s">${highlight(a.summary, q)}</div><div class="c">${escapeHtml(a.category)}</div></a></li>`).join('')
      : `<li class="empty">No articles match “${escapeHtml(q)}”. Try Help with AI, or <a href="/ticket">open a ticket</a>.</li>`;
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    const links = $$('a', list).filter((a) => a.closest('li:not(.empty)'));
    if (!links.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links.forEach((a, i) => a.classList.toggle('active', i === active));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      location.href = (links[Math.max(active, 0)]).href;
    }
  });
  return { render };
}

/** Segmented toggle "Help with AI ✦ | Basic search". Calls onChange('ai'|'basic'). */
export function mountToggle(root, initial, onChange) {
  root.innerHTML = `<div class="toggle" role="tablist" aria-label="Search mode">
    <button type="button" role="tab" data-mode="ai">Help with AI ${icons.sparkle}</button>
    <button type="button" role="tab" data-mode="basic">Basic search</button></div>`;
  const set = (mode) => {
    $$('button', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    onChange(mode);
  };
  $$('button', root).forEach((b) => b.addEventListener('click', () => set(b.dataset.mode)));
  set(initial);
}

/** Wire a textarea so Enter submits and Shift+Enter inserts a newline. */
export function enterToSubmit(textarea, submit) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
}

// ---------------------------------------------------------------------------------------------
// In-chat ticket form (Figma frames 08/09)
// ---------------------------------------------------------------------------------------------
export function ticketForm({ draft = null, categories, conversationId = null, surface = 'public', onSubmitted, onClose }) {
  const selected = draft?.category && categories.includes(draft.category) ? draft.category : '';
  const form = el(`<form class="ticket-form" novalidate>
    <label for="tf-cat-${Date.now()}">I need help with...</label>
    <div class="field"><select name="category" required>
      <option value=""${selected ? '' : ' selected'} disabled>Select</option>
      ${categories.map((c) => `<option${c === selected ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
    </select>${icons.chevronDown.replace('<svg', '<svg class="sel-chev"')}</div>
    <label>Description of the problem</label>
    <div class="field"><textarea name="description" maxlength="2000" placeholder="Please describe your issue in detail"></textarea></div>
    <div class="form-error" hidden></div>
    <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>Close</button><button type="submit" class="btn">Submit</button></div>
  </form>`);
  const id = `tf-cat-${Math.random().toString(36).slice(2, 8)}`;
  $('select', form).id = id;
  $('label', form).setAttribute('for', id);
  $('textarea', form).value = draft?.description || '';
  $('[data-close]', form).addEventListener('click', () => onClose?.(form));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const category = $('select', form).value;
    const description = $('textarea', form).value.trim();
    const err = $('.form-error', form);
    if (!category || description.length < 5) {
      err.hidden = false;
      err.textContent = !category ? 'Please choose what you need help with.' : 'Please describe the problem.';
      return;
    }
    err.hidden = true;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const r = await fetch('/api/tickets', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, description, conversation_id: conversationId, surface }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'Could not submit the ticket.');
      onSubmitted?.({ ticket_number: j.ticket_number, category, description, form });
    } catch (ex) {
      err.hidden = false;
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
  return form;
}

export const GREETING = "Hi! I'm Athena, WealthQuest Support Agent.\n\nAsk me a question. I'll help you solve it or get you to the right place.";
export const COMP_GREETING = "Hi Maria! I'm Athena, your Compensation Agent.\n\nAsk me about the Compensation Plan or your own rank, volume and bonuses. I'll cite the plan sections I use.";
export const ticketSubmittedText = (n) => `Your support request has been submitted as ticket #${n}, and a specialist will review it and follow up by email.\n\nIf you need to add more details later, just reply to that email thread.`;

// ---------------------------------------------------------------------------------------------
// ChatView — message list + streaming, shared by /chat and the Back Office panel
// ---------------------------------------------------------------------------------------------
export class ChatView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.body        scroll container for messages
   * @param {'support'|'comp'} o.agent
   * @param {'public'|'backoffice'} o.surface
   * @param {string} o.storageKey      sessionStorage key for persistence
   * @param {string} o.greeting
   * @param {Function} [o.onBusy]      (busy:boolean) → void
   */
  constructor({ body, agent, surface = 'public', storageKey, greeting, onBusy, onChange }) {
    Object.assign(this, { body, agent, surface, storageKey, greeting, onBusy, onChange });
    this.state = store.get(storageKey, null) || { conversation_id: null, first_q: '', messages: [] };
    this.busy = false;
    this.controller = null;
    this.renderAll();
  }

  get endpoint() { return this.agent === 'comp' ? '/api/comp/message' : '/api/support/message'; }

  persist() {
    // Keep the transcript for this tab only; forms are not persisted.
    store.set(this.storageKey, { ...this.state, messages: this.state.messages.filter((m) => m.kind !== 'form').slice(-60) });
    this.onChange?.(this.state);
  }

  reset() {
    this.controller?.abort();
    this.pinRow = null;
    this.state = { conversation_id: null, first_q: '', messages: [] };
    this.persist();
    this.renderAll();
    this.setBusy(false);
  }

  renderAll() {
    this.body.innerHTML = '';
    this.addBubble('assistant', this.greeting, { pre: true, save: false });
    for (const m of this.state.messages) this.addBubble(m.role, m.text, { md: m.md, pre: !m.md, save: false });
    this.scroll(false);
  }

  scroll(smooth = true) {
    requestAnimationFrame(() => {
      // While an answer streams, keep the user's question pinned near the top instead of chasing the
      // bottom of a long answer (the reader starts at the beginning of the answer).
      let top = this.body.scrollHeight;
      if (this.pinRow?.isConnected) top = Math.min(top, this.pinRow.offsetTop - 12);
      this.body.scrollTo({ top: Math.max(top, 0), behavior: smooth ? 'smooth' : 'auto' });
    });
  }

  /** Append a bubble. Returns { row, bubble, stack }. */
  addBubble(role, text, { md = false, pre = false, save = true } = {}) {
    const row = el(`<div class="msg ${role}">${role === 'assistant' ? `<div class="av">${fleur({ gradient: false, ring: false })}</div>` : ''}<div class="stack"><div class="bubble${pre ? ' pre' : ''}"></div></div></div>`);
    const bubble = $('.bubble', row);
    if (md) bubble.innerHTML = `<div class="md">${renderMarkdown(text)}</div>`;
    else bubble.textContent = text;
    this.body.append(row);
    if (save) { this.state.messages.push({ role, text, md }); this.persist(); }
    this.scroll();
    return { row, bubble, stack: $('.stack', row) };
  }

  setBusy(b) { this.busy = b; this.onBusy?.(b); }

  /** Send a user message and stream the reply. */
  async send(text, { extra = {} } = {}) {
    const q = String(text || '').trim();
    if (!q || this.busy) return;
    if (!this.state.first_q) this.state.first_q = q;
    this.pinRow = null;
    const { row: userRow } = this.addBubble('user', q);
    this.pinRow = userRow;
    const { bubble, stack, row } = this.addBubble('assistant', '', { save: false });
    bubble.innerHTML = '<div class="working status-line"><span class="dots"><i></i><i></i><i></i></span><span data-status>Working on your answer</span></div>';
    this.setBusy(true);
    this.controller = new AbortController();
    let answer = '';
    let raf = 0;
    const paint = () => { raf = 0; bubble.innerHTML = `<div class="md cursor">${renderMarkdown(answer)}</div>`; this.scroll(false); };

    const turnstile_token = this.state.conversation_id ? null : await turnstileToken();
    await postStream(this.endpoint, { text: q, conversation_id: this.state.conversation_id, surface: this.surface, turnstile_token, ...extra }, (ev, data) => {
      if (ev === 'status') {
        if (data.conversation_id) this.state.conversation_id = data.conversation_id;
        const s = $('[data-status]', bubble);
        if (s && data.text) s.textContent = data.text.replace(/…$/, '');
      } else if (ev === 'delta') {
        answer += data.text;
        if (!raf) raf = requestAnimationFrame(paint);
      } else if (ev === 'ticket_draft') {
        this.showTicketDraft({ data, bubble, stack, row, answerSoFar: answer });
        answer = null; // handled
      } else if (ev === 'error') {
        bubble.innerHTML = `<span style="color:#912018">${escapeHtml(data.message)}</span>`;
        answer = null;
      }
    }, { signal: this.controller.signal });

    cancelAnimationFrame(raf);
    if (answer !== null) {
      if (answer) {
        bubble.innerHTML = `<div class="md">${renderMarkdown(answer)}</div>`;
        this.state.messages.push({ role: 'assistant', text: answer, md: true });
        this.persist();
      } else if ($('.working', bubble)) {
        bubble.textContent = 'Sorry, I could not generate an answer. Please try again.';
      }
    }
    this.setBusy(false);
    this.scroll();
  }

  /** Render the "We will get this sorted" bubble + pre-filled ticket form. */
  showTicketDraft({ data, bubble, stack, answerSoFar }) {
    const intro = data.intro;
    bubble.classList.add('pre');
    bubble.innerHTML = answerSoFar ? `<div class="md">${renderMarkdown(answerSoFar)}</div><p style="margin:12px 0 0;white-space:pre-wrap">${escapeHtml(intro)}</p>` : escapeHtml(intro);
    this.state.messages.push({ role: 'assistant', text: answerSoFar ? `${answerSoFar}\n\n${intro}` : intro, md: Boolean(answerSoFar) });
    this.persist();
    const form = ticketForm({
      draft: data, categories: data.categories, conversationId: this.state.conversation_id, surface: this.surface,
      onClose: (f) => { f.remove(); this.scroll(); },
      onSubmitted: ({ ticket_number: n, category, description, form: f }) => {
        f.remove();
        this.pinRow = null;
        this.addBubble('user', `I need help with:\n${category}\n\nDescription:\n${description}`);
        this.addBubble('assistant', ticketSubmittedText(n), { pre: true });
      },
    });
    // Figma 09: the avatar stays aligned with the text bubble; the form is its own block underneath.
    const formRow = el('<div class="msg assistant cont"><div class="av-spacer"></div><div class="stack"></div></div>');
    $('.stack', formRow).append(form);
    this.body.append(formRow);
    const cleanup = new MutationObserver(() => { if (!form.isConnected) { formRow.remove(); cleanup.disconnect(); } });
    cleanup.observe(formRow, { childList: true, subtree: true });
    this.pinRow = null;
    requestAnimationFrame(() => form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}
