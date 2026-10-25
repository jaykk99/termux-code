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

const EMPTY_ENV = {};

describe('directModels()', () => {
  it('enables keyless providers with no env at all', () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('kilo'));
    assert.ok(providers.has('llm7'));
    assert.ok(providers.has('horde'));
  });

  it('keeps keyed providers off until their key is set', () => {
    const before = directModels(EMPTY_ENV).map((m) => m.provider);
    assert.ok(!before.includes('groq'));
    const after = directModels({ ...EMPTY_ENV, GROQ_API_KEY: 'x' }).map((m) => m.provider);
    assert.ok(after.includes('groq'));
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
    const m = await resolveModel({ id: 'kilo-auto/free', provider: 'kilo', source: 'direct' }, EMPTY_ENV);
    assert.ok(m);
    assert.equal(m.id, 'kilo-auto/free');
    assert.equal(m.url, PROVIDERS.kilo.url);
    assert.equal(m.auth, 'none');
  });

  it('returns null for unknown provider/model triples', async () => {
    assert.equal(await resolveModel({ id: 'nope', provider: 'kilo', source: 'direct' }, EMPTY_ENV), null);
    assert.equal(await resolveModel({ id: 'kilo-auto/free', provider: 'evil', source: 'direct' }, EMPTY_ENV), null);
  });

  it('rejects malformed refs and overlong ids', async () => {
    assert.equal(await resolveModel(null), null);
    assert.equal(await resolveModel('kilo-auto/free'), null);
    assert.equal(await resolveModel({ id: '', provider: 'kilo', source: 'direct' }), null);
    assert.equal(await resolveModel({ id: 'x'.repeat(301), provider: 'kilo', source: 'direct' }), null);
    assert.equal(await resolveModel({ id: 'kilo-auto/free', provider: 'kilo', source: 'weird' }), null);
  });

  it('never trusts a client-supplied URL', async () => {
    const m = await resolveModel(
      { id: 'kilo-auto/free', provider: 'kilo', source: 'direct', url: 'http://169.254.169.254/' },
      EMPTY_ENV
    );
    assert.ok(m);
    assert.equal(m.url, PROVIDERS.kilo.url);
  });

  it('resolves omniroute URLs from env, and null when the base is missing', async () => {
    const m = await resolveModel(
      { id: 'auto', provider: 'omniroute', source: 'direct' },
      { OMNIROUTE_API_KEY: 'k', OMNIROUTE_BASE_URL: 'https://or.example.com' }
    );
    assert.equal(m.url, 'https://or.example.com/v1/chat/completions');
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

describe('pollinations (keyless, verified live 2026-10-25)', () => {
  it('is on with no env at all', () => {
    const models = directModels(EMPTY_ENV);
    const providers = new Set(models.map((m) => m.provider));
    assert.ok(providers.has('pollinations'));
  });

  it('uses the verified OpenAI-compatible endpoint with no auth', () => {
    assert.equal(PROVIDERS.pollinations.url, 'https://text.pollinations.ai/openai/v1/chat/completions');
    assert.equal(PROVIDERS.pollinations.auth, 'none');
    assert.equal(PROVIDERS.pollinations.envKey, null);
  });
});

describe('kilo live discovery', () => {
  it('keeps :free and kilo-auto ids, drops paid ids, caps at 12', () => {
    const rows = [
      { id: 'nvidia/foo:free', name: 'Foo' },
      { id: 'kilo-auto/free', name: 'Auto' },
      { id: 'kilo-auto/efficient', name: 'Auto Efficient (paid-gated, dropped)' },
      { id: 'anthropic/claude-opus-5.5', name: 'Claude' },
      { id: 'openai/gpt-6.1-sol', name: 'GPT' },
      ...Array.from({ length: 15 }, (_, i) => ({ id: `some/model-${i}:free`, name: `M${i}` })),
    ];
    const out = filterKiloFreeModels(rows);
    assert.equal(out.length, 12);
    assert.ok(out.every((m) => m.provider === 'kilo' && m.free && m.auth === 'none' && m.source === 'direct'));
    assert.ok(out.some((m) => m.id === 'kilo-auto/free'));
    assert.ok(!out.some((m) => m.id === 'kilo-auto/efficient'));
    assert.ok(!out.some((m) => m.id === 'anthropic/claude-opus-5.5'));
  });
});

describe('dead model refresh (verified against live lists 2026-10-25)', () => {
  it('drops kilo and llm7 ids no longer in the live catalogues', () => {
    const models = directModels(EMPTY_ENV);
    const byProvider = (p) => models.filter((m) => m.provider === p).map((m) => m.id);
    assert.ok(!byProvider('kilo').includes('minimax/minimax-m2.7:free'));
    assert.ok(!byProvider('kilo').includes('minimax/minimax-m3:free'));
    assert.ok(!byProvider('kilo').includes('stealth/ox-alpha'));
    assert.ok(!byProvider('llm7').includes('gemini-3.1-flash-lite'));
  });
});
