# Handoff: where we stopped

Last updated 2026-10-20. Read this first in a new session, then [`embed-auth-plan.md`](embed-auth-plan.md) (the full plan, contracts and open questions).

## The goal
Embed the AI support chat in the WealthQuest main app (`wealth-quest`, AdonisJS + Inertia/React, production at `app.wealthquest.com`):
- **Member pages:** round chat button → panel with **Support** and **My earnings**. My earnings stays disabled ("Soon") for now.
- **Sign-in page (`/login`):** the same button, **Support only** (guests).
- **This repo's help home page:** stays as is, on its own subdomain (DevOps picks the name and hosting), with no password gate.

## Ground rules (from the user)
- **Never commit or push unless explicitly asked.** No PRs unless asked.
- In `wealth-quest`: create a branch for step 6; never commit or push there without the user's OK; it's a production app, so it goes through their PR review and CI.
- DevOps owns domains, DNS, TLS and hosting. Every address is an env var.

## State of `wq-ai-support`
Branch **`feat/embed-widget`**, branched from `main`; `main` already has the OpenRouter work (PR #1 merged).

| Commit | What |
|---|---|
| `9855335` | Step 1: `/embed` panel, framing allowed only for `ALLOWED_PARENT_ORIGINS`, `npm run embed:host` stand-in |
| `db43559` | Steps 2–3: production mode (`DEMO_MODE`), member token verification (`src/identity.js`, `jose` 6.2.12), conversations / rate limits per member |

**Built, tested, uncommitted (waiting for the user's go):**
- **Step 4, token handoff:** `public/js/embed.js` (on-demand refresh, never on a timer; sign-out wipes the screen; separate transcripts per identity) and `apiFetch` in `public/js/common.js`. The stand-in `scripts/embed-host.mjs` now signs tokens, publishes its JWKS, has fake "Alice"/"Bob" logins and receives tickets.
- **Step 5, tickets forwarded to the main app:** `src/tickets.js` (HMAC-signed `POST /internal/ai/tickets`, the main app's reference shown, "Something else" → "Manage your account"); email field for guests (chat form + `/ticket`); production refuses unforwarded tickets; `test/tickets.test.js`.
- **Issuer trailing-slash fix** in `src/config.js` (matches the main app's `ssoConfig.issuer`).
- **Docs:** `embed-auth-plan.md` (§4.5 and §6.1 contracts, §9 My earnings plan, progress) and this file.
- `.claude/launch.json`: local launch configs only, never committed.

**Tests:** `npm test` → 57 pass. Last verified in the browser with mock AI + the stand-in, covering:
- member and guest tickets;
- token refresh after expiry;
- sign-out with the panel open;
- switching Alice → Bob;
- the main app rotating its signing key;
- `/ticket`.

## Update 2026-10-21
- Steps 4–5 committed and pushed here (`bd0343a`).
- **Step 6 done in `wealth-quest`**: branch `feat/ai-support-widget` (from up-to-date `main`), three commits, pushed; **no PR yet** (the user opens it). Its build-log entry (2026-10-21) lists everything.
- Tested end to end with the **real OpenRouter key** (user, 2026-10-21): guest and member answers, member and guest tickets landing in `support_tickets` with the right owner and address, transcript kept across page changes.
- Security review (2026-10-21): two fixes. Main app: each signed ticket request is accepted once (replay guard). Here: the guest panel clears member transcripts left in the tab.
- `embed.js` fixes here: a frame reload no longer wipes the member's own transcript; links in the panel open in a new tab (help pages refuse to be framed).
- `docs/DEPLOY.md`: what DevOps needs, for both repos.
- **Next batch:** "My earnings" (plan §9) and per-user flag targeting.
- **Open before launch:** turn on Turnstile for the public help site (a guest can type any address into a ticket); `LIMITER_STORE` shared (Redis) if the main app runs several instances; one instance only here until state moves to Redis; the two help centers (the AI's password steps differ from the real app); nothing else blocking.
- **Attachments built (2026-10-21, user's call):** 3 files, jpg/png/pdf, 10MB each, in the chat's ticket form and on `/ticket`, forwarded with a signed SHA-256 list (plan §6.1) and stored by the main app like its own form's. On production they live on the container's disk until uploads move to S3; accepted.
- Local launch configs `ai-for-wealth-quest` and `wealth-quest-with-ai` are in `.claude/launch.json`. To send no mail while testing, the main app needs a `.env.local` (gitignored) with `SENDGRID_API_KEY=`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1`, `QUEUE_DRIVER=sync`, `AI_SUPPORT_ORIGIN=http://localhost:3000`, `AI_SUPPORT_SERVICE_SECRET=dev-ai-secret`; the flag is turned on in the dev DB (the admin toggle needs an emailed code).

## Step 6 checklist (as originally planned; now built, see above)
The checklist is plan §7.2; the contracts it must follow are §4.2 (token claims, `iss` = `ssoConfig.issuer`), §4.5 (messages) and §6.1 (ticket endpoint). In short:
1. **Flag** `ai_support_widget` in the feature-flag seeder, off.
2. **`GET /ai/session-token`** behind `auth()`: EdDSA token signed with the existing SSO key, `typ: wq-ai+jwt`, `aud: wq-ai-support`, 10 min, pairwise `sub`, `name`, `email`, `uid_enc`.
3. **`POST /internal/ai/tickets`:** CSRF exception, HMAC + timestamp check, member token → user. Move the ticket-saving logic out of `SupportTicketsController#store` into a shared service.
4. **`<AiSupportLauncher>`** in `AppLayout` (member) and `auth/sign_in.tsx` (guest). `scripts/embed-host.mjs` is the working reference.
5. **CSP `frameSrc`** + `AI_SUPPORT_ORIGIN`; env `AI_SUPPORT_SERVICE_SECRET`.
6. **Japa tests;** `docs/build-log.md` + `CLAUDE.md` line, per their rules.

Then test both real apps locally. Then commit steps 4–5 here and step 6 there (PR).

## How to run locally
```bash
npm run mock              # mock AI, demo mode, password "demo", :3000
npm run embed:host        # main-app stand-in on :3334 (guest: /, member: /login?as=alice, tickets: /tickets)
```
For the AI server against the stand-in, set:
- `MOCK_OPENAI=1`
- `WQ_ISSUER=http://localhost:3334`
- `MAIN_APP_URL=http://localhost:3334`
- `AI_SUPPORT_SERVICE_SECRET=dev-ai-secret`

and don't load `.env`, which holds the real OpenRouter key and `MOCK_OPENAI=0`. `.claude/launch.json` has this as `ai-mock-embedded`, and `TOKEN_TTL_S=90` on the stand-in to watch refreshes.

Against the real main app (once step 6 exists): `wealth-quest` on `:3333` (its `.env` already has `SSO_SIGNING_KEY` + `SSO_SUBJECT_SALT`), and this repo with `WQ_ISSUER=http://localhost:3333`, `MAIN_APP_URL=http://localhost:3333` and the same `AI_SUPPORT_SERVICE_SECRET` as the main app. Don't put only this repo behind ngrok: the iframe's cookies break across sites.

## Decisions made (2026-10-20)
- Embed with an **iframe** (`/embed`); the button is a component in the main app. Identity comes from a **signed token** from the main app, verified here against its JWKS.
- **Tokens fetched on demand only**, never on a timer: a timer would keep an idle member's main-app session alive forever.
- **Tickets go into the main app's `support_tickets`.** "Something else" is mapped to "Manage your account", so the main app's categories don't change.
- **Text-only tickets.** The main app stores attachments, but production storage (`DRIVE_DISK=fs` on ECS) loses them on deploy and no screen shows them to support. Revisit after S3.
- **My earnings later** (plan §9): the main app returns **finished numbers** from Pillars, and the AI never calculates. "What if" illustrations are dropped in the first version. Customers (licence not paid) don't get it.

## Open questions for the lead
Plan §10. The ones that matter next:
- Should held or locked members see the widget? (Default: yes.)
- Per-user flag targeting for a staff-first rollout.
- Two help centers (the main app's 48 articles vs the AI's 39).
- Reuse the SSO signing key or a dedicated one.

## Not done / caveats
- **`npm run screenshots`** was updated for the email field but not run (needs Playwright Chromium).
- **State is in memory** (conversations, rate limits, budget): one instance only until it moves to Redis/DB. DevOps knows (plan §7.3).
- **`.env` here** holds the real OpenRouter key, `DEMO_PASSWORD=demo-password` and a `SESSION_SECRET`. It's gitignored.
