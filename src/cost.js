// Cost calculation, copied from the shared helper (repos must be self-contained).
// usage = Responses API `usage` object (OpenRouter adds `usage.cost` in USD; the mock does not).
import pricing from './pricing.json' with { type: 'json' };

export const FX = pricing._fx.usd_to_eur;

/**
 * Compute the USD/EUR cost of one Responses API call.
 * When the provider reports what it billed (`usage.cost`, OpenRouter), that is the cost.
 * Otherwise: fresh input = input - cached - cache_write; each bucket has its own price per 1M tokens.
 * Reasoning tokens are already included in output_tokens (they are billed as output).
 */
export function costOf(model, usage) {
  const p = pricing.models[model];
  const billed = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null;
  if (!usage || (!p && billed === null)) return { usd: 0, eur: 0, tokens: {} };
  const input = usage.input_tokens || 0;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  const write = usage.input_tokens_details?.cache_write_tokens || 0;
  const fresh = Math.max(0, input - cached - write);
  const output = usage.output_tokens || 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens || 0;
  const usd = billed ?? (fresh * p.input + cached * p.cached_input + write * p.cache_write + output * p.output) / 1e6;
  return { usd, eur: usd * FX, tokens: { input, cached, cache_write: write, fresh, output, reasoning } };
}

export { pricing };
