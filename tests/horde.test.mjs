/**
 * Tests for the Horde uncensored route — pickHordeUncensoredModels and the
 * callHorde submit body (uncensored models requested when online, any
 * worker when the status fetch fails).
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { complete, pickHordeUncensoredModels } from '../lib/agent.mjs';

const HORDE_URL = 'https://aihorde.net/api/v2/generate/text/async';
const hordeModel = {
  id: 'any', provider: 'horde', providerLabel: 'AI Horde',
  source: 'direct', free: true, auth: 'horde', url: HORDE_URL,
};

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
let responder;
let seenSubmit;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, options) => responder(url, options);
});
after(() => { globalThis.fetch = realFetch; });

describe('pickHordeUncensoredModels()', () => {
  it('picks all online uncensored workers, fastest queue first', () => {
    const rows = [
      { name: 'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic', count: 1, eta: 32 },
      { name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 1, eta: 0 },
      { name: 'google/gemma-4-31b', count: 4, eta: 5 },
      { name: 'koboldcpp/Judas-Uncensored-3.2-1B.Q8', count: 1, eta: 12 },
      { name: 'koboldcpp/mini-magnum-12b-v1.1', count: 1, eta: 91 },
      { name: 'koboldcpp/offline-heretic', count: 0, eta: 0 },
    ];
    assert.deepEqual(pickHordeUncensoredModels(rows), [
      'koboldcpp/L3-8B-Stheno-v3.2-GGUF',
      'koboldcpp/Judas-Uncensored-3.2-1B.Q8',
      'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic',
      'koboldcpp/mini-magnum-12b-v1.1',
    ]);
  });

  it('returns [] when nothing uncensored is online or input is bad', () => {
    assert.deepEqual(pickHordeUncensoredModels([{ name: 'google/gemma-4-31b', count: 4, eta: 5 }]), []);
    assert.deepEqual(pickHordeUncensoredModels(null), []);
    assert.deepEqual(pickHordeUncensoredModels('nope'), []);
  });
});

describe('callHorde() via complete()', () => {
  it('requests the uncensored workers in the submit body', async () => {
    responder = async (url, options) => {
      if (url.includes('/status/models')) {
        return jsonRes([
          { name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 1, eta: 0 },
          { name: 'koboldcpp/Judas-Uncensored-3.2-1B.Q8', count: 1, eta: 12 },
          { name: 'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic', count: 1, eta: 32 },
          { name: 'google/gemma-4-31b', count: 4, eta: 5 },
        ]);
      }
      if (url.endsWith('/async')) {
        seenSubmit = JSON.parse(options.body);
        return jsonRes({ id: 'job1' });
      }
      return jsonRes({ done: true, generations: [{ text: 'hello uncensored' }] });
    };
    const reply = await complete(hordeModel, [{ role: 'user', content: 'say hi' }], {});
    assert.deepEqual(seenSubmit.models, [
      'koboldcpp/L3-8B-Stheno-v3.2-GGUF',
      'koboldcpp/Judas-Uncensored-3.2-1B.Q8',
      'koboldcpp/Gemma-4-E4B-it-Ultra-Uncensored-Heretic',
    ]);
    assert.equal(reply.text, 'hello uncensored');
  });

  it('falls back to any worker when the status fetch fails', async () => {
    responder = async (url, options) => {
      if (url.includes('/status/models')) throw new Error('status down');
      if (url.endsWith('/async')) {
        seenSubmit = JSON.parse(options.body);
        return jsonRes({ id: 'job2' });
      }
      return jsonRes({ done: true, generations: [{ text: 'hello any' }] });
    };
    const reply = await complete(hordeModel, [{ role: 'user', content: 'say hi' }], {});
    assert.equal(seenSubmit.models, undefined);
    assert.equal(reply.text, 'hello any');
  });

  const errRes = (status, body) => ({
    ok: false,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? {} : body),
  });

  it('retries unrestricted when the models-restricted submit is gated (403 KudosUpfront)', async () => {
    const submits = [];
    responder = async (url, options) => {
      if (url.includes('/status/models')) {
        return jsonRes([{ name: 'koboldcpp/L3-8B-Stheno-v3.2-GGUF', count: 1, eta: 0 }]);
      }
      if (url.endsWith('/async')) {
        const body = JSON.parse(options.body);
        submits.push(body);
        if (body.models) return errRes(403, { message: 'This request requires upfront kudos', rc: 'KudosUpfront' });
        return jsonRes({ id: 'job3' });
      }
      return jsonRes({ done: true, generations: [{ text: 'hello unrestricted' }] });
    };
    const reply = await complete(hordeModel, [{ role: 'user', content: 'say hi' }], {});
    assert.equal(submits.length, 2);
    assert.deepEqual(submits[0].models, ['koboldcpp/L3-8B-Stheno-v3.2-GGUF']);
    assert.equal(submits[1].models, undefined);
    assert.equal(reply.text, 'hello unrestricted');
  });

  it('surfaces Horde\'s own rc and message when every submit rung fails', async () => {
    responder = async (url) => {
      if (url.includes('/status/models')) return jsonRes([]);
      if (url.endsWith('/async')) return errRes(403, { message: 'This request requires upfront kudos', rc: 'KudosUpfront' });
      throw new Error('poll must not happen after a failed submit');
    };
    await assert.rejects(
      () => complete(hordeModel, [{ role: 'user', content: 'say hi' }], {}),
      (err) => {
        assert.match(err.message, /Horde 403 \(KudosUpfront\): This request requires upfront kudos/);
        assert.equal(err.status, 403);
        assert.equal(err.rc, 'KudosUpfront');
        return true;
      },
    );
  });

  it('retries as anonymous when a configured API key is rejected', async () => {
    const submitKeys = [];
    responder = async (url, options) => {
      if (url.includes('/status/models')) return jsonRes([]);
      if (url.endsWith('/async')) {
        submitKeys.push(options.headers.apikey);
        if (options.headers.apikey !== '0000000000') {
          return errRes(401, { message: 'No user matching sent API Key.', rc: 'InvalidAPIKey' });
        }
        return jsonRes({ id: 'job4' });
      }
      return jsonRes({ done: true, generations: [{ text: 'hello anonymous' }] });
    };
    const reply = await complete(hordeModel, [{ role: 'user', content: 'say hi' }], { AIHORDE_API_KEY: 'stale-key-value' });
    assert.deepEqual(submitKeys, ['stale-key-value', '0000000000']);
    assert.equal(reply.text, 'hello anonymous');
  });

  it('fails fast on a faulted job instead of polling until the deadline', async () => {
    responder = async (url) => {
      if (url.includes('/status/models')) return jsonRes([]);
      if (url.endsWith('/async')) return jsonRes({ id: 'job5' });
      return jsonRes({ done: false, faulted: true, generations: [] });
    };
    await assert.rejects(
      () => complete(hordeModel, [{ role: 'user', content: 'say hi' }], {}),
      /Horde: job faulted in the queue/,
    );
  });
});
