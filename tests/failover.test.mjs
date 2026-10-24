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
  formatAttempts,
  FAILURES_TO_TRIP,
} from '../lib/failover.mjs';

const M = (id, provider, auth, free = false, disabled = false) => ({
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

  it('tries uncensored-lineage models before every aligned model', () => {
    const models = [
      M('kilo-x', 'kilo', 'none', true),
      M('gpt-4o-mini', 'githubmodels', 'bearer'),
      M('0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', 'hf', 'hf', true),
      M('gateway-uncensored-1', 'gatewayx', 'bearer'),
      M('gemini-x', 'gemini', 'gemini'),
    ];
    const ids = buildFailoverPlan(models).map((m) => m.id);
    // A keyed uncensored-marked model (tool-capable) leads, the HF
    // Heretic pool next, and only then the aligned pool in its order.
    assert.equal(ids[0], 'gateway-uncensored-1');
    assert.equal(ids[1], '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF');
    assert.ok(ids.indexOf('kilo-x') > ids.indexOf(ids[1]));
    assert.ok(ids.indexOf('gpt-4o-mini') > ids.indexOf('kilo-x') || ids.indexOf('gpt-4o-mini') > 1);
    assert.equal(ids[ids.length - 1], 'gemini-x');
  });

  it('an aligned model on a keyed gateway provider does not get the uncensored rank', () => {
    const models = [
      M('glm-5.2', 'gatewayx', 'bearer'),
      M('DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF', 'hf', 'hf', true),
      M('kilo-x', 'kilo', 'none', true),
    ];
    const ids = buildFailoverPlan(models).map((m) => m.id);
    assert.equal(ids[0], 'DavidAU/Llama-3.2-8X3B-MOE-Dark-Champion-Instruct-uncensored-abliterated-18.4B-GGUF');
    assert.ok(ids.indexOf('glm-5.2') > 0);
    assert.ok(ids.indexOf('kilo-x') > 0);
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
      if (m.id === 'bad') throw new Error('kilo 429');
      return replyFor(m);
    });
    assert.equal(calls, 2);
    assert.equal(model.id, 'good');
    assert.equal(reply.text, 'from good');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].ok, false);
    assert.match(attempts[0].error, /kilo 429/);
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
