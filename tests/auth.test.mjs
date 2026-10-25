/**
 * Tests for lib/auth.mjs — sessions, the owner allowlist, GitHub OAuth
 * helpers, gateway tokens, and the two gate levels (gateway vs owner-only).
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  verifySession,
  parseCookies,
  sessionFromRequest,
  ownerLogin,
  oauthConfigured,
  githubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
  issueGatewayToken,
  verifyGatewayToken,
  listGatewayTokens,
  revokeGatewayTokens,
  gatewayAccess,
  ownerSession,
  SESSION_COOKIE,
} from '../lib/auth.mjs';

let storeFile;
let ENV;
before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-auth-'));
  storeFile = path.join(dir, 'tokens.json');
  ENV = {
    SESSION_SECRET: 'test-secret',
    OWNER_GITHUB_LOGIN: 'jaykk99',
    GATEWAY_TOKEN_STORE: storeFile,
  };
});
after(async () => {
  await fs.rm(path.dirname(storeFile), { recursive: true, force: true });
});

function reqWith(headers = {}) {
  return new Request('https://x.test/api', { headers });
}

describe('sessions', () => {
  it('round-trips a session for the owner', () => {
    const token = createSession('jaykk99', ENV);
    const session = verifySession(token, ENV);
    assert.equal(session.login, 'jaykk99');
  });

  it('rejects a tampered session', () => {
    const token = createSession('jaykk99', ENV);
    const [payload, sig] = token.split('.');
    assert.equal(verifySession(`${payload}.${sig.slice(0, -2)}xx`, ENV), null);
    assert.equal(verifySession('garbage', ENV), null);
    assert.equal(verifySession(undefined, ENV), null);
  });

  it('rejects an expired session', () => {
    const token = createSession('jaykk99', ENV, Date.now() - 8 * 24 * 3600 * 1000);
    assert.equal(verifySession(token, ENV), null);
  });

  it('rejects a session minted for anyone but the owner allowlist', () => {
    const token = createSession('someoneelse', ENV);
    assert.equal(verifySession(token, ENV), null);
  });

  it('ownerLogin defaults to jaykk99 and oauthConfigured needs both values', () => {
    assert.equal(ownerLogin({}), 'jaykk99');
    assert.equal(oauthConfigured({}), false);
    assert.equal(
      oauthConfigured({ GITHUB_OAUTH_CLIENT_ID: 'a', GITHUB_OAUTH_CLIENT_SECRET: 'b' }),
      true
    );
  });
});

describe('GitHub OAuth helpers', () => {
  it('builds the authorize URL with client, callback and state', () => {
    const url = githubAuthorizeUrl({
      clientId: 'cid',
      redirectUri: 'https://app.test/api/auth/callback',
      state: 'abc123',
    });
    assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'));
    assert.ok(url.includes('client_id=cid'));
    assert.ok(url.includes('state=abc123'));
    assert.ok(url.includes(encodeURIComponent('https://app.test/api/auth/callback')));
  });

  it('exchanges a code and reads the user login (network stubbed)', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push(url);
      if (url.includes('access_token')) {
        return { ok: true, json: async () => ({ access_token: 'gho_test' }) };
      }
      assert.equal(options.headers.Authorization, 'Bearer gho_test');
      return { ok: true, json: async () => ({ login: 'jaykk99', id: 1 }) };
    };
    const token = await exchangeGithubCode(
      { code: 'c', clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.test/api/auth/callback' },
      fetchFn
    );
    assert.equal(token, 'gho_test');
    const user = await fetchGithubUser(token, fetchFn);
    assert.equal(user.login, 'jaykk99');
    assert.equal(calls.length, 2);
  });
});

describe('gateway tokens', () => {
  it('issues a stateless token that verifies with no store at all', async () => {
    const token = await issueGatewayToken('jaykk99', ENV);
    assert.ok(token.startsWith('tc_v1.'));
    assert.deepEqual(await verifyGatewayToken(token, ENV), { login: 'jaykk99' });

    // Stateless means exactly that: deleting the store must not matter,
    // and nothing about the token is ever listed or written to disk.
    assert.equal((await listGatewayTokens('jaykk99', ENV)).length, 0);
    await assert.rejects(fs.readFile(storeFile, 'utf8'));
    assert.deepEqual(await verifyGatewayToken(token, ENV), { login: 'jaykk99' });
  });

  it('rejects a tampered stateless token and one signed with another secret', async () => {
    const token = await issueGatewayToken('jaykk99', ENV);
    assert.equal(await verifyGatewayToken(`${token.slice(0, -2)}xx`, ENV), null);
    const otherSecret = { ...ENV, SESSION_SECRET: 'different-secret' };
    assert.equal(await verifyGatewayToken(token, otherSecret), null);
  });

  it('rejects an expired stateless token and one minted for a non-owner', async () => {
    const old = await issueGatewayToken('jaykk99', ENV, Date.now() - 366 * 24 * 3600 * 1000);
    assert.equal(await verifyGatewayToken(old, ENV), null);
    const stranger = await issueGatewayToken('someoneelse', ENV);
    assert.equal(await verifyGatewayToken(stranger, ENV), null);
  });

  it('minting a second token does NOT revoke the first (stateless contract)', async () => {
    const first = await issueGatewayToken('jaykk99', ENV);
    const second = await issueGatewayToken('jaykk99', ENV);
    assert.deepEqual(await verifyGatewayToken(first, ENV), { login: 'jaykk99' });
    assert.deepEqual(await verifyGatewayToken(second, ENV), { login: 'jaykk99' });
    // Revoke/list cover stored (legacy) tokens only, so they are no-ops
    // here and must never make a stateless token stop verifying.
    assert.equal(await revokeGatewayTokens('jaykk99', ENV), 0);
    assert.deepEqual(await verifyGatewayToken(first, ENV), { login: 'jaykk99' });
  });

  it('rejects junk tokens', async () => {
    assert.equal(await verifyGatewayToken('tc_deadbeef', ENV), null);
    assert.equal(await verifyGatewayToken('not-a-token', ENV), null);
    assert.equal(await verifyGatewayToken(undefined, ENV), null);
  });
});

describe('the two gate levels', () => {
  it('anonymous requests get neither gateway nor owner access', async () => {
    const req = reqWith();
    assert.equal(await gatewayAccess(req, ENV), null);
    assert.equal(ownerSession(req, ENV), null);
  });

  it('a gateway token opens the gateway but NEVER owner-only routes', async () => {
    const token = await issueGatewayToken('jaykk99', ENV);
    const req = reqWith({ Authorization: `Bearer ${token}` });
    const access = await gatewayAccess(req, ENV);
    assert.equal(access.login, 'jaykk99');
    assert.equal(access.via, 'token');
    assert.equal(ownerSession(req, ENV), null);
    await revokeGatewayTokens('jaykk99', ENV);
  });

  it('a session cookie opens both levels', async () => {
    const token = createSession('jaykk99', ENV);
    const req = reqWith({ Cookie: `${SESSION_COOKIE}=${token}` });
    assert.equal(sessionFromRequest(req, ENV).login, 'jaykk99');
    assert.equal(ownerSession(req, ENV).login, 'jaykk99');
    assert.equal((await gatewayAccess(req, ENV)).via, 'session');
  });

  it('parseCookies reads a realistic header', () => {
    const cookies = parseCookies('a=1; tc_session=x.y; b=two%20words');
    assert.equal(cookies.a, '1');
    assert.equal(cookies.tc_session, 'x.y');
    assert.equal(cookies.b, 'two words');
  });
});

/* In-memory stand-in for a Cloudflare KV namespace (async get/put/delete). */
function memoryKv() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    raw() {
      return [...map.values()].join('\n');
    },
  };
}

describe('gateway tokens on a KV store (Cloudflare runtime)', () => {
  it('issues and verifies via KV without writing anything to it', async () => {
    const kv = memoryKv();
    const KV_ENV = { ...ENV, GATEWAY_KV: kv };
    const token = await issueGatewayToken('jaykk99', KV_ENV);
    assert.ok(token.startsWith('tc_v1.'));
    assert.deepEqual(await verifyGatewayToken(token, KV_ENV), { login: 'jaykk99' });

    // Stateless tokens never touch the store, so listing is empty and
    // the KV value holds nothing — the store is legacy-only now.
    assert.equal((await listGatewayTokens('jaykk99', KV_ENV)).length, 0);
    assert.equal(kv.raw(), '');
    assert.deepEqual(await verifyGatewayToken(token, KV_ENV), { login: 'jaykk99' });
  });

  it('minting a second token does not revoke the first, even on KV', async () => {
    const kv = memoryKv();
    const KV_ENV = { ...ENV, GATEWAY_KV: kv };
    const first = await issueGatewayToken('jaykk99', KV_ENV);
    const second = await issueGatewayToken('jaykk99', KV_ENV);
    assert.deepEqual(await verifyGatewayToken(first, KV_ENV), { login: 'jaykk99' });
    assert.deepEqual(await verifyGatewayToken(second, KV_ENV), { login: 'jaykk99' });
  });

  it('a failing KV store no longer rejects the mint or the verify', async () => {
    // Regression test for the Pages failure: the old store-backed mint
    // answered JSON 500 whenever the store threw (or silently lost the
    // token on a filesystem-less runtime). Stateless tokens must mint
    // and verify with the store completely dead.
    const brokenKv = {
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
    const brokenEnv = { ...ENV, GATEWAY_KV: brokenKv };
    const token = await issueGatewayToken('jaykk99', brokenEnv);
    assert.deepEqual(await verifyGatewayToken(token, brokenEnv), { login: 'jaykk99' });
  });
});
