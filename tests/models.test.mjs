/**
 * Tests for lib/models.mjs — the provider registry, gating, and the
 * trusted model resolution that closes the SSRF hole.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  directModels,
  filterKiloFreeModels,
  fetchGratisfyModels,
  fetchKiloModels,
  fetchErrorInboxModels,
  setErrorInboxPrefs,
  capabilities,
  resolveModel,
  withCapabilities,
  groupBySource,
} from '../lib/models.mjs';
import { isUncensoredModel } from '../lib/uncensored.mjs';

const EMPTY_ENV = {};

describe('directModels()', () => {
  it('enables the keyless uncensored routes (AI Horde + Pollinations GPT-OSS) with no env at all', () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('horde'));
    assert.ok(providers.has('pollinations'));
    // Kilo / LLM7 are keyless too, but their current catalogues carry no
    // uncensored-lineage model, so they contribute nothing — keyless was
    // never the criterion, uncensored is.
    assert.ok(!providers.has('kilo'));
    assert.ok(!providers.has('llm7'));
  });

  it('hands out uncensored-lineage models only, whatever keys are set', () => {
    const allKeys = Object.fromEntries(
      Object.values(PROVIDERS).map((c) => c.envKey).filter(Boolean).map((k) => [k, 'x'])
    );
    const models = directModels({ ...EMPTY_ENV, ...allKeys });
    assert.ok(models.length > 0);
    assert.ok(models.every((m) => isUncensoredModel(m)));
    const ids = models.map((m) => `${m.provider}/${m.id}`);
    assert.ok(!ids.some((k) => k.includes('claude')));
    assert.ok(!ids.some((k) => k.includes('gemini')));
    assert.ok(!ids.some((k) => k.includes('gpt-4o')));
  });

  it('keeps keyed providers off until their key is set', () => {
    const before = directModels(EMPTY_ENV).map((m) => m.provider);
    assert.ok(!before.includes('hf'));
    const after = directModels({ ...EMPTY_ENV, HF_TOKEN: 'x' }).map((m) => m.provider);
    assert.ok(after.includes('hf'));
    // A key does not resurrect a provider whose models are all aligned.
    const groqKeyed = directModels({ ...EMPTY_ENV, GROQ_API_KEY: 'x' }).map((m) => m.provider);
    assert.ok(!groqKeyed.includes('groq'));
  });

  it('marks every model with its source', () => {
    for (const m of directModels(EMPTY_ENV)) {
      assert.equal(m.source, 'direct');
      assert.ok(m.id && m.provider && m.url !== undefined);
    }
  });
});

describe('capabilities()', () => {
  it('gives bearer/none providers tool support', () => {
    assert.equal(capabilities({ auth: 'bearer' }).tools, true);
    assert.equal(capabilities({ auth: 'none' }).tools, true);
    assert.equal(capabilities({ auth: 'anthropic' }).tools, true);
  });

  it('keeps gemini/cohere/horde text-only', () => {
    for (const auth of ['gemini', 'cohere', 'horde']) {
      const caps = capabilities({ auth });
      assert.equal(caps.chat, true);
      assert.equal(caps.tools, false);
    }
  });
});

describe('resolveModel()', () => {
  it('rebuilds a trusted model from the (id, provider, source) triple', async () => {
    const m = await resolveModel({ id: 'any', provider: 'horde', source: 'direct' }, EMPTY_ENV);
    assert.ok(m);
    assert.equal(m.id, 'any');
    assert.equal(m.url, PROVIDERS.horde.url);
    assert.equal(m.auth, 'horde');
  });

  it('returns null for unknown provider/model triples', async () => {
    assert.equal(await resolveModel({ id: 'nope', provider: 'kilo', source: 'direct' }, EMPTY_ENV), null);
    assert.equal(await resolveModel({ id: 'any', provider: 'evil', source: 'direct' }, EMPTY_ENV), null);
  });

  it('returns null for aligned registry entries — they are inert, key or no key', async () => {
    assert.equal(
      await resolveModel({ id: 'openai/gpt-oss-120b', provider: 'groq', source: 'direct' }, { GROQ_API_KEY: 'x' }),
      null
    );
    assert.equal(
      await resolveModel({ id: 'gemini-2.5-flash', provider: 'gemini', source: 'direct' }, { GEMINI_API_KEY: 'x' }),
      null
    );
    assert.equal(
      await resolveModel({ id: 'openai/gpt-4o-mini', provider: 'githubmodels', source: 'error-inbox' }, EMPTY_ENV),
      null
    );
  });

  it('rejects malformed refs and overlong ids', async () => {
    assert.equal(await resolveModel(null), null);
    assert.equal(await resolveModel('any'), null);
    assert.equal(await resolveModel({ id: '', provider: 'horde', source: 'direct' }), null);
    assert.equal(await resolveModel({ id: 'x'.repeat(301), provider: 'horde', source: 'direct' }), null);
    assert.equal(await resolveModel({ id: 'any', provider: 'horde', source: 'weird' }), null);
  });

  it('never trusts a client-supplied URL', async () => {
    const m = await resolveModel(
      { id: 'any', provider: 'horde', source: 'direct', url: 'http://169.254.169.254/' },
      EMPTY_ENV
    );
    assert.ok(m);
    assert.equal(m.url, PROVIDERS.horde.url);
  });

  it('does not resolve omniroute auto: an opaque router is not an uncensored model', async () => {
    assert.equal(
      await resolveModel(
        { id: 'auto', provider: 'omniroute', source: 'direct' },
        { OMNIROUTE_API_KEY: 'k', OMNIROUTE_BASE_URL: 'https://or.example.com' }
      ),
      null
    );
    assert.equal(await resolveModel({ id: 'auto', provider: 'omniroute', source: 'direct' }, EMPTY_ENV), null);
  });
});

describe('withCapabilities()', () => {
  it('annotates every model without mutating it', () => {
    const models = [{ id: 'a', auth: 'none' }];
    const out = withCapabilities(models);
    assert.deepEqual(out[0].capabilities, { chat: true, tools: true });
    assert.ok(!('capabilities' in models[0]));
  });
});

describe('groupBySource()', () => {
  it('groups models by their source field', () => {
    const grouped = groupBySource([
      { id: 'a', source: 'direct' },
      { id: 'b', source: 'error-inbox' },
      { id: 'c', source: 'direct' },
    ]);
    assert.equal(grouped.direct.length, 2);
    assert.equal(grouped['error-inbox'].length, 1);
  });
});

describe('pollinations (allowlisted GPT-OSS fallback)', () => {
  it('is in the pool: its route serves GPT-OSS 20B, keyless', async () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('pollinations'));
    const resolved = await resolveModel({ id: 'openai', provider: 'pollinations', source: 'direct' }, EMPTY_ENV);
    assert.ok(resolved);
    assert.equal(resolved.provider, 'pollinations');
    assert.equal(resolved.id, 'openai');
  });

  it('keeps its verified endpoint config in the registry', () => {
    assert.equal(PROVIDERS.pollinations.url, 'https://text.pollinations.ai/openai/v1/chat/completions');
    assert.equal(PROVIDERS.pollinations.auth, 'none');
    assert.equal(PROVIDERS.pollinations.envKey, null);
  });
});

describe('kilo live discovery', () => {
  it('keeps free uncensored ids only, drops aligned/paid/opaque ids, caps at 12', () => {
    const rows = [
      { id: 'lab/dolphin-1:free', name: 'Dolphin 1' },
      { id: 'venice/venice-uncensored:free', name: 'Venice Uncensored' },
      { id: 'nvidia/nemotron-3-nano:free', name: 'Nemotron (aligned, dropped)' },
      { id: 'kilo-auto/free', name: 'Auto (opaque router, dropped)' },
      { id: 'kilo-auto/efficient', name: 'Auto Efficient (paid-gated, dropped)' },
      { id: 'anthropic/claude-opus-5.5', name: 'Claude' },
      { id: 'openai/gpt-6.1-sol', name: 'GPT' },
      { id: 'lab/dolphin-paid', name: 'Dolphin paid tier (not :free, dropped)' },
      ...Array.from({ length: 15 }, (_, i) => ({ id: `lab/stheno-${i}:free`, name: `S${i}` })),
    ];
    const out = filterKiloFreeModels(rows);
    assert.equal(out.length, 12);
    assert.ok(out.every((m) => m.provider === 'kilo' && m.free && m.auth === 'none' && m.source === 'direct'));
    assert.ok(out.every((m) => isUncensoredModel(m)));
    assert.ok(out.some((m) => m.id === 'lab/dolphin-1:free'));
    assert.ok(out.some((m) => m.id === 'venice/venice-uncensored:free'));
    assert.ok(!out.some((m) => m.id === 'kilo-auto/free'));
    assert.ok(!out.some((m) => m.id === 'kilo-auto/efficient'));
    assert.ok(!out.some((m) => m.id === 'anthropic/claude-opus-5.5'));
    assert.ok(!out.some((m) => m.id === 'nvidia/nemotron-3-nano:free'));
    assert.ok(!out.some((m) => m.id === 'lab/dolphin-paid'));
  });

  it('a live list with no uncensored free models yields nothing — stale ids never re-enter', () => {
    const rows = [
      { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron' },
      { id: 'cohere/north-mini-code:free', name: 'North Mini Code' },
    ];
    assert.deepEqual(filterKiloFreeModels(rows), []);
    assert.deepEqual(filterKiloFreeModels(null), []);
    assert.deepEqual(filterKiloFreeModels('nope'), []);
  });
});

describe('dead model refresh (verified against live lists 2026-10-25)', () => {
  it('kilo and llm7 contribute nothing at all now — no stale id can come back', () => {
    const models = directModels(EMPTY_ENV);
    const byProvider = (p) => models.filter((m) => m.provider === p).map((m) => m.id);
    assert.deepEqual(byProvider('kilo'), []);
    assert.deepEqual(byProvider('llm7'), []);
    assert.ok(!byProvider('kilo').includes('minimax/minimax-m2.7:free'));
    assert.ok(!byProvider('llm7').includes('gemini-3.1-flash-lite'));
  });
});

describe('live model-list fetchers (mocked fetch)', () => {
  const realFetch = globalThis.fetch;
  let seen;
  let responder;
  before(() => {
    globalThis.fetch = async (url, options) => {
      seen.push({ url, options });
      return responder(url, options);
    };
  });
  after(() => { globalThis.fetch = realFetch; });
  const jsonRes = (body, { ok = true, status = 200 } = {}) => ({
    ok, status, statusText: '',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  describe('fetchGratisfyModels()', () => {
    it('returns [] without a key and never calls the network', async () => {
      seen = [];
      responder = () => { throw new Error('fetch must not run without a key'); };
      assert.deepEqual(await fetchGratisfyModels({}), []);
      assert.equal(seen.length, 0);
    });

    it('maps live rows, keeps uncensored-lineage only, honours a custom base URL', async () => {
      seen = [];
      responder = () => jsonRes({ data: [
        { id: 'dolphin-3.0-8b' },
        { id: 'gpt-4o' },
        { id: 'stheno-3.2' },
      ] });
      const models = await fetchGratisfyModels({ GRATISFY_API_KEY: 'g-key', GRATISFY_BASE_URL: 'https://custom.example/v9' });
      assert.deepEqual(models.map((m) => m.id), ['dolphin-3.0-8b', 'stheno-3.2']);
      assert.equal(models[0].provider, 'gratisfy');
      assert.equal(models[0].url, 'https://custom.example/v9/chat/completions');
      assert.equal(models[0].free, true);
      assert.equal(seen[0].url, 'https://custom.example/v9/models');
      assert.equal(seen[0].options.headers.Authorization, 'Bearer g-key');
    });

    it('returns [] when the payload has no data array', async () => {
      seen = [];
      responder = () => jsonRes({ error: 'nope' });
      assert.deepEqual(await fetchGratisfyModels({ GRATISFY_API_KEY: 'g-key' }), []);
    });
  });

  describe('fetchKiloModels()', () => {
    it('returns the free uncensored slice of the live list', async () => {
      seen = [];
      responder = () => jsonRes({ data: [
        { id: 'dolphin-3.0:free', name: 'Dolphin 3' },
        { id: 'gpt-4o:free', name: 'GPT-4o' },
        { id: 'heretic-8b', name: 'Heretic' },
      ] });
      const models = await fetchKiloModels();
      assert.deepEqual(models.map((m) => m.id), ['dolphin-3.0:free']);
      assert.equal(seen[0].url, 'https://api.kilo.ai/api/gateway/v1/models');
    });

    it('returns [] when Kilo does not answer', async () => {
      responder = () => jsonRes({ error: 'down' }, { ok: false, status: 502 });
      assert.deepEqual(await fetchKiloModels(), []);
    });
  });

  describe('fetchErrorInboxModels()', () => {
    it('maps the pool, keeps uncensored entries only, and passes prefs through', async () => {
      seen = [];
      responder = () => jsonRes({
        ok: true,
        prefs: { pinned: 'horde/any', disabled: [] },
        models: [
          { key: 'horde/any', provider: 'horde', model: 'any', ok: 9, fail: 1, disabled: false },
          { key: 'kilo/dolphin-3.0', provider: 'kilo', model: 'dolphin-3.0', ok: 5, fail: 0, disabled: false },
          { key: 'openai/gpt-4o', provider: 'openai', model: 'gpt-4o', ok: 99, fail: 0, disabled: false },
        ],
      });
      const { models, prefs } = await fetchErrorInboxModels();
      assert.deepEqual(models.map((m) => m.id), ['horde/any', 'kilo/dolphin-3.0']);
      assert.equal(models[0].source, 'error-inbox');
      assert.equal(models[0].label, 'any (9/10 recent)');
      assert.deepEqual(models[0].stats, { ok: 9, fail: 1 });
      assert.deepEqual(prefs, { pinned: 'horde/any', disabled: [] });
      assert.ok(seen[0].url.endsWith('/api/models'));
    });

    it('yields nothing when the payload is not ok or the fetch fails', async () => {
      responder = () => jsonRes({ ok: false, models: [] });
      assert.deepEqual(await fetchErrorInboxModels(), { models: [], prefs: null });
      responder = () => jsonRes({}, { ok: false, status: 401 });
      assert.deepEqual(await fetchErrorInboxModels(), { models: [], prefs: null });
    });
  });

  describe('setErrorInboxPrefs()', () => {
    it('POSTs the pin/disable body and returns the parsed reply', async () => {
      seen = [];
      responder = () => jsonRes({ ok: true });
      const out = await setErrorInboxPrefs({ pinned: 'horde/any', disabled: ['kilo/x'] });
      assert.deepEqual(out, { ok: true });
      assert.equal(seen[0].options.method, 'POST');
      assert.deepEqual(JSON.parse(seen[0].options.body), { pinned: 'horde/any', disabled: ['kilo/x'] });
      assert.ok(seen[0].url.endsWith('/api/models'));
    });

    it('sends the bearer token when ERROR_INBOX_KEY is set, nulls an absent pin', async () => {
      seen = [];
      responder = () => jsonRes({ ok: true });
      process.env.ERROR_INBOX_KEY = 'eibx_test_key';
      try {
        await setErrorInboxPrefs({ disabled: [] });
      } finally {
        delete process.env.ERROR_INBOX_KEY;
      }
      assert.equal(seen[0].options.headers.Authorization, 'Bearer eibx_test_key');
      assert.deepEqual(JSON.parse(seen[0].options.body), { pinned: null, disabled: [] });
    });
  });
});

describe('keyed uncensored catalogue (Venice, Naga, OpenRouter, DeepInfra, LLM7)', () => {
  it('keeps the new keyed providers off until their key is set', () => {
    const before = new Set(directModels(EMPTY_ENV).map((m) => m.provider));
    assert.ok(!before.has('venice'));
    assert.ok(!before.has('naga'));
    const after = new Set(directModels({ VENICE_API_KEY: 'x', NAGA_API_KEY: 'x' }).map((m) => m.provider));
    assert.ok(after.has('venice'));
    assert.ok(after.has('naga'));
  });

  it('lists only uncensored-lineage models for Venice and Naga', () => {
    const models = directModels({ VENICE_API_KEY: 'x', NAGA_API_KEY: 'x' });
    const venice = models.filter((m) => m.provider === 'venice');
    assert.ok(venice.some((m) => m.id === 'venice-uncensored-1-2'));
    assert.ok(venice.every((m) => isUncensoredModel(m)));
    assert.equal(PROVIDERS.venice.url, 'https://api.venice.ai/api/v1/chat/completions');
    assert.equal(PROVIDERS.venice.auth, 'bearer');
    const naga = models.filter((m) => m.provider === 'naga');
    assert.ok(naga.some((m) => m.id === 'sao10k/l3.1-euryale-70b'));
    assert.ok(naga.every((m) => isUncensoredModel(m)));
    assert.equal(PROVIDERS.naga.url, 'https://api.naga.ac/v1/chat/completions');
  });

  it('gates only the LLM7 uncensored Gemma entry on LLM7_API_KEY', () => {
    const keyless = directModels(EMPTY_ENV).filter((m) => m.provider === 'llm7');
    assert.ok(!keyless.some((m) => m.id === 'gemma-4-uncensored'));
    const keyed = directModels({ LLM7_API_KEY: 'x' }).filter((m) => m.provider === 'llm7');
    assert.deepEqual(keyed.map((m) => m.id), ['gemma-4-uncensored']);
  });

  it('gives the existing OpenRouter and DeepInfra keys a runnable uncensored entry', () => {
    const models = directModels({ OPENROUTER_API_KEY: 'x', DEEPINFRA_API_KEY: 'x' });
    assert.ok(
      models.some((m) => m.provider === 'openrouter' && m.id === 'cognitivecomputations/dolphin-mistral-24b-venice-edition')
    );
    assert.ok(models.some((m) => m.provider === 'deepinfra' && m.id === 'Sao10K/L3.1-70B-Euryale-v2.2'));
  });

  it('resolves the keyed routes only when their key is present', async () => {
    const ref = { id: 'venice-uncensored-1-2', provider: 'venice', source: 'direct' };
    assert.equal(await resolveModel(ref, EMPTY_ENV), null);
    const v = await resolveModel(ref, { VENICE_API_KEY: 'x' });
    assert.equal(v?.url, PROVIDERS.venice.url);
    const n = await resolveModel({ id: 'gryphe/mythomax-l2-13b', provider: 'naga', source: 'direct' }, { NAGA_API_KEY: 'x' });
    assert.ok(n && n.provider === 'naga');
    const gemma = { id: 'gemma-4-uncensored', provider: 'llm7', source: 'direct' };
    assert.equal(await resolveModel(gemma, EMPTY_ENV), null);
    assert.ok(await resolveModel(gemma, { LLM7_API_KEY: 'x' }));
  });
});
