/**
 * Gate tests: the REAL route handlers, called directly. The contract Jay
 * set — anonymous requests to chat and tool endpoints are refused, a
 * gateway token opens the gateway but never the chatbot's tools, and only
 * the owner's GitHub session opens everything.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-gate-'));
process.env.SESSION_SECRET = 'gate-test-secret';
process.env.GATEWAY_TOKEN_STORE = path.join(dir, 'tokens.json');
process.env.AUDIT_LOG_PATH = path.join(dir, 'audit.log');

const { issueGatewayToken, createSession, SESSION_COOKIE } = await import('../lib/auth.mjs');
const chatRoute = await import('../app/api/chat/route.js');
const botRoute = await import('../app/api/bot/chat/route.js');
const modelsRoute = await import('../app/api/models/route.js');
const tokenRoute = await import('../app/api/auth/token/route.js');

let gatewayToken;
let sessionCookie;
before(async () => {
  gatewayToken = await issueGatewayToken('jaykk99');
  sessionCookie = `${SESSION_COOKIE}=${createSession('jaykk99')}`;
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function post(url, { headers = {}, body } = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const chatBody = {
  model: { id: 'nope', provider: 'nope', source: 'direct' },
  messages: [{ role: 'user', content: 'hi' }],
};

describe('/api/chat (gateway completions)', () => {
  it('refuses anonymous requests with 401', async () => {
    const res = await chatRoute.POST(post('https://x.test/api/chat', { body: chatBody }));
    assert.equal(res.status, 401);
  });

  it('lets a gateway token through the gate (then fails on the bogus model, 400)', async () => {
    const res = await chatRoute.POST(
      post('https://x.test/api/chat', { headers: { Authorization: `Bearer ${gatewayToken}` }, body: chatBody })
    );
    assert.equal(res.status, 400);
  });
});

describe('/api/bot/chat (chatbot + server tools)', () => {
  it('refuses anonymous requests with 401', async () => {
    const res = await botRoute.POST(post('https://x.test/api/bot/chat', { body: { messages: [] } }));
    assert.equal(res.status, 401);
  });

  it('refuses a gateway token — tools are session-only', async () => {
    const res = await botRoute.POST(
      post('https://x.test/api/bot/chat', {
        headers: { Authorization: `Bearer ${gatewayToken}` },
        body: { messages: [{ role: 'user', content: 'hi' }] },
      })
    );
    assert.equal(res.status, 401);
  });

  it('lets the owner session through the gate (then validates messages, 400)', async () => {
    const res = await botRoute.POST(
      post('https://x.test/api/bot/chat', { headers: { Cookie: sessionCookie }, body: { messages: [] } })
    );
    assert.equal(res.status, 400);
  });
});

describe('/api/models', () => {
  it('refuses anonymous requests with 401', async () => {
    const res = await modelsRoute.GET(new Request('https://x.test/api/models'));
    assert.equal(res.status, 401);
  });
});

describe('/api/auth/token', () => {
  it('refuses anonymous minting with 401', async () => {
    const res = await tokenRoute.POST(post('https://x.test/api/auth/token'));
    assert.equal(res.status, 401);
  });

  it('serves the owner session', async () => {
    const res = await tokenRoute.GET(
      new Request('https://x.test/api/auth/token', { headers: { Cookie: sessionCookie } })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.tokens));
  });
});

describe('/api/auth/token (mint path)', () => {
  it('mints for the owner session through the real handler', async () => {
    const res = await tokenRoute.POST(
      post('https://x.test/api/auth/token', { headers: { Cookie: sessionCookie } })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.token === 'string' && data.token.startsWith('tc_'));
  });

  it('a failing store no longer blocks the mint, and the body stays parseable JSON', async () => {
    // Regression test for the Cloudflare failure, inverted: the old
    // handler let the store throw out of the route, and the browser saw
    // an empty body ("Unexpected end of JSON input"). Stateless tokens
    // need no store, so the mint must succeed even with the store dead,
    // and the response must still be parseable JSON.
    const throwingKv = {
      async get() {
        throw new Error('KV unavailable');
      },
      async put() {
        throw new Error('KV unavailable');
      },
      async delete() {
        throw new Error('KV unavailable');
      },
    };
    process.env.GATEWAY_KV = throwingKv;
    try {
      const res = await tokenRoute.POST(
        post('https://x.test/api/auth/token', { headers: { Cookie: sessionCookie } })
      );
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.ok(typeof data.token === 'string' && data.token.startsWith('tc_v1.'));
    } finally {
      delete process.env.GATEWAY_KV;
    }
  });
});
