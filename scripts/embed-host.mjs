// Local stand-in for the WealthQuest main app, to try /embed the way it will be framed.
//   npm run embed:host   → http://localhost:3334 (guest) · http://localhost:3334/?surface=member
// Needs this server running on AI_URL (default http://localhost:3000). The launcher + panel here are the
// reference for the main app's <AiSupportLauncher> (docs/embed-auth-plan.md §5).
import http from 'node:http';

const PORT = Number(process.env.EMBED_HOST_PORT) || 3334;
const AI_URL = new URL(process.env.AI_URL || 'http://localhost:3000').origin;

const page = (surface) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Embed host (${surface})</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1c1c1c; background: #f4f4f4; }
  main { max-width: 760px; margin: 48px auto; padding: 0 16px; }
  nav a { margin-right: 12px; }
  .ai-launcher { position: fixed; right: 24px; bottom: 24px; z-index: 40; width: 58px; height: 58px; border-radius: 50%;
    border: 1px solid #ececec; background: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.14); cursor: pointer; font-size: 22px; }
  .ai-panel { position: fixed; right: 24px; bottom: 96px; z-index: 41; width: 460px; height: min(640px, calc(100vh - 120px));
    border: 0; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.2); background: #fff; }
  .ai-panel[hidden] { display: none; }
  .ai-panel iframe { width: 100%; height: 100%; border: 0; display: block; }
  @media (max-width: 640px) { .ai-panel { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; } }
</style></head>
<body>
<main>
  <h1>Main app stand-in · ${surface}</h1>
  <p>Pretends to be the WealthQuest ${surface === 'member' ? 'dashboard (signed in)' : 'sign-in page (guest)'}. The chat comes from <code>${AI_URL}/embed</code>.</p>
  <nav><a href="/">Guest (sign-in page)</a><a href="/?surface=member">Member (dashboard)</a></nav>
</main>
<button class="ai-launcher" id="ai-launcher" type="button" aria-label="Open support chat" aria-expanded="false" aria-controls="ai-panel">💬</button>
<div class="ai-panel" id="ai-panel" hidden></div>
<script>
  const AI = ${JSON.stringify(AI_URL)};
  const launcher = document.getElementById('ai-launcher');
  const panel = document.getElementById('ai-panel');
  let frame = null;
  function open() {
    if (!frame) { // created on first open, so pages that never use the chat never load it
      frame = document.createElement('iframe');
      frame.title = 'WealthQuest support chat';
      frame.src = AI + '/embed?surface=${surface}';
      panel.append(frame);
    }
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    frame.focus();
  }
  function close() { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); }
  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  window.addEventListener('message', (e) => {
    if (e.origin !== AI || !frame || e.source !== frame.contentWindow) return; // only our iframe
    if (e.data && e.data.type === 'wq-ai:close') close();
  });
</script>
</body></html>`;

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/') { res.writeHead(404).end('Not found'); return; }
  const surface = url.searchParams.get('surface') === 'member' ? 'member' : 'guest';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(surface));
}).listen(PORT, () => console.log(`Embed host on http://localhost:${PORT} (guest) and /?surface=member, framing ${AI_URL}/embed`));
