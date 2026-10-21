// Knowledge base: frontmatter parsing, tree, and the path allow-list that stops the model reading arbitrary files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledgeBases, parseFrontmatter, normalizePath, ctaHref } from '../src/kb.js';

const kb = loadKnowledgeBases();

test('both vaults load every index entry', () => {
  assert.equal(kb.support.paths.length, 39);
  assert.equal(kb.compplan.paths.length, 21);
});

test('allow-list keeps only index paths; traversal, absolute and unknown paths are dropped', () => {
  const out = kb.support.resolvePaths([
    '[[account/logging-in/cant-log-in]]',
    '/help/membership/kyc-verification.md',
    '../../../etc/passwd',
    '/etc/passwd',
    'account/../../server',
    'README',
    'index',
    'log',
    'account/logging-in/does-not-exist',
    42,
    'x'.repeat(500),
  ]);
  assert.deepEqual(out, ['account/logging-in/cant-log-in', 'membership/kyc-verification']);
});

test('allow-list caps and de-duplicates', () => {
  const p = 'account/logging-in/log-out';
  assert.deepEqual(kb.support.resolvePaths([p, `[[${p}]]`, `${p}.md`]), [p]);
  const many = kb.support.paths.slice(0, 10);
  assert.equal(kb.support.resolvePaths(many, 3).length, 3);
  assert.deepEqual(kb.compplan.resolvePaths(['sitb', 'SITB', '../kb-support/index']), ['sitb']);
});

test('normalizePath strips wikilink brackets, /help/ prefix, .md and case', () => {
  assert.equal(normalizePath('[[Account/Logging-In/Log-Out.md]]'), 'account/logging-in/log-out');
  assert.equal(normalizePath('/help/account/logging-in/log-out/'), 'account/logging-in/log-out');
});

test('frontmatter parser handles scalars, lists, one-level maps and null', () => {
  const { meta, body } = parseFrontmatter('---\ntitle: "A \\"quoted\\" title"\nsubcategory: null\naliases:\n  - "one"\n  - two\ncta:\n  label: "Go"\n  url: "/x"\nupdated: 2026-09-15\n---\n\n# Body\n');
  assert.equal(meta.title, 'A "quoted" title');
  assert.equal(meta.subcategory, null);
  assert.deepEqual(meta.aliases, ['one', 'two']);
  assert.deepEqual(meta.cta, { label: 'Go', url: '/x' });
  assert.equal(meta.updated, '2026-09-15');
  assert.equal(body, '# Body\n');
});

test('article sent to the model keeps only title, escalate_if and cta from the frontmatter', () => {
  const t = kb.support.articleForModel('account/logging-in/reset-or-change-password');
  assert.match(t, /^title: How to reset or change your WealthQuest password/);
  assert.match(t, /escalate_if:/);
  assert.match(t, /cta: Change your password/);
  assert.doesNotMatch(t, /aliases|summary:|updated:/);
});

test('tree and ticket categories mirror the help center', () => {
  const tree = kb.support.tree();
  assert.deepEqual(tree.map((c) => c.name), ['Payments & billing', 'Manage your account', 'WealthQuest membership', 'In-app features', 'Device & troubleshooting', 'Safety & privacy']);
  assert.deepEqual(tree[1].subcategories.map((s) => s.name), ['Logging in', 'Profile help', 'Account settings', 'Security']);
  const cats = kb.support.ticketCategories();
  assert.ok(cats.includes('Logging in') && cats.at(-1) === 'Something else');
});

test('article render data: H1 and Related section removed, wikilinks become /help links', () => {
  const a = kb.support.articleRenderData('account/logging-in/reset-or-change-password');
  assert.doesNotMatch(a.body_markdown, /^# /m);
  assert.doesNotMatch(a.body_markdown, /## Related articles/);
  assert.equal(a.related.length, 4);
  assert.equal(a.cta.label, 'Change your password');
  const g = kb.support.articleRenderData('membership/compensation-plan-guide');
  assert.doesNotMatch(g.body_markdown, /\[\[/);
});

test('CTA paths point at the main app; full https links are kept', () => {
  assert.equal(ctaHref('/settings?tab=security', 'https://app.wealthquest.com'), 'https://app.wealthquest.com/settings?tab=security');
  assert.equal(ctaHref('https://www.wealthquest.com/legal/income-disclosure', 'https://app.wealthquest.com'), 'https://www.wealthquest.com/legal/income-disclosure');
  assert.equal(ctaHref('/settings?tab=security', ''), '/settings?tab=security');
});

test('no article CTA points at the demo Back Office (it 404s in production)', () => {
  for (const p of kb.support.paths) {
    const url = kb.support.get(p).meta.cta?.url;
    if (url) assert.match(url, /^(\/(?!backoffice)|https:\/\/)/, `${p}: ${url}`);
  }
});
