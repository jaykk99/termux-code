/**
 * Tests for lib/sessions.mjs — multi-session conversation persistence.
 * Run: node --test tests/
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, compact, deriveTitle } from '../lib/sessions.mjs';

let dir;
let store;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-sessions-'));
  store = new SessionStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const MSG = (role, content) => ({ role, content });

describe('SessionStore', () => {
  it('creates a session with meta and an empty message list', async () => {
    const meta = await store.create('my chat');
    assert.ok(meta.id);
    assert.equal(meta.title, 'my chat');
    const loaded = await store.load(meta.id);
    assert.deepEqual(loaded.messages, []);
    assert.equal(loaded.meta.title, 'my chat');
  });

  it('round-trips messages including tool results', async () => {
    const { id } = await store.create('tools');
    const messages = [
      MSG('system', 'sys'),
      MSG('user', 'read foo'),
      MSG('assistant', 'reading'),
      { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'file contents' },
    ];
    await store.append(id, messages);
    const loaded = await store.load(id);
    assert.deepEqual(loaded.messages, messages);
  });

  it('lists sessions most-recently-updated first', async () => {
    const a = await store.create('a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create('b');
    await store.append(a.id, [MSG('user', 'touch a')]); // a becomes newest
    const list = await store.list();
    assert.equal(list[0].id, a.id);
    assert.equal(list[1].id, b.id);
    assert.equal(list[0].messages, 1);
  });

  it('renames a session', async () => {
    const { id } = await store.create('old');
    const meta = await store.rename(id, 'new title');
    assert.equal(meta.title, 'new title');
    assert.equal((await store.load(id)).meta.title, 'new title');
  });

  it('rename does not bump updated, so it cannot hijack resume order', async () => {
    const a = await store.create('a');
    await store.append(a.id, [MSG('user', 'real chat')]);
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create('b');
    await store.append(b.id, [MSG('user', 'newer chat')]);
    await store.rename(a.id, 'renamed old');
    const list = await store.list();
    assert.equal(list[0].id, b.id);
  });

  it('newestNonEmpty skips empty sessions and returns null when all are empty', async () => {
    const a = await store.create('real');
    await store.append(a.id, [MSG('user', 'hi')]);
    await store.create('empty just made');
    const picked = await store.newestNonEmpty();
    assert.equal(picked.meta.id, a.id);
    await store.delete(a.id);
    assert.equal(await store.newestNonEmpty(), null);
  });

  it('deletes a session, false when missing', async () => {
    const { id } = await store.create('x');
    assert.equal(await store.delete(id), true);
    assert.equal(await store.load(id), null);
    assert.equal(await store.delete(id), false);
  });

  it('returns null for a missing session id', async () => {
    assert.equal(await store.load('doesnotexist'), null);
  });

  it('rejects bad session ids', async () => {
    await assert.rejects(() => store.load('../../etc/passwd'), /Bad session id/);
  });

  it('skips corrupt lines instead of failing the load', async () => {
    const { id } = await store.create('corrupt');
    const p = path.join(dir, `${id}.jsonl`);
    await fs.appendFile(p, 'this is not json\n{"type":"msg","role":"user","content":"survivor"}\n');
    const loaded = await store.load(id);
    assert.equal(loaded.messages.at(-1).content, 'survivor');
  });

  it('compacts long sessions on append', async () => {
    const { id } = await store.create('long');
    const many = Array.from({ length: 500 }, (_, i) => MSG('user', `msg ${i}`));
    const { messages } = await store.append(id, many);
    assert.ok(messages.length < 500);
    assert.ok(messages.some((m) => String(m.content).includes('session compacted')));
    // system prompt and recent messages survive
    assert.equal(messages.at(-1).content, 'msg 499');
  });

  it('prunes old sessions but keeps the newest keepN', async () => {
    const mk = async (title) => (await store.create(title)).id;
    const ids = [await mk('one'), await mk('two'), await mk('three')];
    // backdate the first session file by editing its meta line
    const p = path.join(dir, `${ids[0]}.jsonl`);
    const text = await fs.readFile(p, 'utf8');
    const [first, ...rest] = text.split('\n');
    const meta = JSON.parse(first);
    meta.updated = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    await fs.writeFile(p, [JSON.stringify(meta), ...rest].join('\n'));
    const removed = await store.prune({ keepN: 2 });
    assert.equal(removed, 1);
    assert.equal(await store.load(ids[0]), null);
    assert.ok(await store.load(ids[1]));
  });

  it('exports a readable markdown transcript', async () => {
    const { id } = await store.create('export me');
    await store.append(id, [
      MSG('system', 'skip me'),
      MSG('user', 'hello'),
      MSG('assistant', 'hi there'),
    ]);
    const md = await store.exportMarkdown(id);
    assert.match(md, /^# export me/m);
    assert.match(md, /## User/);
    assert.match(md, /hello/);
    assert.match(md, /## Assistant/);
    assert.ok(!md.includes('skip me'));
  });
});

describe('compact()', () => {
  it('leaves short sessions alone', () => {
    const msgs = [MSG('user', 'a'), MSG('assistant', 'b')];
    assert.equal(compact(msgs), msgs);
  });

  it('keeps the system prompt at index 0', () => {
    const msgs = [MSG('system', 'sys'), ...Array.from({ length: 500 }, (_, i) => MSG('user', `m${i}`))];
    const out = compact(msgs);
    assert.equal(out[0].role, 'system');
    assert.ok(out.length < 500);
  });

  it('never starts the kept window with an orphaned tool result', () => {
    const msgs = [MSG('system', 'sys'), ...Array.from({ length: 199 }, (_, i) => MSG('user', `u${i}`))];
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'bash', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: 'c0', name: 'bash', content: 'out' });
    for (let i = 0; i < 199; i++) msgs.push(MSG('user', `tail${i}`));
    const out = compact(msgs);
    const firstKept = out.find((m) => m.role !== 'system' && !String(m.content).includes('session compacted'));
    assert.notEqual(firstKept.role, 'tool');
    assert.ok(String(out.find((m) => String(m.content).includes('session compacted')).content).includes('dropped'));
  });
});

describe('deriveTitle()', () => {
  it('titles from the first user message', () => {
    assert.equal(deriveTitle([MSG('system', 's'), MSG('user', 'fix the bug in auth')]), 'fix the bug in auth');
  });

  it('truncates long first lines', () => {
    const t = deriveTitle([MSG('user', 'x'.repeat(100))]);
    assert.ok(t.length <= 60);
    assert.ok(t.endsWith('...'));
  });

  it('falls back when there is no user message yet', () => {
    assert.equal(deriveTitle([MSG('system', 's')]), 'untitled');
    assert.equal(deriveTitle([]), 'untitled');
  });
});
