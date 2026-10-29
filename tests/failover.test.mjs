/**
 * Tests for lib/failover.mjs — the provider failover chain and circuit breaker.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FailureTracker,
  buildFailoverPlan,
  completeWithFailover,
  FailoverError,
  gatewayFallbackReason,
  isTransientError,
  isBadModelError,
  parseRetryAfterMs,
  formatAttempts,
  makeAttempt,
  renderError,
  FAILURES_TO_TRIP,
} from '../lib/failover.mjs';

// Fixtures are uncensored-lineage by default (label marker): the plan is
// uncensored-only now, so a neutral fixture would be filtered out before
// any ordering/failover behaviour could be tested. Tests that need an
// ALIGNED model build it with alignedM(), whose label carries no marker.
const M = (id, provider, auth, free = false, disabled = false) => ({
  id, provider, auth, free, disabled, source: 'direct', label: `${id} uncensored`,
});
const alignedM = (id, provider, auth, free = false, disabled = false) => ({
  id, provider, auth, free, disabled, source: 'direct', label: id,
});

describe('FailureTracker', () => {
  it('trips after N consecutive failures and cools down', () => {
    let t = 0;
    const tr = new FailureTracker({ now: () => t, cooldownMs: 1000 });
    assert.equal(tr.isCoolingDown('kilo'), false);
    for (let i = 0; i < FAILURES_TO_TRIP - 1; i++) tr.recordFailure('kilo');
    assert.equal(tr.isCoolingDown('kilo'), false);
    tr.recordFailure('kilo');
    assert.equal(tr.isCoolingDown('kilo'), true);
    assert.equal(tr.failures('kilo'), FAILURES_TO_TRIP);
  });

  it('becomes eligible again after the cooldown expires', () => {
    let t = 0;
    const tr = new FailureTracker({ now: () => t, cooldownMs: 1000 });
    for (let i = 0; i < FAILURES_TO_TRIP; i++) tr.recordFailure('kilo');
    t = 2000;
    assert.equal(tr.isCoolingDown('kilo'), false);
  });

  it('resets failure counts on success', () => {
    const tr = new FailureTracker();
    tr.recordFailure('kilo');
    tr.recordFailure('kilo');
    assert.equal(tr.failures('kilo'), 2);
    tr.recordSuccess('kilo');
    assert.equal(tr.failures('kilo'), 0);
  });

  it('summarises state honestly', () => {
    let t = 0;
    const tr = new FailureTracker({ now: () => t, cooldownMs: 1000 });
    for (let i = 0; i < FAILURES_TO_TRIP; i++) tr.recordFailure('groq');
    const s = tr.summary();
    assert.equal(s.length, 1);
    assert.equal(s[0].provider, 'groq');
    assert.equal(s[0].coolingDown, true);
    assert.ok(s[0].coolsDownInMs > 0);
  });
});

describe('buildFailoverPlan()', () => {
  it('orders keyless tool-capable first, chat-only last, skips disabled', () => {
    const models = [
      M('horde-x', 'horde', 'horde'),
      M('gemini-x', 'gemini', 'gemini'),
      M('groq-x', 'groq', 'bearer'),
      M('kilo-x', 'kilo', 'none'),
      M('dead', 'kilo', 'none', false, true),
    ];
    const plan = buildFailoverPlan(models);
    assert.ok(!plan.some((m) => m.id === 'dead'));
    const ids = plan.map((m) => m.id);
    assert.equal(ids[0], 'kilo-x'); // keyless + tools
    assert.equal(ids[1], 'groq-x'); // keyed + tools
    assert.ok(ids.indexOf('gemini-x') > ids.indexOf('groq-x'));
    assert.ok(ids.indexOf('horde-x') > ids.indexOf('groq-x'));
  });

  it('drops aligned models from the plan entirely — they are not a fallback tier', () => {
    const models = [
      alignedM('kilo-x', 'kilo', 'none', true),
      alignedM('gpt-4o-mini', 'githubmodels', 'bearer'),
      M('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'hf', 'hf', true),
      M('gateway-uncensored-1', 'gatewayx', 'bearer'),
      alignedM('gemini-x', 'gemini', 'gemini'),
    ];
    const ids = buildFailoverPlan(models).map((m) => m.id);
    // Only the uncensored candidates remain, in capability order: the
    // tool-capable keyed one first, the chat-only HF pool entry second.
    // The aligned models are absent, not ranked last.
    assert.deepEqual(ids, [
      'gateway-uncensored-1',
      '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF',
    ]);
  });

  it('an aligned model on a keyed gateway provider never enters the plan', () => {
    const models = [
      alignedM('glm-5.2', 'gatewayx', 'bearer'),
      M('DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF', 'hf', 'hf', true),
      alignedM('kilo-x', 'kilo', 'none', true),
    ];
    const ids = buildFailoverPlan(models).map((m) => m.id);
    assert.deepEqual(ids, ['DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF']);
  });

  it('returns an empty plan when every candidate is aligned', () => {
    const models = [alignedM('gpt-4o-mini', 'githubmodels', 'bearer'), alignedM('claude-x', 'anthropic', 'anthropic')];
    assert.deepEqual(buildFailoverPlan(models), []);
  });

  it('demotes providers in cooldown to the back of their tier', () => {
    let t = 0;
    const tr = new FailureTracker({ now: () => t, cooldownMs: 60000 });
    for (let i = 0; i < FAILURES_TO_TRIP; i++) tr.recordFailure('kilo');
    const plan = buildFailoverPlan([M('kilo-x', 'kilo', 'none'), M('llm7-x', 'llm7', 'none')], tr);
    assert.equal(plan[0].id, 'llm7-x');
    assert.equal(plan[1].id, 'kilo-x');
  });

  it('does not mutate the input array', () => {
    const models = [M('gemini-x', 'gemini', 'gemini'), M('kilo-x', 'kilo', 'none')];
    buildFailoverPlan(models);
    assert.equal(models[0].id, 'gemini-x');
  });
});

describe('completeWithFailover()', () => {
  const replyFor = (model) => ({ text: `from ${model.id}`, toolCalls: [], assistantMessage: { role: 'assistant', content: 'x' } });

  it('returns the first success with the full attempt log', async () => {
    // Same tier (both keyless + tool-capable) so the plan keeps input order:
    // the first fails, failover walks to the second.
    const models = [M('bad', 'kilo', 'none'), M('good', 'llm7', 'none')];
    let calls = 0;
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) => {
      calls++;
      if (m.id === 'bad') throw new Error('kilo exploded');
      return replyFor(m);
    });
    assert.equal(calls, 2);
    assert.equal(model.id, 'good');
    assert.equal(reply.text, 'from good');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].ok, false);
    assert.match(attempts[0].error, /kilo exploded/);
    assert.equal(attempts[1].ok, true);
  });

  it('short-circuits on the first success', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    let calls = 0;
    const { attempts } = await completeWithFailover(models, [], async (m) => (calls++, replyFor(m)));
    assert.equal(calls, 1);
    assert.equal(attempts.length, 1);
  });

  it('throws FailoverError with attempts when everything fails', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    try {
      await completeWithFailover(models, [], async () => {
        throw new Error('down');
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof FailoverError);
      assert.equal(err.attempts.length, 2);
      assert.match(err.message, /2 provider\(s\) failed/);
    }
  });

  it('stops the chain at once on a terminal error (auth/config, not outage)', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none'), M('c', 'horde', 'none')];
    let calls = 0;
    const attempts = [];
    try {
      await completeWithFailover(models, [], async () => {
        calls++;
        const err = new Error('Gateway rejected the token (NO_KEY).');
        err.terminal = true;
        throw err;
      }, null, { onAttempt: (a) => attempts.push(a) });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(!(err instanceof FailoverError), 'terminal error rethrown as-is, not wrapped');
      assert.match(err.message, /Gateway rejected the token/);
      assert.equal(calls, 1, 'no further candidates tried after a terminal failure');
      assert.equal(attempts.length, 1, 'the terminal attempt is still logged');
    }
  });

  it('feeds the circuit breaker: failures recorded, successes reset', async () => {
    const tr = new FailureTracker();
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    await completeWithFailover(models, [], async (m) => (m.id === 'a' ? (() => { throw new Error('x'); })() : replyFor(m)), tr);
    assert.equal(tr.failures('kilo'), 1);
    assert.equal(tr.failures('llm7'), 0);
  });

  it('respects maxAttempts', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none'), M('c', 'horde', 'horde')];
    let calls = 0;
    try {
      await completeWithFailover(models, [], async () => (calls++, Promise.reject(new Error('down'))), null, { maxAttempts: 2 });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(calls, 2);
      assert.equal(err.attempts.length, 2);
    }
  });

  it('calls onAttempt for live TUI updates', async () => {
    const seen = [];
    await completeWithFailover([M('a', 'kilo', 'none')], [], async (m) => replyFor(m), null, {
      onAttempt: (a) => seen.push(a),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].ok, true);
  });
});

describe('completeWithFailover() — refusal handling', () => {
  const REFUSAL = "I'm sorry, but I can't help with that request.";
  const replyFor = (model) => ({ text: `from ${model.id}`, toolCalls: [], assistantMessage: { role: 'assistant', content: 'x' } });

  it('skips a refusal and surfaces the next provider\'s real answer', async () => {
    const models = [M('refuser', 'kilo', 'none'), M('helper', 'llm7', 'none')];
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) =>
      m.id === 'refuser' ? { text: REFUSAL, toolCalls: [], assistantMessage: { role: 'assistant', content: REFUSAL } } : replyFor(m)
    );
    assert.equal(model.id, 'helper');
    assert.equal(reply.text, 'from helper');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].ok, false);
    assert.match(attempts[0].error, /^refused: /);
    assert.equal(attempts[1].ok, true);
  });

  it('counts a refusal against the circuit breaker like any failure', async () => {
    const tr = new FailureTracker();
    const models = [M('refuser', 'kilo', 'none'), M('helper', 'llm7', 'none')];
    await completeWithFailover(models, [], async (m) =>
      m.id === 'refuser' ? { text: REFUSAL, toolCalls: [], assistantMessage: {} } : replyFor(m), tr);
    assert.equal(tr.failures('kilo'), 1);
    assert.equal(tr.failures('llm7'), 0);
  });

  it('surfaces the last refusal when every candidate refuses', async () => {
    const models = [M('r1', 'kilo', 'none'), M('r2', 'llm7', 'none')];
    const texts = { r1: REFUSAL, r2: 'As an AI, I cannot assist with that.' };
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) => ({
      text: texts[m.id], toolCalls: [], assistantMessage: { role: 'assistant', content: texts[m.id] },
    }));
    assert.equal(model.id, 'r2');
    assert.equal(reply.text, texts.r2);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every((a) => !a.ok));
  });

  it('still throws FailoverError when refusals mix with transport failures', async () => {
    const models = [M('refuser', 'kilo', 'none'), M('down', 'llm7', 'none')];
    try {
      await completeWithFailover(models, [], async (m) => {
        if (m.id === 'refuser') return { text: REFUSAL, toolCalls: [], assistantMessage: {} };
        throw new Error('llm7 502');
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof FailoverError);
      assert.equal(err.attempts.length, 2);
      assert.match(err.attempts[0].error, /^refused: /);
      assert.match(err.attempts[1].error, /llm7 502/);
    }
  });

  it('skips a reply flagged refused even when its text looks innocent', async () => {
    const models = [M('flagged', 'kilo', 'none'), M('helper', 'llm7', 'none')];
    const { model, attempts } = await completeWithFailover(models, [], async (m) =>
      m.id === 'flagged'
        ? { text: 'Anthropic declined this request.', toolCalls: [], refused: true, assistantMessage: {} }
        : replyFor(m));
    assert.equal(model.id, 'helper');
    assert.equal(attempts[0].ok, false);
  });

  it('does not skip a working reply that carries tool calls', async () => {
    const models = [M('worker', 'kilo', 'none'), M('backup', 'llm7', 'none')];
    let calls = 0;
    const { model, attempts } = await completeWithFailover(models, [], async (m) => {
      calls++;
      return {
        text: "I can't edit that file directly, but I'll run the change through the shell.",
        toolCalls: [{ id: '1', name: 'bash', args: { command: 'true' } }],
        assistantMessage: { role: 'assistant', content: 'x' },
      };
    });
    assert.equal(calls, 1);
    assert.equal(model.id, 'worker');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].ok, true);
  });

  it('walks past a newly-caught refusal phrasing to the next provider', async () => {
    const models = [M('refuser', 'kilo', 'none'), M('helper', 'llm7', 'none')];
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) =>
      m.id === 'refuser' ? { text: "I can't do this.", toolCalls: [], assistantMessage: {} } : replyFor(m));
    assert.equal(model.id, 'helper');
    assert.equal(reply.text, 'from helper');
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].error, /^refused: /);
  });

  it('walks the whole chain when every model refuses in a different phrasing', async () => {
    const models = [M('r1', 'kilo', 'none'), M('r2', 'llm7', 'none'), M('r3', 'horde', 'horde')];
    const texts = { r1: 'I refuse to help with that.', r2: "That's not something I can help with.", r3: 'Unable to comply with this request.' };
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) => ({
      text: texts[m.id], toolCalls: [], assistantMessage: {},
    }));
    assert.equal(model.id, 'r3');
    assert.equal(reply.text, texts.r3);
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((a) => !a.ok));
  });

  it('treats an empty reply as a failed attempt and walks on', async () => {
    const models = [M('blank', 'kilo', 'none'), M('helper', 'llm7', 'none')];
    const { model, reply, attempts } = await completeWithFailover(models, [], async (m) =>
      m.id === 'blank' ? { text: '', toolCalls: [], assistantMessage: {} } : replyFor(m));
    assert.equal(model.id, 'helper');
    assert.equal(reply.text, 'from helper');
    assert.equal(attempts[0].error, 'empty reply');
  });

  it('treats whitespace-only and missing text as failed attempts', async () => {
    for (const text of ['   \n  ', undefined]) {
      const models = [M('blank', 'kilo', 'none'), M('helper', 'llm7', 'none')];
      const { model } = await completeWithFailover(models, [], async (m) =>
        m.id === 'blank' ? { text, toolCalls: [], assistantMessage: {} } : replyFor(m));
      assert.equal(model.id, 'helper');
    }
  });

  it('does not treat a blank-text reply carrying tool calls as empty', async () => {
    const models = [M('worker', 'kilo', 'none'), M('backup', 'llm7', 'none')];
    let calls = 0;
    const { model, attempts } = await completeWithFailover(models, [], async () => {
      calls++;
      return { text: '', toolCalls: [{ id: '1', name: 'bash', args: {} }], assistantMessage: {} };
    });
    assert.equal(calls, 1);
    assert.equal(model.id, 'worker');
    assert.equal(attempts[0].ok, true);
  });

  it('throws FailoverError with an honest log when every reply is blank', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    try {
      await completeWithFailover(models, [], async () => ({ text: '', toolCalls: [], assistantMessage: {} }));
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof FailoverError);
      assert.ok(err.attempts.every((a) => a.error === 'empty reply'));
    }
  });

  it('does not skip an answer that merely says sorry in passing', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    let calls = 0;
    const { attempts } = await completeWithFailover(models, [], async () => {
      calls++;
      return { text: 'Fixed. Sorry about the earlier confusion — the bug was in parse().', toolCalls: [], assistantMessage: {} };
    });
    assert.equal(calls, 1);
    assert.equal(attempts[0].ok, true);
  });
});

describe('formatAttempts()', () => {
  it('renders one honest line per attempt', () => {
    const lines = formatAttempts([
      { provider: 'groq', modelId: 'x', ok: false, latencyMs: 12, error: '429 rate limited' },
      { provider: 'kilo', modelId: 'y', ok: true, latencyMs: 900, error: null },
    ]);
    assert.match(lines[0], /\[fail\] groq\/x 12ms — 429 rate limited/);
    assert.match(lines[1], /\[ok\] kilo\/y 900ms/);
  });
});

describe('renderError() — no more "[object Object]"', () => {
  it('passes strings through unchanged', () => {
    assert.equal(renderError('kilo 429'), 'kilo 429');
  });

  it('renders Errors via their message', () => {
    assert.equal(renderError(new Error('fetch failed')), 'fetch failed');
  });

  it('renders a plain object error as JSON, not "[object Object]"', () => {
    const out = renderError({ error: { message: 'model overloaded', code: 503 } });
    assert.doesNotMatch(out, /\[object Object\]/);
    assert.match(out, /model overloaded/);
    assert.match(out, /503/);
  });

  it('renders an Error whose message was clobbered with an object', () => {
    const err = new Error('placeholder');
    err.message = { status: 401, detail: 'bad gateway key' };
    const out = renderError(err);
    assert.doesNotMatch(out, /\[object Object\]/);
    assert.match(out, /bad gateway key/);
  });

  it('renders null/undefined as empty, and never throws on circular objects', () => {
    assert.equal(renderError(null), '');
    assert.equal(renderError(undefined), '');
    const circ = {};
    circ.self = circ;
    assert.equal(typeof renderError(circ), 'string');
  });

  it('makeAttempt truncates a long object error to 300 chars', () => {
    const big = { detail: 'x'.repeat(500) };
    const a = makeAttempt({ provider: 'kilo', modelId: 'm', ok: false, latencyMs: 100, error: big });
    assert.equal(a.error.length, 300);
    assert.doesNotMatch(a.error, /\[object Object\]/);
  });

  it('makeAttempt keeps a string error and a null error as before', () => {
    assert.equal(
      makeAttempt({ provider: 'kilo', modelId: 'm', ok: false, latencyMs: 1, error: 'down' }).error,
      'down'
    );
    assert.equal(
      makeAttempt({ provider: 'kilo', modelId: 'm', ok: false, latencyMs: 1, error: null }).error,
      null
    );
  });

  it('completeWithFailover surfaces a thrown plain object readably', async () => {
    const models = [M('a', 'kilo', 'none')];
    try {
      await completeWithFailover(models, [], async () => {
        throw { status: 401, body: 'keyless endpoint rejected' };
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof FailoverError);
      assert.doesNotMatch(err.attempts[0].error, /\[object Object\]/);
      assert.match(err.attempts[0].error, /keyless endpoint rejected/);
      assert.doesNotMatch(err.message, /\[object Object\]/);
      assert.match(err.message, /keyless endpoint rejected/);
    }
  });

  it('formatAttempts prints an object-error attempt as readable text', () => {
    const a = makeAttempt({
      provider: 'horde',
      modelId: 'any',
      ok: false,
      latencyMs: 69,
      error: { error: 'queue rejected the job' },
    });
    const lines = formatAttempts([a]);
    assert.doesNotMatch(lines[0], /\[object Object\]/);
    assert.match(lines[0], /queue rejected the job/);
  });
});

describe('transient retry', () => {
  it('retries a 429 once, then succeeds', async () => {
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error('429 Too Many Requests');
      return { text: 'hi', toolCalls: [] };
    };
    const { reply, attempts } = await completeWithFailover([M('m1', 'kilo', 'none', true)], [{ role: 'user', content: 'hi' }], completeFn);
    assert.equal(calls, 2);
    assert.equal(reply.text, 'hi');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].ok, true);
  });

  it('retries a persistent 429 exactly once, then fails over', async () => {
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      throw new Error('429 Too Many Requests');
    };
    await assert.rejects(
      completeWithFailover([M('m1', 'kilo', 'none', true)], [{ role: 'user', content: 'hi' }], completeFn),
      (e) => e instanceof FailoverError
    );
    assert.equal(calls, 2);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      throw new Error('400 Bad Request');
    };
    await assert.rejects(
      completeWithFailover([M('m1', 'kilo', 'none', true)], [{ role: 'user', content: 'hi' }], completeFn),
      (e) => e instanceof FailoverError
    );
    assert.equal(calls, 1);
  });

  it('does not retry terminal errors', async () => {
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      const e = new Error('NO_KEY');
      e.terminal = true;
      throw e;
    };
    await assert.rejects(
      completeWithFailover([M('m1', 'kilo', 'none', true)], [{ role: 'user', content: 'hi' }], completeFn),
      (e) => e.terminal === true
    );
    assert.equal(calls, 1);
  });

  it('classifies transient errors', () => {
    assert.equal(isTransientError(new Error('429 Too Many Requests')), true);
    assert.equal(isTransientError(new Error('Upstream timed out after 45s')), true);
    assert.equal(isTransientError(new Error('503 Service Unavailable')), true);
    assert.equal(isTransientError(new Error('400 Bad Request')), false);
    assert.equal(isTransientError(new Error('401 Unauthorized')), false);
  });
});

describe('pinFirst', () => {
  it('tries the pinned model before the rank order', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    const calls = [];
    const { model } = await completeWithFailover(models, [], async (m) => {
      calls.push(m.id);
      return { text: 'ok', toolCalls: [] };
    }, null, { pinFirst: { id: 'b', provider: 'llm7' } });
    assert.deepEqual(calls, ['b']);
    assert.equal(model.id, 'b');
  });

  it('ignores an unknown pinFirst', async () => {
    const models = [M('a', 'kilo', 'none'), M('b', 'llm7', 'none')];
    const calls = [];
    await completeWithFailover(models, [], async (m) => {
      calls.push(m.id);
      return { text: 'ok', toolCalls: [] };
    }, null, { pinFirst: { id: 'nope', provider: 'nope' } });
    assert.deepEqual(calls, ['a']);
  });
});

describe('gatewayFallbackReason()', () => {
  it('terminal token rejection falls back', () => {
    const err = new Error('NO_KEY');
    err.terminal = true;
    assert.equal(gatewayFallbackReason(err), 'terminal');
  });

  it('FailoverError (every provider failed through the gateway) falls back', () => {
    assert.equal(gatewayFallbackReason(new FailoverError('All failed', [])), 'failover');
  });

  it('a lone transport error does not fall back', () => {
    assert.equal(gatewayFallbackReason(new Error('fetch failed')), null);
  });

  it('null and terminal:false do not fall back', () => {
    assert.equal(gatewayFallbackReason(null), null);
    const err = new Error('x');
    err.terminal = false;
    assert.equal(gatewayFallbackReason(err), null);
  });
});

describe('BAD_MODEL blacklisting — a stale id costs one failure per session', () => {
  const BAD = 'Kilo 400: {"code":"BAD_MODEL","message":"Unknown model. Pick one from /api/models."}';
  const replyFor = (model) => ({ text: `from ${model.id}`, toolCalls: [], assistantMessage: { role: 'assistant', content: 'x' } });

  it('classifies provider unknown-model rejections, and nothing else', () => {
    assert.equal(isBadModelError(new Error(BAD)), true);
    assert.equal(isBadModelError(new Error('Unknown model: foo/bar')), true);
    assert.equal(isBadModelError({ error: { code: 'model_not_found', message: 'no such model' } }), true);
    assert.equal(isBadModelError(new Error('The model `x` does not exist')), true);
    assert.equal(isBadModelError(new Error('429 Too Many Requests')), false);
    assert.equal(isBadModelError(new Error('404 Not Found')), false);
    assert.equal(isBadModelError(new Error('file not found: config.json')), false);
    assert.equal(isBadModelError(new Error('fetch failed')), false);
  });

  it('is not transient — an unknown model never earns a same-model retry', () => {
    assert.equal(isTransientError(new Error(BAD)), false);
  });

  it('blacklists the model after one rejection and never calls it again', async () => {
    const tr = new FailureTracker();
    const sessionBadModels = new Set();
    const models = [M('stale', 'kilo', 'none'), M('good', 'llm7', 'none')];
    const calls = [];
    const completeFn = async (m) => {
      calls.push(m.id);
      if (m.id === 'stale') throw new Error(BAD);
      return replyFor(m);
    };
    const opts = { sessionBadModels };

    const first = await completeWithFailover(models, [], completeFn, tr, opts);
    assert.equal(first.model.id, 'good');
    assert.deepEqual(calls, ['stale', 'good']);
    assert.ok(tr.isBadModel('kilo', 'stale'));
    assert.ok(sessionBadModels.has('kilo/stale'));
    // The provider itself is NOT blamed: a stale id must not cool down
    // or count against the provider's circuit breaker.
    assert.equal(tr.failures('kilo'), 0);

    // Second turn, same session state: the blacklisted model is not
    // even attempted — no call is spent on it.
    calls.length = 0;
    const second = await completeWithFailover(models, [], completeFn, tr, opts);
    assert.equal(second.model.id, 'good');
    assert.deepEqual(calls, ['good']);
    assert.equal(second.attempts.length, 1);
  });

  it('buildFailoverPlan excludes tracker-blacklisted models', () => {
    const tr = new FailureTracker();
    tr.recordBadModel('kilo', 'stale');
    const plan = buildFailoverPlan([M('stale', 'kilo', 'none'), M('good', 'kilo', 'none')], tr);
    assert.deepEqual(plan.map((m) => m.id), ['good']);
  });

  it('reset() clears the blacklist with the rest of the tracker state', () => {
    const tr = new FailureTracker();
    tr.recordBadModel('kilo', 'stale');
    tr.reset();
    assert.equal(tr.isBadModel('kilo', 'stale'), false);
    assert.deepEqual(tr.badModelList(), []);
  });
});

describe('retry-after parsing and pacing', () => {
  it('parses Retry-After style hints in seconds, minutes, and ms', () => {
    assert.equal(parseRetryAfterMs(new Error('429 (retry-after: 30)')), 30_000);
    assert.equal(parseRetryAfterMs(new Error('Retry-After: 2')), 2_000);
    assert.equal(parseRetryAfterMs(new Error('Too many requests. Try again in 1324s.')), 1_324_000);
    assert.equal(parseRetryAfterMs(new Error('rate limited, wait 2 minutes')), 120_000);
    assert.equal(parseRetryAfterMs(new Error('quota exceeded, try again in 500ms')), 500);
  });

  it('returns null when the error carries no usable hint', () => {
    assert.equal(parseRetryAfterMs(new Error('429 Too Many Requests')), null);
    assert.equal(parseRetryAfterMs(new Error('502 Bad Gateway')), null);
    assert.equal(parseRetryAfterMs(new Error('fetch failed')), null);
  });

  it('paces the next candidate on a short retry-after instead of hammering', async () => {
    const models = [M('limited', 'kilo', 'none'), M('good', 'llm7', 'none')];
    const started = Date.now();
    const { model, attempts } = await completeWithFailover(models, [], async (m) => {
      if (m.id === 'limited') throw new Error('429 Too Many Requests (retry-after: 1)');
      return { text: 'from good', toolCalls: [], assistantMessage: {} };
    });
    const elapsed = Date.now() - started;
    assert.equal(model.id, 'good');
    assert.equal(attempts.length, 2);
    assert.ok(elapsed >= 900, `expected the chain to honour the 1s retry-after, took ${elapsed}ms`);
  });
});
