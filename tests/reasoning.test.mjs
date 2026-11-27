import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseEffort, reasoningPolicy, withReasoningNote, isLocalDefensiveReview } from '../lib/reasoning.mjs';
import { parseArgs } from '../lib/cli-args.mjs';

describe('adaptive reasoning classification', () => {
  it('uses fast for conversational and small questions', () => {
    assert.equal(chooseEffort('hi'), 'fast');
    assert.equal(chooseEffort('what is a closure?'), 'fast');
    assert.equal(chooseEffort(''), 'fast');
  });

  it('uses balanced for routine implementation and debugging', () => {
    assert.equal(chooseEffort('fix the login error'), 'balanced');
    assert.equal(chooseEffort('add a regression test'), 'balanced');
  });

  it('uses deep for architecture, audits and broad tasks', () => {
    assert.equal(chooseEffort('refactor the authentication architecture'), 'deep');
    assert.equal(chooseEffort('audit the entire repository'), 'deep');
  });

  it('respects explicit modes irrespective of prompt content', () => {
    for (const mode of ['fast', 'balanced', 'deep']) {
      assert.equal(chooseEffort('hi', mode), mode);
    }
    assert.throws(() => chooseEffort('hello', 'magic'), /Unknown reasoning mode/);
  });

  it('does not mutate or reject prompts', () => {
    assert.equal(chooseEffort('a complicated prompt with literal /mcp and punctuation!?'), 'fast');
  });
});

describe('adaptive execution policy', () => {
  it('caps tool budget by task and caller maximum', () => {
    assert.deepEqual(reasoningPolicy('hi'), {mode:'adaptive',effort:'fast',maxSteps:8,maxVerifyAttempts:1});
    assert.equal(reasoningPolicy('fix tests').maxSteps, 24);
    assert.equal(reasoningPolicy('audit entire repository').maxVerifyAttempts, 3);
    assert.equal(reasoningPolicy('audit entire repository', 'deep', 3).maxSteps, 3);
  });

  it('replaces previous effort note without losing other system instructions', () => {
    const system = 'You are an engineer. SECRET: not included in effort notes';
    const first = withReasoningNote(system, 'deep');
    const next = withReasoningNote(first, 'fast');
    assert.equal((next.match(/termux-code:reasoning:start/g) || []).length, 1);
    assert.ok(next.includes('You are an engineer.'));
    assert.ok(next.includes('## Execution effort: fast'));
    assert.ok(!next.includes('## Execution effort: deep'));
    assert.equal(withReasoningNote(next, 'fast'), next);
  });
});

describe('reasoning CLI flags', () => {
  it('defaults to adaptive when unspecified by config', () => {
    assert.equal(parseArgs([]).reasoning, null);
  });
  it('parses both flag forms', () => {
    assert.equal(parseArgs(['--reasoning=deep', '-p', 'fix this']).reasoning, 'deep');
    assert.equal(parseArgs(['--reasoning', 'balanced']).reasoning, 'balanced');
  });
  it('rejects unsupported or missing modes', () => {
    assert.match(parseArgs(['--reasoning', 'instant']).error, /must be/);
    assert.match(parseArgs(['--reasoning']).error, /needs a value/);
  });
});

describe('local defensive review effort', () => {
  it('recognizes short local reviews that require real inspection', () => {
    for (const prompt of ['check my repo for vulnerabilities', 'scan this workspace for secrets', 'review our dependencies for vulnerabilities']) {
      assert.equal(isLocalDefensiveReview(prompt), true, prompt);
      assert.equal(reasoningPolicy(prompt).maxSteps, 40);
    }
  });
  it('does not treat remote access or exploitation as a local review', () => {
    for (const prompt of ['check my repo for vulnerabilities at https://example.com', 'hack this project', 'pentest this project remotely', 'check the weather']) {
      assert.equal(isLocalDefensiveReview(prompt), false, prompt);
    }
  });
  it('honors explicit fast mode and caller ceilings', () => {
    assert.equal(reasoningPolicy('check my repo for vulnerabilities', 'fast').maxSteps, 8);
    assert.equal(reasoningPolicy('check my repo for vulnerabilities', 'adaptive', 5).maxSteps, 5);
  });
});
