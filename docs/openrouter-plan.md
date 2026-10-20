# OpenRouter integration plan

Goal: run both agents through OpenRouter instead of calling OpenAI directly, with no change to the agents' behaviour, the UI or the security model. Researched against OpenRouter's docs on 2026-10-19.

## Summary

- OpenRouter has an OpenAI-compatible **Responses API** at `https://openrouter.ai/api/v1/responses`. This repo already uses the Responses API through the official `openai` SDK, so the SDK can be pointed at OpenRouter by changing `baseURL` and `apiKey`.
- Every request parameter the agents send is in OpenRouter's request schema, and the stream events the code reads are the same as OpenAI's.
- The three models are listed on OpenRouter at the same prices as `src/pricing.json`.
- **Two real changes are needed:** there is no `/moderations` endpoint, and the model names need an `openai/` prefix.
- **Estimate:** 1–2 days including tests. Only `src/openai.js`, `src/config.js`, `src/cost.js` and `.env.example`/README change, plus small additions to the two router schemas if moderation moves into the router (see 4.4).

## 1. What OpenRouter supports, checked against our code

| What the code sends or reads | Where | OpenRouter Responses API | Notes |
|---|---|---|---|
| `instructions` | both agents | ✅ supported | |
| `input` with `role: developer/user/assistant` messages | both agents | ✅ supported | |
| `reasoning: { effort }` with `none` / `low` / `medium` | both agents | ✅ supported (`none` … `max`) | |
| `text.verbosity: 'low'` | both agents | ✅ supported | |
| `text.format: { type: 'json_schema', strict: true }` | both routers | ✅ supported (`FormatJsonSchemaConfig`) | Strictness depends on the provider. OpenAI enforces it natively. |
| `tools` of type `function` with `strict: true` | ticket tool, comp tools | ✅ supported | |
| `tool_choice: 'auto' / 'none'`, `parallel_tool_calls` | both agents | ✅ supported | |
| `max_output_tokens` | all calls | ✅ supported | |
| `store: false` | all calls | ✅ **required** (`store: true` → 400) | We already send `false`. |
| `include: ['reasoning.encrypted_content']` + replaying `completed.output` | comp tool loop | ✅ supported, documented in the GPT-5.6 guide | Needed so the stateless tool loop keeps reasoning between steps. |
| `function_call_output { call_id, output }` | comp tool loop | ✅ same shape | |
| `safety_identifier` | all calls | ✅ supported | OpenRouter hashes it before forwarding. |
| Stream events `response.output_text.delta`, `response.output_item.done`, `response.completed`, `response.failed`, `error` | `streamResponse()` | ✅ same names | `response.incomplete` also exists. Handle it (see 4.2). |
| `usage.input_tokens`, `input_tokens_details.cached_tokens` / `cache_write_tokens`, `output_tokens_details.reasoning_tokens` | `cost.js` | ✅ same shape, **plus `usage.cost` in USD** | |
| `moderations.create({ model: 'omni-moderation-latest' })` | `isFlagged()` | ❌ **no moderations endpoint** | See 4.4. |
| Model ids `gpt-5.6-luna/terra/sol` | `config.js` | ⚠️ called `openai/gpt-5.6-luna` etc. | See 4.3. |

Model prices on OpenRouter (USD per 1M tokens, from `GET /api/v1/models`). They match `src/pricing.json`:

| Model | Input | Cached read | Cache write | Output |
|---|---|---|---|---|
| `openai/gpt-5.6-luna` | 0.20 | 0.02 | 0.25 | 1.20 |
| `openai/gpt-5.6-terra` | 2.00 | 0.20 | 2.50 | 12.00 |
| `openai/gpt-5.6-sol` | 4.00 | 0.40 | 5.00 | 20.00 |

Prices double for prompts over 272k tokens. Our prompts are far below that.

## 2. Request and response format

Request: the same body as today, with a prefixed model and optional OpenRouter extras.

```js
POST https://openrouter.ai/api/v1/responses
Authorization: Bearer <OPENROUTER_API_KEY>
HTTP-Referer: <APP_URL>          // optional: app attribution in the OpenRouter dashboard
X-Title: WealthQuest Support     // optional

{
  model: 'openai/gpt-5.6-terra',
  instructions: '…',
  input: [ { role: 'developer', content: '…' }, …, { role: 'user', content: '…' } ],
  tools: [ { type: 'function', name: 'create_support_ticket', strict: true, parameters: {…} } ],
  tool_choice: 'auto',
  reasoning: { effort: 'low' },
  text: { verbosity: 'low' },
  max_output_tokens: 900,
  store: false,
  safety_identifier: '<sha256(session)>',
  stream: true,
  // OpenRouter extras:
  session_id: '<conversation id>',            // routes a conversation to one provider for better cache hits
  provider: { data_collection: 'deny' },       // only providers that don't keep or train on the data
}
```

Usage in the final `response.completed` event:

```json
"usage": {
  "input_tokens": 3100,
  "input_tokens_details": { "cached_tokens": 2900, "cache_write_tokens": 0 },
  "output_tokens": 60,
  "output_tokens_details": { "reasoning_tokens": 0 },
  "total_tokens": 3160,
  "cost": 0.00017,
  "cost_details": { "upstream_inference_input_cost": 0.0001, "upstream_inference_output_cost": 0.00007 },
  "is_byok": false
}
```

Errors return `{ error: { code, message }, error_type }`. The ones to handle:
- **401:** bad key
- **402:** out of credits
- **429:** rate limit
- **403:** blocked by a guardrail
- **5xx:** provider down

## 3. Environment variables

| Var | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `openrouter` when `OPENROUTER_API_KEY` is set, else `openai` | Which backend to call. Switching back needs no code change. |
| `OPENROUTER_API_KEY` | – | Server-side only, like the OpenAI key. |
| `OPENROUTER_APP_URL` / `OPENROUTER_APP_NAME` | – | Optional `HTTP-Referer` / `X-Title` headers. |
| `OPENROUTER_DATA_COLLECTION` | `deny` | `provider.data_collection`. |
| `OPENROUTER_ZDR` | `0` | `1` sends `provider.zdr: true` (zero data retention only). Check first that OpenAI's endpoints on OpenRouter are ZDR, or every request fails with "no endpoints". |
| `OPENAI_API_KEY` | – | Kept for `LLM_PROVIDER=openai`, and optionally for moderation only (option B in 4.4). |

`MOCK_OPENAI=1` keeps working unchanged. The mock client is chosen before any provider.

## 4. Code changes

### 4.1 `src/config.js`
- Add `provider`, `openrouterKey`, `openrouterAppUrl`, `openrouterAppName`, `openrouterDataCollection`, `openrouterZdr`.
- **Keep the model names in `COMBOS` as they are** (`gpt-5.6-luna` …). The prefix is added in one place (4.3), so `pricing.json`, the cost inspector UI and the tests don't change.

### 4.2 `src/openai.js`: the main change
- `getClient()`: when the provider is `openrouter`, create the client with `new OpenAI({ apiKey: config.openrouterKey, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer', 'X-Title' }, maxRetries: 1, timeout: 60_000 })`.
- Add a small `toProviderParams(params)` used by `streamResponse()` and `createResponse()`:
  - prefixes the model: `gpt-5.6-terra` → `openai/gpt-5.6-terra`
  - adds `provider: { data_collection, zdr? }`
  - adds `session_id` when the caller passes one (thread `conv.id` through from both agents; optional)
- Handle `response.incomplete` in `streamResponse()`. Treat it like `completed`, so usage is still recorded when `max_output_tokens` cuts an answer short. This also fixes a small gap that exists with OpenAI today.
- Error messages: map 402 to "AI credits exhausted" and 401 to "AI provider key invalid", so the UI shows a clear inline error rather than a raw one.
- `NO_KEY_MESSAGE` and the `getClient()` null check: treat a missing `OPENROUTER_API_KEY` the same as a missing OpenAI key today.

### 4.3 Model naming
- One map in `openai.js`: `providerModel(name) = config.provider === 'openrouter' ? `openai/${name}` : name`.
- Response handling keeps the unprefixed name for `usageEvent()`, so `pricing.json` lookups keep working.

### 4.4 Moderation (`isFlagged`): pick one
OpenRouter has no `/moderations` endpoint. Its request schema lists a `moderation` plugin, but the docs don't explain what it does, so it isn't used here.
- **A (recommended):** add `flagged: boolean` to the router JSON schema in both agents. The router already reads every message, so this costs no extra call and almost no tokens. `isFlagged()` is removed from the call path. Add one line to `prompts/support-router.md` and `prompts/comp-router.md` saying when to set it.
  - Note: the comp agent's `sol-only` combo has no router. In that combo, rely on the agent prompt's own refusal rules, or keep option B there.
- **B:** keep a separate `OPENAI_API_KEY` used only for `omni-moderation-latest`, which is free. That's two keys to manage.
- **C:** drop moderation. The answer prompts already refuse off-topic requests. Least safe.

### 4.5 `src/cost.js` and `agents/common.js`
- `costOf(model, usage)`: if `usage.cost` is a number, use it as the USD cost (it's what OpenRouter actually billed). Otherwise fall back to the `pricing.json` calculation. Token counts are read the same way as today.
- The daily budget (`recordSpend`) then tracks real spend.
- The cost inspector label in `public/js/common.js` ("live OpenAI usage") becomes "live OpenRouter usage" based on a `provider` field added to `/api/config`.

### 4.6 Docs
- `.env.example`: add the new variables.
- README: update "Run locally", "Env vars" and "How the key is protected".

## 5. Tests
- `test/cost.test.js`: `usage.cost` is preferred when present, and `pricing.json` is used when it's absent.
- New `test/provider.test.js`: model prefixing, `provider` / `session_id` added only for OpenRouter, nothing added for OpenAI.
- Router schema tests, if option 4.4 A: `flagged: true` gives the refusal text and the answer model is never called. Run this in mock mode by teaching the mock router to set `flagged` for a test phrase.
- The existing 37 tests and `npm run mock` must still pass unchanged.

## 6. First check with a real key (about 1 hour)
Run it locally with `OPENROUTER_API_KEY` set and check:
1. Support: a normal question (streaming plus article links); "I want to talk to a person" (the ticket draft appears); a non-English question.
2. Back Office comp agent: "How far am I from the next rank?" (at least one tool loop, which proves encrypted reasoning replay works); "What will I earn next week?" (the compliance wording).
3. The cost inspector total matches the OpenRouter activity page for the same requests.
4. All three combos for each agent.
5. Optional: `OPENROUTER_ZDR=1`. Confirm requests still route or fail cleanly.

## 7. Fallback if the Responses API misbehaves
If something in step 6 fails (most likely the reasoning replay or strict structured output), switch only `openai.js` to `POST /chat/completions` and keep the same normalized events (`text` / `item` / `completed`) for the agents:
- `instructions` becomes a `system` message, and `developer` messages stay `developer`.
- `text.format` becomes `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }`.
- Tools become `{ type: 'function', function: { name, description, parameters, strict } }`.
- A `function_call` item becomes `assistant.tool_calls[]`, and `function_call_output` becomes a `role: 'tool'` message.
- Usage comes from the final stream chunk: `prompt_tokens` and `prompt_tokens_details.cached_tokens` / `cache_write_tokens`, plus `cost`.

Estimated at 1–2 extra days. The agent files change very little.

## 8. Account setup
- Create an OpenRouter account, add credits and create an API key.
- **Set a credit limit on the key**, as a second kill switch next to `DAILY_BUDGET_USD`.
- Privacy settings: decide whether to require zero data retention account-wide.
- Optional: an OpenRouter guardrail (budget, model allowlist limited to `openai/gpt-5.6-*`).

## 9. Later, optional
- Cheaper models listed on OpenRouter: `openai/gpt-6-luna` costs $0.10 / $0.50, half the price of 5.6-luna. `openai/gpt-6-sol` and `openai/gpt-6.1-sol` cost $2 / $10, half the price of 5.6-sol. Add them as extra combos in `COMBOS` and `pricing.json`, compare answer quality, and only then change the defaults.
- Explicit prompt caching (`prompt_cache_key`, `prompt_cache_options`) if cache-write costs show up high in the inspector.

## Sources
- Responses API overview, basic usage, tool calling, reasoning, error handling: https://openrouter.ai/docs/api/reference/responses/overview
- Create-a-response OpenAPI spec: https://openrouter.ai/docs/api/api-reference/responses/create-a-response
- GPT-5.6 migration guide (encrypted reasoning, cache-write usage fields): https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/gpt-5-6
- Usage accounting: https://openrouter.ai/docs/cookbook/administration/usage-accounting
- Zero data retention: https://openrouter.ai/docs/guides/features/zdr
- Model list and prices: https://openrouter.ai/api/v1/models
