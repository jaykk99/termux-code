/**
 * Tests for lib/mcp-manager.mjs — interactive MCP server management:
 * validate / add / remove / list / test / reconnect, with auth headers
 * never leaking into list output.
 * Run: node --test tests/mcp-manager.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateServerName,
  validateServerUrl,
  parseHeaderArg,
  addMcpServer,
  removeMcpServer,
  listMcpServers,
  formatServerList,
  testMcpServer,
  reconnectMcpServers,
} from '../lib/mcp-manager.mjs';

describe('validateServerName', () => {
  it('accepts plain names, dashes and underscores', () => {
    for (const name of ['composio', 'my-server', 'my_server', 's1', 'A']) {
      assert.equal(validateServerName(name), name);
    }
  });

  it('trims surrounding whitespace', () => {
    assert.equal(validateServerName('  composio  '), 'composio');
  });

  it('rejects empty, dotted, spaced and slash names', () => {
    for (const name of ['', '  ', 'my.server', 'my server', 'a/b', '-lead', '_lead', 'mcp__x']) {
      assert.throws(() => validateServerName(name), /Invalid MCP server name/, name);
    }
  });
});

describe('validateServerUrl', () => {
  it('accepts http and https URLs', () => {
    assert.equal(validateServerUrl('https://example.com/mcp'), 'https://example.com/mcp');
    assert.equal(validateServerUrl('http://192.168.1.5:8080/'), 'http://192.168.1.5:8080/');
  });

  it('rejects relative, non-http and empty URLs', () => {
    for (const url of ['', 'example.com/mcp', '/mcp', 'ftp://example.com/x', 'ws://example.com/x', 'javascript:alert(1)']) {
      assert.throws(() => validateServerUrl(url), /Invalid MCP server URL/, url);
    }
  });
});

describe('parseHeaderArg', () => {
  it('parses "Name: value" and normalises the header name casing', () => {
    assert.deepEqual(parseHeaderArg('Authorization: Bearer abc'), { name: 'Authorization', value: 'Bearer abc' });
    assert.deepEqual(parseHeaderArg('x-api-key: secret'), { name: 'X-Api-Key', value: 'secret' });
  });

  it('rejects a missing colon or an empty value', () => {
    for (const arg of ['Authorization', 'Authorization:', 'Authorization:   ', '']) {
      assert.throws(() => parseHeaderArg(arg), /Invalid header/, JSON.stringify(arg));
    }
  });
});

describe('addMcpServer / removeMcpServer', () => {
  it('adds a server without mutating the input map', () => {
    const before = { old: { url: 'https://old.example/mcp' } };
    const after = addMcpServer(before, 'new', 'https://new.example/mcp');
    assert.deepEqual(before, { old: { url: 'https://old.example/mcp' } });
    assert.deepEqual(after, {
      old: { url: 'https://old.example/mcp' },
      new: { url: 'https://new.example/mcp' },
    });
  });

  it('stores headers when given, and drops empty ones', () => {
    const after = addMcpServer({}, 's', 'https://s.example/mcp', {
      Authorization: 'Bearer abc',
      'X-Empty': '   ',
    });
    assert.deepEqual(after.s, { url: 'https://s.example/mcp', headers: { Authorization: 'Bearer abc' } });
  });

  it('refuses a duplicate name, a bad name and a bad URL', () => {
    const servers = { s: { url: 'https://s.example/mcp' } };
    assert.throws(() => addMcpServer(servers, 's', 'https://other.example/mcp'), /already configured/);
    assert.throws(() => addMcpServer(servers, 'bad name', 'https://x.example/mcp'), /Invalid MCP server name/);
    assert.throws(() => addMcpServer(servers, 'ok', 'not-a-url'), /Invalid MCP server URL/);
    assert.deepEqual(servers, { s: { url: 'https://s.example/mcp' } });
  });

  it('removes an existing server and reports a missing one', () => {
    const before = { a: { url: 'https://a.example/mcp' }, b: { url: 'https://b.example/mcp' } };
    const { servers, removed } = removeMcpServer(before, 'a');
    assert.equal(removed, true);
    assert.deepEqual(Object.keys(servers), ['b']);
    assert.deepEqual(Object.keys(before), ['a', 'b']);
    assert.deepEqual(removeMcpServer(before, 'nope'), { servers: before, removed: false });
  });
});

describe('listMcpServers / formatServerList', () => {
  it('sorts by name and never exposes header values', () => {
    const list = listMcpServers({
      zeta: { url: 'https://z.example/mcp', headers: { Authorization: 'Bearer TOPSECRET' } },
      alpha: { url: 'https://a.example/mcp' },
    });
    assert.deepEqual(list, [
      { name: 'alpha', url: 'https://a.example/mcp', hasAuth: false },
      { name: 'zeta', url: 'https://z.example/mcp', hasAuth: true },
    ]);
    assert.equal(JSON.stringify(list).includes('TOPSECRET'), false);
  });

  it('formats an empty list as a usage hint', () => {
    assert.deepEqual(formatServerList({}), ['  No MCP servers configured. Add one with /mcp add <name> <url>.']);
    assert.deepEqual(formatServerList(null), ['  No MCP servers configured. Add one with /mcp add <name> <url>.']);
  });

  it('marks servers with a saved auth header in the display lines', () => {
    const lines = formatServerList({
      s: { url: 'https://s.example/mcp', headers: { Authorization: 'Bearer X' } },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /s\s+https:\/\/s\.example\/mcp\s+\(auth header saved\)/);
    assert.equal(lines[0].includes('Bearer X'), false);
  });
});

describe('testMcpServer / reconnectMcpServers with a stubbed fetch', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Answers initialize + tools/list like a real MCP server would; a URL
  // that is not parseable at all throws, like the real fetch would.
  const stubFetch = (tools) => async (url, { body } = {}) => {
    if (String(url).includes('not-a-url')) throw new Error('Failed to parse URL: not-a-url');
    const { method } = JSON.parse(body);
    const result =
      method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.1.0' } }
        : { tools };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    };
  };

  it('reports ready with the tool list for a healthy server', async () => {
    globalThis.fetch = stubFetch([
      { name: 'gmail_search', description: 'Search Gmail', inputSchema: { type: 'object', properties: {} } },
      { name: 'send_mail' },
    ]);
    const out = await testMcpServer('stub', { url: 'https://stub.example/mcp' });
    assert.deepEqual(out, {
      name: 'stub',
      url: 'https://stub.example/mcp',
      ready: true,
      tools: ['gmail_search', 'send_mail'],
      error: null,
    });
  });

  it('reports not-ready with the error for a server that answers 500', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      text: async () => 'boom',
    });
    const out = await testMcpServer('down', { url: 'https://down.example/mcp' });
    assert.equal(out.ready, false);
    assert.deepEqual(out.tools, []);
    assert.match(out.error, /500/);
  });

  it('reports not-ready when fetch itself throws (unreachable host)', async () => {
    globalThis.fetch = async () => {
      throw new Error('fetch failed');
    };
    const out = await testMcpServer('gone', { url: 'https://gone.example/mcp' });
    assert.equal(out.ready, false);
    assert.match(out.error, /fetch failed/);
  });

  it('reconnects every configured server and keeps failures per-server', async () => {
    globalThis.fetch = stubFetch([{ name: 'ping' }]);
    const servers = await reconnectMcpServers({
      good: { url: 'https://good.example/mcp' },
      bad: { url: 'not-a-url' },
    });
    assert.equal(servers.length, 2);
    const good = servers.find((s) => s.name === 'good');
    const bad = servers.find((s) => s.name === 'bad');
    assert.equal(good.ready, true);
    assert.deepEqual(good.tools.map((t) => t.name), ['ping']);
    assert.equal(bad.ready, false);
    assert.match(bad.error, /parse URL|fetch failed|Invalid URL/);
  });
});
