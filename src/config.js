// Central configuration: environment variables + the model-combination allow-list.
// In AdonisJS this becomes config/ai.ts + start/env.ts (validated env schema).
import crypto from 'node:crypto';

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

/** Comma-separated origins → normalised `scheme://host[:port]` list; anything unparsable is dropped. */
export function parseOrigins(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    try {
      const { origin } = new URL(s);
      return origin === 'null' ? [] : [origin];
    } catch {
      return [];
    }
  });
}

export const config = {
  port: Number(env.PORT) || 3000,
  openrouterKey: env.OPENROUTER_API_KEY || '',
  openrouterAppUrl: env.OPENROUTER_APP_URL || '',
  openrouterAppName: env.OPENROUTER_APP_NAME || '',
  openrouterDataCollection: env.OPENROUTER_DATA_COLLECTION === 'allow' ? 'allow' : 'deny',
  openrouterZdr: env.OPENROUTER_ZDR === '1' || env.OPENROUTER_ZDR === 'true',
  mock: env.MOCK_OPENAI === '1' || env.MOCK_OPENAI === 'true',
  demoPassword: env.DEMO_PASSWORD || '',
  // A random secret is fine for local runs; set SESSION_SECRET in production so cookies survive restarts.
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  dailyBudgetUsd: Number(env.DAILY_BUDGET_USD) || 5,
  turnstileSecret: env.TURNSTILE_SECRET || '',
  turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
  isProduction,
  // Pages allowed to frame /embed (the main app). Unset in development = the local main app (:3333)
  // and the test host (`npm run embed:host`, :3334); unset in production = nobody.
  allowedParentOrigins: env.ALLOWED_PARENT_ORIGINS !== undefined
    ? parseOrigins(env.ALLOWED_PARENT_ORIGINS)
    : isProduction ? [] : ['http://localhost:3333', 'http://localhost:3334'],

  limits: {
    maxInputChars: 2000,
    maxConversationTurns: 40, // user+assistant messages kept per conversation
    maxToolIterations: 4,
    aiPerMinute: 20,
    aiPerDay: 150,
  },

  // The signed-in Back Office user. In production this is the authenticated session user.
  backofficeUser: {
    distributor_id: 'WQ-100482',
    user_id: 'usr_7f3a91c2',
    display_name: 'Maria Kovač',
    email: 'maria.kovac@example.com',
  },
};

/**
 * Model combinations. Requests use DEFAULT_COMBO unless they pass a known combo key.
 * The browser only ever sends the combo KEY; the server resolves it here, so a client
 * can never pick an arbitrary (expensive) model.
 */
export const COMBOS = {
  support: {
    'luna-terra': {
      label: 'Luna → Terra',
      router: { model: 'gpt-5.6-luna', effort: 'none' },
      answer: { model: 'gpt-5.6-terra', effort: 'low' },
    },
    'luna-luna-deep': {
      label: 'Luna → Luna (deep)',
      router: { model: 'gpt-5.6-luna', effort: 'none' },
      answer: { model: 'gpt-5.6-luna', effort: 'medium' },
    },
    'luna-luna-fast': {
      label: 'Luna → Luna (fast)',
      router: { model: 'gpt-5.6-luna', effort: 'none' },
      answer: { model: 'gpt-5.6-luna', effort: 'low' },
    },
  },
  comp: {
    'luna-sol': {
      label: 'Luna → Sol',
      router: { model: 'gpt-5.6-luna', effort: 'none' },
      agent: { model: 'gpt-5.6-sol', effort: 'low' },
    },
    'luna-terra': {
      label: 'Luna → Terra',
      router: { model: 'gpt-5.6-luna', effort: 'none' },
      agent: { model: 'gpt-5.6-terra', effort: 'medium' },
    },
    'sol-only': {
      label: 'Sol only',
      router: null, // no router: the agent fetches everything through tools
      agent: { model: 'gpt-5.6-sol', effort: 'low' },
    },
  },
};

export const DEFAULT_COMBO = { support: 'luna-terra', comp: 'luna-sol' };

/** Resolve a combo key coming from a cookie/request; unknown keys fall back to the default. */
export function resolveCombo(agent, key) {
  const table = COMBOS[agent];
  const k = key && Object.hasOwn(table, key) ? key : DEFAULT_COMBO[agent];
  return { key: k, ...table[k] };
}
