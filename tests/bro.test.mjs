/**
 * Tests for the Bro provider (lib/models.mjs, lib/agent.mjs, lib/uncensored.mjs).
 *
 * Bro is Jay's own uncensored gateway: POST {BRO_BASE_URL}/v1/chat/completions,
 * OpenAI-shaped, model 'bro'. It is OFF until BRO_BASE_URL is set, first in
 * the chain once it is, and Horde stays the fallback. The access code is
 * never stored in the repo — BRO_ACCESS_CODE is sent as a Bearer token only
 * when it is set, and omitted entirely when it is not.
 * Run: node --test tests/bro.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { directModels, resolveModel } from '../lib/models.mjs';
import { complete } from '../lib/agent.mjs';
import { buildFailoverPlan } from '../lib/failover.mjs';
import { isUncensoredModel, UNCENSORED_ALLOWLIST } from '../lib/uncensored.mjs';

const BRO_URL = 'http://127.0.0.1:8898';
const EMPTY_ENV = {};

describe('Bro provider registration', () => {
  it('is off until BRO_BASE_URL is set — nothing can point at a gateway Jay never set', () => {
    const models = directModels(EMPTY_ENV);
    assert.ok(!models.some((m) => m.provider === 'bro'));
  });

  it('turns on with BRO_BASE_URL, first in the list, and passes the uncensored-only filter', () => {
    assert.ok(UNCENSORED_ALLOWLIST.has('bro/bro'));
    assert.equal(isUncensoredModel({ id: 'bro', provider: 'bro', label: 'Bro (uncensored gateway)' }), true);
    const models = directModels({ BRO_BASE_URL: BRO_URL });
    const bro = models.find((m) => m.provider === 'bro');
    assert.ok(bro);
    assert.equal(bro.id, 'bro');
    assert.equal(models[0].provider, 'bro');
    assert.ok(models.every((m) => isUncensoredModel(m)));
  });

  it('resolveModel builds the Bro URL from env, and resolves to nothing without one', async () => {
    const model = await resolveModel(
      { id: 'bro', provider: 'bro', source: 'direct' },
      { BRO_BASE_URL: BRO_URL }
    );
    assert.ok(model);
    assert.equal(model.url, `${BRO_URL}/v1/chat/completions`);
    assert.equal(model.auth, 'none');
    const unset = await resolveModel(
      { id: 'bro', provider: 'bro', source: 'direct' },
      EMPTY_ENV
    );
    assert.equal(unset, null);
  });

  it('resolveModel tolerates a trailing slash on BRO_BASE_URL', async () => {
    const model = await resolveModel(
      { id: 'bro', provider: 'bro', source: 'direct' },
      { BRO_BASE_URL: `${BRO_URL}/` }
    );
    assert.equal(model.url, `${BRO_URL}/v1/chat/completions`);
  });
});

describe('Bro completion wire shape', () => {
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

  const broModel = () => directModels({ BRO_BASE_URL: BRO_URL }).find((m) => m.provider === 'bro');

  it('POSTs OpenAI-shaped to {BRO_BASE_URL}/v1/chat/completions with no auth header when no code is set', async () => {
    responder = async () => jsonRes({ choices: [{ message: { role: 'assistant', content: 'hello there' } }] });
    const reply = await complete(broModel(), [{ role: 'user', content: 'hi' }], { BRO_BASE_URL: BRO_URL });
    assert.equal(seen.url, `${BRO_URL}/v1/chat/completions`);
    assert.equal(seen.options.method, 'POST');
    const body = JSON.parse(seen.options.body);
    assert.equal(body.model, 'bro');
    // The gateway ignores the `tools` field, so Bro runs the text
    // protocol (like Horde): no tools field, protocol in the system
    // prompt, so the model can still drive tools as text.
    assert.equal(body.tools, undefined);
    assert.match(body.messages[0].content, /<tool_call>/);
    assert.equal(seen.options.headers.Authorization, undefined);
    assert.equal(reply.text, 'hello there');
    assert.deepEqual(reply.toolCalls, []);
  });

  it('sends the access code as a Bearer token when BRO_ACCESS_CODE is set', async () => {
    responder = async () => jsonRes({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    await complete(broModel(), [{ role: 'user', content: 'hi' }], { BRO_BASE_URL: BRO_URL, BRO_ACCESS_CODE: 'test-code' });
    assert.equal(seen.options.headers.Authorization, 'Bearer test-code');
  });

  it('tolerates a trailing slash on BRO_BASE_URL at call time too', async () => {
    responder = async () => jsonRes({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    await complete(broModel(), [{ role: 'user', content: 'hi' }], { BRO_BASE_URL: `${BRO_URL}/` });
    assert.equal(seen.url, `${BRO_URL}/v1/chat/completions`);
  });

  it('surfaces the gateway error instead of swallowing it', async () => {
    responder = async () => jsonRes({ error: 'all backends failed' }, false, 502);
    await assert.rejects(
      () => complete(broModel(), [{ role: 'user', content: 'hi' }], { BRO_BASE_URL: BRO_URL }),
      /Bro 502/
    );
  });
});

describe('Bro failover order', () => {
  it('puts Bro first and Horde after it when Bro is configured', () => {
    const models = directModels({ BRO_BASE_URL: BRO_URL });
    const plan = buildFailoverPlan(models);
    assert.equal(plan[0].provider, 'bro');
    const hordeAt = plan.findIndex((m) => m.provider === 'horde');
    assert.ok(hordeAt > 0, 'Horde stays in the chain as the fallback');
  });

  it('leaves Horde first when Bro is not configured', () => {
    const plan = buildFailoverPlan(directModels(EMPTY_ENV));
    assert.ok(plan.length > 0);
    assert.ok(!plan.some((m) => m.provider === 'bro'));
  });
});
