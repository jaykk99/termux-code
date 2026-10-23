/**
 * Tests for lib/refusal.mjs — the refusal detector behind the failover
 * chain's sorry-skip. The detector is ported from error-inbox's
 * isRefusalResponse; these tests pin both halves of its contract:
 * real refusals are caught, ordinary answers are not.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRefusalResponse, isRefusalReply } from '../lib/refusal.mjs';

describe('isRefusalResponse() — catches real refusals', () => {
  const refusals = [
    "I'm sorry, but I can't help with that request.",
    "I'm sorry, I cannot assist with that.",
    'As an AI language model, I cannot help with that.',
    "I understand what you're asking, but I'm not able to help with that.",
    "Unfortunately, I can't provide that information.",
    'I must decline to answer that.',
    'That would violate my content policy, so I will not help with it.',
    "I don't feel comfortable generating that.",
    'I cannot and will not comply with that request.',
  ];
  for (const text of refusals) {
    it(`flags: ${text.slice(0, 48)}…`, () => {
      assert.equal(isRefusalResponse(text), true);
    });
  }

  it('normalises curly quotes before matching', () => {
    assert.equal(isRefusalResponse('I’m sorry, but I can’t help with that.'), true);
  });
});

describe('isRefusalResponse() — leaves real answers alone', () => {
  const answers = [
    'Here is the function you asked for:\n\nfunction add(a, b) { return a + b; }',
    'The build passes now. Sorry about the noise in the earlier logs.',
    "I'm sorry to hear the tests are failing. Let's look at the stack trace first.",
    "I can't reproduce the bug locally, but the null check in parse() is the likely culprit — here is a fix.",
    'Sure — I can help with that. First, open lib/agent.mjs and find the dispatch switch.',
  ];
  for (const text of answers) {
    it(`passes: ${text.slice(0, 48)}…`, () => {
      assert.equal(isRefusalResponse(text), false);
    });
  }

  it('ignores refusal-shaped text deep in a long answer (head-bounded scan)', () => {
    const long = 'Here is the full walkthrough of the change. '.repeat(12) +
      "One caveat from testing: I can't help with that edge case yet because the API is undocumented.";
    assert.ok(long.length > 320);
    assert.equal(isRefusalResponse(long), false);
  });

  it('handles empty and missing text', () => {
    assert.equal(isRefusalResponse(''), false);
    assert.equal(isRefusalResponse(null), false);
    assert.equal(isRefusalResponse(undefined), false);
  });
});

describe('isRefusalReply()', () => {
  it('honours the explicit refused flag regardless of text', () => {
    assert.equal(isRefusalReply({ text: 'Anthropic declined this request.', toolCalls: [], refused: true }), true);
  });

  it('never flags a reply that carries tool calls', () => {
    const reply = {
      text: "I can't do that part directly, but I'll run the tests and show you.",
      toolCalls: [{ id: '1', name: 'run_tests', args: {} }],
    };
    assert.equal(isRefusalReply(reply), false);
  });

  it('flags a text-only refusal reply', () => {
    assert.equal(isRefusalReply({ text: "I'm sorry, but I can't help with that.", toolCalls: [] }), true);
  });

  it('passes a normal reply and a null reply', () => {
    assert.equal(isRefusalReply({ text: 'Done — two files changed.', toolCalls: [] }), false);
    assert.equal(isRefusalReply(null), false);
  });
});
