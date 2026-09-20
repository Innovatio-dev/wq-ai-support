// Knowledge-base loader for the two Obsidian-style vaults ("LLM wiki" / Karpathy method).
// - Parses the small YAML frontmatter subset the vaults use (no dependency).
// - Builds the help-center tree (categories → subcategories → articles).
// - Exposes a PATH ALLOW-LIST: the model can only ever cause files listed in index.md
//   to be read. Anything else is dropped, so a prompt-injected path can't read arbitrary files.
// In AdonisJS this becomes app/services/knowledge_base_service.ts (a singleton loaded at boot).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse `---` frontmatter. Supports: scalars (quoted or bare), null, block lists (`  - item`)
 * and one-level maps (`cta:` followed by `  label: ...`). That is exactly what the vault lint allows.
 */
export function parseFrontmatter(text) {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { meta: {}, body: src };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: src };
  const yaml = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n+/, '');
  const meta = {};
  let currentKey = null;
  for (const raw of yaml.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    const mapItem = raw.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    const top = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(scalar(listItem[1]));
    } else if (mapItem && currentKey) {
      if (meta[currentKey] === null || typeof meta[currentKey] !== 'object' || Array.isArray(meta[currentKey])) meta[currentKey] = {};
      meta[currentKey][mapItem[1]] = scalar(mapItem[2]);
    } else if (top) {
      currentKey = top[1];
      meta[currentKey] = top[2] === '' ? null : scalar(top[2]);
    }
  }
  return { meta, body };
}

function scalar(v) {
  let s = v.replace(/\s+#.*$/, '').trim();
  if (s === 'null' || s === '~' || s === '') return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/** "[[account/logging-in/cant-log-in]]" → "account/logging-in/cant-log-in" */
export function unwikilink(s) {
  return String(s || '').replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
}

/** Normalise a path coming from the model or a URL: strip [[ ]], leading "/help/", ".md", slashes. */
export function normalizePath(p) {
  return unwikilink(p)
    .replace(/^\/?help\//, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

// Material-style category icons (inline SVG path names are resolved on the client).
const CATEGORY_ICONS = {
  'Payments & billing': 'card',
  'Manage your account': 'person',
  'WealthQuest membership': 'star',
  'In-app features': 'apps',
  'Device & troubleshooting': 'devices',
  'Safety & privacy': 'shield',
};

/** Parse index.md lines `- [[path]] ...` in order, with the heading they sit under. */
function parseIndex(indexText) {
  const entries = [];
  let h2 = null;
  let h3 = null;
  for (const line of indexText.split('\n')) {
    if (line.startsWith('## ')) { h2 = line.slice(3).trim(); h3 = null; continue; }
    if (line.startsWith('### ')) { h3 = line.slice(4).trim(); continue; }
    const m = line.match(/^- \[\[([^\]]+)\]\]/);
    if (m) entries.push({ path: m[1].trim(), h2, h3 });
  }
  return entries;
}

export class Vault {
  /**
   * @param {string} dir  vault folder
   * @param {'support'|'compplan'} kind
   */
  constructor(dir, kind) {
    this.dir = path.resolve(dir);
    this.kind = kind;
    // index.md is sent verbatim to the router as part of the static (cacheable) prefix.
    this.indexText = fs.readFileSync(path.join(this.dir, 'index.md'), 'utf8');
    this.docs = new Map();
    for (const e of parseIndex(this.indexText)) {
      const file = path.join(this.dir, `${e.path}.md`);
      // Defence in depth: the resolved file must stay inside the vault.
      if (!file.startsWith(this.dir + path.sep) || !fs.existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      this.docs.set(e.path.toLowerCase(), { path: e.path, meta, body, h2: e.h2, h3: e.h3 });
    }
  }

  /** The allow-list: every path that appears in index.md and exists on disk. */
  get paths() { return [...this.docs.keys()]; }

  has(p) { return this.docs.has(normalizePath(p)); }

  get(p) { return this.docs.get(normalizePath(p)) || null; }

  /**
   * Keep only allow-listed paths (deduplicated, max `limit`). This is the ONLY way
   * model output turns into file reads.
   */
  resolvePaths(paths, limit = 3) {
    const out = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      if (typeof p !== 'string' || p.length > 200) continue;
      const n = normalizePath(p);
      if (this.docs.has(n) && !out.includes(n)) out.push(n);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Text handed to the answer model: frontmatter stripped except title, cta, escalate_if. */
  articleForModel(p) {
    const d = this.get(p);
    if (!d) return null;
    const m = d.meta;
    const head = [`title: ${m.title}`];
    if (m.section) head.push(`section: ${m.section}`);
    if (Array.isArray(m.escalate_if) && m.escalate_if.length) {
      head.push('escalate_if:', ...m.escalate_if.map((x) => `  - ${x}`));
    }
    if (m.cta && m.cta.label) head.push(`cta: ${m.cta.label} (${m.cta.url})`);
    return `${head.join('\n')}\n\n${d.body.trim()}`;
  }

  /** Help-center tree for the browse accordion, sidebar and client-side Basic search. */
  tree() {
    const cats = [];
    const byName = new Map();
    for (const d of this.docs.values()) {
      const catName = d.meta.category || d.h2;
      let cat = byName.get(catName);
      if (!cat) {
        cat = { name: catName, slug: d.path.split('/')[0], icon: CATEGORY_ICONS[catName] || 'apps', articles: [], subcategories: [] };
        byName.set(catName, cat);
        cats.push(cat);
      }
      const item = {
        path: d.path,
        title: d.meta.title,
        summary: d.meta.summary || '',
        aliases: d.meta.aliases || [],
      };
      if (d.meta.subcategory) {
        let sub = cat.subcategories.find((s) => s.name === d.meta.subcategory);
        if (!sub) { sub = { name: d.meta.subcategory, articles: [] }; cat.subcategories.push(sub); }
        sub.articles.push(item);
      } else {
        cat.articles.push(item);
      }
    }
    return cats;
  }

  /** Ticket categories: every category, plus its subcategories, plus "Something else". */
  ticketCategories() {
    const out = [];
    for (const c of this.tree()) {
      if (c.subcategories.length) for (const s of c.subcategories) out.push(s.name);
      else out.push(c.name);
    }
    out.push('Something else');
    return out;
  }

  /** Render data for the article page. Markdown is rendered (and sanitised) in the browser. */
  articleRenderData(p) {
    const d = this.get(p);
    if (!d) return null;
    // Remove the H1 (the page renders it) and the "## Related articles" section
    // (the page renders `related` from frontmatter as titled links).
    let body = d.body.replace(/^# .*\n+/, '');
    body = body.replace(/\n## Related (articles|pages)[\s\S]*$/, '\n').trim();
    body = this.linkify(body);
    const related = (d.meta.related || []).map(unwikilink).map((rp) => {
      const r = this.get(rp);
      return r ? { path: r.path, title: r.meta.title } : null;
    }).filter(Boolean);
    return {
      path: d.path,
      title: d.meta.title,
      category: d.meta.category,
      category_slug: d.path.split('/')[0],
      subcategory: d.meta.subcategory || null,
      summary: d.meta.summary,
      cta: d.meta.cta && d.meta.cta.label ? { label: d.meta.cta.label, url: d.meta.cta.url } : null,
      related,
      updated: d.meta.updated,
      body_markdown: body,
    };
  }

  /** Turn [[wikilinks]] into Markdown links to /help/<path> with the target's title. */
  linkify(md) {
    return md.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
      const r = this.get(target);
      return r ? `[${r.meta.title}](/help/${r.path})` : unwikilink(target);
    });
  }
}

let cache = null;
/** Load both vaults once (they are small: ~130 KB total). */
export function loadKnowledgeBases(root = path.resolve('kb')) {
  if (!cache) {
    cache = {
      support: new Vault(path.join(root, 'support'), 'support'),
      compplan: new Vault(path.join(root, 'compplan'), 'compplan'),
    };
  }
  return cache;
}
