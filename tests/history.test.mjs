import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessages, trimForGateway } from '../lib/history.mjs';

test('cleanMessages drops null, undefined, and non-object entries', () => {
  const out = cleanMessages([
    { role: 'user', content: 'hi' },
    null,
    undefined,
    'junk',
    42,
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('cleanMessages drops bad roles and bad content, keeps tool fields', () => {
  const out = cleanMessages([
    { role: 'bogus', content: 'x' },
    { role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'read' },
    { role: 'user', content: 123 },
  ]);
  assert.deepEqual(out, [
    { role: 'tool', content: 'ok', tool_call_id: 'c1', name: 'read' },
  ]);
});

test('cleanMessages keeps a poisoned session usable', () => {
  const out = cleanMessages([
    { role: 'user', content: 'first' },
    null,
    { role: 'user', content: 'second' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].content, 'second');
});

test('cleanMessages keeps well-formed tool_calls, drops malformed ones', () => {
  const out = cleanMessages([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
      { id: '', function: { name: 'x', arguments: '{}' } },
      { id: 'c2', function: { name: 'x' } },
      'junk',
    ] },
    { role: 'tool', tool_call_id: 'c1', name: 'list_dir', content: 'a.txt' },
  ]);
  assert.deepEqual(out[0].tool_calls, [
    { id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
  ]);
});

test('trimForGateway keeps the system prompt plus recent turns under the cap', () => {
  const msgs = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` }))];
  const out = trimForGateway(msgs);
  assert.equal(out[0].role, 'system');
  assert.ok(out.length <= 91);
  assert.equal(out.at(-1).content, 'm199');
  // no tool history was trimmed away, so nothing orphaned
  assert.ok(!out.some((m) => m.role === 'tool'));
});

test('trimForGateway never starts with an orphaned tool result', () => {
  const msgs = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 199 }, (_, i) => ({ role: 'user', content: `u${i}` }))];
  msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
  msgs.push({ role: 'tool', tool_call_id: 'c0', name: 'bash', content: 'out' });
  for (let i = 0; i < 199; i++) msgs.push({ role: 'user', content: `tail${i}` });
  // force the trim window to start exactly on the orphaned tool message
  const out = trimForGateway(msgs, { maxMessages: 200, maxChars: 1_000_000 });
  assert.notEqual(out[1].role, 'tool');
  assert.ok(out.every((m, i) => i === 0 || m.role !== 'tool' || out[i - 1].tool_calls?.some((c) => c.id === m.tool_call_id)));
});

test('trimForGateway always keeps the newest message, even over the char budget', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old' },
    { role: 'user', content: 'x'.repeat(5000) },
  ];
  const out = trimForGateway(msgs, { maxChars: 100 });
  assert.equal(out.at(-1).content, 'x'.repeat(5000));
});

test('trimForGateway keeps tool_calls through the trim', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'bash', content: 'out' },
    { role: 'user', content: 'thanks' },
  ];
  const out = trimForGateway(msgs);
  const asst = out.find((m) => m.role === 'assistant');
  assert.equal(asst.tool_calls[0].id, 'c1');
});

test('cleanMessages returns [] for non-arrays', () => {
  assert.deepEqual(cleanMessages(null), []);
  assert.deepEqual(cleanMessages('nope'), []);
});
