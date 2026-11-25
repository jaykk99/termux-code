/**
 * Model registry — the uncensored-lineage catalogue termux-code may run.
 *
 * UNCENSORED-ONLY (Jay's order, 2026-10-29; tightened 2026-11-22): this
 * file carries uncensored-lineage models and nothing else. An aligned
 * model is not registered, so there is no aligned model to fall back to —
 * not from a stale phone config, not from a hand-crafted gateway request,
 * not from a provider that happens to be the only one left. Every listing
 * and resolution path still filters through isUncensoredModel
 * (lib/uncensored.mjs — the one owner-editable policy file) as a second
 * check, and Kilo's / Gratisfy's / error-inbox's live lists are filtered
 * the same way so a provider catalogue cannot smuggle one in.
 *
 * Two live catalogues feed the pool: GET {ERROR_INBOX_URL}/api/models
 * (error-inbox's own model switcher: { ok, models:[{key,provider,model,
 * ok,fail,disabled}], prefs:{pinned,disabled} }, key "provider/model") and
 * Gratisfy's /v1/models. Both are filtered here.
 *
 * Kilo and AI Horde need no key at all. The EI-catalog Hugging Face route
 * (`hf`) used to be keyless too, but api-inference.huggingface.co returns
 * empty replies unauthenticated (verified 2026-10-25, even for gpt2), so
 * its models only load when HF_TOKEN is set. Everything else is off until
 * its key is set.
 *
 * REMOVED ON PURPOSE (2026-11-22), do not re-add: every aligned entry the
 * pool used to carry (Groq's GPT-OSS/Qwen, Gemini, NVIDIA NIM, Cerebras,
 * SambaNova, GitHub Models, Mistral, Together, Fireworks, the HF router,
 * Cohere, Anthropic, OmniRoute auto, LLM7's keyless Codestral/MiniMax/
 * Mistral Nemo, Kilo's Nemotron/North) and the two routes that fell back to
 * an aligned model — Pollinations' GPT-OSS 20B and any-worker Horde jobs.
 */

import { isUncensoredModel, UNCENSORED_MARK } from './uncensored.mjs';

const TIMEOUT_MS = 6000;

export const ERROR_INBOX_URL = process.env.ERROR_INBOX_URL || 'https://error-inbox.onrender.com';

/**
 * HF_MODEL may swap the hosted agent's default model, but only to another
 * uncensored-lineage build. 'hf' is a trusted pool provider (its whole
 * catalogue here is Jay's curated Uncensored section), so an unchecked
 * override would carry ANY Hugging Face model past the policy — an aligned
 * one included. A marker-less override is ignored and the pool's first
 * entry stays the default.
 */
const HF_POOL_FIRST = '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF';
const HF_OVERRIDE = typeof process.env.HF_MODEL === 'string' ? process.env.HF_MODEL.trim() : '';
const HF_FIRST = UNCENSORED_MARK.test(HF_OVERRIDE) ? HF_OVERRIDE : HF_POOL_FIRST;

/**
 * label: how it reads in the picker. free: no card/signup required, or a
 * genuinely free tier. auth: 'bearer' | 'none' | 'gemini' | 'cohere' | 'anthropic' | 'horde'.
 * envKey: which env var gates this provider, matching error-inbox's names 1:1.
 */
export const PROVIDERS = {
  bro: {
    label: 'Bro',
    // Jay's own uncensored gateway (Bro). URL is null on purpose: the
    // gateway lives wherever Jay runs it, so {BRO_BASE_URL} supplies it
    // (e.g. a tunnel URL for the VM gateway, or the Render URL) and the
    // provider stays OFF until one is configured — nothing here can
    // point the phone at a gateway Jay never set. The access code is
    // likewise never stored here: BRO_ACCESS_CODE is sent as a Bearer
    // token only when it is set (lib/agent.mjs keyFor), and the gateway
    // itself does not require one today. First in the registry so that,
    // once configured, Bro is tried first and Horde stays the fallback.
    url: null, // {BRO_BASE_URL}/v1/chat/completions — see urlFor/resolveModel
    auth: 'none', // keyless when no code is set; code sent when it is
    envKey: 'BRO_BASE_URL', // gates the provider on: on only when a Bro URL is set
    models: [{ id: 'bro', label: 'Bro (uncensored gateway)', free: true }],
  },
  kilo: {
    label: 'Kilo',
    url: 'https://api.kilo.ai/api/gateway/chat/completions',
    auth: 'none',
    envKey: null, // always on — no key exists for this provider
    // No hardcoded ids: every one Kilo used to pin here was aligned
    // (Nemotron / North Mini Code) and never entered the pool anyway. Kilo
    // contributes only what its live list returns and filterKiloFreeModels
    // finds marker-carrying; an opaque router like kilo-auto stays out for
    // the same reason.
    models: [],
  },
  llm7: {
    label: 'LLM7',
    url: 'https://api.llm7.io/v1/chat/completions',
    auth: 'none',
    // The provider itself stays keyless (KEYLESS below) — LLM7_API_KEY is
    // only sent when it is set, which upgrades the quota and unlocks the
    // key-gated uncensored entry. The free key takes a minute on llm7.io
    // and is the cheapest way to add an uncensored route that is not
    // Horde's queue.
    envKey: 'LLM7_API_KEY',
    models: [
      // The only uncensored-lineage id in LLM7's 87-model catalogue; its
      // Codestral / MiniMax / Mistral Nemo entries were aligned and are no
      // longer registered. Verified live 2026-11-22: listed free-tier, but
      // a keyless POST is a 401 missing_api_key, so the per-model envKey
      // keeps it out of the plan until LLM7_API_KEY is set and it can never
      // burn a keyless attempt.
      { id: 'gemma-4-uncensored', label: 'Gemma 4 Uncensored (LLM7 free key)', free: true, envKey: 'LLM7_API_KEY' },
    ],
  },
  horde: {
    label: 'AI Horde',
    url: 'https://aihorde.net/api/v2/generate/text/async',
    auth: 'horde',
    envKey: null, // AIHORDE_API_KEY optional, anonymous key works
    models: [{ id: 'any', label: 'Any uncensored worker online (auto)', free: true }],
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    auth: 'bearer',
    envKey: 'OPENROUTER_API_KEY',
    // OpenRouter's eleven :free routes carry no uncensored-lineage model
    // (checked live 2026-11-22), so these are the paid uncensored ids
    // instead. They make an existing OPENROUTER_API_KEY useful to an
    // uncensored-only pool: before this the provider contributed nothing
    // but aligned entries, which every list filters out.
    models: [
      { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', label: 'Dolphin Mistral 24B Venice Edition', free: false },
      { id: 'sao10k/l3.1-euryale-70b', label: 'Euryale L3.1 70B', free: false },
      { id: 'anthracite-org/magnum-v4-72b', label: 'Magnum v4 72B', free: false },
      { id: 'nousresearch/hermes-4-405b', label: 'Hermes 4 405B', free: false },
      { id: 'gryphe/mythomax-l2-13b', label: 'MythoMax L2 13B', free: false },
    ],
  },
  deepinfra: {
    label: 'DeepInfra',
    url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    auth: 'bearer',
    envKey: 'DEEPINFRA_API_KEY',
    models: [
      // The one uncensored-lineage model DeepInfra hosts (verified in its
      // live /v1/openai/models on 2026-11-22). Its Llama/Qwen entries were
      // aligned and are no longer registered.
      { id: 'Sao10K/L3.1-70B-Euryale-v2.2', label: 'Euryale L3.1 70B v2.2', free: false },
    ],
  },
  venice: {
    label: 'Venice',
    // The most uncensored-first catalogue of any provider here: Venice
    // ships its own uncensored line (venice-uncensored-*) plus abliterated
    // builds of Gemma/GLM/DeepSeek. OpenAI-compatible, bearer auth.
    url: 'https://api.venice.ai/api/v1/chat/completions',
    auth: 'bearer',
    envKey: 'VENICE_API_KEY',
    // Every id below is from Venice's live /api/v1/models on 2026-11-22
    // (that route answers keyless; completions need the key, which is why
    // the provider is gated). Its aligned models are simply not listed —
    // the registry lists what this pool may run, not everything a
    // provider sells.
    models: [
      { id: 'venice-uncensored-1-2', label: 'Venice Uncensored 1.2', free: false },
      { id: 'venice-uncensored-role-play', label: 'Venice Uncensored Role Play', free: false },
      { id: 'gemma-4-uncensored', label: 'Gemma 4 Uncensored', free: false },
      { id: 'glm-5-3-flash-uncensored', label: 'GLM 5.3 Flash Uncensored', free: false },
      { id: 'deepseek-v4-1-flash-uncensored', label: 'DeepSeek V4.1 Flash Uncensored', free: false },
      { id: 'abliteration-abliterated-model-large-flash', label: 'Abliterated Large Flash', free: false },
    ],
  },
  naga: {
    label: 'Naga',
    // Naga is a second independent host for the well-known uncensored
    // finetunes (Dolphin, Euryale, Magnum, Hermes, MythoMax), so one dead
    // host no longer takes the whole family out of the chain. Ids verified
    // against its live /v1/models on 2026-11-22; completions need
    // NAGA_API_KEY (keyless POST is 401 authentication_required).
    url: 'https://api.naga.ac/v1/chat/completions',
    auth: 'bearer',
    envKey: 'NAGA_API_KEY',
    models: [
      { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', label: 'Dolphin Mistral 24B Venice Edition', free: false },
      { id: 'sao10k/l3.1-euryale-70b', label: 'Euryale L3.1 70B', free: false },
      { id: 'anthracite-org/magnum-v4-72b', label: 'Magnum v4 72B', free: false },
      { id: 'nousresearch/hermes-4-405b', label: 'Hermes 4 405B', free: false },
      { id: 'gryphe/mythomax-l2-13b', label: 'MythoMax L2 13B', free: false },
    ],
  },
  // Wire-shape parity only: no model is registered for these two, because
  // every model they sell is aligned. The entries stay so keyFor() and the
  // Anthropic/Cohere dispatchers keep error-inbox's exact request shape;
  // resolveModel() finds no entry, so neither can ever run a turn.
  cohere: {
    label: 'Cohere',
    url: 'https://api.cohere.com/v2/chat',
    auth: 'cohere',
    envKey: 'COHERE_API_KEY',
    models: [],
  },
  anthropic: {
    label: 'Anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    auth: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: [],
  },
  hf: {
    label: 'Hugging Face (EI catalog)',
    // Error Inbox's own wire shape for catalog source "huggingface"
    // (error-inbox lib/llm/adapters.ts): POST {url}/{model id} with
    // { inputs, parameters } — NOT the OpenAI chat/completions shape.
    // Keyless exactly like error-inbox calls it;
    // HF_TOKEN / HUGGINGFACE_API_KEY only upgrade the quota when set.
    url: 'https://api-inference.huggingface.co/models',
    auth: 'hf',
    envKey: 'HF_TOKEN', // optional — this provider is on with or without it
    // Jay's Inbox Models pool, Uncensored section, in pool order
    // (2026-10-23). The first entry is the hosted agent's default model;
    // HF_MODEL swaps it only to another marker-carrying uncensored build
    // (the HF_FIRST guard above). The rest stay in the chain in order so
    // failover walks the same list.
    models: [
      { id: HF_FIRST, label: 'Qwen3.8 27B Heretic Abliterated Uncensored (GGUF)', free: true },
      { id: 'AEON-7/Qwen3.8-27B-AEON-ULTIMATE-UNCENSORED-BF16', label: 'Qwen3.8 27B AEON Ultimate Uncensored (BF16)', free: true },
      { id: 'DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF', label: 'GLM 4.7 Flash Uncensored Heretic NEO CODE (GGUF)', free: true },
      { id: 'DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF', label: 'Llama 3.2 8X3B MOE Dark Champion Uncensored (GGUF)', free: true },
      { id: 'DavidAU/OpenAi-GPT-oss-20b-HERETIC-uncensored-NEO-Imatrix-gguf', label: 'GPT-OSS 20B Heretic Uncensored (GGUF)', free: true },
      { id: 'DavidAU/OpenAi-GPT-oss-20b-abliterated-uncensored-NEO-Imatrix-gguf', label: 'GPT-OSS 20B Abliterated Uncensored (GGUF)', free: true },
    ],
  },
  gratisfy: {
    label: 'Gratisfy',
    url: null, // {GRATISFY_BASE_URL}/chat/completions — discovered live, no fixed list
    auth: 'bearer',
    envKey: 'GRATISFY_API_KEY',
    models: [], // populated at runtime from Gratisfy's own /v1/models
  },
};

/** True for providers that work with no key at all. */
const KEYLESS = new Set(['kilo', 'llm7', 'horde']);

/**
 * The models actually usable right now, given which env vars are set —
 * exactly the same gating error-inbox's own buildPool() applies, then
 * the uncensored-only filter (lib/uncensored.mjs): a provider being on
 * makes its UNCENSORED entries usable, never its aligned ones.
 */
export function directModels(env = process.env) {
  const out = [];
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    const on = KEYLESS.has(provider) || (cfg.envKey && env[cfg.envKey]);
    if (!on) continue;
    for (const m of cfg.models) {
      // A single entry can need its own key (LLM7's uncensored Gemma is
      // key-gated while the rest of LLM7 is keyless): leave it out of the
      // plan without one instead of spending an attempt on a certain 401.
      if (m.envKey && !env[m.envKey]) continue;
      const model = {
        id: m.id,
        label: m.label,
        provider,
        providerLabel: cfg.label,
        source: 'direct',
        free: m.free,
        auth: cfg.auth,
        url: cfg.url,
      };
      if (isUncensoredModel(model)) out.push(model);
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
 * Uncensored check for a row from a LIVE catalogue (error-inbox's pool, Kilo,
 * Gratisfy, Horde).
 *
 * The curated-pool shortcut in isUncensoredModel (`hf` ⇒ uncensored) is a
 * claim about OUR catalogue, not about a live one. error-inbox's pool is
 * mostly aligned models, so its `hf` rows inherited that trust and an aligned
 * repo such as `meta-llama/Llama-3.1-8B-Instruct` was listed — and resolvable
 * on the gateway — as uncensored. A live row has to carry an uncensored
 * marker itself.
 */
export function isUncensoredLiveModel(m) {
  if (!isUncensoredModel(m)) return false;
  if (m?.provider !== 'hf') return true;
  return UNCENSORED_MARK.test(m.id || '') || UNCENSORED_MARK.test(m.label || '');
}

/**
 * error-inbox's real /api/models: { ok, models:[{key,provider,model,ok,fail,
 * disabled}], prefs:{pinned,disabled} }. key is "provider/model" — the same
 * format modelKey() uses server-side, so pin/disable round-trips cleanly.
 * The live route sits behind error-inbox's default-deny API gate, so an
 * anonymous fetch 401s and this leg yields no models — the CLI then falls
 * back to the direct pool. Set ERROR_INBOX_KEY and it's sent as a bearer
 * token.
 */
export async function fetchErrorInboxModels() {
  const key = process.env.ERROR_INBOX_KEY;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const payload = await getJSON(ERROR_INBOX_URL.replace(/\/$/, '') + '/api/models', headers);
  if (!payload?.ok || !Array.isArray(payload.models)) return { models: [], prefs: null };

  const models = payload.models
    .map((m) => ({
      id: m.key, // "provider/model" — what pin/disable expects back
      label: `${m.model} (${m.ok}/${m.ok + m.fail} recent)`,
      provider: m.provider,
      providerLabel: m.provider,
      source: 'error-inbox',
      free: undefined,
      disabled: m.disabled,
      stats: { ok: m.ok, fail: m.fail },
    }))
    // error-inbox's pool is mostly aligned models; only its uncensored
    // section is ever shown or run here (lib/uncensored.mjs). A live row is
    // checked with the live rule: the `hf` pool shortcut does not apply to a
    // catalogue we do not curate.
    .filter((m) => isUncensoredLiveModel(m));
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
  return rows
    .map((r) => ({
      id: r.id,
      label: r.id,
      provider: 'gratisfy',
      providerLabel: 'Gratisfy',
      source: 'direct',
      free: true,
      auth: 'bearer',
      url: base + '/chat/completions',
    }))
    .filter((m) => isUncensoredModel(m));
}

/** Kilo's live model list, filtered to what is actually free keyless
 * AND uncensored-lineage. Hardcoded ids rot (three were already gone
 * from the live list, and their replacements kept answering BAD_MODEL —
 * "Unknown model" — turn after turn); the live list is the source of
 * truth when it answers, and it doubles as the validation step: an id
 * Kilo no longer serves is simply not in it, so it never enters the
 * plan. The hardcoded list stays as the fallback when it does not
 * answer. kilo-auto is gone from BOTH lists: it is an opaque router
 * that can land on an aligned model, so it fails the uncensored-only
 * filter like every other aligned entry. */
export function filterKiloFreeModels(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.id === 'string' && r.id.endsWith(':free'))
    .map((r) => ({
      id: r.id,
      label: r.name || r.id,
      provider: 'kilo',
      providerLabel: 'Kilo',
      source: 'direct',
      free: true,
      auth: 'none',
      url: PROVIDERS.kilo.url,
    }))
    .filter((m) => isUncensoredModel(m))
    .slice(0, 12);
}

export async function fetchKiloModels() {
  const payload = await getJSON('https://api.kilo.ai/api/gateway/v1/models');
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return filterKiloFreeModels(rows);
}

/**
 * The parameter count in a worker name: "L3-8B-Stheno" → 8, "Gemma-4-E4B" → 4,
 * "Judas-Uncensored-3.2-1B.Q8" → 1. Used to sort the queue biggest-first: on
 * uncensored-lineage weights the larger build is the smarter one, and "any"
 * used to be the only Horde entry a phone with no keys ever saw.
 */
export function hordeParams(name) {
  const m = /(\d+(?:\.\d+)?)\s*B(?![A-Za-z0-9])/i.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

/**
 * The uncensored workers online on AI Horde right now, one entry each.
 *
 * Horde is the only keyless route left, and it used to surface as a single
 * nameless "any" row: `/models` on a phone with no keys showed one entry, so
 * there was nothing to pick and no way to aim a job at a bigger, smarter
 * uncensored worker. The queue's own status feed names every worker, so the
 * list is built from it — biggest first, then most workers — and callHorde
 * restricts a pinned pick to that worker.
 */
export async function fetchHordeLiveModels(env = process.env) {
  const key = (typeof env.AIHORDE_API_KEY === 'string' && env.AIHORDE_API_KEY) || '0000000000';
  const rows = await getJSON('https://aihorde.net/api/v2/status/models?type=text', {
    apikey: key,
    'Client-Agent': 'termux-code:1.0',
  });
  if (!Array.isArray(rows)) return [];
  // The feed can carry the same model name on two worker rows (a kudos /
  // priority split), and /models must not offer the same pick twice: one
  // entry per model, worker counts summed.
  const byName = new Map();
  for (const r of rows) {
    if (typeof r?.name !== 'string' || (r.count || 0) <= 0 || !UNCENSORED_MARK.test(r.name)) continue;
    const name = r.name.trim();
    const hit = byName.get(name);
    if (hit) {
      hit.workers += r.count || 0;
      continue;
    }
    const params = hordeParams(name);
    const short = name.split('/').pop();
    byName.set(name, {
      id: name,
      label: params ? `${short} (${params}B)` : short,
      provider: 'horde',
      providerLabel: 'AI Horde',
      source: 'direct',
      free: true,
      auth: 'horde',
      url: PROVIDERS.horde.url,
      params,
      workers: r.count || 0,
    });
  }
  return [...byName.values()]
    .sort((a, b) => (b.params ?? 0) - (a.params ?? 0) || (b.workers ?? 0) - (a.workers ?? 0))
    .slice(0, 12);
}

/** Everything reachable right now: direct pool + Kilo's live list + Gratisfy's live list + error-inbox's. */
export async function listModels(env = process.env) {
  const [gratisfy, inbox, kiloLive, hordeLive] = await Promise.all([
    fetchGratisfyModels(env),
    fetchErrorInboxModels(),
    fetchKiloModels(),
    fetchHordeLiveModels(env),
  ]);
  let direct = directModels(env);
  if (kiloLive.length) {
    const firstKilo = direct.findIndex((m) => m.provider === 'kilo');
    const rest = direct.filter((m) => m.provider !== 'kilo');
    rest.splice(firstKilo === -1 ? rest.length : firstKilo, 0, ...kiloLive);
    direct = rest;
  }
  if (!hordeLive.length) return [...direct, ...gratisfy, ...inbox.models];
  // The workers by name, then "any uncensored worker" as the explicit
  // auto-pick — a worker that goes offline between listing and asking still
  // leaves the route usable without ever allowing an aligned any-worker job.
  const pos = direct.findIndex((m) => m.provider === 'horde');
  const anyEntry = direct.find((m) => m.provider === 'horde' && m.id === 'any');
  const horde = [...hordeLive, ...(anyEntry ? [anyEntry] : [])];
  const rest = direct.filter((m) => m.provider !== 'horde');
  rest.splice(pos === -1 ? rest.length : pos, 0, ...horde);
  return [...rest, ...gratisfy, ...inbox.models];
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
    // differ from OpenAI's and aren't wired here. Horde is a text queue,
    // and the EI-catalog HF route is a plain text-generation call.
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
    // A keyed bearer provider resolves only when its key is set — without
    // one the call can only 401, so the gateway must not be talked into it.
    // (HF's route is auth 'hf' with an optional token and still resolves
    // without one; keyless providers have no envKey at all.)
    if (cfg.auth === 'bearer' && cfg.envKey && !env[cfg.envKey]) return null;
    // Same per-model key gate as directModels(): a key-gated entry is not
    // resolvable without its key, so the gateway cannot be asked to call it.
    if (entry?.envKey && !env[entry.envKey]) return null;
    if (!entry) {
      // Gratisfy ids are live, not hardcoded — check the live list
      // (which is already uncensored-filtered, so a hit is servable).
      if (provider === 'gratisfy' && env.GRATISFY_API_KEY) {
        const live = await fetchGratisfyModels(env);
        const hit = live.find((m) => m.id === id);
        if (hit) return hit;
      }
      // Horde workers are live, not hardcoded: a pick from /models names one
      // online uncensored worker, and it resolves only while that worker is
      // still in the queue's feed.
      if (provider === 'horde') {
        const live = await fetchHordeLiveModels(env);
        const hit = live.find((m) => m.id === id);
        if (hit) return hit;
      }
      return null;
    }
    const url =
      provider === 'bro'
        ? env.BRO_BASE_URL
          ? `${env.BRO_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`
          : null
        : cfg.url;
    if (!url) return null;
    const model = {
      id: entry.id,
      label: entry.label,
      provider,
      providerLabel: cfg.label,
      source: 'direct',
      free: entry.free,
      auth: cfg.auth,
      url,
    };
    // Uncensored-only: a registry entry for an aligned model is inert —
    // it resolves to nothing, so the gateway can never be made to run
    // it, by a stale phone config or a hand-crafted request alike.
    return isUncensoredModel(model) ? model : null;
  }

  if (source === 'error-inbox') {
    // Error Inbox's pool models: the wire shape here matches what error-inbox
    // calls directly, so we call it the same way — provider config from our
    // registry, model id as error-inbox reported it.
    const cfg = PROVIDERS[provider];
    if (!cfg) return null;
    const model = {
      id,
      label: id,
      provider,
      providerLabel: cfg.label,
      source: 'error-inbox',
      free: undefined,
      auth: cfg.auth,
      url: cfg.url,
    };
    // Same live rule as fetchErrorInboxModels(): a client-supplied hf id is
    // not uncensored just because the provider is our curated pool. Without
    // this, a hand-crafted request could run an aligned HF repo through the
    // gateway by claiming source "error-inbox".
    return isUncensoredLiveModel(model) ? model : null;
  }

  return null;
}

/** Annotate a public model list with honest capabilities. */
export function withCapabilities(models) {
  return models.map((m) => ({ ...m, capabilities: capabilities(m) }));
}
