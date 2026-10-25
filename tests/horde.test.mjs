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
});
