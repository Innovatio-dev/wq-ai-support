# Embedding the AI support agent in WealthQuest: plan

Status: **plan only, nothing built.** Written 2026-10-20 after the decision with the team lead. Covers this batch: the embedded chat (support only), the public help subdomain, and identity for logged-in vs. guest users. "My earnings" (member data) is a later batch; §9 lists what it will need.

## 1. What was decided

| Surface | Where | Who | What it shows |
|---|---|---|---|
| **Chat widget** (round button, bottom-right → panel) | Main app (`app.wealthquest.com`), member pages | Logged-in members | Header + **Support / My earnings** toggle; *My earnings* is disabled and labelled **"Coming soon"** |
| **Chat widget** | Main app sign-in page (`/login`, `/login/sign-in`) | Guests | Support only, **no toggle** |
| **Help home page** (current `/` of this repo) | Its own subdomain (name chosen by DevOps; `support.wealthquest.com` below is only a placeholder) | Anyone | Unchanged design; **no password gate** |

**Domains are configuration, not code.** Every origin in this plan (the AI subdomain, the main app, staging, localhost) comes from environment variables, so DevOps can pick the names and nothing has to change in either codebase.

## 2. What the main app already gives us (checked in `wealth-quest` at `origin/main`, 2026-10-20)

- **Session auth**: `@adonisjs/auth` session guard, `adonis-session` cookie, `SameSite=Lax`, 2 h idle (`config/auth.ts`, `config/session.ts`).
- **Signed tokens**: it is already an identity provider for WealthVentures: Ed25519 keys (`#services/sso/keys`, `SSO_SIGNING_KEY`), `jose`, a published JWKS at `/.well-known/jwks.json`, pairwise subjects (`#services/sso/subject`). **We reuse this instead of inventing a shared secret.**
- **Tickets**: a full system: `SupportTicket` + attachments on S3, `ddmmyy-N` references, confirmation mail to the member + inbox mail to support, cooldown + throttle (`#controllers/support_tickets_controller`). The six `TICKET_CATEGORIES` are **exactly** our support KB's top-level categories.
- **Feature flags**: `#services/flags`, shared to every page by `inertia_middleware`; seeded by `feature_flag_seeder`.
- **CSP** (`config/shield.ts`) is **report-only**, `frameSrc` is an allow-list; `X-Frame-Options: DENY` protects the main app itself (irrelevant here: we frame *into* it, not the other way).
- **Domains**: `app.wealthquest.com`, `app-staging.wealthquest.com`.
- Mobile has a fixed bottom bar (`app_layout.tsx`, `z-30`, `md:hidden`): the launcher must sit above it.

## 3. Architecture

```
Browser on app.wealthquest.com                                   support.wealthquest.com (this repo)
┌──────────────────────────────────────────┐                     ┌──────────────────────────────────┐
│ Main-app page                             │                     │ /embed  (chat panel, in iframe)  │
│  <AiSupportLauncher mode="member|guest"> │  iframe src ──────► │  header · toggle · chat · ticket │
│   round button + panel container          │                     │                                  │
│   postMessage  ◄──── ready / token-request│ ◄────────────────── │  asks parent for a token         │
│   GET /ai/session-token (session cookie)  │                     │                                  │
│   postMessage  ────► token ──────────────►│ ──────────────────► │  Authorization: Bearer <token>   │
└──────────────────────────────────────────┘                     │  server verifies via JWKS        │
                                                                  └───────────────┬──────────────────┘
app.wealthquest.com backend ◄───── POST /internal/ai/tickets (service secret + member token) ─┘
```

- **Iframe, not a script from our domain.** The launcher is a small React component in the main app's own bundle, so its `scriptSrc 'self'` CSP stays as is; only `frameSrc` gains the AI origin. Everything inside the panel (header, toggle, chat, ticket form) is served by this repo, so chat changes don't need a main-app deploy.
- **Same site.** Both apps are on `*.wealthquest.com`, so the iframe's own cookies are first-party (same-site) and not hit by third-party-cookie blocking. Identity still travels as a **token**, never as the main app's cookie.

## 4. Identity

### 4.1 Guests (sign-in page)
- No token. The panel shows Support only, no toggle.
- The AI service keeps its anonymous session cookie (`wq_sid`) for rate limits and conversation ownership, as today.
- Ticket form asks for an **email** (required, like the main app's own open-ticket form).

### 4.2 Members (dashboard and every member page)
1. The member opens the widget; the iframe loads `https://support.wealthquest.com/embed?surface=member` (**no token in the URL**).
2. The iframe posts `wq-ai:ready` (informational) and then `wq-ai:token-request` to `window.parent`. The launcher accepts messages only from the AI origin *and* its own iframe's window, and fetches a token **only on `wq-ai:token-request`**.
3. The launcher calls **`GET /ai/session-token`** on the main app (behind `auth()`, same-origin, session cookie, throttled).
4. The main app returns a JWT signed with the existing SSO key:
   - header `alg: EdDSA`, `kid`, `typ: wq-ai+jwt`
   - `iss` = **`ssoConfig.issuer`** (`SSO_ISSUER`, else `APP_URL`, trailing `/` removed; the AI side's `WQ_ISSUER` must equal it), `aud` = `wq-ai-support`, `iat`, `exp` = **+10 min**, `jti`
   - `sub` = `pairwiseSubject(user.id, 'wq-ai-support')` (the AI service never sees internal ids)
   - `name` (public display name), `email`, `uid_enc` = the user id encrypted with the main app's `encryption` service (only the main app can read it; used when the AI service calls back, §6)
5. The launcher posts `{type: 'wq-ai:token', token}` to the iframe with `targetOrigin` = the exact AI origin.
6. The iframe sends `Authorization: Bearer <token>` on every API call. The AI server verifies the signature against the cached JWKS, and checks `iss`, `aud`, `typ`, `exp`.
7. **Refresh, on demand only**: before a request, if the token has less than a minute left (or the server answers `401 token_expired`, retried once), the iframe posts `wq-ai:token-request`; the launcher repeats step 3. **Never on a timer**: each token fetch carries the main-app session cookie and would reset its 2 h idle timeout, so an open, idle panel would keep the member signed in forever. Idle panel = no requests.
8. **Main-app session gone** (idle 2 h, logged out elsewhere): step 3 returns 401 → the launcher posts `wq-ai:signed-out` → the panel shows "Your session ended, please sign in again" and stops sending.

### 4.3 Already-logged-in production users
- **Nothing changes for existing sessions.** The token endpoint reads the session the member already has: no re-login, no migration of sessions, no new cookie on the main app.
- The widget sits behind a **feature flag** (`ai_support_widget`, seeded **off**). Flags are shared on every Inertia render, so turning it on shows the button on the member's next navigation, and turning it off hides it the same way. It is the kill switch.
- The token is short-lived and holds no permission beyond "talk to the support agent as this member". A leaked token is useless after 10 minutes and can't act in the main app.
- Restricted / held / closed accounts: the token endpoint follows the same `auth()` gate as other member pages. Should they still see the widget? Default: yes (support is how they get unstuck).

### 4.4 Switching users on a shared computer
The chat transcript is kept in the iframe's `sessionStorage`. Key it by identity (`guest` or `sub`) and clear it whenever the identity changes (guest → member after login, member → guest after logout, member A → member B). On `wq-ai:signed-out` the conversation is wiped **from the screen too**, not only from storage. The server binds each conversation to its owner (`sid` for guests, `sub` for members), and a request carrying a different identity starts a new conversation.

### 4.5 Message contract (built: `public/js/embed.js`; reference parent: `scripts/embed-host.mjs`)
All messages are `{ type, ... }` objects, posted with an exact `targetOrigin`, never `'*'`.

| Direction | `type` | Payload | Parent does |
|---|---|---|---|
| iframe → parent | `wq-ai:ready` | `surface` | nothing required |
| iframe → parent | `wq-ai:token-request` | – | `GET /ai/session-token`; 200 → `wq-ai:token`, 401 → `wq-ai:signed-out`, other → nothing (the panel times out after 10 s and offers "Try again") |
| iframe → parent | `wq-ai:close` | – | hide the panel, return focus to the launcher |
| parent → iframe | `wq-ai:token` | `token` | – |
| parent → iframe | `wq-ai:signed-out` | – | also send it on logout if the page stays open |

## 5. The widget UI

- **Launcher** (main app): round button, bottom-right, above the mobile bottom bar; opens a panel about 420×640 on desktop and full-screen on mobile; Esc closes; focus moves into the panel and back to the button; remembers open/closed only for the tab.
- **Panel** (this repo, `/embed`): reuse the Back Office panel (`public/backoffice.html` + `backoffice.js`) without the demo dashboard around it.
  - `surface=member`: toggle shown; *My earnings* rendered disabled with a **"Coming soon"** pill, not clickable, `aria-disabled`.
  - `surface=guest`: no toggle.
  - The close (×) button posts `wq-ai:close` to the parent.
- **Help home page** stays as is on the subdomain. Article links in chat answers keep pointing at the subdomain (`/help/<path>`), opened in a new tab from inside the iframe.

## 6. Tickets: into the main app's existing system

Instead of `data/tickets.jsonl`, the AI service forwards tickets to the main app, so they land in `support_tickets` with the same references, emails and attachments as tickets from `/login/open-ticket`.

- **New main-app endpoint** `POST /internal/ai/tickets` (CSRF-excepted like `/oauth/token`), authenticated by a shared **service secret** (HMAC over the body + timestamp, so a replayed or edited request fails).
- **Members**: the AI service forwards the member's current token as well. The main app verifies it (its own key), decrypts `uid_enc` → `userId`, and takes the **email from the user record**, not from the form.
- **Guests**: the email comes from the form.
- Category: the AI's subcategory (e.g. "Logging in") maps to its top-level category (e.g. "Manage your account"), which is always one of `TICKET_CATEGORIES`. The AI's "Something else" is sent as **"Manage your account"** (decided 2026-10-20), so the main app's list stays as it is.
- The main app returns the `reference`, and the chat shows that number.
- Rate limits: the main app's cooldown is keyed by IP + email. The AI service passes the member's IP and email so the cooldown still applies per person, not to the AI server's IP.
- Attachments (built 2026-10-21): the main app's limits, 3 files, 10 MB each, jpg/png/pdf, in the chat's ticket form and on `/ticket`. This service checks them (extension *and* first bytes), never sends them to the model provider, and forwards them with the ticket (§6.1); the main app stores them like its own form's. Production keeps them on the container's disk until uploads move to S3 (accepted, 2026-10-21).
- To reuse the logic, the ticket-creation part of `SupportTicketsController#store` moves into a small service (`#services/support/create_ticket`) that both endpoints call.
- Optional, additive migration: `support_tickets.source` (`form` | `ai_chat`) + `conversation_ref`, so support can see a ticket came from the chat.

### 6.1 Request contract (built: `src/tickets.js`; reference receiver: `scripts/embed-host.mjs`)
```
POST {MAIN_APP_URL}/internal/ai/tickets
Content-Type: application/json
X-WQ-AI-Timestamp: <unix seconds>
X-WQ-AI-Signature: sha256=<hex HMAC-SHA256(AI_SUPPORT_SERVICE_SECRET, "<timestamp>.<raw body>")>

{ "category": "Manage your account",          // always one of TICKET_CATEGORIES ("Something else" → "Manage your account")
  "description": "…",                          // ≥ 10 characters
  "email": "guest@example.com" | null,         // guests only
  "member_token": "<the member's token>" | null, // members: verify with our own key → uid_enc → user; email from the user record
  "conversation_ref": "<uuid>" | null,
  "client_ip": "203.0.113.7",                  // for the per-IP cooldown
  "source": "ai_chat" | "help_center" }
```
**With files**, the same request goes as `multipart/form-data`: the JSON above is the `payload` field, and it is what's signed (`"<timestamp>.<payload>"`, since a multipart body can't be signed whole). It gains a list of the files, which follow as `attachments[0..2]` in the same order:
```
"attachments": [ { "name": "receipt.pdf", "type": "application/pdf", "size": 48213, "sha256": "<hex>" } ]
```
The main app holds the files to its form's limits, then re-hashes each one: a missing, extra, swapped or edited file is refused (`422`), so the files are as tamper-proof as the text.

The main app must: compare the signature in constant time; refuse a timestamp more than 5 minutes off, and a signature it has already accepted; never trust a user id from the body (only from the verified token); apply its cooldown to `client_ip` + the resolved email.

| Response | Meaning | Shown to the user |
|---|---|---|
| `201 {"reference": "ddmmyy-N"}` | created | "submitted as ticket #ddmmyy-N" |
| `401` | bad signature, or the member token no longer verifies | "Your session has ended…" (members) |
| `422 {"message"}` | validation | the main app's message |
| `429 {"message"}` | cooldown | the main app's message |
| anything else / timeout (10 s; 60 s with files) | | "We couldn't send your ticket right now…" |

## 7. Work list

### 7.1 This repo (wq-ai-support)
1. **Production mode** (`APP_MODE=production` or similar):
   - no password gate;
   - `/backoffice` demo, `/mock/api/v1` and the simulated Maria login **off** (they expose fake member data and a fake login);
   - `/api/comp/message` returns 404 while My earnings is "Coming soon".
2. **`/embed` page** with `surface=guest|member`, built from the Back Office panel.
3. **Framing headers**: `/embed` only: `frame-ancestors` = `ALLOWED_PARENT_ORIGINS` (prod, staging, localhost dev), no `X-Frame-Options: DENY`. Every other page keeps `frame-ancestors 'none'`.
4. **postMessage handshake** (§4.2): strict origin checks both ways, message types versioned (`wq-ai:*`).
5. **Token verification**: add `jose`; env `WQ_ISSUER`, `WQ_JWKS_URL`, `WQ_AUDIENCE`; JWKS cached with refresh on unknown `kid` (key rotation).
6. **Conversations bound to identity**; transcript storage keyed and cleared per identity (§4.4).
7. **Ticket form**: email field for guests; submit goes to our server, which forwards to the main app (§6); show the returned reference.
8. **Rate limits / budget**: per member (`sub`) as well as per IP; keep `DAILY_BUDGET_USD`.
9. **Cookies**: `wq_sid` `Secure` + `SameSite=Lax` in production (already the case when `NODE_ENV=production`).
10. Tests: token verification (valid, wrong `aud`, expired, unknown `kid`, bad signature), framing headers per route, guest vs member surfaces, comp endpoint off.

### 7.2 Main app (wealth-quest)
1. **Flag** `ai_support_widget` in `feature_flag_seeder` (off).
2. **`GET /ai/session-token`** behind `auth()` + throttle: mints the token (§4.2) with `#services/sso/keys`; service `#services/ai_support/token`.
3. **`POST /internal/ai/tickets`**: CSRF exception in `config/shield.ts`, HMAC check, shared ticket service (§6).
4. **`<AiSupportLauncher>`** component (`inertia/components/...`): rendered by `AppLayout` (members) and by `auth/sign_in.tsx` (guests); reads the flag; the postMessage bridge lives here.
5. **CSP**: add `AI_SUPPORT_ORIGIN` to `frameSrc` in `config/shield.ts`.
6. **Env** (`start/env.ts`): `AI_SUPPORT_ORIGIN`, `AI_SUPPORT_SERVICE_SECRET`.
7. **Tests** (Japa functional): token endpoint (guest → 401; member → token with the right `aud`/`exp`/`sub`; flag off → 404), internal ticket endpoint (bad HMAC → 401; member token → ticket with `userId`; guest → email required; category validated).
8. Docs per the repo's rules: `docs/build-log.md` entry, `CLAUDE.md` §9 or §19 line, `docs/help-center.md` note.

### 7.3 Infrastructure: owned by DevOps
DevOps chooses the subdomain names, DNS, TLS and hosting. What they need from us:
- **One requirement:** the AI subdomain must be under the same parent domain as the main app (`*.wealthquest.com`), so the iframe stays same-site (§3). A production and a staging instance.
- **The service**: Node 22+, `npm start`, listens on `PORT`, health check `GET /healthz`, no database (state is in memory today, so **one instance** until conversations and budget move to Redis/DB).
- **Env for this repo**: `OPENROUTER_API_KEY`, `SESSION_SECRET`, `DAILY_BUDGET_USD`, `ALLOWED_PARENT_ORIGINS` (the main app origins), `WQ_ISSUER`, `WQ_JWKS_URL`, `WQ_AUDIENCE`, `MAIN_APP_URL`, `AI_SUPPORT_SERVICE_SECRET`, `NODE_ENV=production`.
- **Env for the main app**: `AI_SUPPORT_ORIGIN` (the chosen subdomain), `AI_SUPPORT_SERVICE_SECRET` (same value as above).
- Until DevOps has the names, local development uses `localhost` origins.

### 7.4 Progress
Built one step at a time on `feat/embed-widget` (branched from `main`, which already has the OpenRouter work, PR #1):

| Step | What | Status |
|---|---|---|
| 1 | `/embed` panel (guest / member, My earnings "Soon"), close → parent, framing only for `ALLOWED_PARENT_ORIGINS`, `npm run embed:host` stand-in | ✅ committed + pushed (`9855335`) |
| 2 | Production mode (`DEMO_MODE` off): demo Back Office, mock API and comp agent return 404; "Log in" → `MAIN_APP_URL/login` | ✅ committed + pushed (`db43559`) |
| 3 | Verify the main app's token (`src/identity.js`: EdDSA, `iss`/`aud`/`typ`, ≤15 min, JWKS cached); conversations, rate limits and `safety_identifier` keyed by member; the agent's "signed in" context decided by the server | ✅ committed + pushed (`db43559`); the trailing-slash issuer fix is uncommitted, with 4–5 |
| 4 | postMessage token handshake (§4.5): on-demand refresh, sign-out wipes the screen, per-identity transcripts; `embed:host` now signs tokens like the main app | ✅ built, not committed |
| 5 | Tickets forwarded to the main app (§6.1), main app's reference shown; email field for guests (chat + `/ticket`); production refuses unforwarded tickets | ✅ built, not committed |
| 6 | Main-app side (`wealth-quest`) behind `ai_support_widget` (§7.2) | not started — next |
| — | My earnings (§9) | later batch, after Support |

### 7.5 Local testing
- Run both apps on `localhost`: the main app on `:3333`, this repo on `:3000`. Ports don't count for "same site", so this behaves like production (`app.` + the AI subdomain under one domain): the iframe's cookies work.
- Before the main-app side exists, `npm run embed:host` serves a stand-in on `:3334` with the launcher and panel.
- With `DEMO_PASSWORD` set (e.g. `npm run mock`), sign in once at `http://localhost:3000` first, or the iframe shows the password page.
- **Don't put only this repo behind ngrok**: the main app on `localhost` and the chat on an ngrok domain are different sites, and the iframe's cookies get blocked. To demo remotely, tunnel both apps (and allow `SameSite=None` cookies for that demo only), or use staging.

## 8. Rollout
1. Build both sides against local dev (`localhost` origins in the allow-lists).
2. Deploy to staging: AI service at the staging subdomain, main app staging with the flag on.
3. Test (§11).
4. Production deploy with the flag **off**: nothing visible changes for live members.
5. Turn the flag on (for staff first if the flag service supports per-user targeting; otherwise for everyone) and watch error logs, spend and ticket volume.
6. Rollback = flag off. No migration has to be reversed (the optional `source` column is additive).

## 9. Later batch: My earnings (after Support ships)

Researched 2026-10-20 against `wealth-quest` `origin/main`; nothing built. Support (steps 1–6) ships first; this is its own batch.

### 9.1 Principle: the AI never calculates
Every figure comes **finished** from the main app (Pillars data, or computed by the main app as its own pages do). The agent only fetches, explains and cites the plan. Not even "required − have": the endpoint returns the missing amount, so the answer always matches the member's dashboard. The main app's rules forbid re-implementing comp logic (`CLAUDE.md` §10), and models make arithmetic mistakes. "What if" illustrations ("if you held R5 every day…") are dropped in the first version (decided 2026-10-20; option 2 = the main app returns finished illustrations, later if wanted).

### 9.2 What the main app already has (all Pillars-sourced, cached)
| The agent needs | In `wealth-quest` |
|---|---|
| Daily / weekly / highest rank, next rung, progress % | `pillarsRankView` (`#services/pillars/rank_view`) |
| What is missing for each rank, per condition | the same view's `ladder` (every rung R1–R12 with this member's progress, computed by Pillars) |
| Weak / strong leg BV | `member_snapshots` (`leftLegBv28D` / `rightLegBv28D`), `WLBV` in the rank view |
| SITB this period, days held per rank | `periodRankPay` / `periodSitbUsd` |
| Daily rank history | `rank_history` (one row per day, 28 days); weekly: `rank_week` |
| Commissions | `commission_lines` (type, `amountMinor` + `asset`, status, `earnedAt`), `earningsPeriodSummary` |
| Personally sponsored by leg | `#services/insights/structure`, the direct-network services |
| Freshness | `readThroughSnapshot` (refreshes when stale; returns `syncedAt`) |

**Not there:** a JSON API — every page is assembled server-side for Inertia.

**Mismatches with the current demo agent:** the mock's 14 daily snapshots (each with SITB + leg BV) don't exist in Pillars, which has daily *rank* only plus per-period totals. The AI's 21 plan pages (`kb/compplan/`) are one plan version; the main app tracks v2/v6 changes and open items (31-day BV window vs Pillars' 28-day reads, Gen-Match not paying, unconfirmed rank names, renamed bonuses). The answers must follow what Pillars actually pays.

### 9.3 Main app work (`wealth-quest`)
1. **Internal read-only JSON endpoints** for the signed-in member, authenticated exactly like `/internal/ai/tickets` (HMAC + the member's token → user; never a user id from the request). Built from the services above, returning **final numbers**, money in minor units + asset, each with `syncedAt`:
   - `GET /internal/ai/me/profile`: name, status, licence, good standing, role
   - `GET /internal/ai/me/rank`: daily / weekly / next rank, ladder with per-condition `required` / `have` / `missing`, SITB this period, 28-day daily ranks
   - `GET /internal/ai/me/commissions?from&to&type`: lines + period totals
   - `GET /internal/ai/me/network`: personally sponsored counts by leg and rank (counts, not other members' names)
2. **`role` claim** in the AI token (`ibo` | `customer`), from `#services/members/back_office_access`.
3. **Flag `ai_comp_agent`** (off), separate from `ai_support_widget`.
4. **Japa tests:** own data only; customer → 403; bad signature → 401; partner down → stale data with `syncedAt`, not a 500.

### 9.4 This repo's work (`wq-ai-support`)
1. **Data client:** replace `mockApiClient` (`src/mock/wq-api.js`) with signed calls to §9.3's endpoints (same `api.get(path)` shape, timeout, a clear "your numbers can't be loaded right now"). The mock stays for demo mode only.
2. **Tools** (`src/tools/comp-tools.js`): fetch-only tools mirroring the endpoints (`get_my_profile`, `get_my_rank`, `get_my_commissions`, `get_my_network`). **Remove** `calculate_rank_gap` and `project_sitb`; `src/calc/plan.js` becomes demo-only or is deleted (with `test/calc.test.js`). Update the prefetch in `src/agents/comp.js` and the router's data sets.
3. **Prompts & plan content:** `prompts/comp-agent.md` explains returned figures, never computes, shows "as of {syncedAt}", keeps the compliance rules, no illustrations; `prompts/comp-router.md` gets the new data-set names; `kb/compplan/*` is updated to the client's **current** plan version once the lead and client confirm which.
4. **Access:** `/api/comp/message` for verified members with `role: ibo` (not only demo mode); guests and customers refused. `src/agents/comp.js` takes the member from `req.member`, not the demo Maria cookie.
5. **Panel:** `/embed` enables *My earnings* for IBOs (from the server, not the page); customers and guests keep "Soon". Suggested questions based on real data.
6. **Tests:** client against a stand-in (own data only, customer refused, main app down handled); the agent never calculates; the comp endpoint refuses guests/customers. Extend `npm run embed:host` to serve fake member data for local testing.

### 9.5 Effort and risks
About 3–4 days in each repo, plus the client's review of plan content and sample answers (the long pole). Risks: Pillars data quality the agent would inherit (`CLAUDE.md` §18 #22, #26, #27); member earnings sent to the model provider via OpenRouter (`data_collection: deny` already; client sign-off needed); compliance — the client's exposure is what is displayed and how earnings are described (`CLAUDE.md` §15).

## 10. Open questions for the lead
Subdomain names, DNS, TLS and hosting are DevOps's call (§7.3) and not open here.

1. **Two help centers**: the main app already serves `/help` (48 client-reviewed articles); the AI answers from this repo's 39 articles, and its links point at the subdomain. Keep both for now, or should the AI answer from the main app's articles?
2. **Signing key**: reuse the SSO Ed25519 key (separated by `aud` + `typ`), or a dedicated key? Reuse is fine if WealthVentures checks `aud`; worth confirming.
3. **Restricted accounts**: should held / locked members see the widget? Default: yes.
4. **Ticket `source` column**: add it now (small, additive) or later?
5. **Which other guest pages** get the widget besides sign-in (forgot password, open ticket, signup)?
6. **Per-user flag targeting** for a staff-only first rollout: does `#services/flags` support it?
7. ~~"Something else"~~: **decided 2026-10-20**: mapped to "Manage your account"; the main app's categories are unchanged.
8. **Attachments** in AI tickets: the main app stores them (3 × 10 MB, jpg/png/pdf), but no screen shows tickets or files to support, the inbox mail carries only a count, and with `DRIVE_DISK=fs` on ECS the files don't survive a deploy (`docs/uploads-on-s3.md`). **Recommendation: text-only AI tickets until that is fixed**; passing files through is about a day then.

## 11. Test checklist (staging)
- Guest on sign-in: button shows, panel has no toggle, a question streams, ticket needs email → ticket appears in `support_tickets` with a reference and confirmation mail.
- Member on dashboard: toggle shows, My earnings disabled with "Coming soon"; a ticket is attached to the member (`userId`) without asking for email.
- Token expiry: wait past 10 min (or shorten in staging) → next question still works (silent refresh).
- Logout in another tab → the widget says the session ended; log in as another member → empty transcript.
- Framing: `/embed` loads inside the app; the subdomain home page refuses to be framed; `/embed` refuses framing from an unlisted origin.
- Mobile: launcher above the bottom bar; panel full-screen; close works.
- Flag off → no button anywhere; `/ai/session-token` → 404.
- Production smoke after deploy with the flag off: nothing visible changed; existing sessions unaffected.
