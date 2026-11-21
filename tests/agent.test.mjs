/**
 * Tests for the lib/agent.mjs pieces no other suite covers: stripThinking,
 * sendToErrorInbox, and the Cohere / Anthropic complete() dispatch paths
 * (Gemini, OpenAI-shaped, Horde, HF and Bro each have their own suite).
 * Run: node --test tests/agent.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { complete, stripThinking, sendToErrorInbox } from '../lib/agent.mjs';

const jsonRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
let responder;
let seen;
const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return responder(url, options);
  };
});
after(() => { globalThis.fetch = realFetch; });

describe('stripThinking()', () => {
  it('strips <think> and <thinking> blocks, case-insensitive', () => {
    assert.equal(stripThinking('<think>hmm, plan first</think>do it'), 'do it');
    assert.equal(stripThinking('before <THINKING>reasoning</THINKING> after'), 'before  after');
    assert.equal(stripThinking('a <think>x</think> b <thinking>y</thinking> c'), 'a  b  c');
  });

  it('leaves plain text alone apart from trimming', () => {
    assert.equal(stripThinking('  just an answer  '), 'just an answer');
    assert.equal(stripThinking(''), '');
  });

  it('leaves an unclosed tag in place (the regex needs a close tag)', () => {
    assert.equal(stripThinking('<think>never closed'), '<think>never closed');
  });
});

describe('sendToErrorInbox()', () => {
  const msg = 'ask my agent to check the inbox';

  it('posts to /api/v1/message with the bearer key and returns the reply', async () => {
    seen = [];
    responder = () => jsonRes({ ok: true, reply: 'checked, nothing new' });
    const reply = await sendToErrorInbox(msg, { baseUrl: 'https://error-inbox.example.com/', apiKey: 'eibx_test' });
    assert.equal(reply, 'checked, nothing new');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://error-inbox.example.com/api/v1/message');
    assert.equal(seen[0].options.method, 'POST');
    assert.equal(seen[0].options.headers.Authorization, 'Bearer eibx_test');
    assert.deepEqual(JSON.parse(seen[0].options.body), { message: msg });
  });

  it('defaults to the live Error Inbox URL when no baseUrl is given', async () => {
    seen = [];
    responder = () => jsonRes({ ok: true, reply: 'ok' });
    await sendToErrorInbox(msg, { apiKey: 'eibx_test' });
    assert.equal(seen[0].url, 'https://error-inbox.onrender.com/api/v1/message');
  });

  it('throws without a key instead of calling the endpoint', async () => {
    seen = [];
    responder = () => { throw new Error('fetch must not run without a key'); };
    await assert.rejects(
      () => sendToErrorInbox(msg, { baseUrl: 'https://error-inbox.example.com' }),
      /No Error Inbox API key set/,
    );
    assert.equal(seen.length, 0);
  });

  it('surfaces Error Inbox\'s own error string on a failed call', async () => {
    seen = [];
    responder = () => jsonRes({ ok: false, error: 'unknown agent: nope' }, { ok: false, status: 404 });
    await assert.rejects(
      () => sendToErrorInbox(msg, { baseUrl: 'https://error-inbox.example.com', apiKey: 'eibx_test' }),
      /unknown agent: nope/,
    );
  });

  it('throws on an ok:false body with no error string', async () => {
    seen = [];
    responder = () => jsonRes({ ok: false });
    await assert.rejects(
      () => sendToErrorInbox(msg, { baseUrl: 'https://error-inbox.example.com', apiKey: 'eibx_test' }),
      /Error Inbox returned 200/,
    );
  });
});

describe('complete() — Cohere dispatch', () => {
  const cohereModel = { id: 'command-a', provider: 'cohere', providerLabel: 'Cohere', auth: 'cohere', url: 'https://api.cohere.com/v2/chat' };

  it('sends the whole history as text with the protocol and joins the parts', async () => {
    seen = [];
    let sentBody;
    responder = (url, options) => {
      sentBody = JSON.parse(options.body);
      return jsonRes({ message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'cohere' }] } });
    };
    const reply = await complete(cohereModel, [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'hi' },
    ], { COHERE_API_KEY: 'co-key' });
    assert.equal(reply.text, 'hello cohere');
    assert.equal(reply.textMode, true);
    assert.deepEqual(reply.toolCalls, []);
    assert.equal(sentBody.model, 'command-a');
    assert.equal(seen[0].options.headers.Authorization, 'Bearer co-key');
    assert.match(sentBody.messages[0].content, /<tool_call>/);
    assert.equal(sentBody.messages[1].content, 'hi');
  });

  it('fails loudly on a non-2xx instead of returning an empty reply', async () => {
    responder = () => jsonRes({ message: 'bad key' }, { ok: false, status: 401 });
    await assert.rejects(
      () => complete(cohereModel, [{ role: 'user', content: 'hi' }], { COHERE_API_KEY: 'bad' }),
      /Cohere 401: .*bad key/,
    );
  });
});

describe('complete() — Anthropic dispatch', () => {
  const claudeModel = { id: 'claude-opus-5', provider: 'anthropic', providerLabel: 'Anthropic', auth: 'anthropic', url: 'https://api.anthropic.com/v1/messages' };

  it('sends the system separately, joins text blocks, and maps tool_use blocks', async () => {
    seen = [];
    let sentBody;
    responder = (url, options) => {
      sentBody = JSON.parse(options.body);
      return jsonRes({
        content: [
          { type: 'text', text: 'reading it now' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        stop_reason: 'tool_use',
      });
    };
    const reply = await complete(claudeModel, [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'read a.txt' },
    ], { ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(reply.text, 'reading it now');
    assert.deepEqual(reply.toolCalls, [{ id: 'toolu_1', name: 'read_file', args: { path: 'a.txt' } }]);
    assert.equal(sentBody.system, 'SYS');
    assert.equal(sentBody.model, 'claude-opus-5');
    assert.deepEqual(sentBody.messages, [{ role: 'user', content: 'read a.txt' }]);
    assert.equal(seen[0].options.headers['x-api-key'], 'sk-test');
    assert.equal(seen[0].options.headers['anthropic-version'], '2023-06-01');
  });

  it('flags a refusal so the failover chain walks on', async () => {
    seen = [];
    responder = () => jsonRes({ content: [{ type: 'text', text: 'I cannot help with that.' }], stop_reason: 'refusal' });
    const reply = await complete(claudeModel, [{ role: 'user', content: 'hi' }], { ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(reply.refused, true);
    assert.equal(reply.text, 'Anthropic declined this request.');
    assert.deepEqual(reply.toolCalls, []);
  });

  it('fails loudly on a non-2xx', async () => {
    responder = () => jsonRes({ error: { message: 'overloaded' } }, { ok: false, status: 529 });
    await assert.rejects(
      () => complete(claudeModel, [{ role: 'user', content: 'hi' }], { ANTHROPIC_API_KEY: 'sk-test' }),
      /Anthropic 529: .*overloaded/,
    );
  });
});
