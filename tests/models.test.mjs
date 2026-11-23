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
  fetchHordeLiveModels,
  hordeParams,
  listModels,
  setErrorInboxPrefs,
  capabilities,
  resolveModel,
  withCapabilities,
  groupBySource,
} from '../lib/models.mjs';
import { isUncensoredModel } from '../lib/uncensored.mjs';

const EMPTY_ENV = {};

describe('directModels()', () => {
  it('enables AI Horde with no env at all, and no aligned provider at all', () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('horde'));
    // Kilo / LLM7 are keyless too, but their catalogues carry no keyless
    // uncensored-lineage model, so they contribute nothing — keyless was
    // never the criterion, uncensored is. Pollinations used to be here and
    // was removed 2026-11-22: its only route served aligned GPT-OSS 20B.
    assert.ok(!providers.has('kilo'));
    assert.ok(!providers.has('llm7'));
    assert.ok(!providers.has('pollinations'));
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
    // An aligned provider is not registered at all, so its key changes
    // nothing — there is no aligned model to resurrect.
    const alignedKeyed = directModels({ ...EMPTY_ENV, GROQ_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' }).map((m) => m.provider);
    assert.ok(!alignedKeyed.includes('groq'));
    assert.ok(!alignedKeyed.includes('anthropic'));
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

  it('has no aligned model to resolve — the aligned providers are unregistered or empty', async () => {
    for (const provider of ['groq', 'gemini', 'pollinations', 'nvidia', 'mistral']) {
      assert.equal(PROVIDERS[provider], undefined, provider);
    }
    // Anthropic/Cohere keep a shape-only entry (no models) so the
    // dispatchers still match error-inbox's wire format.
    assert.deepEqual(PROVIDERS.anthropic.models, []);
    assert.deepEqual(PROVIDERS.cohere.models, []);
    assert.equal(
      await resolveModel({ id: 'openai/gpt-oss-120b', provider: 'groq', source: 'direct' }, { GROQ_API_KEY: 'x' }),
      null
    );
    assert.equal(
      await resolveModel({ id: 'claude-opus-5', provider: 'anthropic', source: 'direct' }, { ANTHROPIC_API_KEY: 'x' }),
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

  it('has no opaque router registered: OmniRoute auto is gone, not merely filtered', async () => {
    assert.equal(PROVIDERS.omniroute, undefined);
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

describe('aligned fallbacks are out of the pool (2026-11-22)', () => {
  it('does not register Pollinations: its only route served aligned GPT-OSS 20B', () => {
    assert.equal(PROVIDERS.pollinations, undefined);
    const providers = new Set(directModels(EMPTY_ENV).map((m) => m.provider));
    assert.ok(!providers.has('pollinations'));
  });

  it('resolves nothing for the old pollinations/openai route', async () => {
    assert.equal(
      await resolveModel({ id: 'openai', provider: 'pollinations', source: 'direct' }, EMPTY_ENV),
      null
    );
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

  describe('fetchHordeLiveModels()', () => {
    it('lists the online uncensored workers, biggest first, by real name', async () => {
      // The complaint that started this: /models on a keyless phone showed one
      // row, and there was nothing to pick.
      seen = [];
      responder = () => jsonRes([
        { name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 2, eta: 0 },
        { name: 'koboldcpp/L3-70B-Rocinante', count: 1, eta: 40 },
        { name: 'koboldcpp/Judas-Uncensored-3.2-1B.Q8', count: 3, eta: 1 },
        { name: ' koboldcpp/L3-70B-Rocinante ', count: 2, eta: 6 },
        { name: 'google/gemma-4-31b', count: 9, eta: 0 },
        { name: 'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic', count: 0, eta: 12 },
      ]);
      const models = await fetchHordeLiveModels({});
      assert.deepEqual(models.map((m) => m.id), [
        'koboldcpp/L3-70B-Rocinante',
        'koboldcpp/L3-8B-Stheno-v3.2-GGUF',
        'koboldcpp/Judas-Uncensored-3.2-1B.Q8',
      ]);
      assert.equal(models[0].params, 70);
      assert.equal(models[0].workers, 3); // the two padded rows merge
      assert.equal(models[1].label, 'L3-8B-Stheno-v3.2-GGUF (8B)');
      assert.equal(models[0].url, PROVIDERS.horde.url);
      assert.equal(seen[0].url, 'https://aihorde.net/api/v2/status/models?type=text');
    });

    it('reads a parameter count out of the worker name', () => {
      assert.equal(hordeParams('koboldcpp/L3-8B-Stheno-v3.2-GGUF'), 8);
      assert.equal(hordeParams('koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic'), 4);
      assert.equal(hordeParams('koboldcpp/Judas-Uncensored-3.2-1B.Q8'), 1);
      assert.equal(hordeParams('someone/mystery-uncensored'), null);
    });

    it('returns [] when Horde does not answer', async () => {
      responder = () => jsonRes({ error: 'down' }, { ok: false, status: 502 });
      assert.deepEqual(await fetchHordeLiveModels({}), []);
    });
  });

  describe('listModels()', () => {
    it('replaces the single "any" row with the live workers, and keeps any as the auto-pick', async () => {
      responder = (url) => {
        if (url.includes('aihorde.net')) return jsonRes([{ name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 1, eta: 0 }]);
        return jsonRes({ data: [] });
      };
      const list = await listModels({});
      assert.deepEqual(
        list.filter((m) => m.provider === 'horde').map((m) => m.id),
        ['koboldcpp/L3-8B-Stheno-v3.2-GGUF', 'any'],
      );
    });

    it('keeps the "any" entry alone when no worker is online', async () => {
      responder = () => jsonRes({ data: [] });
      const list = await listModels({});
      assert.deepEqual(list.filter((m) => m.provider === 'horde').map((m) => m.id), ['any']);
    });

    it('resolves a pinned worker only while it is online', async () => {
      seen = [];
      responder = (url) =>
        url.includes('aihorde.net') ? jsonRes([{ name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 1, eta: 0 }]) : jsonRes({});
      const hit = await resolveModel({ id: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', provider: 'horde', source: 'direct' }, {});
      assert.equal(hit.provider, 'horde');
      assert.equal(hit.url, PROVIDERS.horde.url);
      assert.equal(hit.auth, 'horde');
      assert.equal(await resolveModel({ id: 'koboldcpp/Gone-Uncensored-9B', provider: 'horde', source: 'direct' }, {}), null);
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
