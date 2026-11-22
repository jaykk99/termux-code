/**
 * Tests for the gateway API routes — the handlers themselves, not just
 * the lib helpers they call. Until now only /api/chat's pure helpers
 * (clampReply, sanitizeMessages) were covered; every other route shipped
 * with zero handler tests, so a 401/400/413 regression, a broken gate,
 * or a wrong error code would only show up live on the phone.
 *
 * The handlers call gatewayAccess(req) against process.env, so this file
 * owns process.env secrets for its run (restored in after()) and stubs
 * global fetch so no test touches the network: listModels' three live
 * legs, sendToErrorInbox, browserRead and setErrorInboxPrefs all go
 * through the stub. Audit lines go to a tmp file, never .data/.
 *
 * Run: node --test tests/gateway-routes.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GET as healthGET } from '../app/api/health/route.js';
import { GET as modelsGET } from '../app/api/models/route.js';
import { POST as askPOST } from '../app/api/ask/route.js';
import { POST as browserReadPOST, validatePageUrl } from '../app/api/browser/read/route.js';
import { POST as toolsExecutePOST } from '../app/api/tools/execute/route.js';
import { POST as prefsPOST } from '../app/api/models/prefs/route.js';
import { POST as tokenPOST, GET as tokenGET, DELETE as tokenDELETE } from '../app/api/auth/token/route.js';
import { POST as botChatPOST } from '../app/api/bot/chat/route.js';
import { directModels } from '../lib/models.mjs';
import { createSession, issueGatewayToken, verifyGatewayToken, SESSION_COOKIE } from '../lib/auth.mjs';

const BASE = 'https://gateway.test';

let tmpDir;
let token;
let sessionCookie;
const realFetch = globalThis.fetch;
let fetchImpl;
const savedEnv = {};

function saveEnv(keys) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

function restoreEnv(keys) {
  for (const k of keys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function jsonReq(pathname, body, extraHeaders = {}) {
  return new Request(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function authedJsonReq(pathname, body) {
  return jsonReq(pathname, body, { authorization: `Bearer ${token}` });
}

async function bodyOf(res) {
  return res.json();
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-gateway-routes-'));
  saveEnv([
    'GATEWAY_TOKEN_SECRET',
    'SESSION_SECRET',
    'OWNER_GITHUB_LOGIN',
    'GATEWAY_TOKEN_STORE',
    'AUDIT_LOG_PATH',
    'ERROR_INBOX_KEY',
    'COMPOSIO_API_KEY',
  ]);
  process.env.GATEWAY_TOKEN_SECRET = 'test-gateway-secret';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.OWNER_GITHUB_LOGIN = 'jaykk99';
  process.env.GATEWAY_TOKEN_STORE = path.join(tmpDir, 'tokens.json');
  process.env.AUDIT_LOG_PATH = path.join(tmpDir, 'audit.log');
  delete process.env.ERROR_INBOX_KEY;
  delete process.env.COMPOSIO_API_KEY;

  token = await issueGatewayToken('jaykk99');
  sessionCookie = `${SESSION_COOKIE}=${createSession('jaykk99')}`;

  fetchImpl = async () => {
    throw new Error('network down (test stub)');
  };
  globalThis.fetch = async (...args) => fetchImpl(...args);
});

after(async () => {
  globalThis.fetch = realFetch;
  restoreEnv([
    'GATEWAY_TOKEN_SECRET',
    'SESSION_SECRET',
    'OWNER_GITHUB_LOGIN',
    'GATEWAY_TOKEN_STORE',
    'AUDIT_LOG_PATH',
    'ERROR_INBOX_KEY',
    'COMPOSIO_API_KEY',
  ]);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('reports ok with the direct pool count when every live leg is down', async () => {
    fetchImpl = async () => {
      throw new Error('network down (test stub)');
    };
    const res = await healthGET(new Request(`${BASE}/api/health`));
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.equal(data.service, 'termux-code-gateway');
    assert.equal(typeof data.version, 'string');
    assert.equal(typeof data.uptimeSeconds, 'number');
    assert.equal(data.modelCount, directModels().length);
    assert.ok(data.modelCount > 0);
  });

  it('still reports ok when the live legs answer non-ok', async () => {
    fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const res = await healthGET(new Request(`${BASE}/api/health`));
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.equal(data.modelCount, directModels().length);
  });
});

describe('GET /api/models', () => {
  it('401s without any credential', async () => {
    const res = await modelsGET(new Request(`${BASE}/api/models`));
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('401s on a forged bearer token', async () => {
    const res = await modelsGET(
      new Request(`${BASE}/api/models`, { headers: { authorization: 'Bearer tc_v1.forged' } })
    );
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('lists the direct pool with a valid gateway token, no network', async () => {
    fetchImpl = async () => {
      throw new Error('network down (test stub)');
    };
    const res = await modelsGET(
      new Request(`${BASE}/api/models`, { headers: { authorization: `Bearer ${token}` } })
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.equal(data.count, data.models.length);
    assert.equal(data.count, directModels().length);
    for (const m of data.models) {
      assert.equal(typeof m.provider, 'string');
      assert.equal(typeof m.id, 'string');
      assert.equal(typeof m.source, 'string');
    }
  });
});

describe('POST /api/ask', () => {
  it('401s without any credential', async () => {
    const res = await askPOST(jsonReq('/api/ask', { message: 'hi' }));
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('400s on a non-JSON body', async () => {
    const res = await askPOST(authedJsonReq('/api/ask', 'not json'));
    assert.equal(res.status, 400);
    assert.equal((await bodyOf(res)).error.code, 'BAD_JSON');
  });

  it('400s when message is missing or blank', async () => {
    for (const body of [{}, { message: '' }, { message: '   ' }, { message: 42 }]) {
      const res = await askPOST(authedJsonReq('/api/ask', body));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_MESSAGES');
    }
  });

  it('413s on a message over the 20k cap', async () => {
    const res = await askPOST(authedJsonReq('/api/ask', { message: 'x'.repeat(20_001) }));
    assert.equal(res.status, 413);
    assert.equal((await bodyOf(res)).error.code, 'MESSAGE_TOO_LONG');
  });

  it('400s on a bad agent value', async () => {
    for (const agent of [42, 'x'.repeat(101)]) {
      const res = await askPOST(authedJsonReq('/api/ask', { message: 'hi', agent }));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_MESSAGES');
    }
  });

  it('401s honestly when no Error Inbox key is configured', async () => {
    delete process.env.ERROR_INBOX_KEY;
    const res = await askPOST(authedJsonReq('/api/ask', { message: 'hi', agent: 'test-agent' }));
    assert.equal(res.status, 401);
    const data = await bodyOf(res);
    assert.equal(data.error.code, 'NO_KEY');
    assert.match(data.error.message, /api key/i);
  });
});

describe('POST /api/browser/read + validatePageUrl', () => {
  it('accepts http(s) URLs and rejects the rest', () => {
    assert.equal(validatePageUrl('https://example.com/a?b=c'), 'https://example.com/a?b=c');
    assert.equal(validatePageUrl('http://example.com/'), 'http://example.com/');
    assert.equal(validatePageUrl('ftp://example.com/x'), null);
    assert.equal(validatePageUrl('javascript:alert(1)'), null);
    assert.equal(validatePageUrl('file:///etc/passwd'), null);
    assert.equal(validatePageUrl('not a url'), null);
    assert.equal(validatePageUrl(''), null);
    assert.equal(validatePageUrl(null), null);
    assert.equal(validatePageUrl(undefined), null);
    assert.equal(validatePageUrl('/relative/path'), null);
  });

  it('401s without any credential', async () => {
    const res = await browserReadPOST(jsonReq('/api/browser/read', { url: 'https://example.com/' }));
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('400s on a non-http(s) or missing url', async () => {
    for (const body of [{}, { url: 'ftp://example.com/x' }, { url: 'javascript:alert(1)' }, { url: 42 }]) {
      const res = await browserReadPOST(authedJsonReq('/api/browser/read', body));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_URL');
    }
  });

  it('returns extracted text, never raw HTML, for a fetched page', async () => {
    fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: async () =>
        '<html><head><title>T</title><style>.x{color:red}</style></head><body><p>Hello world</p><script>var x = 1;</script></body></html>',
    });
    const res = await browserReadPOST(authedJsonReq('/api/browser/read', { url: 'https://example.com/' }));
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.match(data.result, /Hello world/);
    assert.doesNotMatch(data.result, /<script>/);
    assert.doesNotMatch(data.result, /color:red/);
    assert.match(data.result, /^HTTP 200 https:\/\/example\.com\//);
  });

  it('returns an honest error string when the fetch fails', async () => {
    fetchImpl = async () => {
      throw new Error('boom');
    };
    const res = await browserReadPOST(authedJsonReq('/api/browser/read', { url: 'https://example.com/' }));
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.match(data.result, /Browser read failed: boom/);
  });
});

describe('POST /api/tools/execute', () => {
  it('401s without any credential', async () => {
    const res = await toolsExecutePOST(jsonReq('/api/tools/execute', { name: 'composio_search', args: {} }));
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('400s on a tool outside the two-Composio allowlist', async () => {
    for (const name of ['run_terminal', 'github_api', 'fetch_url', '', undefined]) {
      const res = await toolsExecutePOST(authedJsonReq('/api/tools/execute', { name, args: {} }));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_TOOL');
    }
  });

  it('413s on arguments over the 16k cap', async () => {
    const res = await toolsExecutePOST(
      authedJsonReq('/api/tools/execute', { name: 'composio_search', args: { query: 'x'.repeat(17_000) } })
    );
    assert.equal(res.status, 413);
    assert.equal((await bodyOf(res)).error.code, 'ARGS_TOO_LONG');
  });

  it('says plainly the Composio key is unset instead of faking success', async () => {
    delete process.env.COMPOSIO_API_KEY;
    const res = await toolsExecutePOST(
      authedJsonReq('/api/tools/execute', { name: 'composio_search', args: { query: 'send email' } })
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.match(data.result, /COMPOSIO_API_KEY is not set/);
  });

  it('asks for a tool slug before touching Composio', async () => {
    const res = await toolsExecutePOST(
      authedJsonReq('/api/tools/execute', { name: 'composio_execute', args: {} })
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.match(data.result, /tool_slug is required/);
  });
});

describe('POST /api/models/prefs', () => {
  it('401s without any credential', async () => {
    const res = await prefsPOST(jsonReq('/api/models/prefs', { pinned: null, disabled: [] }));
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('400s on a non-string pinned value', async () => {
    for (const pinned of [42, {}, ['x']]) {
      const res = await prefsPOST(authedJsonReq('/api/models/prefs', { pinned, disabled: [] }));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_PREFS');
    }
  });

  it('400s on a pinned value over 200 chars', async () => {
    const res = await prefsPOST(
      authedJsonReq('/api/models/prefs', { pinned: 'x'.repeat(201), disabled: [] })
    );
    assert.equal(res.status, 400);
    assert.equal((await bodyOf(res)).error.code, 'BAD_PREFS');
  });

  it('400s when disabled is not an array of short strings', async () => {
    for (const disabled of ['x', [42], ['x'.repeat(201)], null, undefined]) {
      const res = await prefsPOST(authedJsonReq('/api/models/prefs', { pinned: null, disabled }));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_PREFS');
    }
  });

  it('passes a valid prefs call through to error-inbox', async () => {
    let seen;
    fetchImpl = async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => ({ ok: true, prefs: { pinned: null, disabled: [] } }) };
    };
    const res = await prefsPOST(
      authedJsonReq('/api/models/prefs', { pinned: null, disabled: ['groq/gpt-oss-120b'] })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await bodyOf(res), { ok: true, prefs: { pinned: null, disabled: [] } });
    assert.match(seen.url, /\/api\/models$/);
    assert.equal(seen.options.method, 'POST');
    assert.deepEqual(JSON.parse(seen.options.body), { pinned: null, disabled: ['groq/gpt-oss-120b'] });
  });

  it('502s when error-inbox is unreachable', async () => {
    fetchImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const res = await prefsPOST(authedJsonReq('/api/models/prefs', { pinned: null, disabled: [] }));
    assert.equal(res.status, 502);
    assert.equal((await bodyOf(res)).error.code, 'UPSTREAM');
  });
});

describe('gateway tokens (/api/auth/token, session-only)', () => {
  it('401s mint/list/revoke without a session', async () => {
    assert.equal((await tokenPOST(new Request(`${BASE}/api/auth/token`, { method: 'POST' }))).status, 401);
    assert.equal((await tokenGET(new Request(`${BASE}/api/auth/token`))).status, 401);
    assert.equal((await tokenDELETE(new Request(`${BASE}/api/auth/token`, { method: 'DELETE' }))).status, 401);
  });

  it('401s mint with a gateway token instead of a session', async () => {
    const res = await tokenPOST(
      new Request(`${BASE}/api/auth/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    );
    assert.equal(res.status, 401);
    assert.equal((await bodyOf(res)).error.code, 'NO_KEY');
  });

  it('mints a verifiable stateless token from a session cookie', async () => {
    const res = await tokenPOST(
      new Request(`${BASE}/api/auth/token`, { method: 'POST', headers: { cookie: sessionCookie } })
    );
    assert.equal(res.status, 200);
    const data = await bodyOf(res);
    assert.equal(data.ok, true);
    assert.match(data.token, /^tc_v1\./);
    assert.deepEqual(await verifyGatewayToken(data.token), { login: 'jaykk99' });
  });

  it('lists zero stored tokens and revokes zero for a fresh store', async () => {
    const listRes = await tokenGET(new Request(`${BASE}/api/auth/token`, { headers: { cookie: sessionCookie } }));
    assert.equal(listRes.status, 200);
    assert.deepEqual(await bodyOf(listRes), { ok: true, tokens: [] });

    const delRes = await tokenDELETE(
      new Request(`${BASE}/api/auth/token`, { method: 'DELETE', headers: { cookie: sessionCookie } })
    );
    assert.equal(delRes.status, 200);
    assert.deepEqual(await bodyOf(delRes), { ok: true, revoked: 0 });
  });
});

describe('POST /api/bot/chat (validation only — no model calls)', () => {
  it('401s without a session, and a gateway token is not enough', async () => {
    const noAuth = await botChatPOST(jsonReq('/api/bot/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(noAuth.status, 401);
    assert.equal((await bodyOf(noAuth)).error.code, 'NO_KEY');

    const withToken = await botChatPOST(
      authedJsonReq('/api/bot/chat', { messages: [{ role: 'user', content: 'hi' }] })
    );
    assert.equal(withToken.status, 401);
    assert.equal((await bodyOf(withToken)).error.code, 'NO_KEY');
  });

  it('400s on missing, empty, or over-long message lists', async () => {
    const headers = { cookie: sessionCookie };
    for (const messages of [undefined, [], Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' }))] ) {
      const res = await botChatPOST(jsonReq('/api/bot/chat', { messages }, headers));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_MESSAGES');
    }
  });

  it('400s on a bad role or non-string content', async () => {
    const headers = { cookie: sessionCookie };
    for (const messages of [
      [{ role: 'system', content: 'x' }],
      [{ role: 'user', content: 42 }],
      [{ content: 'x' }],
      ['hi'],
    ]) {
      const res = await botChatPOST(jsonReq('/api/bot/chat', { messages }, headers));
      assert.equal(res.status, 400);
      assert.equal((await bodyOf(res)).error.code, 'BAD_MESSAGES');
    }
  });

  it('413s on a single message over the 16k cap', async () => {
    const res = await botChatPOST(
      jsonReq('/api/bot/chat', { messages: [{ role: 'user', content: 'x'.repeat(16_001) }] }, { cookie: sessionCookie })
    );
    assert.equal(res.status, 413);
    assert.equal((await bodyOf(res)).error.code, 'MESSAGE_TOO_LONG');
  });
});
