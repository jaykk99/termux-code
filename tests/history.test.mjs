import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessages } from '../lib/history.mjs';

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

test('cleanMessages returns [] for non-arrays', () => {
  assert.deepEqual(cleanMessages(null), []);
  assert.deepEqual(cleanMessages('nope'), []);
});
