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
2. The iframe posts `wq-ai:ready` to `window.parent`. The launcher accepts messages only from the AI origin.
3. The launcher calls **`GET /ai/session-token`** on the main app (behind `auth()`, same-origin, session cookie, throttled).
4. The main app returns a JWT signed with the existing SSO key:
   - header `alg: EdDSA`, `kid`, `typ: wq-ai+jwt`
   - `iss` = APP_URL, `aud` = `wq-ai-support`, `iat`, `exp` = **+10 min**, `jti`
   - `sub` = `pairwiseSubject(user.id, 'wq-ai-support')` (the AI service never sees internal ids)
   - `name` (public display name), `email`, `uid_enc` = the user id encrypted with the main app's `encryption` service (only the main app can read it; used when the AI service calls back, §6)
5. The launcher posts `{type: 'wq-ai:token', token}` to the iframe with `targetOrigin` = the exact AI origin.
6. The iframe sends `Authorization: Bearer <token>` on every API call. The AI server verifies the signature against the cached JWKS, and checks `iss`, `aud`, `typ`, `exp`.
7. **Refresh**: on `401 token_expired` (or ~1 min before `exp`) the iframe posts `wq-ai:token-request`; the launcher repeats step 3.
8. **Main-app session gone** (idle 2 h, logged out elsewhere): step 3 returns 401 → the launcher posts `wq-ai:signed-out` → the panel shows "Your session ended, please sign in again" and stops sending.

### 4.3 Already-logged-in production users
- **Nothing changes for existing sessions.** The token endpoint reads the session the member already has: no re-login, no migration of sessions, no new cookie on the main app.
- The widget sits behind a **feature flag** (`ai_support_widget`, seeded **off**). Flags are shared on every Inertia render, so turning it on shows the button on the member's next navigation, and turning it off hides it the same way. It is the kill switch.
- The token is short-lived and holds no permission beyond "talk to the support agent as this member". A leaked token is useless after 10 minutes and can't act in the main app.
- Restricted / held / closed accounts: the token endpoint follows the same `auth()` gate as other member pages. Should they still see the widget? Default: yes (support is how they get unstuck).

### 4.4 Switching users on a shared computer
The chat transcript is kept in the iframe's `sessionStorage`. Key it by identity (`guest` or `sub`) and clear it whenever the identity changes (guest → member after login, member → guest after logout, member A → member B). The server binds each conversation to its owner (`sid` for guests, `sub` for members), and a request carrying a different identity starts a new conversation.

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
- Category: the AI's subcategory (e.g. "Logging in") maps to its top-level category (e.g. "Manage your account"), which is always one of `TICKET_CATEGORIES`.
- The main app returns the `reference`, and the chat shows that number.
- Rate limits: the main app's cooldown is keyed by IP + email. The AI service passes the member's IP and email so the cooldown still applies per person, not to the AI server's IP.
- Attachments: the main app already supports them (3 files, 10 MB, jpg/png/pdf). Add them to the in-chat form in a later step (multipart pass-through); text-only in the first step.
- To reuse the logic, the ticket-creation part of `SupportTicketsController#store` moves into a small service (`#services/support/create_ticket`) that both endpoints call.
- Optional, additive migration: `support_tickets.source` (`form` | `ai_chat`) + `conversation_ref`, so support can see a ticket came from the chat.

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
Built one step at a time, each committed on `feat/embed-widget`:

| Step | What | Status |
|---|---|---|
| 1 | `/embed` panel (guest / member, My earnings "Soon"), close → parent, framing only for `ALLOWED_PARENT_ORIGINS`, `npm run embed:host` stand-in | ✅ done |
| 2 | Production mode (`DEMO_MODE` off): demo Back Office, mock API and comp agent return 404; "Log in" → `MAIN_APP_URL/login` | ✅ done |
| 3 | Verify the main app's token (`src/identity.js`: EdDSA, `iss`/`aud`/`typ`, ≤15 min, JWKS cached); conversations, rate limits and `safety_identifier` keyed by member; the agent's "signed in" context decided by the server | ✅ done |
| 4 | postMessage token handshake: refresh, sign-out, user switch | next |
| 5 | Tickets forwarded to the main app | |
| 6 | Main-app side (`wealth-quest`) behind `ai_support_widget` | |

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

## 9. Later batch: My earnings (not now)
The comp agent will call the main app for the member's figures: a service secret plus the member token, over new read-only endpoints backed by the main app's Pillars read-models (rank status, commission lines, network). The token design above already covers who the member is. The BV-vs-money and data-freshness questions from before still apply.

Not every signed-in user is an IBO: since `730eb879` (main app) a node is a Promoter only once the licence is paid, and unpaid accounts are Customers (`dashboard-customer` page, `#services/members/back_office_access`). Customers have no rank or commissions, so the token will need a role claim and *My earnings* should stay unavailable for them.

## 10. Open questions for the lead
Subdomain names, DNS, TLS and hosting are DevOps's call (§7.3) and not open here.

1. **Two help centers**: the main app already serves `/help` (48 client-reviewed articles); the AI answers from this repo's 39 articles, and its links point at the subdomain. Keep both for now, or should the AI answer from the main app's articles?
2. **Signing key**: reuse the SSO Ed25519 key (separated by `aud` + `typ`), or a dedicated key? Reuse is fine if WealthVentures checks `aud`; worth confirming.
3. **Restricted accounts**: should held / locked members see the widget? Default: yes.
4. **Ticket `source` column**: add it now (small, additive) or later?
5. **Which other guest pages** get the widget besides sign-in (forgot password, open ticket, signup)?
6. **Per-user flag targeting** for a staff-only first rollout: does `#services/flags` support it?

## 11. Test checklist (staging)
- Guest on sign-in: button shows, panel has no toggle, a question streams, ticket needs email → ticket appears in `support_tickets` with a reference and confirmation mail.
- Member on dashboard: toggle shows, My earnings disabled with "Coming soon"; a ticket is attached to the member (`userId`) without asking for email.
- Token expiry: wait past 10 min (or shorten in staging) → next question still works (silent refresh).
- Logout in another tab → the widget says the session ended; log in as another member → empty transcript.
- Framing: `/embed` loads inside the app; the subdomain home page refuses to be framed; `/embed` refuses framing from an unlisted origin.
- Mobile: launcher above the bottom bar; panel full-screen; close works.
- Flag off → no button anywhere; `/ai/session-token` → 404.
- Production smoke after deploy with the flag off: nothing visible changed; existing sessions unaffected.
