import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEffort, effortConfig, effortInstruction } from '../lib/effort.mjs';
import { callWithTransientRetry } from '../lib/failover.mjs';

test('automatic effort tracks prompt complexity', () => {
  assert.equal(selectEffort('hi'), 'fast');
  assert.equal(selectEffort('What is a variable?'), 'fast');
  assert.equal(selectEffort('Fix a broken module in this repo'), 'balanced');
  assert.equal(selectEffort('Build an entire full-stack application with frontend backend and tests'), 'deep');
  assert.equal(selectEffort('Refactor this whole repository architecture'), 'deep');
  assert.equal(selectEffort('Read https://example.com and summarize'), 'balanced');
});

test('manual preferences override classification', () => {
  assert.equal(selectEffort('hello','deep'), 'deep');
  assert.equal(selectEffort('Refactor the entire project','fast'), 'fast');
  assert.throws(()=>selectEffort('hello','invalid'), /Invalid effort/);
});

test('fast has smaller failover and backoff budget, deep is more deliberate', () => {
  const fast = effortConfig('fast');
  const deep = effortConfig('deep');
  assert.ok(fast.maxAttempts < deep.maxAttempts);
  assert.ok(fast.maxRetryDelayMs < deep.maxRetryDelayMs);
  assert.equal(fast.transientRetries, 0);
  assert.equal(deep.transientRetries, 1);
  assert.equal(fast.emptyRetry, true);
  assert.equal(effortConfig('balanced').emptyRetry, true);
  assert.equal(deep.emptyRetry, true);
  assert.equal(fast.refusalRetry, false);
  assert.ok(fast.maxAttempts >= 4);
  assert.match(effortInstruction('deep'), /checks/);
  assert.match(effortInstruction('fast'), /promptly/);
});

test('fast mode skips transient retry on a failed provider', async () => {
  let calls=0;
  await assert.rejects(() => callWithTransientRetry({provider:'mock',id:'m'},[],async()=>{
    calls++;
    throw new Error('fetch failed: timeout');
  }, effortConfig('fast')), /timeout/);
  assert.equal(calls, 1);
});
