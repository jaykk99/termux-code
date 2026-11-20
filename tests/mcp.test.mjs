/**
 * Tests for lib/mcp.mjs — the zero-dependency MCP client (JSON-RPC 2.0
 * over Streamable HTTP, JSON and SSE answers, per-server failure capture).
 * Run: node --test tests/mcp.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  qualify,
  parseQualified,
  McpServer,
  connectAll,
  toolsForOpenAI,
  toolsForAnthropic,
  runMcpTool,
} from '../lib/mcp.mjs';

describe('qualify / parseQualified', () => {
  it('round-trips server and tool names', () => {
    assert.equal(qualify('composio', 'gmail_search'), 'mcp__composio__gmail_search');
    assert.deepEqual(parseQualified('mcp__composio__gmail_search'), { server: 'composio', tool: 'gmail_search' });
  });

  it('handles server names with underscores', () => {
    assert.deepEqual(parseQualified(qualify('my_server', 'do_thing')), { server: 'my_server', tool: 'do_thing' });
  });

  it('returns null for anything that is not an MCP tool', () => {
    for (const name of ['read_file', 'mcp__onlyone', 'mcp____', '', 'mcp__a__']) {
      assert.equal(parseQualified(name), null, name);
    }
  });
});

describe('toolsForOpenAI / toolsForAnthropic', () => {
  const servers = [
    { name: 'composio', tools: [{ name: 'gmail_search', description: 'Search Gmail', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] },
    { name: 'empty', tools: [] },
    { name: 'nodesc', tools: [{ name: 'ping' }] },
  ];

  it('namespaces tools and keeps their schemas', () => {
    const defs = toolsForOpenAI(servers);
    assert.equal(defs.length, 2);
    assert.equal(defs[0].type, 'function');
    assert.equal(defs[0].function.name, 'mcp__composio__gmail_search');
    assert.equal(defs[0].function.description, '[composio] Search Gmail');
    assert.deepEqual(defs[0].function.parameters, { type: 'object', properties: { q: { type: 'string' } } });
    // No description falls back to the tool name; no schema falls back to {}.
    assert.equal(defs[1].function.description, '[nodesc] ping');
    assert.deepEqual(defs[1].function.parameters, { type: 'object', properties: {} });
  });

  it('produces the Anthropic shape', () => {
    const defs = toolsForAnthropic(servers);
    assert.equal(defs.length, 2);
    assert.equal(defs[0].name, 'mcp__composio__gmail_search');
    assert.equal(defs[0].input_schema.type, 'object');
    assert.equal(defs[0].type, undefined);
  });

  it('clips over-long descriptions at 1000 chars', () => {
    const defs = toolsForOpenAI([{ name: 's', tools: [{ name: 't', description: 'x'.repeat(2000) }] }]);
    assert.equal(defs[0].function.description.length, 1000);
  });

  it('returns [] for servers with no tools', () => {
    assert.deepEqual(toolsForOpenAI([]), []);
    assert.deepEqual(toolsForAnthropic([{ name: 'empty', tools: [] }]), []);
  });
});

describe('McpServer.rpc with a stubbed fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const jsonResponse = (payload, { status = 200, contentType = 'application/json', sessionId = null } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : n.toLowerCase() === 'mcp-session-id' ? sessionId : null) },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });

  it('sends a JSON-RPC 2.0 envelope and returns the result', async () => {
    let seen;
    globalThis.fetch = async (url, opts) => {
      seen = { url, opts, body: JSON.parse(opts.body) };
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    };
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    const res = await s.rpc('tools/list', {});
    assert.deepEqual(res, { tools: [] });
    assert.equal(seen.url, 'https://mcp.example/rpc');
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.body.jsonrpc, '2.0');
    assert.equal(seen.body.method, 'tools/list');
    assert.equal(seen.body.id, 1);
    assert.match(seen.opts.headers.Accept, /text\/event-stream/);
    assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  });

  it('increments the request id per call and keeps the session id', async () => {
    let lastBody;
    globalThis.fetch = async (url, opts) => {
      lastBody = JSON.parse(opts.body);
      return jsonResponse({ jsonrpc: '2.0', id: lastBody.id, result: {} }, { sessionId: 'sess-123' });
    };
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    await s.rpc('initialize', {});
    await s.rpc('tools/list', {});
    assert.equal(lastBody.id, 2);
    assert.equal(s.session, 'sess-123');
  });

  it('sends the session id back on later calls', async () => {
    const seenHeaders = [];
    globalThis.fetch = async (url, opts) => {
      seenHeaders.push(opts.headers);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} }, { sessionId: 'abc' });
    };
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    await s.rpc('initialize', {});
    await s.rpc('tools/list', {});
    assert.equal(seenHeaders[1]['Mcp-Session-Id'], 'abc');
  });

  it('parses SSE answers, taking the last complete frame', async () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"partial":true}}',
      '',
      'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ping"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    globalThis.fetch = async () => jsonResponse(sse, { contentType: 'text/event-stream' });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    assert.deepEqual(await s.rpc('tools/list', {}), { tools: [{ name: 'ping' }] });
  });

  it('throws when the SSE body has no parsable frame', async () => {
    globalThis.fetch = async () => jsonResponse('event: ping\ndata: not json\n', { contentType: 'text/event-stream' });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    await assert.rejects(s.rpc('tools/list', {}), /no parsable SSE data frame/);
  });

  it('throws an honest error on a non-2xx status', async () => {
    globalThis.fetch = async () => jsonResponse('server exploded', { status: 500 });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    await assert.rejects(s.rpc('initialize', {}), /500 server exploded/);
  });

  it('throws the payload error message', async () => {
    globalThis.fetch = async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    await assert.rejects(s.rpc('nope', {}), /Method not found/);
  });

  it('passes custom headers (auth) through', async () => {
    let seen;
    globalThis.fetch = async (url, opts) => {
      seen = opts.headers;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
    };
    const s = new McpServer('test', { url: 'https://mcp.example/rpc', headers: { Authorization: 'Bearer sekrit' } });
    await s.rpc('initialize', {});
    assert.equal(seen.Authorization, 'Bearer sekrit');
  });
});

describe('McpServer.connect / call', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
  });

  it('connects, caches the tool list, and marks itself ready', async () => {
    const methods = [];
    globalThis.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      methods.push(body.method);
      return jsonResponse(body.method === 'initialize'
        ? { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }
        : { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'gmail_search' }, { name: 'gmail_send' }] } });
    };
    const s = await new McpServer('composio', { url: 'https://mcp.example/rpc' }).connect();
    assert.deepEqual(methods, ['initialize', 'tools/list']);
    assert.equal(s.ready, true);
    assert.equal(s.error, null);
    assert.deepEqual(s.tools.map((t) => t.name), ['gmail_search', 'gmail_send']);
  });

  it('captures a failed handshake instead of throwing', async () => {
    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };
    const s = await new McpServer('down', { url: 'https://mcp.example/rpc' }).connect();
    assert.equal(s.ready, false);
    assert.match(s.error, /connection refused/);
    assert.deepEqual(s.tools, []);
  });

  it('flattens content blocks to text on call', async () => {
    globalThis.fetch = async () => jsonResponse({
      jsonrpc: '2.0', id: 1,
      result: { content: [{ type: 'text', text: 'hello' }, { type: 'resource', resource: { uri: 'file://x', text: 'res text' } }, { type: 'image' }] },
    });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    const out = await s.call('doit', { a: 1 });
    assert.match(out, /hello/);
    assert.match(out, /res text/);
    assert.match(out, /\[image\]/);
  });

  it('reports tool errors in the text, and an empty result honestly', async () => {
    globalThis.fetch = async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    const s = new McpServer('test', { url: 'https://mcp.example/rpc' });
    assert.match(await s.call('doit', {}), /Tool reported an error:\nboom/);

    globalThis.fetch = async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: null });
    assert.equal(await s.call('doit', {}), '(no result)');
  });
});

describe('connectAll', () => {
  it('returns [] with no servers configured', async () => {
    assert.deepEqual(await connectAll({}), []);
    assert.deepEqual(await connectAll(), []);
  });

  it('connects every server and never throws for a dead one', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('down')) throw new Error('down');
      return {
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      };
    };
    try {
      const servers = await connectAll({
        up: { url: 'https://up.example/rpc' },
        down: { url: 'https://down.example/rpc' },
      });
      assert.equal(servers.length, 2);
      assert.equal(servers.find((s) => s.name === 'up').ready, true);
      assert.equal(servers.find((s) => s.name === 'down').ready, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('runMcpTool', () => {
  const fakeServer = (over = {}) => ({
    name: 'composio',
    ready: true,
    error: null,
    call: async (tool, args) => `ran ${tool} with ${JSON.stringify(args)}`,
    ...over,
  });

  it('refuses names that are not MCP tools', async () => {
    assert.match(await runMcpTool([], 'read_file', {}, async () => true), /Not an MCP tool/);
  });

  it('refuses unknown servers', async () => {
    assert.match(
      await runMcpTool([fakeServer()], 'mcp__other__x', {}, async () => true),
      /No MCP server named "other"/
    );
  });

  it('refuses a server that never connected', async () => {
    const s = fakeServer({ ready: false, error: 'connection refused' });
    assert.match(await runMcpTool([s], 'mcp__composio__x', {}, async () => true), /not connected: connection refused/);
  });

  it('requires approval and reports a decline', async () => {
    const calls = [];
    const s = fakeServer({ call: async (...a) => { calls.push(a); return 'ran'; } });
    const out = await runMcpTool([s], 'mcp__composio__gmail_send', { to: 'a@b.c' }, async () => false);
    assert.match(out, /Declined by the user/);
    assert.deepEqual(calls, []);
  });

  it('shows the tool and a clipped preview to the approver, then runs', async () => {
    let shown;
    const s = fakeServer();
    const out = await runMcpTool([s], 'mcp__composio__gmail_send', { to: 'a@b.c' }, async (title, preview) => {
      shown = { title, preview };
      return true;
    });
    assert.match(shown.title, /composio → gmail_send/);
    assert.match(shown.preview, /a@b\.c/);
    assert.match(out, /ran gmail_send/);
  });

  it('reports a failed call instead of throwing', async () => {
    const s = fakeServer({ call: async () => { throw new Error('upstream 500'); } });
    assert.match(await runMcpTool([s], 'mcp__composio__x', {}, async () => true), /MCP call failed: upstream 500/);
  });
});
