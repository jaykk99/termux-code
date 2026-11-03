import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseTextToolCalls, toTextTranscript, textProtocolPrompt, normalizeToolDefs } from '../lib/text-tools.mjs';
import { composioToolsForOpenAI, composioToolsForAnthropic } from '../lib/server-tools.mjs';
import { complete, applyTextProtocol, appendToolResult, rejectsTools, hordePrompt, cutAtNextTurn } from '../lib/agent.mjs';
import { runTool, applyEdits } from '../lib/tools.mjs';
import { parsePatch, applyPatchText } from '../lib/patch.mjs';
import { compactInPlace, needsCompaction, digest, SUMMARY_MARK } from '../lib/context.mjs';
import { isOrphanedStart } from '../lib/history.mjs';
import { detectVerifyCommand, wroteFiles, pathsFromCall, exitCodeOf, failureMessage } from '../lib/verify.mjs';
import { clampReply } from '../app/api/chat/route.js';

const yes = async () => true;
const no = async () => false;

async function tmpdir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tc-up-')));
}

/* ---------------- text tool protocol ---------------- */

describe('parseTextToolCalls', () => {
  it('parses a plain block and strips it from visible text', () => {
    const r = parseTextToolCalls('Reading it.\n<tool_call>{"name":"read_file","args":{"path":"a.js"}}</tool_call>');
    assert.equal(r.text, 'Reading it.');
    assert.equal(r.calls.length, 1);
    assert.deepEqual({ name: r.calls[0].name, args: r.calls[0].args }, { name: 'read_file', args: { path: 'a.js' } });
    assert.equal(r.calls[0].textProtocol, true);
    assert.match(r.calls[0].id, /^txt_/);
  });

  it('tolerates fences, "arguments" as a JSON string, trailing commas and a missing close tag', () => {
    const r = parseTextToolCalls(
      '<tool_call>```json\n{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}",}\n```</tool_call>' +
        '<tool_call>{"tool":"grep","parameters":{"pattern":"x"}}'
    );
    assert.deepEqual(r.calls.map((c) => [c.name, c.args]), [['bash', { command: 'ls' }], ['grep', { pattern: 'x' }]]);
    assert.deepEqual(r.errors, []);
  });

  it('reports unparseable blocks instead of dropping them silently', () => {
    const r = parseTextToolCalls('<tool_call>not json at all</tool_call>');
    assert.equal(r.calls.length, 0);
    assert.equal(r.errors.length, 1);
  });

  it('removes a hallucinated <tool_result> from what the user sees', () => {
    const r = parseTextToolCalls('<tool_call>{"name":"list_dir","args":{}}</tool_call>\n<tool_result name="list_dir">fake</tool_result>');
    assert.equal(r.text, '');
    assert.equal(r.calls.length, 1);
  });

  it('leaves text without blocks alone', () => {
    assert.deepEqual(parseTextToolCalls('just an answer'), { text: 'just an answer', calls: [], errors: [] });
  });
});

describe('toTextTranscript', () => {
  it('re-encodes OpenAI tool history as text and keeps every exchange', () => {
    const t = toTextTranscript([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'file body' },
    ]);
    assert.equal(t.system, 'SYS');
    assert.deepEqual(t.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(t.messages[1].content, /<tool_call>\{"name":"read_file","args":\{"path":"a"\}\}<\/tool_call>/);
    assert.match(t.messages[2].content, /<tool_result name="read_file">\nfile body/);
  });

  it('handles Anthropic blocks and merges same-role neighbours', () => {
    const t = toTextTranscript([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'exit 0' }] },
    ]);
    assert.deepEqual(t.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(t.messages[0].content, 'a\n\nb');
    assert.match(t.messages[1].content, /"name":"bash"/);
    assert.match(t.messages[2].content, /exit 0/);
  });
});

describe('applyTextProtocol + appendToolResult', () => {
  it('turns blocks into calls and answers them as merged text, never role:"tool"', () => {
    const reply = applyTextProtocol({
      text: 'x',
      toolCalls: [],
      assistantMessage: { role: 'assistant', content: '<tool_call>{"name":"a","args":{}}</tool_call><tool_call>{"name":"b","args":{}}</tool_call>' },
    });
    assert.equal(reply.textProtocol, true);
    assert.equal(reply.toolCalls.length, 2);
    const msgs = [reply.assistantMessage];
    for (const c of reply.toolCalls) appendToolResult(msgs, { auth: 'none' }, c, `result ${c.name}`);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /name="a"[\s\S]*result a[\s\S]*name="b"[\s\S]*result b/);
  });

  it('leaves native tool calls untouched, and skips when baseTools is false', () => {
    const native = { text: '<tool_call>{"name":"x"}</tool_call>', toolCalls: [{ id: '1', name: 'y', args: {} }], assistantMessage: {} };
    assert.equal(applyTextProtocol(native), native);
    const hosted = { text: '<tool_call>{"name":"x","args":{}}</tool_call>', toolCalls: [], assistantMessage: { content: '<tool_call>{"name":"x","args":{}}</tool_call>' } };
    assert.equal(applyTextProtocol(hosted, { baseTools: false }), hosted);
  });
});

describe('provider fallback to the text protocol', () => {
  const realFetch = globalThis.fetch;
  let calls;
  let responder;
  before(() => {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return responder(calls.length, JSON.parse(options.body));
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });
  const res = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

  it('rejectsTools recognises tools-not-supported errors only', () => {
    assert.equal(rejectsTools(400, '{"error":"tools is not supported for this model"}'), true);
    assert.equal(rejectsTools(422, 'Extra inputs are not permitted: tool_choice unexpected'), true);
    assert.equal(rejectsTools(400, 'max_tokens too large'), false);
    assert.equal(rejectsTools(500, 'tools not supported'), false);
  });

  it('an OpenAI-shaped endpoint that 400s on `tools` is retried in text mode and its calls parse', async () => {
    calls = [];
    responder = (n) =>
      n === 1
        ? res(400, { error: { message: 'tools are not supported by this model' } })
        : res(200, { choices: [{ message: { content: 'Let me look.\n<tool_call>{"name":"list_dir","args":{"path":"."}}</tool_call>' } }] });
    const model = { auth: 'none', id: 'm', provider: 'x', providerLabel: 'X', url: 'https://example.invalid/v1/chat/completions' };
    const reply = await complete(model, [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }], {});
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.tools);
    assert.equal(calls[1].body.tools, undefined);
    assert.match(calls[1].body.messages[0].content, /Tools \(text protocol\)/);
    assert.equal(reply.text, 'Let me look.');
    assert.deepEqual(reply.toolCalls.map((c) => c.name), ['list_dir']);
    assert.equal(reply.toolCalls[0].textProtocol, true);
  });

  it('Gemini sees the whole history including tool results, and can call tools', async () => {
    calls = [];
    responder = () => res(200, { candidates: [{ content: { parts: [{ text: '<tool_call>{"name":"read_file","args":{"path":"b"}}</tool_call>' }] } }] });
    const model = { auth: 'gemini', id: 'g', provider: 'gemini', url: 'https://example.invalid/models' };
    const reply = await complete(model, [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'AAA' },
    ], {});
    const sent = calls[0].body;
    assert.deepEqual(sent.contents.map((c) => c.role), ['user', 'model', 'user']);
    assert.match(sent.contents[2].parts[0].text, /AAA/);
    assert.match(sent.systemInstruction.parts[0].text, /<tool_call>/);
    assert.deepEqual(reply.toolCalls.map((c) => c.args.path), ['b']);
  });
});

describe('Horde / completion-style helpers', () => {
  it('hordePrompt keeps the newest turns inside its budget and ends on the assistant cue', () => {
    const msgs = [{ role: 'system', content: 'S' }];
    for (let i = 0; i < 60; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(400) });
    const p = hordePrompt(msgs);
    assert.ok(p.length < 12_500, `prompt ${p.length}`);
    assert.match(p, /turn 59/);
    assert.doesNotMatch(p, /turn 0 /);
    assert.ok(p.endsWith('### Assistant:\n'));
  });

  it('cutAtNextTurn stops where the model starts writing the user or a fake result', () => {
    assert.equal(cutAtNextTurn('answer\n### User:\nmore'), 'answer');
    assert.equal(cutAtNextTurn('<tool_call>{}</tool_call>\n<tool_result name="x">made up'), '<tool_call>{}</tool_call>');
  });

  it('the protocol prompt lists the editing tools', () => {
    const p = textProtocolPrompt();
    for (const n of ['read_file', 'edit_file', 'multi_edit', 'apply_patch', 'bash']) assert.match(p, new RegExp(`- ${n}\\(`));
  });
});

/* ---------------- smarter editing ---------------- */

describe('applyEdits', () => {
  it('applies in order and tracks where each new string landed', () => {
    const r = applyEdits('a x b x c', [{ old_string: 'x', new_string: 'YY', replace_all: true }, { old_string: 'c', new_string: 'Z' }]);
    assert.equal(r.text, 'a YY b YY Z');
    assert.deepEqual(r.spans.map(([s, e]) => r.text.slice(s, e)), ['YY', 'YY', 'Z']);
  });

  it('fails without changing anything when any edit misses or is ambiguous', () => {
    assert.match(applyEdits('aa', [{ old_string: 'a', new_string: 'b' }]).error, /appears 2 times/);
    assert.match(applyEdits('abc', [{ old_string: 'a', new_string: 'b' }, { old_string: 'zz', new_string: 'q' }]).error, /Edit 2: old_string was not found/);
    assert.match(applyEdits('if (x)  {', [{ old_string: 'if (x) {', new_string: 'y' }]).error, /whitespace/);
  });
});

describe('edit tools on disk', () => {
  let root;
  before(async () => {
    root = await tmpdir();
  });

  it('edit_file returns the edited lines with numbers', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    const out = await runTool('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' }, { root, approve: yes });
    assert.match(out, /^Edited a\.txt\. Now on disk:/);
    assert.match(out, /\s2\tTWO/);
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  });

  it('multi_edit is all-or-nothing and asks once', async () => {
    await fs.writeFile(path.join(root, 'm.txt'), 'alpha\nbeta\ngamma\n');
    let asks = 0;
    const count = async () => (asks++, true);
    const bad = await runTool('multi_edit', { path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'nope', new_string: 'B' }] }, { root, approve: count });
    assert.match(bad, /Edit 2: .*Nothing was written/);
    assert.equal(asks, 0);
    assert.equal(await fs.readFile(path.join(root, 'm.txt'), 'utf8'), 'alpha\nbeta\ngamma\n');
    const good = await runTool('multi_edit', { path: 'm.txt', edits: [{ old_string: 'alpha', new_string: 'A' }, { old_string: 'gamma', new_string: 'G' }] }, { root, approve: count });
    assert.match(good, /2 changes/);
    assert.equal(asks, 1);
    assert.equal(await fs.readFile(path.join(root, 'm.txt'), 'utf8'), 'A\nbeta\nG\n');
  });

  it('declining an edit writes nothing', async () => {
    await fs.writeFile(path.join(root, 'd.txt'), 'keep');
    const out = await runTool('edit_file', { path: 'd.txt', old_string: 'keep', new_string: 'lose' }, { root, approve: no });
    assert.match(out, /Declined/);
    assert.equal(await fs.readFile(path.join(root, 'd.txt'), 'utf8'), 'keep');
  });

  it('flags a syntax error right after the write (JS and JSON)', async () => {
    await fs.writeFile(path.join(root, 'x.mjs'), 'export const a = 1;\n');
    const js = await runTool('edit_file', { path: 'x.mjs', old_string: '1;', new_string: '(1;' }, { root, approve: yes });
    assert.match(js, /Syntax check failed/);
    const json = await runTool('write_file', { path: 'c.json', content: '{"a": 1,}' }, { root, approve: yes });
    assert.match(json, /JSON syntax error/);
    const fine = await runTool('write_file', { path: 'ok.json', content: '{"a": 1}' }, { root, approve: yes });
    assert.doesNotMatch(fine, /error/i);
  });

  it('apply_patch creates, modifies (with line drift) and deletes in one approval', async () => {
    await fs.writeFile(path.join(root, 'p.txt'), 'l1\nl2\nl3\nl4\n');
    await fs.writeFile(path.join(root, 'gone.txt'), 'bye\n');
    const patch = [
      '```diff',
      '--- a/p.txt',
      '+++ b/p.txt',
      '@@ -40,2 +40,3 @@',
      ' l2',
      '-l3',
      '+L3',
      '+new',
      '--- /dev/null',
      '+++ b/sub/new.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '```',
    ].join('\n');
    let asks = 0;
    const out = await runTool('apply_patch', { patch }, { root, approve: async () => (asks++, true) });
    assert.equal(asks, 1);
    assert.match(out, /Patched p\.txt/);
    assert.match(out, /Created sub\/new\.txt/);
    assert.match(out, /Deleted gone\.txt/);
    assert.equal(await fs.readFile(path.join(root, 'p.txt'), 'utf8'), 'l1\nl2\nL3\nnew\nl4\n');
    assert.equal(await fs.readFile(path.join(root, 'sub/new.txt'), 'utf8'), 'hello\nworld\n');
    await assert.rejects(fs.stat(path.join(root, 'gone.txt')));
  });

  it('apply_patch writes nothing when one hunk does not fit', async () => {
    await fs.writeFile(path.join(root, 'q.txt'), 'a\nb\n');
    const patch = '--- a/q.txt\n+++ b/q.txt\n@@ -1 +1 @@\n-a\n+A\n--- a/q.txt\n+++ b/q.txt\n@@ -9 +9 @@\n-zzz\n+Z\n';
    const out = await runTool('apply_patch', { patch }, { root, approve: yes });
    assert.match(out, /does not match.*Nothing was written/);
    assert.equal(await fs.readFile(path.join(root, 'q.txt'), 'utf8'), 'a\nb\n');
  });

  it('apply_patch refuses paths outside the workspace', async () => {
    const out = await runTool('apply_patch', { patch: '--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+x\n' }, { root, approve: yes }).catch((e) => e.message);
    assert.match(String(out), /outside the workspace/);
  });
});

describe('parsePatch', () => {
  it('rejects junk inside a hunk and hunks without a file header', () => {
    assert.throws(() => parsePatch('@@ -1 +1 @@\n-a\n+b'), /no --- \/ \+\+\+ file header/);
    assert.throws(() => parsePatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\nweird line'), /unexpected line/);
  });

  it('accepts a bare @@ header and finds the context anywhere', () => {
    const [f] = parsePatch('--- x\n+++ x\n@@\n-c\n+C');
    assert.equal(applyPatchText('a\nb\nc\n', f.hunks).text, 'a\nb\nC\n');
  });
});

/* ---------------- context compaction ---------------- */

function longSession(n = 40) {
  const msgs = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: `request ${i}` });
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: i % 2 ? 'edit_file' : 'bash', arguments: JSON.stringify(i % 2 ? { path: `f${i}.js`, old_string: 'a', new_string: 'b' } : { command: `npm test ${i}` }) } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, name: 'x', content: (i % 2 ? 'Edited.' : `exit ${i % 4 === 0 ? 0 : 1}\n`) + 'y'.repeat(2000) });
    msgs.push({ role: 'assistant', content: `done ${i}` });
  }
  return msgs;
}

describe('compactInPlace', () => {
  it('does nothing under budget', async () => {
    const msgs = longSession(2);
    assert.equal(needsCompaction(msgs), false);
    assert.equal(await compactInPlace(msgs), null);
  });

  it('replaces the old part with a digest and keeps a clean recent tail', async () => {
    const msgs = longSession(40);
    assert.equal(needsCompaction(msgs), true);
    const res = await compactInPlace(msgs);
    assert.ok(res && res.dropped > 0 && res.after < res.before);
    assert.equal(msgs[0].content, 'SYS');
    assert.ok(msgs[1].content.startsWith(SUMMARY_MARK));
    assert.match(msgs[1].content, /request 0/);
    assert.match(msgs[1].content, /f1\.js \(edited\)/);
    assert.match(msgs[1].content, /npm test 4 → 0/);
    assert.match(msgs[1].content, /npm test 2 → 1/);
    assert.match(msgs[1].content, /\[Current\]\nrequest \d+/);
    assert.ok(!msgs.slice(1).some((m, i) => i === 0 && isOrphanedStart(m)));
    assert.equal(needsCompaction(msgs), false);
    // The newest exchange is intact.
    assert.equal(msgs.at(-1).content, 'done 39');
  });

  it('uses the model summary when the summarizer answers, and folds earlier summaries', async () => {
    const msgs = longSession(40);
    let seenPrompt = '';
    await compactInPlace(msgs, { summarize: async (p) => ((seenPrompt = p), 'MODEL SUMMARY') });
    assert.match(seenPrompt, /Transcript to compress/);
    assert.match(msgs[1].content, /MODEL SUMMARY/);
    msgs.push(...longSession(40).slice(1));
    await compactInPlace(msgs, { summarize: async (p) => ((seenPrompt = p), 'SECOND') });
    assert.match(seenPrompt, /Earlier summary:\nMODEL SUMMARY/);
    assert.equal(msgs.filter((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARK)).length, 1);
  });

  it('falls back to the digest when the summarizer fails or times out', async () => {
    const a = longSession(40);
    const r1 = await compactInPlace(a, { summarize: async () => { throw new Error('down'); } });
    assert.equal(r1.usedModel, false);
    const b = longSession(40);
    const r2 = await compactInPlace(b, { summarize: () => new Promise(() => {}), timeoutMs: 20 });
    assert.equal(r2.usedModel, false);
    assert.match(b[1].content, /Files changed/);
  });

  it('a single long tool loop (no user message in range) cuts on an assistant message', async () => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'big job' }];
    for (let i = 0; i < 60; i++) {
      msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `k${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"r${i}"}` } }] });
      msgs.push({ role: 'tool', tool_call_id: `k${i}`, name: 'read_file', content: 'z'.repeat(1500) });
    }
    await compactInPlace(msgs);
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /big job/);
    assert.equal(msgs[2].role, 'assistant');
    assert.ok(msgs[2].tool_calls);
  });

  it('digest reads text-protocol calls too', () => {
    const d = digest([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '<tool_call>{"name":"write_file","args":{"path":"n.py","content":"x"}}</tool_call>' },
    ]);
    assert.match(d, /n\.py \(wrote\)/);
  });
});

/* ---------------- verify ---------------- */

describe('verify', () => {
  it('detects the project check command, skipping the npm placeholder', async () => {
    const d = await tmpdir();
    assert.equal(await detectVerifyCommand(d), null);
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } }));
    assert.equal(await detectVerifyCommand(d), 'npm run build');
    await fs.writeFile(path.join(d, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(await detectVerifyCommand(d), 'npm test');
    const m = await tmpdir();
    await fs.writeFile(path.join(m, 'Makefile'), 'all:\n\techo\ntest:\n\techo ok\n');
    assert.equal(await detectVerifyCommand(m), 'make test');
    const g = await tmpdir();
    await fs.writeFile(path.join(g, 'go.mod'), 'module x\n');
    assert.equal(await detectVerifyCommand(g), 'go test ./...');
  });

  it('knows which tool results mean files changed', () => {
    assert.equal(wroteFiles('edit_file', 'Edited a.js. Now on disk:'), true);
    assert.equal(wroteFiles('apply_patch', 'Patched a.js.'), true);
    assert.equal(wroteFiles('edit_file', 'Declined by the user.'), false);
    assert.equal(wroteFiles('edit_file', 'old_string was not found.'), false);
    assert.equal(wroteFiles('bash', 'Wrote'), false);
    assert.deepEqual(pathsFromCall({ name: 'apply_patch', args: { patch: '--- a/x\n+++ b/x\n--- /dev/null\n+++ b/y\n' } }), ['x', 'y']);
  });

  it('reads exit codes and builds a failure message with the tail of the log', () => {
    assert.equal(exitCodeOf('exit 0\nok'), 0);
    assert.equal(exitCodeOf('exit 2\nboom'), 2);
    assert.equal(exitCodeOf('Command timed out after 180s.'), 124);
    const msg = failureMessage('npm test', 'exit 1\n' + 'x'.repeat(10_000) + 'THE FAILURE', 1, 3, new Set(['a.js']));
    assert.match(msg, /^\[verify\] `npm test` failed \(exit 1\) after your changes to a\.js\. Attempt 1 of 3/);
    assert.match(msg, /THE FAILURE/);
    assert.ok(msg.length < 7000);
  });
});

/* ---------------- gateway shape ---------------- */

test('gateway keeps text-protocol calls as text, never as orphaned tool_calls', () => {
  const raw = 'ok\n<tool_call>{"name":"read_file","args":{"path":"a"}}</tool_call>';
  const out = clampReply({
    text: 'ok',
    toolCalls: [{ id: 'txt_1', name: 'read_file', args: { path: 'a' }, textProtocol: true }],
    textProtocol: true,
    assistantMessage: { role: 'assistant', content: raw },
  });
  assert.equal(out.textProtocol, true);
  assert.equal(out.toolCalls[0].textProtocol, true);
  assert.deepEqual(out.assistantMessage, { role: 'assistant', content: raw });
});

test('gateway reports oversized tool args instead of crashing on them', () => {
  const big = 'x'.repeat(70_000);
  const out = clampReply({ text: '', toolCalls: [{ id: '1', name: 'write_file', args: { path: 'a', content: big } }], assistantMessage: { role: 'assistant', content: '' } });
  assert.match(out.toolCalls[0].args._error, /over the 65536 limit/);
  const mid = clampReply({ text: '', toolCalls: [{ id: '1', name: 'write_file', args: { path: 'a', content: 'y'.repeat(30_000) } }], assistantMessage: { role: 'assistant', content: '' } });
  assert.equal(mid.toolCalls[0].args.content.length, 30_000);
});

/* ---------------- Composio for text-protocol models ---------------- */

describe('Composio through the text protocol', () => {
  it('normalizes OpenAI and Anthropic wire shapes to one schema', () => {
    const a = normalizeToolDefs(composioToolsForOpenAI());
    const b = normalizeToolDefs(composioToolsForAnthropic());
    assert.deepEqual(a.map((t) => t.name), b.map((t) => t.name));
    assert.ok(a.every((t) => t.parameters && t.parameters.type === 'object'));
    assert.deepEqual(normalizeToolDefs([null, {}, { type: 'function' }]), []);
  });

  it('the protocol prompt lists the Composio tools and the search-then-execute rule only when offered', () => {
    const withC = textProtocolPrompt(undefined, composioToolsForOpenAI());
    assert.match(withC, /- composio_search\(/);
    assert.match(withC, /- composio_execute\(/);
    assert.match(withC, /Never\nguess a slug/);
    assert.doesNotMatch(textProtocolPrompt(), /composio/);
  });

  it('a text-only model is told about Composio and its call comes back as a text-protocol call', async () => {
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (_url, options) => {
      sent = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '<tool_call>{"name":"composio_search","args":{"query":"send an email"}}</tool_call>' }] } }] }),
        text: async () => '',
      };
    };
    try {
      const model = { auth: 'gemini', id: 'g', provider: 'gemini', url: 'https://example.invalid/models' };
      const reply = await complete(model, [{ role: 'system', content: 'S' }, { role: 'user', content: 'email bob' }], {}, composioToolsForOpenAI());
      assert.match(sent.systemInstruction.parts[0].text, /composio_search/);
      assert.equal(reply.toolCalls[0].name, 'composio_search');
      assert.equal(reply.toolCalls[0].textProtocol, true);
      assert.deepEqual(reply.toolCalls[0].args, { query: 'send an email' });
      // The hosted chatbot passes baseTools:false — no protocol, no tools.
      await complete(model, [{ role: 'user', content: 'x' }], {}, composioToolsForOpenAI(), { baseTools: false });
      assert.doesNotMatch(sent.systemInstruction.parts[0].text, /composio_search|tool_call|read_file/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('hordePrompt includes Composio when the gateway offers it', () => {
    assert.match(hordePrompt([{ role: 'user', content: 'hi' }], textProtocolPrompt(undefined, composioToolsForOpenAI())), /composio_execute/);
    assert.match(hordePrompt([{ role: 'user', content: 'hi' }]), /read_file/);
    assert.doesNotMatch(hordePrompt([{ role: 'user', content: 'hi' }], ''), /tool_call/);
  });
});
