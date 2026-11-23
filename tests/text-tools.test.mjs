/**
 * Tests for lib/text-tools.mjs — the text tool-calling protocol for models
 * with no native function calling, and the transcript conversion that
 * keeps tool exchanges when a session fails over to a text-only model.
 * Run: node --test tests/text-tools.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  normalizeToolDefs,
  describeTools,
  textProtocolPrompt,
  parseTextToolCalls,
  parseToolArgs,
  formatToolResult,
  formatToolCall,
  toTextTranscript,
  transcriptToPrompt,
} from '../lib/text-tools.mjs';

const PLAIN = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
];

describe('normalizeToolDefs', () => {
  it('passes plain schemas through', () => {
    assert.deepEqual(normalizeToolDefs(PLAIN), PLAIN);
  });

  it('unwraps OpenAI wire format', () => {
    const defs = [{ type: 'function', function: { name: 'grep', description: 'Search', parameters: { type: 'object', properties: {} } } }];
    assert.deepEqual(normalizeToolDefs(defs), [{ name: 'grep', description: 'Search', parameters: { type: 'object', properties: {} } }]);
  });

  it('unwraps Anthropic wire format', () => {
    const defs = [{ name: 'grep', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }];
    assert.deepEqual(normalizeToolDefs(defs), [{ name: 'grep', description: 'Search', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]);
  });

  it('skips junk and defaults missing fields', () => {
    assert.deepEqual(normalizeToolDefs([null, 'nope', 42, {}, { name: '' }, { description: 'no name' }]), []);
    assert.deepEqual(normalizeToolDefs([{ name: 'x' }]), [{ name: 'x', description: '', parameters: {} }]);
    assert.deepEqual(normalizeToolDefs(null), []);
    assert.deepEqual(normalizeToolDefs('not an array'), []);
  });
});

describe('describeTools', () => {
  it('lists one line per tool with required vs optional args', () => {
    const out = describeTools(PLAIN);
    assert.match(out, /- read_file\(path: string\) — Read a file/);
    assert.match(out, /- bash\(command: string, timeout\?: number\) — Run a command/);
  });

  it('dedupes by name and merges extras', () => {
    const extra = [{ name: 'bash', description: 'duplicate', parameters: {} }];
    const out = describeTools(PLAIN, extra);
    assert.equal(out.split('\n').filter((l) => l.startsWith('- bash')).length, 1);
  });

  it('renders array args as array', () => {
    const out = describeTools([{ name: 'multi', description: 'd', parameters: { type: 'object', properties: { files: { type: 'array' } } } }]);
    assert.match(out, /files\?: array/);
  });
});

describe('textProtocolPrompt', () => {
  it('shows the block format and the tool list', () => {
    const p = textProtocolPrompt(PLAIN);
    assert.match(p, /<tool_call>{"name": "read_file"/);
    assert.match(p, /read_file\(path: string\)/);
    assert.match(p, /STOP and wait/);
    assert.match(p, /Never write a\s+<tool_result> yourself/);
  });

  it('adds the Composio note only when a composio_ tool is present', () => {
    const withComposio = textProtocolPrompt(PLAIN, [{ name: 'composio_search', description: 'find an action', parameters: {} }]);
    assert.match(withComposio, /composio_search finds the right action/);
    assert.doesNotMatch(textProtocolPrompt(PLAIN), /composio_search finds/);
  });
});

describe('parseTextToolCalls', () => {
  it('returns plain text untouched when there are no calls', () => {
    const r = parseTextToolCalls('just an answer, no tools');
    assert.deepEqual(r, { text: 'just an answer, no tools', calls: [], errors: [] });
    assert.deepEqual(parseTextToolCalls(''), { text: '', calls: [], errors: [] });
    assert.deepEqual(parseTextToolCalls(null), { text: '', calls: [], errors: [] });
  });

  it('takes a tool object written without <tool_call> tags', () => {
    const r = parseTextToolCalls('{"name": "write_file", "args": {"path": "NOTES.md", "content": "hi"}}');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'write_file');
    assert.deepEqual(r.calls[0].args, { path: 'NOTES.md', content: 'hi' });
    assert.equal(r.text, '');
  });

  it('takes several bare objects in one reply, in order', () => {
    const r = parseTextToolCalls(
      '{"name": "bash", "args": {"command": "ls"}} {"name": "write_file", "args": {"path": "a", "content": "b"}}',
    );
    assert.deepEqual(r.calls.map((c) => c.name), ['bash', 'write_file']);
    assert.deepEqual(r.calls[1].args, { path: 'a', content: 'b' });
  });

  it('leaves JSON that names no real tool in the visible text', () => {
    const r = parseTextToolCalls('{"name": "not_a_tool", "args": {}}');
    assert.equal(r.calls.length, 0);
    assert.match(r.text, /not_a_tool/);
  });

  it('never runs a call that has prose around it', () => {
    const src = 'I will write the file now: {"name": "write_file", "args": {"path": "a", "content": "b"}}';
    const r = parseTextToolCalls(src);
    assert.equal(r.calls.length, 0);
    assert.equal(r.text, src);
  });

  it('never runs bare objects that are followed by prose', () => {
    const src = '{"name": "bash", "args": {"command": "ls"}} that should list the folder';
    const r = parseTextToolCalls(src);
    assert.equal(r.calls.length, 0);
    assert.match(r.text, /should list the folder/);
  });

  it('never runs a call inside a code fence', () => {
    const r = parseTextToolCalls('```json\n{"name": "bash", "args": {"command": "ls"}}\n```');
    assert.equal(r.calls.length, 0);
    assert.match(r.text, /"name": "bash"/);
  });

  it('ignores a bare object whose JSON never closes', () => {
    const r = parseTextToolCalls('{"name": "write_file", "args": {"path": "a", "content": "b"');
    assert.equal(r.calls.length, 0);
  });

  it('keeps <tool_call> the only parse when both forms are present', () => {
    const r = parseTextToolCalls(
      '<tool_call>{"name": "read_file", "args": {"path": "a"}}</tool_call> {"name": "bash", "args": {"command": "ls"}}',
    );
    assert.deepEqual(r.calls.map((c) => c.name), ['read_file']);
    assert.match(r.text, /"name": "bash"/);
  });

  it('parses one call and strips it from the visible text', () => {
    const r = parseTextToolCalls('Let me read that.\n<tool_call>{"name": "read_file", "args": {"path": "a.js"}}</tool_call>');
    assert.equal(r.text, 'Let me read that.');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'read_file');
    assert.deepEqual(r.calls[0].args, { path: 'a.js' });
    assert.equal(r.calls[0].textProtocol, true);
    assert.match(r.calls[0].id, /^txt_/);
    assert.deepEqual(r.errors, []);
  });

  it('parses several calls in one reply, in order', () => {
    const src = '<tool_call>{"name": "read_file", "args": {"path": "a.js"}}</tool_call> and then <tool_call>{"name": "bash", "args": {"command": "ls"}}</tool_call>';
    const r = parseTextToolCalls(src);
    assert.deepEqual(r.calls.map((c) => c.name), ['read_file', 'bash']);
    assert.equal(r.text, 'and then');
  });

  it('accepts arguments, parameters, and input keys', () => {
    for (const key of ['args', 'arguments', 'parameters', 'input']) {
      const r = parseTextToolCalls(`<tool_call>{"name": "bash", "${key}": {"command": "ls"}}</tool_call>`);
      assert.deepEqual(r.calls[0].args, { command: 'ls' }, key);
    }
  });

  it('accepts arguments as a JSON string', () => {
    const r = parseTextToolCalls('<tool_call>{"name": "bash", "args": "{\\"command\\": \\"ls\\"}"}</tool_call>');
    assert.deepEqual(r.calls[0].args, { command: 'ls' });
  });

  it('accepts {"tool": ...} and {"function": {...}} shapes', () => {
    const a = parseTextToolCalls('<tool_call>{"tool": "bash", "args": {"command": "ls"}}</tool_call>');
    assert.equal(a.calls[0].name, 'bash');
    const b = parseTextToolCalls('<tool_call>{"function": {"name": "bash", "arguments": "{\\"command\\": \\"ls\\"}"}}</tool_call>');
    assert.equal(b.calls[0].name, 'bash');
    assert.deepEqual(b.calls[0].args, { command: 'ls' });
  });

  it('strips code fences inside the block', () => {
    const r = parseTextToolCalls('<tool_call>```json\n{"name": "bash", "args": {"command": "ls"}}\n```</tool_call>');
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].args, { command: 'ls' });
  });

  it('recovers trailing commas and prose around the object', () => {
    const a = parseTextToolCalls('<tool_call>{"name": "bash", "args": {"command": "ls",},}</tool_call>');
    assert.equal(a.calls.length, 1, 'trailing commas');
    const b = parseTextToolCalls('<tool_call>here is the call: {"name": "bash", "args": {"command": "ls"}} hope that helps</tool_call>');
    assert.equal(b.calls.length, 1, 'prose around the object');
  });

  it('parses an unterminated final block', () => {
    const r = parseTextToolCalls('Reading now <tool_call>{"name": "read_file", "args": {"path": "a.js"}}');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, 'read_file');
    assert.equal(r.text, 'Reading now');
  });

  it('treats a nested open as an unterminated first block', () => {
    const src = '<tool_call>{"name": "read_file", "args": {"path": "a.js"}}<tool_call>{"name": "bash", "args": {"command": "ls"}}</tool_call>';
    const r = parseTextToolCalls(src);
    assert.deepEqual(r.calls.map((c) => c.name), ['read_file', 'bash']);
    assert.deepEqual(r.errors, []);
  });

  it('reports unparseable blocks as errors instead of dropping them silently', () => {
    const r = parseTextToolCalls('<tool_call>not json at all {{{</tool_call> done');
    assert.equal(r.calls.length, 0);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /not json/);
    assert.equal(r.text, 'done');
  });

  it('ignores empty blocks', () => {
    const r = parseTextToolCalls('<tool_call>   </tool_call> hi');
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.text, 'hi');
  });

  it('never shows a hallucinated tool_result', () => {
    const r = parseTextToolCalls('I already read it <tool_result name="read_file">fake contents</tool_result> trust me');
    assert.doesNotMatch(r.text, /fake contents/);
    assert.match(r.text, /trust me/);
  });

  it('rejects calls with no name', () => {
    const r = parseTextToolCalls('<tool_call>{"args": {"path": "a.js"}}</tool_call>');
    assert.equal(r.calls.length, 0);
    assert.equal(r.errors.length, 1);
  });

  it('recovers a block whose arguments contain raw newlines', () => {
    const r = parseTextToolCalls('<tool_call>{"name":"write_file","args":{"path":"a.js","content":"one\ntwo"}}</tool_call>');
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].args, { path: 'a.js', content: 'one\ntwo' });
    assert.deepEqual(r.errors, []);
  });

  it('collapses runs of blank lines in the visible text', () => {
    const r = parseTextToolCalls('a\n\n\n\n<tool_call>{"name": "bash", "args": {}}</tool_call>\n\n\n\nb');
    assert.equal(r.text, 'a\n\nb');
  });
});

describe('parseToolArgs', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(parseToolArgs('{"path":"a.js"}'), { path: 'a.js' });
    assert.deepEqual(parseToolArgs('{}'), {});
  });

  it('repairs raw newlines and tabs inside a string value', () => {
    const raw = '{"path":"a.js","content":"one\ntwo\tend"}';
    assert.throws(() => JSON.parse(raw), 'the input really is invalid JSON');
    assert.deepEqual(parseToolArgs(raw), { path: 'a.js', content: 'one\ntwo\tend' });
  });

  it('leaves existing escapes untouched', () => {
    assert.deepEqual(parseToolArgs('{"content":"a\\nb\\"c"}'), { content: 'a\nb"c' });
  });

  it('still handles fences, trailing commas and prose', () => {
    assert.deepEqual(parseToolArgs('```json\n{"command":"ls",}\n```'), { command: 'ls' });
    assert.deepEqual(parseToolArgs('the call: {"command":"ls"} thanks'), { command: 'ls' });
    assert.deepEqual(parseToolArgs('{"command":"ls","content":"a\nb"}'), { command: 'ls', content: 'a\nb' });
  });

  it('returns null for junk, non-objects and empty input', () => {
    assert.equal(parseToolArgs('not json at all'), null);
    assert.equal(parseToolArgs('[1,2,3]'), null);
    assert.equal(parseToolArgs(''), null);
    assert.equal(parseToolArgs(null), null);
  });
});

describe('formatToolResult / formatToolCall', () => {
  it('wraps a result in a tool_result block', () => {
    assert.equal(formatToolResult('read_file', 'hello'), '<tool_result name="read_file">\nhello\n</tool_result>');
  });

  it('sanitizes quotes out of the name attribute', () => {
    assert.match(formatToolResult('we"ird', 'x'), /name="we'ird"/);
  });

  it('round-trips through the parser', () => {
    const encoded = formatToolCall('bash', { command: 'ls' });
    assert.equal(encoded, `${TOOL_CALL_OPEN}{"name":"bash","args":{"command":"ls"}}${TOOL_CALL_CLOSE}`);
    const r = parseTextToolCalls(encoded);
    assert.equal(r.calls[0].name, 'bash');
    assert.deepEqual(r.calls[0].args, { command: 'ls' });
  });
});

describe('toTextTranscript', () => {
  it('joins system messages and keeps user/assistant turns', () => {
    const t = toTextTranscript([
      { role: 'system', content: 'Be helpful.' },
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    assert.equal(t.system, 'Be helpful.\n\nBe brief.');
    assert.deepEqual(t.messages, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('turns role:tool messages into user tool_result blocks', () => {
    const t = toTextTranscript([
      { role: 'user', content: 'read a.js' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
      { role: 'tool', name: 'read_file', content: 'file contents' },
    ]);
    assert.deepEqual(t.messages, [
      { role: 'user', content: 'read a.js' },
      { role: 'assistant', content: '<tool_call>{"name":"read_file","args":{"path":"a.js"}}</tool_call>' },
      { role: 'user', content: '<tool_result name="read_file">\nfile contents\n</tool_result>' },
    ]);
  });

  it('converts Anthropic tool_use / tool_result blocks', () => {
    const t = toTextTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'a.js' }] },
    ]);
    assert.match(t.messages[1].content, /checking/);
    assert.match(t.messages[1].content, /<tool_call>{"name":"bash"/);
    assert.match(t.messages[2].content, /<tool_result name="tool">/);
    assert.match(t.messages[2].content, /a\.js/);
  });

  it('merges same-role neighbours so providers get strict alternation', () => {
    const t = toTextTranscript([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'three' },
      { role: 'assistant', content: 'four' },
    ]);
    assert.deepEqual(t.messages, [
      { role: 'user', content: 'one\n\ntwo' },
      { role: 'assistant', content: 'three\n\nfour' },
    ]);
  });

  it('drops a leading assistant turn so the transcript starts with user', () => {
    const t = toTextTranscript([
      { role: 'assistant', content: 'orphaned greeting' },
      { role: 'user', content: 'real start' },
    ]);
    assert.deepEqual(t.messages, [{ role: 'user', content: 'real start' }]);
  });

  it('keeps text-protocol calls inside assistant text', () => {
    const t = toTextTranscript([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'on it <tool_call>{"name": "bash", "args": {"command": "ls"}}</tool_call>' },
    ]);
    assert.match(t.messages[1].content, /<tool_call>/);
  });

  it('skips empty and malformed messages', () => {
    const t = toTextTranscript([null, 'nope', { role: 'user', content: '  ' }, { role: 'user', content: 'kept' }]);
    assert.deepEqual(t.messages, [{ role: 'user', content: 'kept' }]);
  });
});

describe('transcriptToPrompt', () => {
  it('renders system, turns, and a trailing assistant header', () => {
    const p = transcriptToPrompt({
      system: 'Be helpful.',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    assert.ok(p.startsWith('Be helpful.'));
    assert.match(p, /### User:\nhi/);
    assert.match(p, /### Assistant:\nhello/);
    assert.ok(p.endsWith('### Assistant:\n'));
  });

  it('works with no system prompt', () => {
    const p = transcriptToPrompt({ system: '', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(p.startsWith('### User:'));
  });
});
