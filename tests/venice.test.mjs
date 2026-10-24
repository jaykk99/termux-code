/**
 * Tests for the Venice provider — registry gating, VENICE_MODEL swapping,
 * trusted resolution, and the exact wire shape complete() sends.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// VENICE_MODEL is read when lib/models.mjs is first evaluated, so set it
// before importing — the same way a deployment sets it in the environment.
process.env.VENICE_MODEL = 'zai-org-glm-5-2';
const { PROVIDERS, directModels, resolveModel } = await import('../lib/models.mjs');
const { complete } = await import('../lib/agent.mjs');

const KEY = { VENICE_API_KEY: '<redacted>' };

describe('Venice provider registration', () => {
  it('is registered as an OpenAI-shaped bearer provider on the Venice base URL', () => {
    assert.equal(PROVIDERS.venice.url, 'https://api.venice.ai/api/v1/chat/completions');
    assert.equal(PROVIDERS.venice.auth, 'bearer');
    assert.equal(PROVIDERS.venice.envKey, 'VENICE_API_KEY');
  });

  it('stays off until VENICE_API_KEY is set', () => {
    assert.ok(!directModels({}).some((m) => m.provider === 'venice'));
    assert.ok(directModels(KEY).some((m) => m.provider === 'venice'));
  });

  it('takes its model id from VENICE_MODEL', () => {
    const model = directModels(KEY).find((m) => m.provider === 'venice');
    assert.equal(model.id, 'zai-org-glm-5-2');
  });

  it('defaults to venice-uncensored-1-2 when VENICE_MODEL is unset', async () => {
    const saved = process.env.VENICE_MODEL;
    delete process.env.VENICE_MODEL;
    try {
      // A cache-busted import re-evaluates the registry with no VENICE_MODEL.
      const fresh = await import('../lib/models.mjs?default-model-check');
      const model = fresh.directModels(KEY).find((m) => m.provider === 'venice');
      assert.equal(model.id, 'venice-uncensored-1-2');
    } finally {
      if (saved !== undefined) process.env.VENICE_MODEL = saved;
    }
  });

  it('resolves through resolveModel with the trusted URL', async () => {
    const model = await resolveModel(
      { id: 'zai-org-glm-5-2', provider: 'venice', source: 'direct' },
      KEY
    );
    assert.ok(model);
    assert.equal(model.url, 'https://api.venice.ai/api/v1/chat/completions');
    assert.equal(model.auth, 'bearer');
  });
});

describe('Venice completion wire shape', () => {
  let realFetch;
  let seen;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'venice-ok' } }],
        }),
      };
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it('POSTs an OpenAI-shaped body with the env key as a bearer', async () => {
    const model = directModels(KEY).find((m) => m.provider === 'venice');
    const reply = await complete(model, [{ role: 'user', content: 'hi' }], KEY);
    assert.equal(reply.text, 'venice-ok');
    assert.equal(seen.url, 'https://api.venice.ai/api/v1/chat/completions');
    assert.equal(seen.options.headers.Authorization, 'Bearer <redacted>');
    const body = JSON.parse(seen.options.body);
    assert.equal(body.model, 'zai-org-glm-5-2');
    assert.ok(Array.isArray(body.tools) && body.tools.length > 0);
  });

  it('with baseTools off, sends only the extra (server) tools', async () => {
    const model = directModels(KEY).find((m) => m.provider === 'venice');
    const extra = [{ type: 'function', function: { name: 'ping', parameters: { type: 'object' } } }];
    await complete(model, [{ role: 'user', content: 'hi' }], KEY, extra, { baseTools: false });
    const body = JSON.parse(seen.options.body);
    assert.deepEqual(body.tools, extra);
  });
});
