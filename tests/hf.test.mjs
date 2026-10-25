/**
 * Tests for the `hf` provider — error-inbox's Hugging Face catalog route
 * (lib/llm/adapters.ts shape), Jay's uncensored pool order, token gating,
 * HF_MODEL swapping, trusted resolution, and the exact wire shape
 * complete() sends.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// HF_MODEL is read when lib/models.mjs is first evaluated, so set it
// before importing — the same way a deployment sets it in the environment.
process.env.HF_MODEL = 'someone/Swapped-Model-GGUF';
const { PROVIDERS, directModels, resolveModel, capabilities } = await import('../lib/models.mjs');
const { complete } = await import('../lib/agent.mjs');

const POOL_ORDER = [
  'someone/Swapped-Model-GGUF', // HF_MODEL lands first
  'AEON-7/Qwen3.8-27B-AEON-ULTIMATE-UNCENSORED-BF16',
  'DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF',
  'DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF',
  'DavidAU/OpenAi-GPT-oss-20b-HERETIC-uncensored-NEO-Imatrix-gguf',
  'DavidAU/OpenAi-GPT-oss-20b-abliterated-uncensored-NEO-Imatrix-gguf',
];

describe('hf provider registration', () => {
  it('uses error-inbox\u2019s Inference API endpoint and its own auth type', () => {
    assert.equal(PROVIDERS.hf.url, 'https://api-inference.huggingface.co/models');
    assert.equal(PROVIDERS.hf.auth, 'hf');
    assert.equal(PROVIDERS.hf.envKey, 'HF_TOKEN');
  });

  it('is off with no env: api-inference returns empty unauthenticated', () => {
    const models = directModels({}).filter((m) => m.provider === 'hf');
    assert.equal(models.length, 0);
  });

  it('is on when HF_TOKEN is set', () => {
    const models = directModels({ HF_TOKEN: 'x' }).filter((m) => m.provider === 'hf');
    assert.equal(models.length, 6);
  });

  it('keeps Jay\u2019s uncensored pool order, HF_MODEL first', () => {
    const ids = directModels({ HF_TOKEN: 'x' }).filter((m) => m.provider === 'hf').map((m) => m.id);
    assert.deepEqual(ids, POOL_ORDER);
  });

  it('defaults to the first uncensored pool entry when HF_MODEL is unset', async () => {
    const saved = process.env.HF_MODEL;
    delete process.env.HF_MODEL;
    try {
      const fresh = await import('../lib/models.mjs?hf-default-check');
      const first = fresh.directModels({ HF_TOKEN: 'x' }).find((m) => m.provider === 'hf');
      assert.equal(first.id, '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF');
    } finally {
      if (saved !== undefined) process.env.HF_MODEL = saved;
    }
  });

  it('is text-only: the EI text-generation shape carries no tools', () => {
    const caps = capabilities({ auth: 'hf' });
    assert.equal(caps.chat, true);
    assert.equal(caps.tools, false);
  });

  it('resolves through resolveModel with the trusted URL', async () => {
    const model = await resolveModel(
      { id: 'AEON-7/Qwen3.8-27B-AEON-ULTIMATE-UNCENSORED-BF16', provider: 'hf', source: 'direct' },
      {}
    );
    assert.ok(model);
    assert.equal(model.url, 'https://api-inference.huggingface.co/models');
    assert.equal(model.auth, 'hf');
  });
});

describe('hf completion wire shape (error-inbox adapter parity)', () => {
  let realFetch;
  let seen;
  let responder;
  before(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      seen = { url, options };
      return responder(url, options);
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  const jsonRes = (body, ok = true, status = 200) => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  it('POSTs { inputs, parameters } to /models/{id}, no auth header keyless', async () => {
    responder = async () => jsonRes([{ generated_text: 'user: hi\nassistant: hello there' }]);
    const model = directModels({ HF_TOKEN: 'x' }).find((m) => m.provider === 'hf');
    const reply = await complete(model, [{ role: 'user', content: 'hi' }], {});
    assert.equal(seen.url, 'https://api-inference.huggingface.co/models/someone/Swapped-Model-GGUF');
    const body = JSON.parse(seen.options.body);
    assert.equal(body.inputs, 'user: hi');
    assert.equal(body.parameters.max_new_tokens, 1024);
    assert.equal(seen.options.headers.Authorization, undefined);
    // The prompt echo and role marker are stripped from generated_text.
    assert.equal(reply.text, 'hello there');
    assert.deepEqual(reply.toolCalls, []);
  });

  it('sends the bearer <redacted> when HF_TOKEN is set, like error-inbox', async () => {
    responder = async () => jsonRes({ generated_text: 'user: hi\nthe answer' });
    const model = directModels({ HF_TOKEN: 'x' }).find((m) => m.provider === 'hf');
    const reply = await complete(model, [{ role: 'user', content: 'hi' }], { HF_TOKEN: 'hf-token' });
    assert.equal(seen.options.headers.Authorization, 'Bearer hf-token');
    assert.equal(reply.text, 'the answer');
  });

  it('falls back to HUGGINGFACE_API_KEY, like error-inbox', async () => {
    responder = async () => jsonRes([{ generated_text: 'user: hi\nok' }]);
    const model = directModels({ HF_TOKEN: 'x' }).find((m) => m.provider === 'hf');
    await complete(model, [{ role: 'user', content: 'hi' }], { HUGGINGFACE_API_KEY: 'hf-alt' });
    assert.equal(seen.options.headers.Authorization, 'Bearer hf-alt');
  });

  it('throws the endpoint\u2019s error body instead of swallowing it', async () => {
    responder = async () => jsonRes({ error: 'model is not available' }, false, 404);
    const model = directModels({ HF_TOKEN: 'x' }).find((m) => m.provider === 'hf');
    await assert.rejects(() => complete(model, [{ role: 'user', content: 'hi' }], {}), /Hugging Face 404/);
  });
});
