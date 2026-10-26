/**
 * Tests for lib/chatty.mjs — casual-chat guards.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGreeting,
  greetingReply,
  looksLikeIdentityLookup,
  userAskedForIdentity,
  shouldRefuseToolCall,
} from '../lib/chatty.mjs';

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

describe('looksLikeIdentityLookup', () => {
  it('flags public IP service fetches', () => {
    for (const c of ['curl ifconfig.me', 'curl -s https://ipinfo.io/json', 'wget -qO- icanhazip.com', 'curl api.ipify.org', 'curl checkip.amazonaws.com']) {
      assert.equal(looksLikeIdentityLookup(c), true, c);
    }
  });
  it('passes ordinary commands through', () => {
    for (const c of ['ls -la', 'git status', 'npm test', 'cat package.json', 'ip addr', 'ping -c1 example.com']) {
      assert.equal(looksLikeIdentityLookup(c), false, c);
    }
  });
});

describe('userAskedForIdentity', () => {
  it('matches explicit IP/location asks', () => {
    for (const m of ["what's my ip", 'show me my ip', 'get my public ip address', 'where am i', 'what is my location']) {
      assert.equal(userAskedForIdentity(m), true, m);
    }
  });
  it('does not match greetings or ordinary tasks', () => {
    for (const m of ['yo', 'hey', 'fix the build', 'check the repo for ip handling', 'pipe this output']) {
      assert.equal(userAskedForIdentity(m), false, m);
    }
  });
});

describe('shouldRefuseToolCall', () => {
  const ipCall = { name: 'bash', args: { command: 'curl -s ifconfig.me' } };
  const lsCall = { name: 'bash', args: { command: 'ls -la' } };
  it('refuses an unasked IP lookup', () => {
    assert.equal(shouldRefuseToolCall(ipCall, 'yo'), true);
    assert.equal(shouldRefuseToolCall(ipCall, 'hey what is new'), true);
  });
  it('allows the same lookup when explicitly asked', () => {
    assert.equal(shouldRefuseToolCall(ipCall, "what's my ip"), false);
  });
  it('never refuses non-bash tools or ordinary commands', () => {
    assert.equal(shouldRefuseToolCall(lsCall, 'yo'), false);
    assert.equal(shouldRefuseToolCall({ name: 'read_file', args: { path: 'x' } }, 'yo'), false);
  });
});
