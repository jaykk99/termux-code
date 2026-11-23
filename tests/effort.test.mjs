import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEffort, effortConfig, effortInstruction } from '../lib/effort.mjs';

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
  assert.match(effortInstruction('deep'), /checks/);
  assert.match(effortInstruction('fast'), /promptly/);
});
