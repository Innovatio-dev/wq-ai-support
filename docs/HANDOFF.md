# Handoff: where we stopped

Last updated 2026-10-21. Read this first in a new session. Then, as needed:
- [`embed-auth-plan.md`](embed-auth-plan.md): the plan, every contract, the My earnings plan (§9), open questions (§10);
- [`DEPLOY.md`](DEPLOY.md): hosting and every env var, both repos.

## The goal
Embed the AI support chat in the WealthQuest main app (`wealth-quest`, AdonisJS + Inertia/React, production `app.wealthquest.com`):
- **Member pages:** round chat button → panel with **Support** and **My earnings** (disabled, "Soon").
- **Sign-in page (`/login`):** the same button, **Support only** (guests).
- **This repo's help site:** `help.wealthquest.com` in production, public, no password gate.

## Status: Support is done. Next is deploying to staging
Built, tested end to end with the real OpenRouter key, security-reviewed, committed and pushed. **No PRs yet; `main` untouched in both repos. The user opens the PRs and merges.**

| Repo | Branch | Last commit |
|---|---|---|
| `wq-ai-support` (this one) | `feat/embed-widget` | `9f3f444` attachments on tickets |
| `wealth-quest` | `feat/ai-support-widget` | `8d040c73` files on the chat's tickets (4 commits on `main`) |

What works:
- **Members:** the main app signs a 10-minute token (`GET /ai/session-token`, SSO key, `aud: wq-ai-support`), fetched only when the chat asks. This repo verifies it against the main app's JWKS. Conversations, limits and transcripts are per member.
- **Guests:** the sign-in page and this help site, anonymous session.
- **Tickets:** forwarded to the main app's `POST /internal/ai/tickets`, signed (HMAC, 5-minute window, each signature once). They land in `support_tickets` with the main app's `ddmmyy-N` reference and the same two emails as its own form: a confirmation to the person, and a notification to `help@wealthquest.com`. A member's ticket is tied to their account; a guest gives an email.
- **Attachments:** 3 files, jpg/png/pdf, 10 MB each, in the chat's ticket form and on `/ticket`. Checked here by extension and by first bytes, never sent to the AI, forwarded with a signed SHA-256 list. Stored on the main app's disk. That disk is lost on deploy until S3, which the user accepted.
- **Flag** `ai_support_widget` in the main app (off by default; no row = off): the kill switch for the button and the token.

Tests at the last run:
- this repo: `npm test`, 59 pass;
- `wealth-quest`: functional 3102 pass, unit 1029 pass, typecheck and lint clean.

## Next steps
1. **Staging deploy.** DevOps hosts this service on a staging subdomain under `wealthquest.com`, with one instance and env from `DEPLOY.md`. Use **staging's own** secrets, not production's. The main app's staging gets `AI_SUPPORT_ORIGIN` + `AI_SUPPORT_SERVICE_SECRET` and the `feat/ai-support-widget` code. No migrations.
2. **Staging test:** turn on "AI support chat" in Admin → Configuration, then check:
   - a guest ticket on `/login`, with a file;
   - a member ticket from the dashboard, with no email field;
   - the transcript is kept across page changes;
   - sign-out leaves the chat empty;
   - links open in a new tab;
   - phone layout.
3. **Production:** PRs + merge, deploy with the flag **off**, then turn it on.
4. **Next batch:**
   - **My earnings** (plan §9): JSON endpoints in the main app (`/internal/ai/me/*`, the same signature + member token), a `role` claim, an `ai_comp_agent` flag. Here: fetch-only tools; the AI never calculates.
   - **Per-user flag targeting** for a staff-first rollout.

## Open before or around launch
- **Turnstile** (`TURNSTILE_SECRET`/`TURNSTILE_SITE_KEY`) for the public help site. Today a guest can type anyone's address into a ticket and that address gets the confirmation email. Turnstile covers the chat's first message, but not the plain `/ticket` form; covering that is a small code change, not done.
- **No ticket screen in the main app.** Support only sees the inbox email, which carries a count of files, not the files. A small admin page (list, open, files, mark answered) is the next useful main-app piece.
- **Two help centers.** The AI answers from this repo's 39 articles, not the main app's 48. The password rule was wrong and is fixed (`53fdd57`). Others may drift; the main app's own articles mention a "Devices" tab its Settings page doesn't have, and so do this repo's `manage-devices` and `log-out` articles.
- **Article buttons** point at the main app's real pages (`/settings?tab=…`, `/membership`, `/wallet`…), with `MAIN_APP_URL` put in front by the server. They used to point at `/backoffice/...`, which 404s on the help site. The "Income Disclosure Statement" button still goes to `https://www.wealthquest.com/legal/income-disclosure`: not checked that it exists, as the main app has no such page.
- **One instance here** (state in memory). On the main app, `LIMITER_STORE` on Redis only matters if it runs several instances; optional.
- The lead's questions, plan §10: held or locked members, per-user targeting, the two help centers, a dedicated signing key.

## Ground rules (from the user)
- **Commit or push only when asked; no PRs unless asked;** never touch `main`. Before a push: full tests, plus a browser check.
- `wealth-quest` is production: it goes through their PR review and CI. Follow its `CLAUDE.md` (build-log entry, `land-a-slice` checklist).
- DevOps owns domains, DNS, TLS and hosting. Every address is an env var.
- **Never let the main app send real mail while testing locally.** Its dev `.env` uses real SendGrid and every ticket emails the support inbox. See "Local testing" below.

## Local testing (both real apps)
- **This repo:** `npm run dev` with `.env` set to:
  - `MOCK_OPENAI=0` (or 1 to spend nothing)
  - `DEMO_PASSWORD=` (empty)
  - `DEMO_MODE=0` (production-like: "Log in" goes to the main app)
  - `WQ_ISSUER=http://localhost:3333`
  - `MAIN_APP_URL=http://localhost:3333`
  - `AI_SUPPORT_SERVICE_SECRET` = the same as the main app's
- **`wealth-quest`:** `node ace serve --hmr` on `:3333`. Create a gitignored `.env.local` with:
  - `AI_SUPPORT_ORIGIN=http://localhost:3000`
  - `AI_SUPPORT_SERVICE_SECRET=...`
  - and, to send no mail: `SENDGRID_API_KEY=`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1`, `QUEUE_DRIVER=sync`

  Restart after env changes (Adonis reads env only at start). Delete `.env.local` afterwards. Run migrations if pages error with unknown columns (`node ace migration:run`; the test DB with `NODE_ENV=test`).
- **Flag:** turn on "AI support chat" in Admin → Configuration. A staff sign-in needs an emailed code, so with mail off, set it in the dev DB instead (`feature_flags`, name `ai_support_widget`).
- **Dev accounts:** `member@wealthquest.test` / `password`.
- **Launch configs** (`.claude/launch.json`, local only): `ai-for-wealth-quest` (mock AI on `:3000`) and `wealth-quest-with-ai`.
- **The stand-in:** `npm run embed:host` (`:3334`) imitates the main app without running it: text tickets only, fake Alice/Bob logins.
- **Known dev-only noise:**
  - Right after the main app starts, Vite may reload the page, which can cut off a first chat answer ("The connection was interrupted"). Retry.
  - `kb/support/_lint.mjs` fails on every article in a Windows checkout, because it expects Unix line endings. The app's own loader is fine.

## Decisions (2026-10-20/21)
- **iframe** (`/embed`) + a launcher component in the main app; identity by **signed token**, verified via JWKS; tokens **on demand only**.
- Tickets go into the main app's `support_tickets`; "Something else" → "Manage your account".
- **Attachments yes** (reversed 2026-10-21), on the main app's disk until S3.
- **My earnings** = finished numbers from the main app (Pillars); the AI never calculates; no "what if" in v1; not for customers.
- `DEMO_MODE=0` explicitly in production.
