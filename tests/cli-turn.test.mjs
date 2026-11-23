/**
 * Tests for the CLI turn loop's two importable pieces (bin/termux-code.mjs):
 * completeViaGateway — the gateway POST and its terminal-token handling —
 * and runFailoverTurn — one assistant step walking the failover chain.
 * The bin only runs main() when executed directly, so importing it here
 * does not start the interactive session.
 * Run: node --test tests/cli-turn.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { completeViaGateway, runFailoverTurn, defaultModel } from '../bin/termux-code.mjs';
import { FailureTracker, FailoverError } from '../lib/failover.mjs';

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

/* Fixtures are uncensored-lineage by label marker, as in failover.test.mjs. */
const M = (id, provider) => ({ id, provider, auth: 'none', free: true, source: 'direct', label: `${id} uncensored` });
const replyFor = (m) => ({ text: `from ${m.id}`, toolCalls: [], assistantMessage: { role: 'assistant', content: `from ${m.id}` } });

/** Capture console.log lines while fn runs, then restore. */
async function captureLog(fn) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const out = await fn();
    return { out, lines };
  } finally {
    console.log = realLog;
  }
}

describe('defaultModel() — nothing aligned is ever seated', () => {
  const aligned = { id: 'gpt-4o-mini', provider: 'githubmodels', auth: 'bearer', free: true, source: 'direct', label: 'GPT-4o mini' };

  it('starts on Horde when it is in the catalogue', () => {
    const horde = M('any', 'horde');
    assert.equal(defaultModel([aligned, horde]).provider, 'horde');
  });

  it('prefers a keyed uncensored route over the Horde queue', () => {
    // The queue's workers are 1B-35B with a 512-token cap: a configured
    // OpenRouter/Venice/Naga model must win the seat, or "high-level coding"
    // never gets a fair chance.
    const horde = M('any', 'horde');
    const big = { id: 'sao10k/l3.1-euryale-70b', provider: 'openrouter', auth: 'bearer', free: false, source: 'direct', label: 'Euryale 70B' };
    assert.equal(defaultModel([horde, big]).provider, 'openrouter');
    assert.equal(defaultModel([big, horde]).provider, 'openrouter');
    assert.equal(defaultModel([horde]).provider, 'horde');
  });

  it('picks an uncensored route over a free aligned one anywhere in the list', () => {
    const unc = { id: 'dolphin', provider: 'naga', auth: 'bearer', free: false, source: 'direct', label: 'Dolphin uncensored' };
    assert.equal(defaultModel([aligned, unc]).id, 'dolphin');
  });

  it('returns null when every candidate is aligned, instead of taking models[0]', () => {
    assert.equal(defaultModel([aligned]), null);
    assert.equal(defaultModel([]), null);
  });
});

describe('completeViaGateway()', () => {
  const model = M('any', 'horde');
  const messages = [{ role: 'user', content: 'hi' }];

  it('returns the gateway reply as-is and sends the token', async () => {
    seen = [];
    responder = () => jsonRes({ text: 'hello', toolCalls: [], assistantMessage: { role: 'assistant', content: 'hello' } });
    const reply = await completeViaGateway('https://gw.example.com/', model, messages, 'tok-1');
    assert.equal(reply.text, 'hello');
    assert.equal(seen[0].url, 'https://gw.example.com/api/chat');
    assert.equal(seen[0].options.headers.Authorization, 'Bearer tok-1');
    assert.deepEqual(JSON.parse(seen[0].options.body).model, model);
  });

  it('omits the Authorization header when no token is set', async () => {
    seen = [];
    responder = () => jsonRes({ text: 'hi', toolCalls: [], assistantMessage: { role: 'assistant', content: 'hi' } });
    await completeViaGateway('https://gw.example.com', model, messages, null);
    assert.equal(seen[0].options.headers.Authorization, undefined);
  });

  it('builds assistantMessage from text and normalises missing toolCalls', async () => {
    seen = [];
    responder = () => jsonRes({ text: 'plain answer' });
    const reply = await completeViaGateway('https://gw.example.com', model, messages, null);
    assert.deepEqual(reply.assistantMessage, { role: 'assistant', content: 'plain answer' });
    assert.deepEqual(reply.toolCalls, []);
  });

  it('honors a short per-request gateway deadline', async () => {
    seen = [];
    responder = (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    await assert.rejects(
      () => completeViaGateway('https://gw.example.com', model, messages, null, { timeoutMs: 20 }),
      /abort|timeout/i,
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0].options.signal.aborted);
  });

  it('treats a 401 as terminal so the chain does not retry the same gate', async () => {
    responder = () => jsonRes({ error: { message: 'bad token', code: 'NO_KEY' } }, { ok: false, status: 401 });
    await assert.rejects(
      () => completeViaGateway('https://gw.example.com', model, messages, 'stale'),
      (err) => {
        assert.equal(err.terminal, true);
        assert.match(err.message, /NO_KEY.*fresh Termux command/);
        return true;
      },
    );
  });

  it('treats a 200 carrying a NO_KEY error as terminal too', async () => {
    responder = () => jsonRes({ error: { message: 'no key on file', code: 'NO_KEY' } });
    await assert.rejects(
      () => completeViaGateway('https://gw.example.com', model, messages, 'tok'),
      (err) => err.terminal === true,
    );
  });

  it('throws a plain error (not terminal) for other gateway failures', async () => {
    responder = () => jsonRes({ error: 'upstream exploded' }, { ok: false, status: 502 });
    await assert.rejects(
      () => completeViaGateway('https://gw.example.com', model, messages, null),
      (err) => {
        assert.equal(err.terminal, undefined);
        assert.match(err.message, /upstream exploded/);
        return true;
      },
    );
    responder = () => jsonRes({}, { ok: false, status: 500 });
    await assert.rejects(
      () => completeViaGateway('https://gw.example.com', model, messages, null),
      /Gateway returned HTTP 500/,
    );
  });
});

describe('runFailoverTurn()', () => {
  const messages = [{ role: 'user', content: 'hi' }];

  it('returns the chosen model\'s reply first try, with no chain line', async () => {
    const chosen = M('a', 'kilo');
    const models = [chosen, M('b', 'llm7')];
    const { out, lines } = await captureLog(() =>
      runFailoverTurn(chosen, models, messages, new FailureTracker(), async (m) => replyFor(m), new Set()));
    assert.equal(out.text, 'from a');
    assert.equal(lines.filter((l) => l.includes('[chain]')).length, 0);
  });

  it('walks to the next model when the chosen one fails, and says so', async () => {
    const chosen = M('a', 'kilo');
    const models = [chosen, M('b', 'llm7')];
    const { out, lines } = await captureLog(() =>
      runFailoverTurn(chosen, models, messages, new FailureTracker(), async (m) => {
        if (m.id === 'a') throw new Error('kilo down');
        return replyFor(m);
      }, new Set()));
    assert.equal(out.text, 'from b');
    const chain = lines.filter((l) => l.includes('[chain]'));
    assert.equal(chain.length, 1);
    assert.match(chain[0], /1 provider failed, answered by llm7\/b/);
  });

  it('throws FailoverError when every candidate fails', async () => {
    const chosen = M('a', 'kilo');
    const models = [chosen, M('b', 'llm7')];
    await captureLog(() => assert.rejects(
      runFailoverTurn(chosen, models, messages, new FailureTracker(), async () => {
        throw new Error('all down');
      }, new Set()),
      (err) => err instanceof FailoverError,
    ));
  });
});
