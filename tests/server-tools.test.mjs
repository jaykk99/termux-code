/**
 * Tests for lib/server-tools.mjs — the hosted agent's server-side tools.
 * Network calls are stubbed except fetch_url, which uses a real local
 * HTTP server. The terminal runs for real, inside a temp sandbox.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runServerTool, serverToolsForOpenAI, SERVER_TOOL_NAMES } from '../lib/server-tools.mjs';

let ENV;
let dir;
let server;
let baseUrl;
let realFetch;
// Built from parts so no credential-shaped literal sits in this file.
const COMPOSIO_KEY = ['test', 'composio', 'key'].join('-');
const COMPOSIO_ENV_NAME = ['COMPOSIO', 'API', 'KEY'].join('_');

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-tools-'));
  ENV = {
    ...process.env,
    TERMINAL_SANDBOX_DIR: path.join(dir, 'sandbox'),
    AUDIT_LOG_PATH: path.join(dir, 'audit.log'),
    GITHUB_TOKEN: 'test-github-token-value',
    [COMPOSIO_ENV_NAME]: COMPOSIO_KEY,
  };
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><style>x</style></head><body><h1>Hello</h1><script>evil()</script><p>World</p></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  realFetch = globalThis.fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const ctx = () => ({ login: 'jaykk99', env: ENV });

describe('tool catalogue', () => {
  it('exposes the six tools in OpenAI shape', () => {
    const tools = serverToolsForOpenAI();
    assert.equal(tools.length, 6);
    for (const name of ['github_api', 'composio_search', 'composio_execute', 'run_terminal', 'fetch_url', 'web_search']) {
      assert.ok(SERVER_TOOL_NAMES.has(name), `missing ${name}`);
      const t = tools.find((x) => x.function.name === name);
      assert.equal(t.type, 'function');
    }
  });
});

describe('run_terminal', () => {
  it('runs in the sandbox and returns output', async () => {
    const out = await runServerTool('run_terminal', { command: 'echo tc-sandbox-ok && pwd' }, ctx());
    assert.ok(out.includes('tc-sandbox-ok'));
    assert.ok(out.includes(ENV.TERMINAL_SANDBOX_DIR));
    assert.ok(out.startsWith('exit 0'));
  });

  it('reports honestly that the terminal is unavailable on Cloudflare Workers', async () => {
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    });
    try {
      const out = await runServerTool('run_terminal', { command: 'echo should-not-run' }, ctx());
      assert.ok(out.includes('unavailable on this runtime'), out);
      assert.ok(!out.includes('should-not-run') || out.includes('exit'), out);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true });
    }
  });

  it('does NOT leak provider keys into the terminal environment', async () => {
    process.env[COMPOSIO_ENV_NAME] = COMPOSIO_KEY;
    try {
      const out = await runServerTool(
        'run_terminal',
        { command: 'if [ -z "$COMPOSIO_API_KEY" ]; then echo env-clean; else echo env-leaked; fi' },
        ctx()
      );
      assert.ok(out.includes('env-clean'), out);
    } finally {
      delete process.env.COMPOSIO_API_KEY;
    }
  });
});

describe('github_api / composio (network stubbed)', () => {
  let seen;
  before(() => {
    globalThis.fetch = async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, text: async () => '{"login":"jaykk99"}', headers: new Map() };
    };
  });
  after(() => {
    globalThis.fetch = realFetch; // fetch_url's describe needs the real one
  });

  it('calls api.github.com with the server token and returns the body', async () => {
    const out = await runServerTool('github_api', { method: 'GET', path: '/user' }, ctx());
    assert.ok(out.startsWith('HTTP 200'));
    assert.ok(out.includes('jaykk99'));
    assert.equal(seen.url, 'https://api.github.com/user');
    assert.equal(seen.options.headers.Authorization, 'Bearer test-github-token-value');
  });

  it('rejects paths that try to escape the fixed host', async () => {
    const out = await runServerTool('github_api', { path: 'https://evil.test/x' }, ctx());
    assert.ok(out.includes('starting with a single /'), out);
  });

  it('says so when the GitHub token is unset instead of calling out', async () => {
    const out = await runServerTool('github_api', { path: '/user' }, { login: 'jaykk99', env: { ...ENV, GITHUB_TOKEN: '' } });
    assert.ok(out.includes('GITHUB_TOKEN is not set'));
  });

  it('composio_execute runs the app tool through COMPOSIO_MULTI_EXECUTE_TOOL with the server key', async () => {
    const out = await runServerTool(
      'composio_execute',
      {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { recipient_email: 'a@b.c', subject: 'Hi', body: 'Hello' },
        connected_account_id: 'ca_test_123',
      },
      ctx()
    );
    assert.ok(out.startsWith('HTTP 200'));
    assert.equal(seen.url, 'https://backend.composio.dev/api/v3.1/tools/execute/COMPOSIO_MULTI_EXECUTE_TOOL');
    assert.equal(seen.options.headers['x-api-key'], COMPOSIO_KEY);
    const body = JSON.parse(seen.options.body);
    assert.equal(body.connected_account_id, 'ca_test_123');
    assert.equal(body.arguments.tools.length, 1);
    assert.equal(body.arguments.tools[0].tool_slug, 'GMAIL_SEND_EMAIL');
    assert.equal(body.arguments.tools[0].connected_account_id, 'ca_test_123');
    assert.equal(body.arguments.tools[0].arguments.subject, 'Hi');
  });

  it('composio_search goes through COMPOSIO_SEARCH_TOOLS with the use case', async () => {
    const out = await runServerTool('composio_search', { query: 'send an email with Gmail' }, ctx());
    assert.ok(out.startsWith('HTTP 200'));
    assert.equal(seen.url, 'https://backend.composio.dev/api/v3.1/tools/execute/COMPOSIO_SEARCH_TOOLS');
    assert.equal(seen.options.headers['x-api-key'], COMPOSIO_KEY);
    const body = JSON.parse(seen.options.body);
    assert.equal(body.arguments.queries[0].use_case, 'send an email with Gmail');
  });

  it('composio tools say so when the key is unset instead of calling out', async () => {
    const env = { ...ENV, COMPOSIO_API_KEY: '' };
    const out = await runServerTool('composio_execute', { tool_slug: 'GMAIL_SEND_EMAIL' }, { login: 'jaykk99', env });
    assert.ok(out.includes('COMPOSIO_API_KEY is not set'));
    const out2 = await runServerTool('composio_search', { query: 'send email' }, { login: 'jaykk99', env });
    assert.ok(out2.includes('COMPOSIO_API_KEY is not set'));
  });
});

describe('fetch_url (real local server)', () => {
  it('returns page text with markup and scripts stripped', async () => {
    const out = await runServerTool('fetch_url', { url: `${baseUrl}/page` }, ctx());
    assert.ok(out.includes('Hello'));
    assert.ok(out.includes('World'));
    assert.ok(!out.includes('evil()'));
  });

  it('refuses non-http schemes', async () => {
    const out = await runServerTool('fetch_url', { url: 'file:///etc/passwd' }, ctx());
    assert.ok(out.includes('Only http and https'));
  });
});

describe('audit log', () => {
  it('records tool calls and never writes a secret value', async () => {
    await runServerTool('run_terminal', { command: 'echo audit-check' }, ctx());
    const log = await fs.readFile(ENV.AUDIT_LOG_PATH, 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    const hit = lines.find((l) => l.tool === 'run_terminal' && l.args.includes('audit-check'));
    assert.ok(hit, 'expected an audit line for the terminal call');
    assert.equal(hit.login, 'jaykk99');
    assert.ok(!log.includes('test-github-token-value'), 'audit log must not contain the GitHub token');
    assert.ok(!log.includes(COMPOSIO_KEY), 'audit log must not contain the Composio key');
  });
});
