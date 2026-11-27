import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSession, verifySession, parseCookies, gatewayAccess, verifyGatewayToken } from '../lib/auth.mjs';
import { audit } from '../lib/audit.mjs';
import { fsWriteStore, fsReadStore } from '../lib/token-store-fs.mjs';
import { logRequest, readJSON } from '../lib/http.mjs';

const env = { OWNER_GITHUB_LOGIN: 'owner', SESSION_SECRET: 'test-only' };
test('malformed cookies do not crash authentication and duplicate names do not override', async () => {
  const token = createSession('owner', env);
  const req = new Request('https://example.test', { headers: { cookie: 'bad=%ZZ; tc_session=' + token } });
  assert.equal((await gatewayAccess(req, env)).login, 'owner');
  assert.equal(parseCookies('a=first; a=second').a, 'first');
  assert.equal(Object.getPrototypeOf(parseCookies('__proto__=ignored')), null);
  assert.equal(verifySession(token + '.extra', env), null);
});
test('legacy tokens must match the current owner and verification is read-only', async () => {
  const token = 'tc_test_legacy';
  let writes = 0;
  const doc = { tokens: [{ hash: createHash('sha256').update(token).digest('hex'), login: 'old-owner' }] };
  const kv = { get: async () => JSON.stringify(doc), put: async () => { writes++; } };
  assert.equal(await verifyGatewayToken(token, { ...env, GATEWAY_KV: kv }), null);
  doc.tokens[0].login = 'owner';
  assert.deepEqual(await verifyGatewayToken(token, { ...env, GATEWAY_KV: kv }), { login: 'owner' });
  assert.equal(writes, 0);
});
test('audit excludes raw arguments and token store uses private atomic files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-security-'));
  try {
    const log = path.join(dir, 'audit.log');
    await audit({ tool: 'test', args: 'arbitrary sensitive input', nested: { cookie: 'fake-cookie' }, ok: true }, { AUDIT_LOG_PATH: log });
    const data = await readFile(log, 'utf8');
    assert.doesNotMatch(data, /arbitrary sensitive input|fake-cookie/);
    assert.equal(JSON.parse(data).tool, 'test');
    if (process.platform !== 'win32') assert.equal((await stat(log)).mode & 0o777, 0o600);
    const file = path.join(dir, 'tokens.json');
    await fsWriteStore(file, { tokens: [] });
    assert.deepEqual(await fsReadStore(file), { tokens: [] });
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('request logs exclude arbitrary extra input', () => {
  const lines = [];
  const original = console.log;
  try {
    console.log = value => lines.push(value);
    logRequest(new Request('https://example.test/api'), 200, 5, 'sensitive test value');
  } finally { console.log = original; }
  assert.doesNotMatch(lines.join(' '), /sensitive test value/);
});
test('oversized body cancels stream and returns 413', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } });
  const req = new Request('https://example.test/api', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readJSON(req, { maxBytes: 8 }), e => e.status === 413);
  assert.equal(cancelled, true);
});

test('local defensive audit flags insecure files, skips templates and never follows symlinks', async () => {
  const { auditWorkspace } = await import('../lib/security-audit.mjs');
  const { writeFile, chmod, symlink, mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-workspace-'));
  try {
    const workspace = path.join(dir, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, '.env'), 'secret-marker');
    await chmod(path.join(workspace, '.env'), 0o644);
    await writeFile(path.join(workspace, '.env.example'), 'template');
    await writeFile(path.join(workspace, 'package.json'), '{}');
    await writeFile(path.join(dir, 'private.key'), 'outside-marker');
    await symlink(dir, path.join(workspace, 'outside'));
    const report = await auditWorkspace(workspace);
    assert.ok(report.findings.some(f => f.rule === 'CREDENTIAL_FILE_PERMISSIONS' && f.path === '.env'));
    assert.ok(report.findings.some(f => f.rule === 'MISSING_DEPENDENCY_LOCK'));
    assert.ok(report.findings.some(f => f.rule === 'SYMLINK_REVIEW'));
    assert.doesNotMatch(JSON.stringify(report), /secret-marker|outside-marker|private\.key|\.env\.example/);
    assert.equal((await auditWorkspace(workspace, { maxEntries: 1 })).truncated, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new signed tokens have bounded configurable lifetimes', async () => {
  const { issueGatewayToken, verifyGatewayToken, gatewayTokenTtlMs } = await import('../lib/auth.mjs');
  const day = 86400000;
  assert.equal(gatewayTokenTtlMs({}), 30 * day);
  for (const bad of ['0','91','1.5','abc','-1']) assert.equal(gatewayTokenTtlMs({GATEWAY_TOKEN_TTL_DAYS:bad}), 30 * day);
  const cfg = {...env,GATEWAY_TOKEN_TTL_DAYS:'2'};
  const now = 1700000000000;
  const token = await issueGatewayToken('owner',cfg,now);
  assert.ok(await verifyGatewayToken(token,cfg,now+2*day-1));
  assert.equal(await verifyGatewayToken(token,cfg,now+2*day),null);
});
test('audit counts every finding even when the detail list is capped', async () => {
  const { auditWorkspace } = await import('../lib/security-audit.mjs');
  const { writeFile, chmod, symlink, mkdir } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'tc-audit-counts-'));
  try {
    const sub = path.join(dir,'sub');
    await mkdir(sub);
    for (let i=0;i<55;i++) await symlink(sub,path.join(dir,'link-'+i));
    await writeFile(path.join(sub,'.env'),'fake-fixture');
    await chmod(path.join(sub,'.env'),0o644);
    const report=await auditWorkspace(dir);
    assert.equal(report.severityCounts.high,1);
    assert.equal(report.severityCounts.info,55);
    assert.equal(report.findings.length,50);
    assert.equal(report.omittedFindings,6);
    assert.ok(report.findings.some(f=>f.severity==='high'));
  } finally {await rm(dir,{recursive:true,force:true});}
});
