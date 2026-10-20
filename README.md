# WealthQuest Support Agent + Compensation Plan Agent — prototype

A working prototype of the WealthQuest help center (built to match the client's Figma frames) with two real AI agents running OpenAI's GPT-5.6 models through [OpenRouter](https://openrouter.ai). Every model call's cost is tracked against a daily budget.

- **Athena, Support Agent**: answers from the support knowledge base (39 Markdown articles), streams the answer, and when a person is needed it drafts a support ticket for the user to review and submit.
- **Athena, Compensation Agent** (Back Office only): explains the Compensation Plan (21 plan pages) using the signed-in member's own numbers. It gets those numbers from a mock WealthQuest API and a deterministic plan calculator, and it follows the compliance rules for a direct-selling business.

The code is meant to be read as a reference implementation for the production AdonisJS build. The backend is split into services with the same responsibilities they would have in Adonis (see [Mapping to AdonisJS](#mapping-to-adonisjs)).

| Route | What it is | Figma |
|---|---|---|
| `/` | Support home: "Help with AI ✦" / "Basic search" toggle, browse accordion, "We're here to help" | 01, 02 |
| `/ai?q=…` | Search with AI: loading state, streamed answer, then a follow-up box that opens the chat | 03, 04 |
| `/chat` | Athena chat with the in-chat ticket form and the "submitted" state | 07–10 |
| `/help/<path>` | Help article: breadcrumb, body, CTA, related articles, category sidebar | 05, 06 |
| `/ticket` | Open-a-ticket form with client-side attachment checks | (no frame; same design language) |
| `/backoffice` | Simulated logged-in Back Office for Maria Kovač: dashboard and floating Athena panel with Support and My earnings modes | 11 |
| `/embed?surface=guest\|member` | The chat panel the WealthQuest main app frames; only `ALLOWED_PARENT_ORIGINS` may frame it ([docs/embed-auth-plan.md](docs/embed-auth-plan.md)) | – |
| `/healthz` | Health check for Railway | – |

## Run locally

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env            # optional: edit it

# 1) No key needed: fake, deterministic streamed answers with realistic fake usage numbers
npm run mock                                    # → http://localhost:3000  (password: demo)

# 2) Real models through OpenRouter
OPENROUTER_API_KEY=sk-or-... DEMO_PASSWORD=demo npm start

npm test               # unit tests (node:test): plan calculator, KB allow-list, cost, security, markdown, mock API
npm run screenshots    # Playwright: boots a mock server, runs every flow, saves docs/screenshots/*.png
npm run embed:host     # a stand-in for the main app on :3334 that frames /embed (guest; ?surface=member)
```

`npm run screenshots` fails if the browser logs any console error, and if any page scrolls sideways at 390 px width. It uses the Chromium at `/opt/pw-browsers` when present. Otherwise set `PLAYWRIGHT_CHROMIUM=/path/to/chrome` or run `npx playwright install chromium`.

With no key and `MOCK_OPENAI` not set, the pages still load. The AI endpoints then return `Server has no OpenRouter API key configured`, and the UI shows that message inline.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | – | Server-side only. |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` | – | Optional `HTTP-Referer` / `X-Title` headers for app attribution in the OpenRouter dashboard. |
| `OPENROUTER_DATA_COLLECTION` | `deny` | Sent as `provider.data_collection`: only providers that don't keep or train on the data. |
| `OPENROUTER_ZDR` | `0` | `1` sends `provider.zdr: true` (zero-data-retention endpoints only). Check that OpenAI's endpoints on OpenRouter are ZDR first, or every request fails with "no endpoints". |
| `MOCK_OPENAI` | `0` | `1` turns on the fake client (chosen before any provider): canned streamed answers (about 25 ms per word), real calculator outputs and fake usage numbers. |
| `DEMO_PASSWORD` | – | Puts the whole demo behind a password page, which sets a signed HttpOnly cookie. Empty means no gate. |
| `SESSION_SECRET` | random per boot | Signs the cookies. Set it in production, or every deploy logs everyone out. |
| `DAILY_BUDGET_USD` | `5` | Global daily limit on AI spend, computed from real usage. Once it is reached, requests get a friendly refusal. |
| `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` | – | Optional Cloudflare Turnstile. When set, the first message of each conversation must carry a token, which the server checks with `siteverify`. |
| `ALLOWED_PARENT_ORIGINS` | dev: `http://localhost:3333,http://localhost:3334`; production: none | Comma-separated main-app origins allowed to frame `/embed`. Every other page refuses framing. |
| `PORT` | `3000` | |

## Architecture

```
Browser (vanilla JS, no build)                         Express 5 server (server.js)
────────────────────────────────                      ─────────────────────────────────────────────────────────
index / ai / chat / article /     ── fetch + SSE ──►  security.js  demo gate · session cookie · same-origin ·
ticket / backoffice pages                              rate limits (IP + session) · budget guard · validation
  common.js  ChatView, SSE client,                         │
             ticket form                                   ├─ POST /api/support/message ─► agents/support.js
  markdown.js  safe renderer                               │        router (luna, JSON schema) ─► kb.js allow-list
                                                           │        answerer (stream, create_support_ticket tool)
                                                           ├─ POST /api/comp/message ────► agents/comp.js
                                                           │        router (luna) ─► plan pages + parallel prefetch
                                                           │        agent (stream, ≤4 tool loops) ─► tools/comp-tools.js
                                                           │                                         ├─ calc/plan.js (deterministic)
                                                           │                                         └─ mock/wq-api.js (in-process)
                                                           ├─ POST /api/tickets ─► tickets.js (memory + data/tickets.jsonl)
                                                           ├─ GET  /api/kb/tree · /api/kb/article · /api/config
                                                           └─ /mock/api/v1/* ─► mock/wq-api.js  (403 for anyone else's id)
                                  openai.js: official SDK (openai@7.20.0) → OpenRouter, or the MOCK client · cost.js + pricing.json
prompts/*.md  (static instructions, kept byte-identical so prompt caching applies)
kb/support, kb/compplan  (Obsidian vaults, copied in; index.md is each router's "table of contents")
```

## Support agent flow

`POST /api/support/message {conversation_id?, text, surface}` returns an SSE stream with these events: `status`, `delta`, `ticket_draft`, `usage`, `done`, `error`.

1. **Guards.** Message length (1–2,000 characters), rate limits, daily budget, and a Turnstile check on the first message. Conversation history is kept on the server, keyed by a conversation id that is bound to the session cookie. It is capped at 40 messages.
2. **Router.** `gpt-5.6-luna`, effort `none`, verbosity low, `max_output_tokens: 300`, structured output (`json_schema`, strict) returning `{intent, paths[], search_terms, reply_language, flagged}`. Its `instructions` are `prompts/support-router.md` plus the full `kb/support/index.md`. That static prefix of about 3.5k tokens is cached automatically. The input is only the last 4 turns (400 characters each) plus the new message. `flagged` is the moderation check (OpenRouter has no moderation endpoint). If it is set, the user gets a polite refusal and the answer model is never called.
3. **Allow-list.** The server keeps only paths that appear in `index.md` (at most 3) and loads those articles. Frontmatter is stripped except `title`, `cta` and `escalate_if`. A made-up or injected path is simply dropped.
4. **Answerer.** Model and effort come from the selected combination (default `gpt-5.6-terra`, effort low). `max_output_tokens: 900`, streaming, `store: false`, `safety_identifier = sha256(session)`. The input is a developer message with `<article path="…">` blocks, the last 8 turns and the question. It has one strict tool, `create_support_ticket {category (enum built from the KB + "Something else"), subcategory|null, summary ≤80, description ≤600, first person}`.
5. **Ticket draft, never an automatic ticket.** When the model calls the tool, the server validates the arguments and sends a `ticket_draft` event. The UI shows "We will get this sorted…" with the pre-filled form. A ticket exists only after the user presses **Submit** (`POST /api/tickets`), which returns a 7-digit number.
6. **Cost.** One `usage` event per model call (router and answer): model, effort, latency, token breakdown, and USD/EUR.

The Support prompt rules: answer only from the provided articles; link to `/help/<path>`; call the tool when an article's `escalate_if` applies, the articles don't cover the question, or the user asks for a person; never invent policy; keep answers short; reply in the user's language.

## Compensation agent flow

`POST /api/comp/message` is only available with the Back Office session cookie, which is set when `/backoffice` is visited. In production this is the real authenticated session. The signed-in member is fixed on the server (Maria Kovač, `WQ-100482`). **No tool takes a distributor id**, so the model cannot ask for someone else's data.

1. **Router** (luna, effort none, JSON schema) returns `{plan_pages[] (≤4), data_needed[], intent, flagged}`. Its instructions are `prompts/comp-router.md` plus `kb/compplan/index.md`.
2. **Prefetch.** The server loads the plan pages (allow-listed) and fetches the requested data sets **in parallel** from the mock API. This saves tool round trips, so answers are faster and cheaper.
3. **Agent.** Default `gpt-5.6-sol`, effort low, streaming, `store: false` + `include: ["reasoning.encrypted_content"]`. Output items are replayed for the stateless tool loop, which runs at most 4 times. The input holds `<plan_page>` blocks and `<user_data source="GET /api/v1/…">` JSON blocks. The tools are all read-only and all act on the session's member:
   `get_my_profile`, `get_my_performance(period)`, `get_my_rank_status`, `get_my_commissions(from,to,type)`, `get_my_network_directs(mode)`, `calculate_rank_gap(target_rank)` (exact missing weak-leg BV, sponsored actives per leg, ranked directs and leadership lines, plus the §6.4 no-skipping check) and `project_sitb(days, rank|null)` (§9.3 arithmetic, 90/10 split, with the mandatory "illustration, not a projection (§21)" note). With the *Sol only* combination there is no router, and a `read_plan_pages` tool is added instead. The UI shows a status line such as "Checking your rank status…" while a tool runs.
4. **Compliance rules in `prompts/comp-agent.md`:** never promise or predict income; frame any forward-looking figure as "if you held Rank X on every day…"; cite sections (e.g. §9.3); compensation comes from retail sales (§1.2), so never recommend recruiting; no tax or legal advice; say what data is missing rather than guess; use the calculators for every amount.

The calculator (`src/calc/plan.js`) holds the rank ladder (§6.2), the SITB table (§9.3), Generational Match percentages and unlock requirements (§10.7–10.8), the Direct Bonus (§8.1) and the 90/10 split (§15). Unit tests cover Maria's R4→R5 gap (10,520 BV, 1 sponsored active, 1 more at Rank 2+), the §9.5 worked example ($2,560) and the Generational Match table.

## Mock API + proposed endpoints

`src/mock/wq-api.js` is mounted at `/mock/api/v1`. The agent's tools call the same handler in-process, so the same authorisation applies to both. Responses follow `WEALTHQUEST_BACKEND_DATA_REQUIREMENTS.md`: every analytics response has `generated_at`, `period{from,to,timezone}`, `comparison_period`, `currency: "USD"` and `amount_scale`, and metrics use the envelope `{value, unit, previous_value, delta_value, delta_pct}`.

Implemented: `GET /me`, `/distributors/:id/performance`, `/distributors/:id/products`, `/network/:id?mode=sponsor|placement&depth=1` and `/leaderboard`.

**Proposed additions for the AI agent** (not in the requirements doc):
- `GET /distributors/:id/rank-status`: the last 14 daily rank snapshots `{date, rank_code, rank_name, daily_accrual_usd, weak_leg_bv, strong_leg_bv}`, `weekly_rank`, `weak_leg {side, bv_31d}`, `strong_leg`, `personally_sponsored_active {left, right, total, by_rank}`, `leadership_lines`, `qualified`, `good_standing`, `license_current`, `as_of`, plus recent leg events (volume that expired on day 32, new volume).
- `GET /distributors/:id/commissions?from&to&type`: ledger entries with `commission_type`, `amount_usd`, `cash_usd` (90%), `gold_points` (10%), `status accrued|approved|paid`, `period`, `source`, and wallet balances.

**Access rule shown in the mock:** any `:id` other than the caller's own returns **403**. The browser can call the mock API with the Back Office cookie; server code uses an internal bearer token plus `X-Distributor-Id`.

**Maria's data is coherent on purpose:** R4 Bronze Manager; weak leg left 13,480 BV and strong leg right 21,950 BV; 9 personally sponsored actives (4 left, 5 right), 2 of them at R2 or above. Three days ago a 1,900 BV order left the 31-day window, so the weak leg dropped to 11,580 BV. That day was her only R3 day ($70 SITB instead of $140). This week's SITB so far matches §9.3. Direct Bonus entries are 10% of BV, there is one $500 Fast 5 award, and there are wallet and Gold Points balances.

> ⚠ **Open business question (doc rule #1):** the requirements doc treats "volume" as money, but the Compensation Plan ranks on **BV**. The mock returns money volume *and* BV (`left_team_bv`, the rank-status endpoint) and uses a placeholder rate of $1.25 per BV. This must be decided before the real backend is built.

## Cost model

- Prices: `src/pricing.json` (USD per 1M tokens, checked 2026-09-20). EUR uses the ECB rate of 2026-09-18 (0.8726).
- The cost is `usage.cost`, which is what OpenRouter actually billed, so the daily budget tracks real spend. When it is missing (e.g. mock mode) it is computed from `pricing.json`.
- `src/cost.js`: `fresh = input − cached − cache_write`; cost = fresh × input price + cached × cached price + cache_write × write price + output × output price. Reasoning tokens are already part of `output_tokens`.
- Each model call adds its cost to the server's daily budget counter and sends a `usage` SSE event (step, model, effort, latency, token breakdown, USD and EUR). The pages ignore it; it is there for API clients and debugging.
- **Model combinations** are defined in `src/config.js`. Every request uses the default unless it passes a known `combo` key; unknown keys fall back to the default:
  - Support: *Luna → Terra* (default), *Luna → Luna (deep)*, *Luna → Luna (fast)*
  - Compensation: *Luna → Sol* (default), *Luna → Terra*, *Sol only*
- Prompt caching: the static instructions (the prompts plus each KB `index.md`) come first and never change byte-for-byte, so repeat calls pay the cached price for that prefix.

## How the key is protected

- `OPENROUTER_API_KEY` exists only on the server. The browser talks only to our own endpoints and never sees the key or a model name it could change. Set a credit limit on the OpenRouter key as a second kill switch next to `DAILY_BUDGET_USD`.
- On OpenRouter every request carries `provider.data_collection: "deny"` (and optionally `zdr: true`), so only providers that don't keep or train on the data are used.
- **Same-origin check** on every POST: the `Origin`, or failing that the `Referer`, must match `Host`. Cookies are `SameSite=Lax`, HttpOnly and signed.
- **Rate limits** (`express-rate-limit`) per IP **and** per session on the AI endpoints: 20 per minute and 150 per day. Tickets have separate limits.
- **Caps:** 2,000 characters of input, `max_output_tokens` on every call (300, 900 and 1,400), at most 4 tool iterations, at most 40 messages per conversation, and `DAILY_BUDGET_USD` as a global kill switch.
- **Model choice** is picked from an allow-list only. Unknown combination keys fall back to the default.
- **Knowledge-base reads** are allow-listed paths only, so a prompt-injected path cannot read files.
- **Comp data:** the agent's endpoint requires the Back Office session, tools have no id parameter, and the mock API returns 403 for anyone else's id.
- **Optional Cloudflare Turnstile** (`TURNSTILE_SECRET`), with the server calling `siteverify`.
- `safety_identifier = sha256(session id)` on every model call (OpenRouter hashes it again before forwarding); `store: false`; no personal data is sent beyond the question itself (and, in the Back Office, the member's own figures).
- Moderation runs before the answer model through the routers' `flagged` field. The *Sol only* combination has no router, so it relies on the agent prompt's own refusal rules.
- **Security headers** are written by hand: CSP (self plus jsDelivr; Turnstile only when enabled; `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, and HSTS in production.
- Model output is rendered by a small **safe Markdown renderer**: all text is escaped first, and links may only point to relative paths, `https:` or `mailto:`. It has its own unit tests.
- Ticket attachments are checked in the browser only (jpg, png or pdf; up to 3 files of 10 MB each). Only their metadata reaches the server, and it never goes to the model provider.

## Mapping to AdonisJS

| This repo | AdonisJS 6 |
|---|---|
| `server.js` routes | `start/routes.ts`; one controller per endpoint group: `SupportMessagesController`, `CompMessagesController`, `TicketsController`, `KnowledgeBaseController` |
| `src/security.js` | middleware: `demo_gate`, `same_origin`, `backoffice_auth` (→ real `auth` guard); `@adonisjs/limiter` for the rate limits; `@adonisjs/shield` for CSP and headers; VineJS validators for input |
| `src/config.js` | `config/ai.ts` + `start/env.ts` (validated env) |
| `src/openai.js` | `app/services/openai_service.ts` (singleton in the IoC container; bind the mock client in tests) |
| `src/agents/support.js`, `src/agents/comp.js` | `app/services/support_agent_service.ts`, `comp_agent_service.ts` |
| `src/tools/comp-tools.js` | `app/services/comp_tools.ts`, calling the real WealthQuest API client with the user's token |
| `src/calc/plan.js` | `app/services/comp_plan_calculator.ts`, **shared with the commission engine** |
| `src/kb.js` | `app/services/knowledge_base_service.ts`, loaded at boot (or from DB/S3) |
| `src/conversations.js`, `src/tickets.js` | Lucid models `Conversation`, `Message`, `Ticket` (or Redis for conversations); tickets go to the helpdesk API |
| budget guard | `app/services/budget_service.ts` backed by Redis or DB (the in-memory counter here resets on restart) |
| SSE (`src/sse.js`) | `response.response.write(...)` in the controller, or `@adonisjs/transmit` |
| `prompts/*.md` | keep as files (`resources/prompts`) so they can be reviewed in PRs |

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway: **New Project → Deploy from GitHub** → pick the repo. Railway detects Node automatically (Nixpacks/Railpack), runs `npm install`, and starts with `npm start`. `railway.json` sets the start command and the `/healthz` health check.
3. Under **Variables**, set `OPENROUTER_API_KEY`, `DEMO_PASSWORD`, `SESSION_SECRET` (a long random string), `DAILY_BUDGET_USD`, and optionally `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY`. Railway provides `PORT`.
4. Open the generated domain and log in with the demo password.

## Design notes (Figma fidelity)

- Positions, sizes and colours were measured from the frame PNGs: text ink widths, cap heights, row pitch and pixel colours. The finished pages were then compared with Playwright screenshots. On the home page every element is within about 2 px of frame 01.
- **Fonts** are self-hosted from the `@fontsource` packages (SIL OFL) instead of Google Fonts. That keeps the CSP tight and avoids a runtime dependency; Google Fonts was also unreachable from the build environment. Measurements showed two heading styles in the frames:
  - page titles ("WealthQuest Support", "Search with AI", "Hi there…"): **Manrope 500 at 34.5 px**;
  - section headings, the article H1 and button labels: a wider face whose widths and cap heights match **Montserrat** (H2 24/600, buttons 14/500, article H1 33/600);
  - body text: **Urbanist 14 px**;
  - the wordmark: closest to **Libre Caslon Text** (Cormorant Garamond is the fallback).
- Content comes from the knowledge base, not the Figma placeholder copy. For example, the Figma answer mentions "Spotify", and the sidebar article titles differ slightly.

## Known limitations

- Conversations, tickets, the rate-limit counters and the daily budget are held in memory. They reset on restart, and multiple instances need Redis or a database.
- The Back Office login is simulated: visiting `/backoffice` signs in Maria.
- Mock-mode answers are canned. They show the flow and the costs, not answer quality.
- The pages outside the Figma frames (ticket page, dashboard content) follow the same visual language but were not specified by the client.
- Attachments are not uploaded (validation only).
