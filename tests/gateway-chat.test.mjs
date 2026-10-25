import test from 'node:test';
import assert from 'node:assert/strict';
import { clampReply } from '../app/api/chat/route.js';

// Regression: the Termux CLI pushes reply.assistantMessage into the
// conversation history after every turn. When the gateway omitted that
// field, the history gained an undefined entry, so the NEXT message failed
// gateway validation (BAD_MESSAGES) on every failover attempt while the
// first message had gone through fine.
test('gateway chat reply carries assistantMessage matching the text', () => {
  const r = clampReply({ text: 'hello', toolCalls: [], refused: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.assistantMessage, { role: 'assistant', content: 'hello' });
});

test('gateway chat reply keeps assistantMessage in sync when text is clamped', () => {
  const long = 'x'.repeat(40000);
  const r = clampReply({ text: long, toolCalls: [] });
  assert.equal(r.truncated, true);
  assert.equal(r.assistantMessage.content, r.text);
  assert.ok(r.assistantMessage.content.includes('[output truncated'));
});
