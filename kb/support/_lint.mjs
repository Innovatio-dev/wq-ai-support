#!/usr/bin/env node
// WealthQuest support KB linter. Node 22+, no dependencies.
// Usage: node _lint.mjs            (run from anywhere; lints the folder this file lives in)
// Checks:
//   1. every article (.md except index/log/README) has the required frontmatter fields
//   2. field shapes: summary <= 25 words, 3-6 aliases, 2-4 related, updated is YYYY-MM-DD
//   3. every article is listed in index.md, and every index entry points to an existing article
//   4. every [[wikilink]] (frontmatter + body) resolves to an existing file
//   5. no orphans: every article is linked from at least one other article
//   6. body starts with an H1 and ends with a "Related articles" section
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SPECIAL = new Set(['index.md', 'log.md', 'README.md']);
const REQUIRED = ['title', 'category', 'subcategory', 'summary', 'aliases', 'related', 'escalate_if', 'updated'];
const LIST_FIELDS = { aliases: [3, 6], related: [2, 4] };
const MAX_SUMMARY_WORDS = 25;
const RELATED_HEADING = /^## Related articles\s*$/m;
const CATEGORIES = new Set(['Payments & billing', 'Manage your account', 'WealthQuest membership', 'In-app features', 'Device & troubleshooting', 'Safety & privacy']);
const SUBCATEGORIES = { 'Manage your account': new Set(['Logging in', 'Profile help', 'Account settings', 'Security']) };

const errors = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const unquote = (s) => {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
};

// Minimal YAML subset: scalars, block lists ("  - x"), one-level maps ("  key: v"), null.
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const data = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      key = top[1];
      const v = top[2].trim();
      data[key] = v === '' ? undefined : v === 'null' || v === '~' ? null : unquote(v);
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(unquote(item[1]));
      continue;
    }
    const sub = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (sub && key) {
      if (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key])) data[key] = {};
      data[key][sub[1]] = unquote(sub[2]);
      continue;
    }
    return { __error: `unparseable frontmatter line: "${line}"` };
  }
  return { data, body: text.slice(m[0].length) };
}

const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const linksIn = (s) => [...s.matchAll(LINK)].map((x) => x[1].trim());

const files = walk(ROOT);
const slugOf = (p) => relative(ROOT, p).split(sep).join('/').replace(/\.md$/, '');
const allSlugs = new Set(files.map(slugOf));
const articles = files.filter((p) => !SPECIAL.has(relative(ROOT, p)));
const articleSlugs = new Set(articles.map(slugOf));
const inbound = new Map([...articleSlugs].map((s) => [s, 0]));

for (const path of articles) {
  const slug = slugOf(path);
  const text = readFileSync(path, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm) { err(slug, 'missing YAML frontmatter'); continue; }
  if (fm.__error) { err(slug, fm.__error); continue; }
  const { data, body } = fm;

  for (const f of REQUIRED) if (!(f in data) || data[f] === undefined) err(slug, `missing required field "${f}"`);
  if (data.summary && data.summary.split(/\s+/).filter(Boolean).length > MAX_SUMMARY_WORDS) err(slug, `summary longer than ${MAX_SUMMARY_WORDS} words`);
  for (const [f, [min, max]] of Object.entries(LIST_FIELDS)) {
    if (f in data && (!Array.isArray(data[f]) || data[f].length < min || data[f].length > max)) err(slug, `"${f}" must be a list of ${min}-${max} items`);
  }
  if ('escalate_if' in data && (!Array.isArray(data.escalate_if) || data.escalate_if.length === 0)) err(slug, '"escalate_if" must be a non-empty list');
  if ('updated' in data && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.updated))) err(slug, '"updated" must be YYYY-MM-DD');
  if ('cta' in data && data.cta !== null && (typeof data.cta !== 'object' || !data.cta.label || !data.cta.url)) err(slug, '"cta" must have label and url');
  if (typeof CATEGORIES !== 'undefined' && data.category && !CATEGORIES.has(data.category)) err(slug, `unknown category "${data.category}"`);
  if (typeof SUBCATEGORIES !== 'undefined' && data.category) {
    const allowed = SUBCATEGORIES[data.category];
    if (allowed && !allowed.has(data.subcategory)) err(slug, `subcategory "${data.subcategory}" not allowed for ${data.category}`);
    if (!allowed && data.subcategory !== null && 'subcategory' in data) err(slug, `category "${data.category}" takes subcategory: null`);
  }
  if (Array.isArray(data.related)) {
    for (const r of data.related) {
      const l = linksIn(r);
      if (l.length !== 1) err(slug, `related entry is not a single [[wikilink]]: ${r}`);
    }
  }

  if (!/^\s*# \S/.test(body)) err(slug, 'body must start with an H1 title');
  if (!RELATED_HEADING.test(body)) err(slug, 'body must contain a "## Related articles" section');

  const links = new Set([...(Array.isArray(data.related) ? data.related.flatMap(linksIn) : []), ...linksIn(body)]);
  for (const l of links) {
    if (!allSlugs.has(l)) err(slug, `broken link [[${l}]]`);
    else if (l !== slug && inbound.has(l)) inbound.set(l, inbound.get(l) + 1);
  }
}

// index.md checks
let indexText = '';
try { indexText = readFileSync(join(ROOT, 'index.md'), 'utf8'); } catch { err('index.md', 'missing'); }
const indexLinks = new Set(linksIn(indexText));
for (const s of articleSlugs) if (!indexLinks.has(s)) err('index.md', `article not listed: [[${s}]]`);
for (const l of indexLinks) if (!allSlugs.has(l)) err('index.md', `broken link [[${l}]]`);

for (const [s, n] of inbound) if (n === 0) err(s, 'orphan: no other article links here');

try {
  const log = readFileSync(join(ROOT, 'log.md'), 'utf8');
  for (const line of log.split('\n')) if (line.startsWith('## ') && !/^## \[\d{4}-\d{2}-\d{2}\] (ingest|update|lint|query|delete) \| .+/.test(line)) err('log.md', `bad entry header: ${line}`);
} catch { err('log.md', 'missing'); }

const idxTokens = Math.round(indexText.length / 4);
if (errors.length) {
  console.error(errors.map((e) => '✗ ' + e).join('\n'));
  console.error(`\nLint FAILED: ${errors.length} problem(s) in ${articles.length} articles.`);
  process.exit(1);
}
console.log(`Lint passed: ${articles.length} articles, ${indexLinks.size} index entries, index.md ≈ ${idxTokens} tokens (chars/4).`);
