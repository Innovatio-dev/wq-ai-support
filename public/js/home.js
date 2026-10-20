// Support home (Figma frames 01/02): AI question box or Basic search + "Browse help articles" accordion.
import { $, $$, mountHeader, mountToggle, mountBasicSearch, enterToSubmit, getTree, icons, CATEGORY_ICON, escapeHtml } from './common.js';

mountHeader();

const aiForm = $('#ai-form');
const basic = $('#basic');
const q = $('#q');

mountToggle($('#toggle'), 'ai', (mode) => {
  aiForm.hidden = mode !== 'ai';
  basic.hidden = mode !== 'basic';
  (mode === 'ai' ? q : $('#s')).focus({ preventScroll: true });
});

// "Help with AI": Enter submits → /ai?q=…  (Shift+Enter = newline)
const submit = () => {
  const text = q.value.trim();
  if (text) location.href = `/ai?q=${encodeURIComponent(text.slice(0, 2000))}`;
};
enterToSubmit(q, submit);
aiForm.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

// "Basic search": live client-side keyword search over titles, summaries and aliases.
mountBasicSearch($('#s'), $('#results'));

// Browse help articles: categories → (subcategories) → article links.
export function renderAccordion(root, cats) {
  root.innerHTML = cats.map((c, i) => {
    const links = (arr) => arr.map((a) => `<a href="/help/${a.path}">${escapeHtml(a.title)}</a>`).join('');
    const body = c.subcategories.length
      ? c.subcategories.map((s) => `<div class="acc-sub"><div class="acc-sub-title">${escapeHtml(s.name)}</div>${links(s.articles)}</div>`).join('')
      : links(c.articles);
    return `<div class="acc-item">
      <button class="acc-head" type="button" aria-expanded="false" aria-controls="acc-p${i}" id="acc-h${i}">
        ${(CATEGORY_ICON[c.icon] || icons.apps).replace('<svg', '<svg class="cat-ico"')}<span>${escapeHtml(c.name)}</span>${icons.chevronDown.replace('<svg', '<svg class="chev"')}
      </button>
      <div class="acc-panel" id="acc-p${i}" role="region" aria-labelledby="acc-h${i}" hidden>${body}</div></div>`;
  }).join('');
  $$('.acc-head', root).forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    b.setAttribute('aria-expanded', String(!open));
    $(`#${b.getAttribute('aria-controls')}`).hidden = open;
  }));
}
getTree().then((cats) => renderAccordion($('#acc'), cats));
