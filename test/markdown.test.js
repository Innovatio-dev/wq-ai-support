// The browser Markdown renderer must never let raw HTML or unsafe links through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeUrl } from '../public/js/markdown.js';

test('raw HTML is escaped, not rendered', () => {
  const html = renderMarkdown('Hi <img src=x onerror=alert(1)> <script>alert(1)</script>');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
});

test('only safe link targets become anchors', () => {
  assert.equal(safeUrl('/help/account/logging-in/log-out'), '/help/account/logging-in/log-out');
  assert.equal(safeUrl('https://wealthquest.com/legal'), 'https://wealthquest.com/legal');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('//evil.example/x'), null);
  assert.equal(safeUrl('data:text/html,hi'), null);
  const html = renderMarkdown('[a](/help/x) [b](javascript:alert(1)) [c](https://x.test/"onmouseover="y)');
  assert.match(html, /<a href="\/help\/x">a<\/a>/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.doesNotMatch(html, /"onmouseover="/);
});

test('headings, lists, bold, tables', () => {
  const html = renderMarkdown('### Steps\n1. One **bold**\n2. Two\n\n- a\n- b\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<h3>Steps<\/h3>/);
  assert.match(html, /<ol><li>One <strong>bold<\/strong><\/li><li>Two<\/li><\/ol>/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<table>.*<th>A<\/th>.*<td>2<\/td>/s);
});

test('numbered list separated by blank lines stays one list', () => {
  const html = renderMarkdown('1. a\n\n2. b\n\n3. c');
  assert.equal((html.match(/<ol/g) || []).length, 1);
});
