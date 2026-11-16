/**
 * Tests for lib/chatty.mjs — the greeting shortcut, and the guarantee that
 * nothing here blocks a tool call any more.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as chatty from '../lib/chatty.mjs';
import { isGreeting, greetingReply } from '../lib/chatty.mjs';

describe('isGreeting', () => {
  it('matches bare greetings', () => {
    for (const g of ['yo', 'Yo', 'yo!', 'hey', 'hi', 'hello', 'sup', 'howdy', 'wassup', "what's up", 'whats up', 'good morning']) {
      assert.equal(isGreeting(g), true, g);
    }
  });
  it('matches greetings with bro or repeats', () => {
    assert.equal(isGreeting('yo bro'), true);
    assert.equal(isGreeting('hey bro'), true);
    assert.equal(isGreeting('yo yo'), true);
    assert.equal(isGreeting('yo yo yo'), true);
  });
  it('does not match messages with real content', () => {
    for (const m of ['yo, check the repo', 'yo what is new with the build', 'hey can you fix this', 'yo bro run the tests', 'help', 'what can you do', '']) {
      assert.equal(isGreeting(m), false, m);
    }
  });
});

describe('greetingReply', () => {
  it('is plain text and asks a follow-up', () => {
    const r = greetingReply();
    assert.match(r, /working on/i);
    assert.doesNotMatch(r, /ip|location|curl|command/i);
  });
});

describe('no hardblocks', () => {
  it('exports no tool-call refusal any more', () => {
    // The owner's rule: fully uncensored, no hardblocks. Approval prompts
    // decide what runs, nothing else. A reintroduced guard should fail here.
    for (const name of ['shouldRefuseToolCall', 'looksLikeIdentityLookup',
      'userAskedForIdentity']) {
      assert.equal(chatty[name], undefined, `${name} must not come back`);
    }
  });

  it('the greeting shortcut is the only interception left', () => {
    const exported = Object.keys(chatty).sort();
    assert.deepEqual(exported, ['greetingReply', 'isGreeting', 'normalizeChat']);
  });
});
