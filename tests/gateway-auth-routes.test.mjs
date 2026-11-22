/**
 * Tests for the remaining gateway routes: the GitHub OAuth start/callback,
 * logout, and /api/chat's POST gate + validation (its completion path is
 * covered by lib-level failover/agent tests; here we pin that the route
 * refuses anonymous callers and malformed bodies before any model call).
 *
 * OAuth is exercised end to end with a stubbed fetch: the code exchange
 * and /user calls never leave the process. Secrets live only on
 * process.env for this file's run and are restored in after().
 *
 * Run: node --test tests/gateway-auth-routes.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { GET as githubGET } from '../app/api/auth/github/route.js';
import { GET as callbackGET } from '../app/api/auth/callback/route.js';
import { POST as logoutPOST } from '../app/api/auth/logout/route.js';
import { POST as chatPOST } from '../app/api/chat/route.js';
import { issueGatewayToken, verifySession, SESSION_COOKIE, STATE_COOKIE } from '../lib/auth.mjs';

const BASE = 'https://gateway.test';

let token;
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

function setOAuth(on) {
  if (on) {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
  } else {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  }
}

before(async () => {
  saveEnv(['GATEWAY_TOKEN_SECRET', 'SESSION_SECRET', 'OWNER_GITHUB_LOGIN', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET']);
  process.env.GATEWAY_TOKEN_SECRET = 'test-gateway-secret';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.OWNER_GITHUB_LOGIN = 'jaykk99';
  token = await issueGatewayToken('jaykk99');
  fetchImpl = async () => {
    throw new Error('network down (test stub)');
  };
  globalThis.fetch = async (...args) => fetchImpl(...args);
});

after(async () => {
  globalThis.fetch = realFetch;
  restoreEnv(['GATEWAY_TOKEN_SECRET', 'SESSION_SECRET', 'OWNER_GITHUB_LOGIN', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET']);
});

function stateCookieValue(res) {
  const setCookie = res.headers.getSetCookie();
  const hit = setCookie.find((c) => c.startsWith(`${STATE_COOKIE}=`));
  return hit ? hit.slice(STATE_COOKIE.length + 1).split(';')[0] : null;
}

describe('GET /api/auth/github', () => {
  it('503s when GitHub OAuth is not configured', async () => {
    setOAuth(false);
    const res = await githubGET(new Request(`${BASE}/api/auth/github`));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'OAUTH_NOT_CONFIGURED');
  });

  it('302s to GitHub with a state cookie when configured', async () => {
    setOAuth(true);
    const res = await githubGET(new Request('http://gateway.test/api/auth/github'));
    assert.equal(res.status, 302);
    const location = res.headers.get('Location');
    assert.match(location, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    assert.match(location, /client_id=test-client-id/);
    assert.match(location, /redirect_uri=/);
    assert.match(location, /state=[0-9a-f]{32}/);
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], new RegExp(`^${STATE_COOKIE}=[0-9a-f]{32};`));
    assert.match(cookies[0], /HttpOnly/);
    assert.match(cookies[0], /SameSite=Lax/);
    assert.match(cookies[0], /Max-Age=600/);
    assert.doesNotMatch(cookies[0], /Secure/);
    // The state in the cookie is the state in the redirect.
    const state = stateCookieValue(res);
    assert.ok(location.includes(`state=${state}`));
  });

  it('marks the state cookie Secure on https', async () => {
    setOAuth(true);
    const res = await githubGET(new Request(`${BASE}/api/auth/github`));
    assert.equal(res.status, 302);
    assert.match(res.headers.getSetCookie()[0], /Secure/);
  });
});

describe('GET /api/auth/callback', () => {
  it('503s when GitHub OAuth is not configured', async () => {
    setOAuth(false);
    const res = await callbackGET(new Request(`${BASE}/api/auth/callback?code=c&state=s`));
    assert.equal(res.status, 503);
    assert.match(await res.text(), /not configured/);
  });

  it('400s when the state does not match the cookie', async () => {
    setOAuth(true);
    const cases = [
      // No state cookie at all.
      new Request(`${BASE}/api/auth/callback?code=c&state=s`),
      // Cookie state differs from the query state.
      new Request(`${BASE}/api/auth/callback?code=c&state=aaa`, { headers: { cookie: `${STATE_COOKIE}=bbb` } }),
      // No code.
      new Request(`${BASE}/api/auth/callback?state=aaa`, { headers: { cookie: `${STATE_COOKIE}=aaa` } }),
    ];
    for (const req of cases) {
      const res = await callbackGET(req);
      assert.equal(res.status, 400);
      assert.match(await res.text(), /expired or did not match/);
    }
  });

  it('502s when the GitHub exchange fails', async () => {
    setOAuth(true);
    fetchImpl = async () => {
      throw new Error('boom');
    };
    const res = await callbackGET(
      new Request(`${BASE}/api/auth/callback?code=c&state=aaa`, { headers: { cookie: `${STATE_COOKIE}=aaa` } })
    );
    assert.equal(res.status, 502);
    assert.match(await res.text(), /GitHub sign-in failed: boom/);
  });

  it('refuses a non-owner GitHub login with no session', async () => {
    setOAuth(true);
    fetchImpl = async (url) => {
      if (String(url).includes('/login/oauth/access_token')) {
        return { ok: true, json: async () => ({ access_token: 'tok123' }) };
      }
      return { ok: true, json: async () => ({ login: 'intruder' }) };
    };
    const res = await callbackGET(
      new Request(`${BASE}/api/auth/callback?code=c&state=aaa`, { headers: { cookie: `${STATE_COOKIE}=aaa` } })
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not the owner/);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.includes('Max-Age=0')));
  });

  it('302s with a verifiable owner session for the owner login', async () => {
    setOAuth(true);
    fetchImpl = async (url) => {
      if (String(url).includes('/login/oauth/access_token')) {
        return { ok: true, json: async () => ({ access_token: 'tok123' }) };
      }
      return { ok: true, json: async () => ({ login: 'jaykk99' }) };
    };
    const res = await callbackGET(
      new Request(`${BASE}/api/auth/callback?code=c&state=aaa`, { headers: { cookie: `${STATE_COOKIE}=aaa` } })
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), '/');
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(session);
    const value = session.slice(SESSION_COOKIE.length + 1).split(';')[0];
    assert.deepEqual(verifySession(value).login, 'jaykk99');
    assert.ok(cookies.some((c) => c.startsWith(`${STATE_COOKIE}=`) && c.includes('Max-Age=0')));
  });
});

describe('POST /api/auth/logout', () => {
  it('302s home clearing the session cookie', async () => {
    const res = await logoutPOST(new Request('http://gateway.test/api/auth/logout', { method: 'POST' }));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), '/');
    const cookies = res.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], new RegExp(`^${SESSION_COOKIE}=;`));
    assert.match(cookies[0], /Max-Age=0/);
    assert.match(cookies[0], /HttpOnly/);
    assert.doesNotMatch(cookies[0], /Secure/);
  });

  it('marks the cleared cookie Secure on https', async () => {
    const res = await logoutPOST(new Request(`${BASE}/api/auth/logout`, { method: 'POST' }));
    assert.equal(res.status, 302);
    assert.match(res.headers.getSetCookie()[0], /Secure/);
  });
});

describe('POST /api/chat (gate + validation only)', () => {
  const model = { id: 'any', provider: 'horde', source: 'direct' };

  function chatReq(body, headers = {}) {
    return new Request(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  it('401s without any credential', async () => {
    const res = await chatPOST(
      new Request(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      })
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'NO_KEY');
  });

  it('400s on an unknown model', async () => {
    const res = await chatPOST(
      chatReq({ model: { id: 'nope', provider: 'kilo', source: 'direct' }, messages: [{ role: 'user', content: 'hi' }] })
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_MODEL');
  });

  it('400s when the model is missing', async () => {
    const res = await chatPOST(chatReq({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'BAD_MODEL');
  });

  it('400s on bad messages before any model call', async () => {
    fetchImpl = async () => {
      throw new Error('must not be called: validation happens first');
    };
    for (const messages of [
      [],
      [{ role: 'admin', content: 'x' }],
      [{ role: 'user', content: 42 }],
      Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' })),
    ]) {
      const res = await chatPOST(chatReq({ model, messages }));
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.code, 'BAD_MESSAGES');
    }
  });

  it('lets a system message through validation to the model (unlike /api/bot/chat)', async () => {
    // /api/chat accepts the system role: the phone sends its own system
    // prompt. With the network stubbed down the turn 502s upstream
    // instead of 400ing, proving validation passed and the call went out.
    fetchImpl = async () => {
      throw new Error('network down (test stub)');
    };
    const res = await chatPOST(
      chatReq({ model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }] })
    );
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, 'UPSTREAM');
  });
});
