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
