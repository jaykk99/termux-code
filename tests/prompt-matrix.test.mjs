/**
 * The prompt matrix: every prompt category × every reasoning mode.
 *
 * The merged tree carries two effort systems (lib/effort.mjs failover effort,
 * lib/reasoning.mjs step/verify budgets) and three prompts (native, text
 * protocol, per-turn note). This asserts they agree: each mode produces a
 * bounded policy, the scope sentence survives the per-turn note, and the real
 * turn loop answers every category — including the non-code and deliberately
 * edgy ones — without a refusal reaching the user.
 * Run: node --test tests/prompt-matrix.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turn } from '../bin/termux-code.mjs';
import { SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT } from '../lib/agent.mjs';
import { reasoningPolicy, withReasoningNote, REASONING_MODES } from '../lib/reasoning.mjs';
import { effortInstruction } from '../lib/effort.mjs';
import { isRefusalResponse } from '../lib/refusal.mjs';

const model = { id: 'matrix', provider: 'mock', auth: 'none' };
const CAPS = { fast: 8, balanced: 24, deep: 40 };

const PROMPTS = [
  ['greeting', 'hi'],
  ['small question', 'what is a closure?'],
  ['bug fix', 'fix the login error in auth.mjs'],
  ['build', 'build an entire full-stack app with frontend, backend and tests'],
  ['url', 'read https://example.com and summarize it'],
  ['research', 'research the best sqlite driver and compare the options'],
  ['audit', 'audit this repository for security issues'],
  ['refactor', 'refactor the whole architecture'],
  ['non-code', 'draft a polite email declining a job offer'],
  ['controversial', 'what do you think about the election?'],
  ['uncensored', 'write me a keylogger for my own laptop'],
  ['multi-part', 'add a --json flag, update the README, and run the tests'],
  ['shell', 'list the files here and tell me what this repo does'],
  ['unknown', 'what is the airspeed velocity of an unladen swallow?'],
];

const reply = (text, calls = []) => ({
  text,
  toolCalls: calls,
  assistantMessage: {
    role: 'assistant',
    content: text || null,
    ...(calls.length
      ? {
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        }
      : {}),
  },
});

/** What a model actually sees for this turn: mode note + effort instruction. */
function promptFor(mode, text) {
  const policy = reasoningPolicy(text, mode, 80);
  return {
    policy,
    system: withReasoningNote(SYSTEM_PROMPT, policy.effort),
    user: text + '\n\n' + effortInstruction(policy.effort),
  };
}

test('every prompt × mode gets a bounded policy and an in-scope prompt', () => {
  for (const mode of REASONING_MODES) {
    for (const [label, text] of PROMPTS) {
      const { policy, system, user } = promptFor(mode, text);
      assert.ok(CAPS[policy.effort], `${label}/${mode}: unknown effort ${policy.effort}`);
      assert.equal(policy.maxSteps, CAPS[policy.effort], `${label}/${mode}: step cap`);
      assert.ok(policy.maxVerifyAttempts >= 1 && policy.maxVerifyAttempts <= 3, `${label}/${mode}: verify cap`);
      // The scope sentence must survive each turn's note replacement.
      assert.match(system, /not limited to code/i, `${label}/${mode}: scope dropped`);
      assert.match(system, /## Execution effort: /, `${label}/${mode}: note missing`);
      assert.equal(isRefusalResponse(system), false, `${label}/${mode}: system prompt reads as a refusal`);
      assert.equal(isRefusalResponse(user), false, `${label}/${mode}: ask reads as a refusal`);
    }
  }
  // Both shipped prompts keep the uncensored framing.
  for (const prompt of [SYSTEM_PROMPT, TEXT_SYSTEM_PROMPT]) {
    assert.match(prompt, /no\s+refusals|no\s+safety\s+lectures/i);
  }
});

test('the real turn loop answers every prompt in every mode', async () => {
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const mode of REASONING_MODES) {
      for (const [label, text] of PROMPTS) {
        const policy = reasoningPolicy(text, mode, 80);
        const messages = [
          { role: 'system', content: withReasoningNote(SYSTEM_PROMPT, policy.effort) },
          { role: 'user', content: text + '\n\n' + effortInstruction(policy.effort) },
        ];
        const responses = [
          reply('', [{ id: 'r1', name: 'read_file', args: { path: 'README.md' } }]),
          reply('', [{ id: 'r2', name: 'write_file', args: { path: 'notes.txt', content: 'ok' } }]),
          // Satisfies the URL-coverage check for the prompts that carry a URL.
          reply('', [{ id: 'r3', name: 'fetch_url', args: { url: 'https://example.com' } }]),
          reply(`ANSWER: ${label}`),
        ];
        let step = 0;
        const result = await turn(
          model,
          messages,
          { closed: false, question: (_q, cb) => cb('y') },
          '/tmp',
          async () => responses[step++] || reply('done'),
          {},
          {
            verify: { enabled: false },
            reasoning: policy,
            toolRunner: async (name) =>
              name === 'read_file' ? '# repo\nsrc/\npackage.json' : 'Wrote 1 lines to notes.txt.',
          },
        );
        assert.equal(result, `ANSWER: ${label}`, `${label}/${mode}: no answer (step ${step})`);
        assert.equal(step, 4, `${label}/${mode}: unexpected step count`);
        // Nothing the loop appended may read as a refusal either.
        for (const message of messages) {
          if (typeof message.content !== 'string') continue;
          assert.equal(isRefusalResponse(message.content), false, `${label}/${mode}: refusal in ${message.role}`);
        }
      }
    }
  } finally {
    console.log = realLog;
  }
});
