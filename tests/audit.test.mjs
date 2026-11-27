/**
 * Tests for lib/audit.mjs — the secret-scrubbing audit log for the
 * hosted chatbot's server-side tools.
 * Run: node --test tests/audit.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditPath, audit } from '../lib/audit.mjs';

describe('auditPath', () => {
  it('defaults under the working directory', () => {
    assert.equal(auditPath({}), path.join(process.cwd(), '.data', 'audit.log'));
  });

  it('honours AUDIT_LOG_PATH', () => {
    assert.equal(auditPath({ AUDIT_LOG_PATH: '/tmp/x/audit.log' }), '/tmp/x/audit.log');
  });
});

describe('audit', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'termux-code-audit-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const envFor = (name) => ({ AUDIT_LOG_PATH: path.join(dir, name) });

  it('appends one JSON line per event, with a timestamp', async () => {
    const env = envFor('a.log');
    await audit({ owner: 'jaykk99', tool: 'run_terminal', command: 'ls', ok: true }, env);
    await audit({ owner: 'jaykk99', tool: 'fetch_url', url: 'https://example.com', ok: false }, env);
    const lines = (await readFile(env.AUDIT_LOG_PATH, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.owner, 'jaykk99');
    assert.equal(first.tool, 'run_terminal');
    assert.equal(first.command, '[omitted]');
    assert.equal(first.ok, true);
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('creates parent directories as needed', async () => {
    const env = { AUDIT_LOG_PATH: path.join(dir, 'deep', 'nested', 'audit.log') };
    await audit({ tool: 'x' }, env);
    const lines = (await readFile(env.AUDIT_LOG_PATH, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
  });

  it('scrubs credential-smelling keys at any depth', async () => {
    const env = envFor('scrub.log');
    await audit({
      tool: 'github_api',
      token: 'ghp_should-never-appear',
      api_key: 'also-secret',
      password: 'hunter2',
      Authorization: 'Bearer sekrit',
      nested: { secret: 'deep-secret', safe: 'visible', list: [{ credential: 'c', ok: 'yes' }] },
      safeField: 'still here',
    }, env);
    const line = (await readFile(env.AUDIT_LOG_PATH, 'utf8')).trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.token, '[redacted]');
    assert.equal(parsed.api_key, '[redacted]');
    assert.equal(parsed.password, '[redacted]');
    assert.equal(parsed.Authorization, '[redacted]');
    assert.equal(parsed.nested.secret, '[redacted]');
    assert.equal(parsed.nested.safe, 'visible');
    assert.equal(parsed.nested.list[0].credential, '[redacted]');
    assert.equal(parsed.nested.list[0].ok, 'yes');
    assert.equal(parsed.safeField, 'still here');
    assert.doesNotMatch(line, /should-never-appear|also-secret|hunter2|sekrit|deep-secret/);
  });

  it('never throws, even when the log path is unwritable', async () => {
    // A real file where a directory is expected: mkdir fails, audit swallows it.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'i am a file, not a directory', 'utf8');
    await audit({ tool: 'x' }, { AUDIT_LOG_PATH: path.join(blocker, 'audit.log') });
    // And with a read-only parent the append itself fails — still no throw.
    await audit({ tool: 'x' }, { AUDIT_LOG_PATH: '/proc/1/audit.log' });
  });
});

