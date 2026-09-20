// Help article page (Figma frames 05/06): question box on top (asks go to /ai), breadcrumb pills,
// rendered article, CTA, related links, category sidebar and the "We're here to help" card.
import { $, $$, icons, mountHeader, mountToggle, mountBasicSearch, enterToSubmit, getTree, renderMarkdown, escapeHtml, CATEGORY_ICON, mountCostInspector } from './common.js';

mountHeader();
mountCostInspector({ agents: ['support'] });

const path = decodeURIComponent(location.pathname.replace(/^\/help\//, '')).replace(/\/+$/, '');
const q = $('#q');

mountToggle($('#toggle'), 'ai', (mode) => {
  $('#ai-form').hidden = mode !== 'ai';
  $('#basic').hidden = mode !== 'basic';
});
const submit = () => { const t = q.value.trim(); if (t) location.href = `/ai?q=${encodeURIComponent(t.slice(0, 2000))}`; };
enterToSubmit(q, submit);
$('#ai-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
mountBasicSearch($('#s'), $('#results'));

async function load() {
  const r = await fetch(`/api/kb/article?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
  if (!r.ok) { $('#title').textContent = 'Article not found'; return; }
  const a = await r.json();
  document.title = `${a.title} · WealthQuest Support`;

  // Breadcrumb: Home › Category
  $('#crumbs').innerHTML = `<a href="/">Home</a>${icons.chevronRight}<a href="/#${escapeHtml(a.category_slug)}">${escapeHtml(a.category)}</a>`;
  $('#title').textContent = a.title;

  // Body: rendered (safe) Markdown. The CTA button goes after the first section, as in the Figma frame.
  const html = renderMarkdown(a.body_markdown, { headingBase: 1 });
  const body = $('#body');
  body.innerHTML = html;
  if (a.cta) {
    const cta = document.createElement('p');
    cta.className = 'cta';
    cta.innerHTML = `<a class="btn" href="${a.cta.url.startsWith('/') ? escapeHtml(a.cta.url) : '#'}">${escapeHtml(a.cta.label)} ${icons.arrowRight}</a>`;
    const h2s = $$('h2', body);
    if (h2s[1]) body.insertBefore(cta, h2s[1]); else body.append(cta);
  }

  if (a.related.length) {
    $('#related').hidden = false;
    $('#related-links').innerHTML = a.related.map((x) => `<a href="/help/${x.path}">${escapeHtml(x.title)}</a>`).join('');
  }
  return a;
}

/** Sidebar: category accordion → subcategory accordion → article links (current = teal). */
function renderSidebar(cats, current) {
  const link = (x) => `<a href="/help/${x.path}"${x.path === path ? ' aria-current="page"' : ''}>${escapeHtml(x.title)}</a>`;
  $('#sidebar').innerHTML = cats.map((c, i) => {
    const hasCurrent = [...c.articles, ...c.subcategories.flatMap((s) => s.articles)].some((x) => x.path === path);
    const inner = c.subcategories.length
      ? c.subcategories.map((s, j) => {
        const open = s.articles.some((x) => x.path === path);
        return `<div class="side-sub"><button class="side-sub-head" type="button" aria-expanded="${open}" aria-controls="sp${i}-${j}">${escapeHtml(s.name)}${icons.chevronDown.replace('<svg', '<svg class="chev"')}</button>
          <div class="side-links" id="sp${i}-${j}"${open ? '' : ' hidden'}>${s.articles.map(link).join('')}</div></div>`;
      }).join('')
      : `<div class="side-links">${c.articles.map(link).join('')}</div>`;
    return `<div class="side-cat"><button class="side-head" type="button" aria-expanded="${hasCurrent}" aria-controls="sc${i}">
        ${(CATEGORY_ICON[c.icon] || icons.apps).replace('<svg', '<svg class="cat-ico"')}<span>${escapeHtml(c.name)}</span>${icons.chevronDown.replace('<svg', '<svg class="chev"')}</button>
      <div class="side-panel" id="sc${i}"${hasCurrent ? '' : ' hidden'}>${inner}</div></div>`;
  }).join('');
  $$('#sidebar button[aria-controls]').forEach((b) => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') === 'true';
    b.setAttribute('aria-expanded', String(!open));
    $(`#${b.getAttribute('aria-controls')}`).hidden = open;
  }));
}

Promise.all([load(), getTree()]).then(([a, cats]) => renderSidebar(cats, a));
