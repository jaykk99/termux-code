/**
 * Tests for lib/gateway-tools.mjs — phone-side dispatch for server-side
 * (Composio) tools, which must run on the gateway where the key lives.
 * Run: node --test tests/gateway-tools.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GATEWAY_TOOL_NAMES, isGatewayTool, executeGatewayTool } from '../lib/gateway-tools.mjs';

const BASE = { gateway: 'https://termux-code.pages.dev', gatewayToken: 'tok-123', name: 'composio_search', args: { task: 'find gmail' } };

const okResponse = (result) => ({
  ok: true,
  status: 200,
  json: async () => ({ result }),
});

describe('isGatewayTool', () => {
  it('recognises the gateway tools and nothing else', () => {
    assert.equal(isGatewayTool('composio_search'), true);
    assert.equal(isGatewayTool('composio_execute'), true);
    assert.equal(isGatewayTool('read_file'), false);
    assert.equal(isGatewayTool('bash'), false);
    assert.equal(isGatewayTool(''), false);
    assert.equal(GATEWAY_TOOL_NAMES.size, 2);
  });
});

describe('executeGatewayTool', () => {
  it('refuses a tool that is not a gateway tool', async () => {
    assert.match(await executeGatewayTool({ ...BASE, name: 'read_file' }), /Not a gateway tool: read_file/);
  });

  it('explains itself when no gateway is configured', async () => {
    const out = await executeGatewayTool({ ...BASE, gateway: '' }, async () => { throw new Error('must not fetch'); });
    assert.match(out, /need the gateway/);
    assert.match(out, /\/gateway/);
  });

  it('posts to /api/tools/execute with the token and returns the result text', async () => {
    let seen;
    const fetchFn = async (url, opts) => {
      seen = { url, opts, body: JSON.parse(opts.body) };
      return okResponse('Found: SendEmail (composio)');
    };
    const out = await executeGatewayTool(BASE, fetchFn);
    assert.equal(out, 'Found: SendEmail (composio)');
    assert.equal(seen.url, 'https://termux-code.pages.dev/api/tools/execute');
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers.Authorization, 'Bearer tok-123');
    assert.equal(seen.opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(seen.body, { name: 'composio_search', args: { task: 'find gmail' } });
  });

  it('strips a trailing slash from the gateway URL', async () => {
    let seenUrl;
    await executeGatewayTool({ ...BASE, gateway: 'https://example.dev/' }, async (url) => {
      seenUrl = url;
      return okResponse('ok');
    });
    assert.equal(seenUrl, 'https://example.dev/api/tools/execute');
  });

  it('works without a token (no Authorization header sent)', async () => {
    let seenHeaders;
    await executeGatewayTool({ ...BASE, gatewayToken: '' }, async (url, opts) => {
      seenHeaders = opts.headers;
      return okResponse('ok');
    });
    assert.equal(seenHeaders.Authorization, undefined);
  });

  it('passes a non-string result through as JSON', async () => {
    const out = await executeGatewayTool(BASE, async () => okResponse({ sent: true, id: '42' }));
    assert.equal(out, JSON.stringify({ sent: true, id: '42' }));
  });

  it('passes the gateway upstream status text through untouched', async () => {
    const out = await executeGatewayTool(BASE, async () => okResponse('HTTP 401 Composio key rejected'));
    assert.equal(out, 'HTTP 401 Composio key rejected');
  });

  it('reports an unreachable gateway honestly', async () => {
    const out = await executeGatewayTool(BASE, async () => { throw new Error('fetch failed'); });
    assert.match(out, /could not reach the gateway \(fetch failed\)/);
  });

  it('reports an error object with code and message', async () => {
    const out = await executeGatewayTool(BASE, async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'BAD_TOKEN', message: 'gateway token expired' } }),
    }));
    assert.match(out, /Gateway tool composio_search failed: BAD_TOKEN: gateway token expired/);
  });

  it('reports a plain-string error', async () => {
    const out = await executeGatewayTool(BASE, async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Composio is down' }),
    }));
    assert.match(out, /Gateway tool composio_search failed: Composio is down/);
  });

  it('falls back to the HTTP status when the error body is empty', async () => {
    const out = await executeGatewayTool(BASE, async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    }));
    assert.match(out, /Gateway returned HTTP 502/);
  });

  it('survives a non-JSON error body', async () => {
    const out = await executeGatewayTool(BASE, async () => ({
      ok: false,
      status: 503,
      json: async () => { throw new Error('not json'); },
    }));
    assert.match(out, /Gateway returned HTTP 503/);
  });
});
