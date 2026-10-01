/**
 * Model registry — mirrors error-inbox's real pool (lib/llm.ts, pulled from
 * source on 2026-09-11) instead of guessing at one. Two catalogues:
 *
 *   1. `POOL`          — every model error-inbox itself knows how to call,
 *                        with the exact base URL and auth style it uses.
 *                        Gated on the same env var names error-inbox uses,
 *                        so an existing .env can be copied over verbatim.
 *   2. Error Inbox live — GET {ERROR_INBOX_URL}/api/models, the real route
 *                        that backs error-inbox's own model switcher. Shape:
 *                        { ok, models:[{key,provider,model,ok,fail,disabled}],
 *                        prefs:{pinned,disabled} }. key is "provider/model".
 *
 * Three providers need no key at all: Kilo, LLM7, and AI Horde. Pollinations
 * is in error-inbox's source but currently excluded from its pool (its free
 * endpoint returns 402 upstream) — left out here for the same reason.
 * Everything else is off until its key is set, exactly like error-inbox.
 */

const TIMEOUT_MS = 6000;

export const ERROR_INBOX_URL = process.env.ERROR_INBOX_URL || 'https://error-inbox.vercel.app';

/**
 * label: how it reads in the picker. free: no card/signup required, or a
 * genuinely free tier. auth: 'bearer' | 'none' | 'gemini' | 'cohere' | 'anthropic' | 'horde'.
 * envKey: which env var gates this provider, matching error-inbox's names 1:1.
 */
export const PROVIDERS = {
  kilo: {
    label: 'Kilo',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    auth: 'none',
    envKey: null, // always on — no key exists for this provider
    models: [
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', label: 'Nemotron 3 Nano Omni Reasoning', free: true },
      { id: 'kilo-auto/free', label: 'Kilo Auto (routes to best free model)', free: true },
      { id: 'cohere/north-mini-code:free', label: 'North Mini Code', free: true },
      { id: 'minimax/minimax-m2.7:free', label: 'MiniMax M2.7', free: true },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B', free: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super 120B', free: true },
      { id: 'minimax/minimax-m3:free', label: 'MiniMax M3', free: true },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning', free: true },
      { id: 'stealth/ox-alpha', label: 'Stealth Ox Alpha', free: true },
    ],
  },
  llm7: {
    label: 'LLM7',
    url: 'https://api.llm7.io/v1/chat/completions',
    auth: 'none',
    envKey: null,
    models: [
      { id: 'codestral-latest', label: 'Codestral (best keyless model)', free: true },
      { id: 'minimax-m2.7', label: 'MiniMax M2.7', free: true },
      { id: 'mistral-Nemo-Instruct-2407', label: 'Mistral Nemo Instruct', free: true },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite (keyless)', free: true },
    ],
  },
  horde: {
    label: 'AI Horde',
    url: 'https://aihorde.net/api/v2/generate/text/async',
    auth: 'horde',
    envKey: null, // AIHORDE_API_KEY optional, anonymous key works
    models: [{ id: 'any', label: 'Any available worker (slow, last resort)', free: true }],
  },
  groq: {
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    auth: 'bearer',
    envKey: 'GROQ_API_KEY',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', free: true },
      { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', free: true },
    ],
  },
  gemini: {
    label: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    auth: 'gemini',
    envKey: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', free: true },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', free: true },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    auth: 'bearer',
    envKey: 'OPENROUTER_API_KEY',
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra 550B', free: true },
      { id: 'cohere/north-mini-code:free', label: 'North Mini Code', free: true },
    ],
  },
  nvidia: {
    label: 'NVIDIA NIM',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    auth: 'bearer',
    envKey: 'NVIDIA_API_KEY',
    models: [
      { id: 'z-ai/glm-5.2', label: 'GLM 5.2', free: true },
      { id: 'z-ai/glm-5.1', label: 'GLM 5.1', free: true },
      { id: 'poolside/laguna-xs-2.1', label: 'Laguna XS 2.1', free: true },
    ],
  },
  cerebras: {
    label: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    auth: 'bearer',
    envKey: 'CEREBRAS_API_KEY',
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', free: true },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', free: true },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', free: true },
    ],
  },
  sambanova: {
    label: 'SambaNova',
    url: 'https://api.sambanova.ai/v1/chat/completions',
    auth: 'bearer',
    envKey: 'SAMBANOVA_API_KEY',
    models: [
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', free: true },
      { id: 'Llama-4-Maverick-17B-128E-Instruct', label: 'Llama 4 Maverick', free: true },
      { id: 'DeepSeek-V3-0324', label: 'DeepSeek V3', free: true },
    ],
  },
  githubmodels: {
    label: 'GitHub Models',
    url: 'https://models.github.ai/inference/chat/completions',
    auth: 'bearer',
    envKey: 'GITHUB_MODELS_TOKEN',
    models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', free: true },
      { id: 'meta/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', free: true },
      { id: 'openai/gpt-4.1-mini', label: 'GPT-4.1 Mini', free: true },
    ],
  },
  mistral: {
    label: 'Mistral',
    url: 'https://api.mistral.ai/v1/chat/completions',
    auth: 'bearer',
    envKey: 'MISTRAL_API_KEY',
    models: [
      { id: 'mistral-small-latest', label: 'Mistral Small', free: true },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo', free: true },
      { id: 'codestral-latest', label: 'Codestral', free: true },
    ],
  },
  together: {
    label: 'Together AI',
    url: 'https://api.together.xyz/v1/chat/completions',
    auth: 'bearer',
    envKey: 'TOGETHER_API_KEY',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', label: 'Llama 3.3 70B (free)', free: true },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', label: 'Llama 3.1 8B Turbo', free: false },
    ],
  },
  fireworks: {
    label: 'Fireworks',
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    auth: 'bearer',
    envKey: 'FIREWORKS_API_KEY',
    models: [{ id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B', free: false }],
  },
  deepinfra: {
    label: 'DeepInfra',
    url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    auth: 'bearer',
    envKey: 'DEEPINFRA_API_KEY',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', free: false },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B', free: false },
    ],
  },
  huggingface: {
    label: 'Hugging Face',
    url: 'https://router.huggingface.co/v1/chat/completions',
    auth: 'bearer',
    envKey: 'HF_TOKEN',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', free: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B', free: true },
    ],
  },
  gratisfy: {
    label: 'Gratisfy',
    url: null, // {GRATISFY_BASE_URL}/chat/completions — discovered live, no fixed list
    auth: 'bearer',
    envKey: 'GRATISFY_API_KEY',
    models: [], // populated at runtime from Gratisfy's own /v1/models
  },
  omniroute: {
    label: 'OmniRoute',
    url: null, // {OMNIROUTE_BASE_URL}/v1/chat/completions — self-hosted
    auth: 'bearer',
    envKey: 'OMNIROUTE_API_KEY',
    models: [{ id: 'auto', label: 'Auto (OmniRoute picks the route)', free: true }],
  },
  cohere: {
    label: 'Cohere',
    url: 'https://api.cohere.com/v2/chat',
    auth: 'cohere',
    envKey: 'COHERE_API_KEY',
    // Empty on purpose: error-inbox's own pool currently excludes Cohere — both
    // command-a models read 0% on its live health page (trial key exhausted).
    // Add real ids here once a working key is in place.
    models: [],
  },
  anthropic: {
    label: 'Anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    auth: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: [{ id: process.env.ANTHROPIC_MODEL || 'claude-opus-5', label: 'Claude (heavy tier)', free: false }],
  },
};

/** True for providers that work with no key at all. */
const KEYLESS = new Set(['kilo', 'llm7', 'horde']);

/**
 * The models actually usable right now, given which env vars are set —
 * exactly the same gating error-inbox's own buildPool() applies.
 */
export function directModels(env = process.env) {
  const out = [];
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    const on = KEYLESS.has(provider) || (cfg.envKey && env[cfg.envKey]);
    if (!on) continue;
    for (const m of cfg.models) {
      out.push({
        id: m.id,
        label: m.label,
        provider,
        providerLabel: cfg.label,
        source: 'direct',
        free: m.free,
        auth: cfg.auth,
        url: cfg.url,
      });
    }
  }
  return out;
}

async function getJSON(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * error-inbox's real /api/models: { ok, models:[{key,provider,model,ok,fail,
 * disabled}], prefs:{pinned,disabled} }. key is "provider/model" — the same
 * format modelKey() uses server-side, so pin/disable round-trips cleanly.
 * No auth header is sent; the route reads open in current source. If that
 * changes, set ERROR_INBOX_KEY and it's sent as a bearer token.
 */
export async function fetchErrorInboxModels() {
  const key = process.env.ERROR_INBOX_KEY;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const payload = await getJSON(ERROR_INBOX_URL.replace(/\/$/, '') + '/api/models', headers);
  if (!payload?.ok || !Array.isArray(payload.models)) return { models: [], prefs: null };

  const models = payload.models.map((m) => ({
    id: m.key, // "provider/model" — what pin/disable expects back
    label: `${m.model} (${m.ok}/${m.ok + m.fail} recent)`,
    provider: m.provider,
    providerLabel: m.provider,
    source: 'error-inbox',
    free: undefined,
    disabled: m.disabled,
    stats: { ok: m.ok, fail: m.fail },
  }));
  return { models, prefs: payload.prefs };
}

/** Pin or disable models on the live error-inbox pool. Mirrors the POST body exactly. */
export async function setErrorInboxPrefs({ pinned, disabled }) {
  const key = process.env.ERROR_INBOX_KEY;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(ERROR_INBOX_URL.replace(/\/$/, '') + '/api/models', {
    method: 'POST',
    headers,
    body: JSON.stringify({ pinned: pinned ?? null, disabled: disabled ?? [] }),
  });
  return res.json();
}

/**
 * Gratisfy's uncapped models are discovered live rather than hardcoded, same
 * as error-inbox does — a fixed list goes stale.
 */
export async function fetchGratisfyModels(env = process.env) {
  if (!env.GRATISFY_API_KEY) return [];
  const base = env.GRATISFY_BASE_URL || 'https://api.gratisfy.xyz/v1';
  const payload = await getJSON(base + '/models', { Authorization: `Bearer ${env.GRATISFY_API_KEY}` });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((r) => ({
    id: r.id,
    label: r.id,
    provider: 'gratisfy',
    providerLabel: 'Gratisfy',
    source: 'direct',
    free: true,
    auth: 'bearer',
    url: base + '/chat/completions',
  }));
}

/** Everything reachable right now: direct pool + Gratisfy's live list + error-inbox's. */
export async function listModels() {
  const [gratisfy, inbox] = await Promise.all([fetchGratisfyModels(), fetchErrorInboxModels()]);
  return [...directModels(), ...gratisfy, ...inbox.models];
}

export function groupBySource(models) {
  return models.reduce((acc, m) => {
    (acc[m.source] ||= []).push(m);
    return acc;
  }, {});
}

/**
 * Trusted model resolution + honest capability reporting.
 *
 * The gateway never trusts a client-supplied model object: `resolveModel`
 * rebuilds the full model from the server-side registry using only the
 * (id, provider, source) triple. This closes an SSRF hole where a client
 * could set `model.url` to an internal address and have the gateway fetch
 * it — every URL and auth style now comes from config, never the wire.
 */

/** Providers whose completions here can actually drive tools. */
const TOOL_CAPABLE_AUTH = new Set(['bearer', 'none', 'anthropic']);

/** What this model can honestly do through the gateway. */
export function capabilities(model) {
  return {
    chat: true,
    tools: TOOL_CAPABLE_AUTH.has(model.auth),
    // Gemini and Cohere answer in text only; their function-calling shapes
    // differ from OpenAI's and aren't wired here. Horde is a text queue.
  };
}

/**
 * Rebuild a trusted model object from an untrusted client reference.
 * Returns null when the triple isn't in the registry. Gratisfy models are
 * live-discovered, so their ids are checked against the live list.
 */
export async function resolveModel(ref, env = process.env) {
  if (!ref || typeof ref !== 'object') return null;
  const { id, provider, source } = ref;
  if (typeof id !== 'string' || typeof provider !== 'string' || typeof source !== 'string') return null;
  if (id.length === 0 || id.length > 300) return null;

  if (source === 'direct') {
    const cfg = PROVIDERS[provider];
    if (!cfg) return null;
    const entry = cfg.models.find((m) => m.id === id);
    if (!entry) {
      // Gratisfy ids are live, not hardcoded — check the live list.
      if (provider === 'gratisfy' && env.GRATISFY_API_KEY) {
        const live = await fetchGratisfyModels(env);
        const hit = live.find((m) => m.id === id);
        if (hit) return hit;
      }
      return null;
    }
    const url = provider === 'omniroute' ? `${env.OMNIROUTE_BASE_URL}/v1/chat/completions` : cfg.url;
    if (!url) return null;
    return {
      id: entry.id,
      label: entry.label,
      provider,
      providerLabel: cfg.label,
      source: 'direct',
      free: entry.free,
      auth: cfg.auth,
      url,
    };
  }

  if (source === 'error-inbox') {
    // Error Inbox's pool models: the wire shape here matches what error-inbox
    // calls directly, so we call it the same way — provider config from our
    // registry, model id as error-inbox reported it.
    const cfg = PROVIDERS[provider];
    if (!cfg) return null;
    return {
      id,
      label: id,
      provider,
      providerLabel: cfg.label,
      source: 'error-inbox',
      free: undefined,
      auth: cfg.auth,
      url: cfg.url,
    };
  }

  return null;
}

/** Annotate a public model list with honest capabilities. */
export function withCapabilities(models) {
  return models.map((m) => ({ ...m, capabilities: capabilities(m) }));
}
