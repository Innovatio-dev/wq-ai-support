// Visual QA: boots the app in MOCK_OPENAI mode, logs in through the demo gate, exercises every main
// flow and saves screenshots (desktop 1440×900, mobile 390×844) to docs/screenshots/.
// Fails (exit 1) on any browser console error or uncaught page error.
//
//   npm run screenshots                     # spawns its own server on a free port
//   BASE_URL=http://localhost:3000 npm run screenshots   # use a server you already started (MOCK_OPENAI=1)
//
// Chromium: uses PLAYWRIGHT_CHROMIUM (path) if set, else the newest /opt/pw-browsers/chromium-*/chrome-linux/chrome,
// else Playwright's own download.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const PASSWORD = process.env.DEMO_PASSWORD || 'demo';

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(root, d, 'chrome-linux', 'chrome');
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });

let server = null;
let BASE = process.env.BASE_URL;
if (!BASE) {
  const port = await freePort();
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, MOCK_OPENAI: '1', DEMO_PASSWORD: PASSWORD, PORT: String(port), MOCK_WORD_DELAY_MS: '6', OPENROUTER_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { if (String(d).includes('http://localhost')) resolve(); });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
}

const errors = [];
const browser = await chromium.launch({ executablePath: findChromium() });

async function newPage(viewport, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, baseURL: BASE });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${viewport.width}] ${page.url()} console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${viewport.width}] ${page.url()} pageerror: ${e.message}`));
  // Log in through the password page (sets the HttpOnly signed gate cookie).
  await page.goto('/');
  if (page.url().includes('/login')) {
    await page.fill('#pw', PASSWORD);
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  }
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const shot = async (page, name, opts = {}) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700); // let smooth scrolling settle
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  console.log('  ✓', name);
};
const answerDone = (page) => page.waitForFunction(() => {
  const w = document.querySelector('#working');
  return w && w.hidden && !document.querySelector('#md.cursor');
}, null, { timeout: 20000 });
const chatIdle = (page, sel = '#send') => page.waitForFunction((s) => !document.querySelector(s).disabled, sel, { timeout: 20000 });

/** Hold the AI request for a moment so the loading state ("••• Working on your answer") can be captured. */
async function captureLoading(page, url, name) {
  const hold = async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue().catch(() => {}); };
  await page.route('**/api/support/message', hold, { times: 1 });
  await page.goto(url);
  await page.waitForSelector('#working:not([hidden])');
  await shot(page, name);
}

const D = { width: 1440, height: 900 };
const M = { width: 390, height: 844 };

try {
  console.log('Desktop 1440×900');
  let p = await newPage(D);
  await p.goto('/');
  await p.waitForSelector('.acc-item');
  await shot(p, 'desktop-01-home');
  await shot(p, 'desktop-02-home-full', { fullPage: true });
  await p.click('[data-mode=basic]');
  await p.fill('#s', 'password');
  await p.waitForSelector('#results li');
  await shot(p, 'desktop-02b-home-basic-search');
  await p.click('[data-mode=ai]');
  await p.click('.acc-head >> nth=1');
  await shot(p, 'desktop-02c-home-accordion-open');

  // AI answer page: loading state then streamed answer.
  const Q = "I don't know how to change password, I checked everything and can't find the change password";
  await captureLoading(p, `/ai?q=${encodeURIComponent(Q)}`, 'desktop-03a-ai-loading');
  await answerDone(p);
  await shot(p, 'desktop-03-ai-answer');
  await shot(p, 'desktop-03b-ai-answer-full', { fullPage: true });

  // Follow-up → chat carries the conversation.
  await p.fill('#fu', 'And what if the reset email never arrives?');
  await Promise.all([p.waitForURL('**/chat'), p.press('#fu', 'Enter')]);
  await chatIdle(p);
  await shot(p, 'desktop-03c-followup-in-chat');

  // Article page.
  await p.goto('/help/account/logging-in/reset-or-change-password');
  await p.waitForSelector('#sidebar .side-cat');
  await shot(p, 'desktop-05-article-top');
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot(p, 'desktop-06-article-bottom');

  // Chat: answer, ticket draft, submit.
  await p.goto('/chat');
  await p.evaluate(() => sessionStorage.clear());
  await p.goto('/chat');
  await p.fill('#first', 'Reset password');
  await p.press('#first', 'Enter');
  await chatIdle(p);
  await shot(p, 'desktop-07-chat-answer');
  await p.fill('#msg', 'Not sure how to do it, I need to submit a ticket');
  await p.press('#msg', 'Enter');
  await p.waitForSelector('.ticket-form');
  await chatIdle(p);
  await shot(p, 'desktop-09-chat-ticket-form');
  await p.fill('.ticket-form textarea', 'I encountered an issue while trying to access my account. It keeps showing an error message. Can you help me resolve this?');
  await p.click('.ticket-form button[type=submit]');
  await p.waitForFunction(() => /submitted as ticket #\d{7}/.test(document.querySelector('#body').textContent));
  await shot(p, 'desktop-10-chat-ticket-submitted');

  // Ticket page.
  await p.goto('/ticket');
  await p.waitForFunction(() => document.querySelectorAll('#cat option').length > 2);
  await shot(p, 'desktop-12a-ticket-empty');
  await p.selectOption('#cat', 'Payments & billing');
  await p.fill('#desc', 'I was charged twice for my monthly license this month.');
  await shot(p, 'desktop-12b-ticket-filled');
  await p.click('#submit');
  await p.waitForSelector('#success:not([hidden])');
  await shot(p, 'desktop-12c-ticket-success');

  // Back Office + floating Athena (support), then comp mode.
  await p.goto('/backoffice');
  await p.evaluate(() => sessionStorage.clear());
  await p.goto('/backoffice');
  await p.waitForSelector('.card .rank-row');
  await shot(p, 'desktop-11a-backoffice-dashboard');
  await p.click('#launcher');
  await p.fill('#msg', 'Reset password');
  await p.press('#msg', 'Enter');
  await chatIdle(p);
  await shot(p, 'desktop-11-backoffice-floating-chat');
  await p.click('.mode [data-mode=comp]');
  await shot(p, 'desktop-11b-backoffice-comp-empty');
  await p.click('.suggestions button >> nth=0');
  await chatIdle(p);
  await shot(p, 'desktop-11c-backoffice-comp-answer');
  await p.fill('#msg', 'What will my SITB be this week?');
  await p.press('#msg', 'Enter');
  await chatIdle(p);
  await shot(p, 'desktop-11d-backoffice-comp-sitb');
  await p.context().close();

  console.log('Mobile 390×844');
  p = await newPage(M, { mobile: true });
  await p.goto('/');
  await p.waitForSelector('.acc-item');
  await shot(p, 'mobile-01-home');
  await captureLoading(p, `/ai?q=${encodeURIComponent(Q)}`, 'mobile-03a-ai-loading');
  await answerDone(p);
  await shot(p, 'mobile-04-ai-answer');
  await p.goto('/help/account/logging-in/reset-or-change-password');
  await p.waitForSelector('#sidebar .side-cat');
  await shot(p, 'mobile-05-article');
  await p.goto('/chat');
  await p.evaluate(() => sessionStorage.clear());
  await p.goto('/chat');
  await p.fill('#first', 'Reset password');
  await p.press('#first', 'Enter');
  await chatIdle(p);
  await shot(p, 'mobile-07-chat');
  await p.goto('/ticket');
  await shot(p, 'mobile-12-ticket');
  await p.goto('/backoffice');
  await p.waitForSelector('.card .rank-row');
  await shot(p, 'mobile-11a-backoffice');
  await p.click('#launcher');
  await p.click('.mode [data-mode=comp]');
  await p.click('.suggestions button >> nth=1');
  await chatIdle(p);
  await shot(p, 'mobile-11-backoffice-comp');
  // No horizontal scroll at phone width on any page.
  for (const u of ['/', '/ai?q=hello', '/chat', '/help/account/logging-in/reset-or-change-password', '/ticket', '/backoffice']) {
    await p.goto(u);
    await p.waitForTimeout(150);
    // Compare with the device width, not innerWidth: on mobile an overflowing page widens the layout viewport.
    const over = await p.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - 390);
    if (over > 0) errors.push(`horizontal overflow ${over}px on ${u} at 390px`);
  }
  await p.context().close();
} catch (err) {
  errors.push(`script: ${err.stack || err.message}`);
} finally {
  await browser.close();
  server?.kill();
}

if (errors.length) {
  console.error(`\n${errors.length} problem(s):\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`\nAll flows passed, no console errors. Screenshots in ${path.relative(process.cwd(), OUT)}/`);
