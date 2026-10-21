# Deploying the AI support service

For DevOps. Covers this repo (`wq-ai-support`) and the settings it needs in the main app (`wealth-quest`). Background and contracts: [`embed-auth-plan.md`](embed-auth-plan.md).

## What it is
- A Node web service: the public help site, plus the chat panel (`/embed`) that the main app shows in an iframe on member pages and on its sign-in page.
- No database. Conversations, rate limits and the daily AI budget are kept in memory.
- Talks to OpenRouter (the AI) and to the main app: it reads the main app's public keys and files support tickets into it.

## Two environments
One instance per environment, each on its own subdomain:

| | Main app | This service |
|---|---|---|
| Staging | `https://app-staging.wealthquest.com` | a staging name under `wealthquest.com` (your choice) |
| Production | `https://app.wealthquest.com` | `https://help.wealthquest.com` |

**The one hard requirement:** this service's subdomain must be under the same parent domain as the main app (`*.wealthquest.com`). Otherwise the browser treats the iframe's cookies as third-party and blocks them, and the chat breaks.

## Running it
| | |
|---|---|
| Runtime | Node 22 or newer |
| Install | `npm ci` |
| Start | `npm start` (listens on `PORT`) |
| Health check | `GET /healthz` returns 200 with `{ "ok": true, ... }` |
| Instances | **Exactly 1.** State is in memory, so a second instance would split conversations and budgets. Moving state to Redis is a later change. |
| Proxy | One reverse proxy / load balancer in front. HTTPS must end there; the app trusts one proxy hop for the client IP. |
| Disk | Nothing persistent needed. |
| Outbound network | `https://openrouter.ai` and the main app over HTTPS (`/.well-known/jwks.json` and `/internal/ai/tickets`). |

**Main app's edge:** the main app's WAF geo allow-list and rate limits must not block this service's outbound IP. Every chat ticket comes from that one IP.

## Environment variables: this service

| Variable | Staging / production value | Secret? | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | | Turns off demo-only parts and makes cookies `Secure`. |
| `PORT` | whatever the platform gives | | |
| `OPENROUTER_API_KEY` | the OpenRouter key | **yes** | One key per environment. Set a credit limit on it in the OpenRouter dashboard. |
| `OPENROUTER_APP_URL` | this service's URL | | Shows in the OpenRouter dashboard. |
| `OPENROUTER_APP_NAME` | `WealthQuest Support` | | |
| `OPENROUTER_DATA_COLLECTION` | `deny` | | Only providers that don't store or train on the data. |
| `OPENROUTER_ZDR` | `0` | | |
| `SESSION_SECRET` | random, `openssl rand -hex 32` | **yes** | Signs cookies. Without it, everyone is logged out on each restart. |
| `DAILY_BUDGET_USD` | e.g. `5` staging, agreed figure in production | | AI requests are refused for the day once this is spent. |
| `ALLOWED_PARENT_ORIGINS` | the main app's URL for that environment, e.g. `https://app.wealthquest.com` | | Only these sites may show the chat in an iframe. Unset in production means nobody, and the chat won't show. |
| `MAIN_APP_URL` | the main app's URL | | Where tickets go, and where "Log in" points. |
| `WQ_ISSUER` | **exactly** the main app's issuer: its `SSO_ISSUER`, or its `APP_URL` if that is unset, with no trailing slash | | Members can't sign in to the chat if this differs by even a slash. |
| `AI_SUPPORT_SERVICE_SECRET` | random, `openssl rand -hex 32` | **yes** | **Same value** as the main app's variable of the same name. Different per environment. |
| `DEMO_PASSWORD` | leave empty | | The help site is public. |
| `MOCK_OPENAI` | leave empty or `0` | | |
| `DEMO_MODE` | `0` | | Already off with `NODE_ENV=production`; set explicitly so a missing `NODE_ENV` can't turn it on. **Never `1`** outside local development: it serves a fake Back Office and fake member data. |
| `WQ_JWKS_URL`, `WQ_AUDIENCE` | leave empty | | Defaults are right. |
| `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` | optional | secret: yes | Cloudflare bot check on the first message, if wanted. |

## Environment variables: main app (`wealth-quest`)

| Variable | Value | Secret? | Notes |
|---|---|---|---|
| `AI_SUPPORT_ORIGIN` | this service's URL for that environment, e.g. `https://help.wealthquest.com` | | Without it there is no chat button. Also allows the iframe in the main app's security policy. |
| `AI_SUPPORT_SERVICE_SECRET` | the same value as this service's | **yes** | Without it the main app refuses chat tickets. |
| `SSO_SIGNING_KEY`, `SSO_SUBJECT_SALT` | already set for WealthVentures sign-in | **yes** | Must be set, or members get no chat button. Don't change them. |

The chat button is also behind the feature flag `ai_support_widget`. It ships **off**. After the deploy, the flag seeder (or an admin, under Admin → Configuration) creates it, and an admin turns it on when the chat is ready.

## Rollout order
1. Staging: deploy this service on its subdomain with the variables above, and check `GET /healthz`.
2. Staging: add the two variables to the main app and deploy the branch with the chat (`feat/ai-support-widget`).
3. Staging: turn on `ai_support_widget`, then test (guest on the sign-in page, member on the dashboard, a ticket from each).
4. Production: same two deploys, with the flag **off**. Nothing changes for members.
5. Turn the flag on. To roll back, turn it off: no migration to undo.

## Watching it
- Logs go to stdout. Ticket problems show as `[tickets] main app refused` / `main app unreachable`. On the main app side, look for `ai-support:bad-signature` (secrets don't match, or clocks are off by more than 5 minutes).
- Spend: the OpenRouter dashboard, and `DAILY_BUDGET_USD`.
