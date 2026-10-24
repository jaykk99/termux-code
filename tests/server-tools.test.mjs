/**
 * Tests for lib/server-tools.mjs — the hosted chatbot's server-side tools.
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

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-tools-'));
  ENV = {
    ...process.env,
    TERMINAL_SANDBOX_DIR: path.join(dir, 'sandbox'),
    AUDIT_LOG_PATH: path.join(dir, 'audit.log'),
    GITHUB_TOKEN: 'test-github-token-value',
    VENICE_API_KEY: '<redacted>',
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
  it('exposes the seven tools in OpenAI shape', () => {
    const tools = serverToolsForOpenAI();
    assert.equal(tools.length, 7);
    for (const name of ['github_api', 'venice_api', 'run_terminal', 'fetch_url', 'web_search', 'list_skills', 'read_skill']) {
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

  it('does NOT leak provider keys into the terminal environment', async () => {
    process.env.VENICE_API_KEY = '<redacted>';
    try {
      const out = await runServerTool(
        'run_terminal',
        { command: 'if [ -z "$VENICE_API_KEY" ]; then echo env-clean; else echo env-leaked; fi' },
        ctx()
      );
      assert.ok(out.includes('env-clean'), out);
    } finally {
      delete process.env.VENICE_API_KEY;
    }
  });
});

describe('github_api / venice_api (network stubbed)', () => {
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

  it('calls api.venice.ai under /api/v1 with the server key', async () => {
    const out = await runServerTool('venice_api', { method: 'GET', path: '/models' }, ctx());
    assert.ok(out.startsWith('HTTP 200'));
    assert.equal(seen.url, 'https://api.venice.ai/api/v1/models');
    assert.equal(seen.options.headers.Authorization, 'Bearer <redacted>');
  });

  it('rejects paths that try to escape the fixed host', async () => {
    const out = await runServerTool('github_api', { path: 'https://evil.test/x' }, ctx());
    assert.ok(out.includes('starting with a single /'), out);
  });

  it('says so when the GitHub token is unset instead of calling out', async () => {
    const out = await runServerTool('github_api', { path: '/user' }, { login: 'jaykk99', env: { ...ENV, GITHUB_TOKEN: '' } });
    assert.ok(out.includes('GITHUB_TOKEN is not set'));
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

describe('skills tools', () => {
  it('list_skills names the vendored Venice skills', async () => {
    const out = await runServerTool('list_skills', {}, ctx());
    assert.ok(out.includes('venice-chat'));
  });

  it('read_skill returns the skill body; unknown names say so', async () => {
    const out = await runServerTool('read_skill', { name: 'venice-errors' }, ctx());
    assert.ok(out.includes('402'));
    const missing = await runServerTool('read_skill', { name: 'venice-nope' }, ctx());
    assert.ok(missing.includes('No skill named'));
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
    assert.ok(!log.includes('test-venice-key'), 'audit log must not contain the Venice key');
  });
});
