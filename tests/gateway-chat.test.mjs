import test from 'node:test';
import assert from 'node:assert/strict';
import { clampReply, sanitizeMessages } from '../app/api/chat/route.js';

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

test('gateway chat reply rebuilds tool_calls so tool results are not orphaned', () => {
  const r = clampReply({ text: '', toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }] });
  assert.deepEqual(r.assistantMessage.tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } },
  ]);
});

test('gateway chat reply keeps native Anthropic blocks, tool_use included', () => {
  const blocks = [
    { type: 'text', text: 'reading' },
    { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } },
  ];
  const r = clampReply({ text: 'reading', toolCalls: [{ id: 'tu1', name: 'read_file', args: { path: 'a.txt' } }], assistantMessage: { role: 'assistant', content: blocks } });
  assert.deepEqual(r.assistantMessage.content, blocks);
});

test('gateway sanitize keeps well-formed tool_calls and drops malformed ones', () => {
  const out = sanitizeMessages([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
      { id: 'c2', function: { name: 'x' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'out' },
  ]);
  assert.deepEqual(out[0].tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } },
  ]);
});

test('gateway sanitize still rejects histories over its 100-message cap', async () => {
  const msgs = Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' }));
  let thrown;
  try {
    sanitizeMessages(msgs);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof Response);
  assert.equal(thrown.status, 400);
  assert.equal((await thrown.json()).error.code, 'BAD_MESSAGES');
});
