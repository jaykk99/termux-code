import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMA, runTool } from '../lib/tools.mjs';
import {
  RECON_TOOL, isReconIntent, reconSettings, runReconTool, validateReconUrl, withReconHint,
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
    for (const intent of ['hack my website', 'pentest staging.example', 'OSINT on a domain', 'scan site example.com', 'bug bounty scan', 'vulnerability assessment']) {
      assert.equal(isReconIntent(intent), true, intent);
    }
    assert.equal(isReconIntent('build a todo app'), false);
    const first = withReconHint('system', 'pentest our app');
    assert.match(first, /recon_anything tool/);
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

  it('shows a useful backend error instead of inventing findings', async () => {
    const message = await runReconTool({ action: 'health' }, {
      recon, fetch: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.match(message, /ReconAnything unavailable/);
    assert.match(message, /linux-start\.sh/);
    assert.doesNotMatch(message, /private-access-code/);
  });
});
