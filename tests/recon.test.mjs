import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMA, runTool } from '../lib/tools.mjs';
import {
  RECON_TOOL, discoverReconSettings, isReconIntent, reconSettings, runReconTool, validateReconUrl, withReconHint,
} from '../lib/recon.mjs';

const recon = { enabled: true, url: 'http://127.0.0.1:8000', code: 'private-access-code' };
const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

describe('ReconAnything routing', () => {
  it('is a native agent tool, including on gateway models', () => {
    const tool = TOOL_SCHEMA.find((t) => t.name === 'recon_anything');
    assert.deepEqual(tool, RECON_TOOL);
    assert.ok(tool.parameters.properties.authorized);
  });

  it('detects security intents and keeps the prompt note idempotent', () => {
    for (const intent of [
      'hack my website', 'pentest staging.example', 'OSINT on a domain',
      'scan site example.com', 'bug bounty scan', 'vulnerability assessment',
      // Phrasings that used to miss the hint, so the model answered that it
      // could not scan even though recon_anything was in its tool list.
      'scan example.com', 'scan my site example.com', 'run a scan on example.com',
      'use reconanything on staging.example', 'use recon-anything to check this host',
      'what did the last scan find?', 'show me the latest recon findings',
    ]) {
      assert.equal(isReconIntent(intent), true, intent);
    }
    assert.equal(isReconIntent('build a todo app'), false);
    assert.equal(isReconIntent('scan the codebase for TODOs'), false, 'a code search is not a recon scan');
    const first = withReconHint('system', 'pentest our app');
    assert.match(first, /recon_anything tool/);
    // The hint must name the capability-list refusal, or a model answers
    // "my capabilities are limited to…" instead of calling the tool.
    assert.match(first, /Never answer a security request with a refusal/);
    assert.match(first, /capability list/);
    assert.equal(withReconHint(first, 'pentest again'), first);
    assert.equal(withReconHint(first, 'build an app'), 'system');
  });

  it('uses environment config first and validates endpoints', () => {
    assert.deepEqual(reconSettings({ reconApiUrl: 'http://localhost:9000', reconAccessCode: 'cfg' }, {}), {
      enabled: true, url: 'http://localhost:9000', code: 'cfg',
    });
    assert.equal(reconSettings({ reconDisabled: true }, {}).enabled, false);
    assert.equal(reconSettings({ reconApiUrl: 'http://localhost:9000' }, { RECON_API_URL: 'https://example.com', RECON_ACCESS_CODE: 'env' }).url, 'https://example.com');
    assert.equal(validateReconUrl('http://192.168.1.30:8000/'), 'http://192.168.1.30:8000');
    assert.throws(() => validateReconUrl('http://public.example:8000'), /Plain HTTP/);
    assert.throws(() => validateReconUrl('https://user:pass@example.com'), /without credentials/);
    assert.throws(() => validateReconUrl('http://127.0.0.1:8000/api/runs'), /origin/);
  });

  it('automatically reads the local installed backend code only for loopback URLs', async () => {
    const seen = [];
    const readFile = async (file) => {
      seen.push(file);
      if (file.includes('recon-anything/.local-access-code')) return 'auto-local-code\n';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const discovered = await discoverReconSettings({}, {}, { home: '/tmp/fake-home', readFile });
    assert.equal(discovered.code, 'auto-local-code');
    assert.ok(seen[0].includes('recon-anything'));
    const remote = await discoverReconSettings({ reconApiUrl: 'https://recon.example.com' }, {}, {
      home: '/tmp/fake-home',
      readFile: async () => { throw new Error('must not read local code for remote server'); },
    });
    assert.equal(remote.code, '');
    const explicit = await discoverReconSettings({ reconAccessCode: 'manual' }, {}, {
      readFile: async () => { throw new Error('must not read code when configured'); },
    });
    assert.equal(explicit.code, 'manual');
  });

  it('checks health and sends the owner code in a header, never in the URL', async () => {
    const calls = [];
    const result = await runTool('recon_anything', { action: 'health' }, {
      root: '.', recon, fetch: async (url, options) => {
        calls.push({ url, options });
        return ok({ ok: true });
      },
    });
    assert.match(result, /"connected": true/);
    assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/health');
    assert.equal(calls[0].options.headers['X-Access-Code'], 'private-access-code');
    assert.doesNotMatch(calls[0].url, /private-access-code/);
  });

  it('never starts unconfirmed or unenabled active scanning', async () => {
    let count = 0;
    const ctx = {
      recon, reconActive: false, approve: async () => true,
      fetch: async () => { count++; return ok({ run_id: 'ok' }); },
    };
    const unauthorized = await runReconTool({ action: 'start_scan', targets: 'example.com' }, ctx);
    assert.match(unauthorized, /confirm they own/);
    const active = await runReconTool({ action: 'start_scan', targets: 'example.com', authorized: true, mode: 'active' }, ctx);
    assert.match(active, /\/recon active on/);
    assert.equal(count, 0);
  });

  it('starts a passive scan, polls status and fetches filtered findings', async () => {
    const calls = [];
    const ctx = {
      recon, reconActive: false, approve: async () => true,
      fetch: async (url, options) => {
        calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
        if (url.endsWith('/api/runs')) return ok({ run_id: 'uuid-123' });
        return ok({ run: { id: 'uuid-123', status: 'finished' }, progress: { percent: 100 },
          executive_summary: 'summary', findings: [
            { severity: 'high', title: 'A' }, { severity: 'low', title: 'B' },
          ] });
      },
    };
    const start = await runReconTool({ action: 'start_scan', targets: 'example.com', authorized: true }, ctx);
    assert.match(start, /uuid-123/);
    assert.equal(calls[0].body.mode, 'passive');
    assert.equal(calls[0].body.targets, 'example.com');
    const status = await runReconTool({ action: 'scan_status', run_id: 'uuid-123' }, ctx);
    assert.match(status, /finished/);
    const findings = JSON.parse(await runReconTool({ action: 'findings', run_id: 'uuid-123', severity: 'high', limit: 2 }, ctx));
    assert.equal(findings.total_matching, 1);
    assert.equal(findings.findings[0].title, 'A');
    assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/runs/uuid-123');
  });

  it('rejects invalid actions and missing targets without network requests', async () => {
    let count = 0;
    const ctx = { recon, fetch: async () => { count++; throw new Error('unexpected request'); } };
    assert.match(await runReconTool({ action: 'subdomain_enumeration' }, ctx), /Do not retry an unsupported action/);
    assert.match(await runReconTool({ action: 'start_scan' }, ctx), /exact authorized target/);
    assert.match(await runReconTool({ action: 'start_scan', targets: 'example.com' }, ctx), /Do not retry until the user confirms/);
    assert.equal(count, 0);
  });

  it('redacts backend response details and advises stopping failed attempts', async () => {
    const result = await runReconTool({ action: 'health' }, {
      recon, fetch: async () => new Response('private-access-code', { status: 401 }),
    });
    assert.match(result, /authentication or permission rejected/);
    assert.match(result, /Stop scan attempts/);
    assert.doesNotMatch(result, /private-access-code/);
  });

  it('shows a useful backend error instead of inventing findings', async () => {
    const message = await runReconTool({ action: 'health' }, {
      recon, fetch: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.match(message, /ReconAnything unavailable/);
    assert.match(message, /linux-start\.sh/);
    assert.doesNotMatch(message, /private-access-code/);
  });
});
