/**
 * Tests for lib/refusal.mjs — the refusal detector behind the failover
 * chain's sorry-skip. The detector is ported from error-inbox's
 * isRefusalResponse; these tests pin both halves of its contract:
 * real refusals are caught, ordinary answers are not.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRefusalResponse, isRefusalReply, isBlankReply } from '../lib/refusal.mjs';

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
    // Battery added in the 2026-10-23 refusal pass — phrasings the
    // original pattern set missed outright.
    'I apologize, but I cannot fulfill this request.',
    'I understand your request, but I cannot assist with creating that content.',
    "As an AI language model, I'm unable to help with that.",
    "I'm unable to assist with that request.",
    "Sorry, I can't generate that kind of content.",
    "I can't help you with that.",
    "I won't be able to help with that.",
    "This request violates my safety guidelines, so I can't proceed.",
    "I'm not comfortable helping with that.",
    'I must decline this request.',
    "Unfortunately, I'm not able to provide that information.",
    'I cannot create content of that nature.',
    "My guidelines don't allow me to help with that.",
    "I can't assist with requests of that nature.",
    'Regrettably, I cannot help you with this.',
    "I'm afraid I can't help with that.",
    "Sorry, but I won't help with that.",
    'I do not provide assistance with that kind of request.',
    "As much as I'd like to help, I can't.",
    "I'm sorry, I won't be able to complete that request.",
    "I don't think it's appropriate for me to generate that content.",
    'That goes against my content policy, so I have to decline.',
    // Battery added in the 2026-10-24 follow-up audit — phrasings the
    // set above missed outright, so the chain stopped at the first
    // model and surfaced the refusal instead of walking on.
    'I refuse to help with that.',
    "I can't do this.",
    'I cannot do this for you.',
    "That's not something I can help with.",
    'This is not something I can do.',
    'Unable to comply with this request.',
    'Unable to help with that.',
    "I don't provide instructions for that.",
    "I'm not in a position to help with that.",
    'My safety guidelines prohibit me from helping with this.',
    "I can't show you that.",
    "I can't share that.",
    "I won't be doing that.",
    "Sorry, can't help with that.",
    'My programming prevents me from generating that content.',
    "I can't do this because it goes against my guidelines.",
    'Unfortunately, unable to comply with this request.',
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
    // Battery added in the 2026-10-23 refusal pass — legit answers the
    // original pattern set misread as refusals, plus near-miss shapes.
    'Here is a recon plan for your own server: start with nmap -sV against your host, then check the TLS config. Log the open ports, banner versions, and any expired certs.',
    'Fall special: full gutter cleaning from $100, guards installed at $8.50 per foot. Call today to book your free inspection before the snow flies.',
    'The lighthouse keeper woke before dawn, the letter still unopened on the table. She made tea, watched the fog eat the harbour, and finally slit the envelope with her thumb.',
    'Healthy relationships are built on trust, communication, and respect. Partners set boundaries, listen without interrupting, and resolve conflict without threats or control.',
    "I'm sorry to hear the deploy failed. Roll back to the last green build, then check the migration logs — here is the command sequence.",
    "I won't be able to finish the full migration tonight because the test suite takes two hours, but the schema half is done and committed.",
    'This cannot be merged yet: the parser cannot handle empty input. Add a guard clause like the one below.',
    "As an AI coding assistant I can help with that — here's the refactored dispatch switch.",
    "I'm sorry, I forgot to mention the second changed file in my last message — it's lib/http.mjs, and the diff is small.",
    "I don't think it's appropriate to use a global variable for the session here; a closure keeps it scoped. Example below.",
    "I don't feel comfortable merging this without tests — add the two cases below and I'll sign off.",
    "The style guide says to decline pull requests that skip CI; here's how to run the checks locally so yours passes.",
    "I can't wait to show you this — the benchmark doubled after the cache fix. Numbers below.",
    'Unfortunately the package was renamed on npm; install the new name and the imports resolve again.',
    'To solve 3x + 7 = 22, subtract 7 from both sides to get 3x = 15, then divide by 3: x = 5.',
    'I cannot stress this enough: back up the database before running the migration. Steps follow.',
    "It would violate the warranty to open the PSU, so instead check the external fuse first — here's how.",
    "My policy is to always run the tests before committing; here's the pre-commit hook I use.",
    "I can't help but notice the loop never terminates when the list is empty — add a break condition like this.",
    "Against my principles of clean code, I'd still ship the workaround today and refactor Friday — here's the patch.",
    // Guards for the 2026-10-24 patterns: near-miss legit answers that
    // must NOT be swept up by the new refusal shapes.
    'I refuse to merge this without tests — add the two cases below and I will sign off.',
    "I can't do this alone, but here is the script that does the bulk of it.",
    "I can't do this justice in one paragraph, so here is the short version plus the full doc.",
    "That's not something I can help with alone — you'll need the electrician for the panel, but here is the wiring plan.",
    'Unable to comply with that approach — use the new API instead, here is the patch.',
    "I'm not in a position to judge that call yet, but here is the data you asked for.",
    'My policy is to run the full suite before every deploy; the checklist is below.',
    "I don't provide legal advice for that jurisdiction, but here is some general information that may help.",
    "I can't share that file until Friday, but here is the draft.",
    "Sorry, can't help but notice the cache key is missing a prefix — fix below.",
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

describe('isBlankReply()', () => {
  it('flags empty, whitespace-only, missing, and null replies', () => {
    assert.equal(isBlankReply({ text: '', toolCalls: [] }), true);
    assert.equal(isBlankReply({ text: '   \n  ', toolCalls: [] }), true);
    assert.equal(isBlankReply({ toolCalls: [] }), true);
    assert.equal(isBlankReply(null), true);
  });

  it('does not flag real text or a reply carrying tool calls', () => {
    assert.equal(isBlankReply({ text: 'Done.', toolCalls: [] }), false);
    assert.equal(isBlankReply({ text: '', toolCalls: [{ id: '1', name: 'bash', args: {} }] }), false);
  });
});
