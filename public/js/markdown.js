// Minimal, SAFE Markdown → HTML renderer for model answers and KB articles.
// Safety model: every piece of text is HTML-escaped FIRST; only the small set of constructs below is
// turned into tags, and link URLs are restricted to relative paths, https: and mailto:. Raw HTML in
// the source is therefore shown as text, never executed. No dependencies; also imported by unit tests.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Allow only safe link targets. Returns null for anything else (javascript:, data:, etc.). */
export function safeUrl(url) {
  const u = String(url).trim();
  if (/^\/(?!\/)[^\s]*$/.test(u)) return u; // same-origin path (not protocol-relative //)
  if (/^#[\w-]*$/.test(u)) return u;
  if (/^https:\/\/[^\s]+$/i.test(u)) return u;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(u)) return u;
  return null;
}

/** Inline formatting on ALREADY-ESCAPED text. */
function inline(escaped) {
  let s = escaped;
  // code spans first; protect their content from other rules
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  // links [text](url) — url was escaped too, so unescape &amp; for validation, re-escape for output
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const raw = url.replace(/&amp;/g, '&');
    const safe = safeUrl(raw);
    if (!safe) return text;
    const ext = /^https:/i.test(safe);
    return `<a href="${escapeHtml(safe)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return s;
}

/**
 * Render Markdown. Options:
 *  - headingBase: level used for "#" (default 1 → "#"=h1, "##"=h2, "###"=h3, deeper capped at h4)
 */
export function renderMarkdown(src, { headingBase = 1 } = {}) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6})\s|^\s*([-*+]|\d+[.)])\s|^>\s?|^\|.*\|\s*$|^(-{3,}|\*{3,})\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const lvl = Math.min(4, headingBase + m[1].length - 1);
      out.push(`<h${lvl}>${inline(escapeHtml(m[2].replace(/\s+#+\s*$/, '')))}</h${lvl}>`);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), { headingBase })}</blockquote>`);
      continue;
    }

    // table: header row, separator row, body rows
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(escapeHtml(c.trim())));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    m = line.match(/^\s*([-*+]|\d+[.)])\s+/);
    if (m) {
      const ordered = /\d/.test(m[1]);
      const start = ordered ? parseInt(m[1], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mm = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (mm && (/\d/.test(mm[1]) === ordered)) { items.push(mm[2]); i++; continue; }
        // continuation line (indented) belongs to the previous item
        if (l.trim() && /^\s{2,}/.test(l) && items.length) { items[items.length - 1] += ` ${l.trim()}`; i++; continue; }
        // a blank line followed by another item of the same list keeps the list going
        if (!l.trim() && i + 1 < lines.length) {
          const nx = lines[i + 1].match(/^\s*([-*+]|\d+[.)])\s+/);
          if (nx && /\d/.test(nx[1]) === ordered) { i++; continue; }
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${startAttr}>${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</${tag}>`);
      continue;
    }

    // paragraph: consecutive non-blank, non-block lines
    const buf = [];
    while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++]);
    out.push(`<p>${buf.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`);
  }
  return out.join('\n');
}
