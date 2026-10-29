/**
 * Tests for lib/models.mjs — the provider registry, gating, and the
 * trusted model resolution that closes the SSRF hole.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  directModels,
  filterKiloFreeModels,
  capabilities,
  resolveModel,
  withCapabilities,
  groupBySource,
} from '../lib/models.mjs';
import { isUncensoredModel } from '../lib/uncensored.mjs';

const EMPTY_ENV = {};

describe('directModels()', () => {
  it('enables the keyless uncensored route (AI Horde) with no env at all', () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('horde'));
    // Kilo / LLM7 / Pollinations are keyless too, but their current
    // catalogues carry no uncensored-lineage model, so they contribute
    // nothing — keyless was never the criterion, uncensored is.
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

describe('pollinations (registry entry kept, pool excluded)', () => {
  it('stays out of the pool: its only model is an aligned OpenAI route', async () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(!providers.has('pollinations'));
    assert.equal(await resolveModel({ id: 'openai', provider: 'pollinations', source: 'direct' }, EMPTY_ENV), null);
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
