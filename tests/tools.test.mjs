/**
 * Tests for lib/tools.mjs — the phone's local tools, and specifically
 * the two ways grep used to hang the session:
 *   1. the grep tool readFile()d every non-directory entry, so a FIFO
 *      (or device/socket) in the tree blocked it forever — no timeout
 *      existed anywhere in that path;
 *   2. the bash tool's exec() left the child's stdin pipe open, so a
 *      bare `grep pattern` (no file target) waited on stdin until the
 *      60s command timeout killed it.
 * Both must now return promptly, and ordinary searches must still work.
 * Run: node --test tests/
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../lib/tools.mjs';

let root;
const approve = async () => true;
const ctx = () => ({ root, approve });

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-tools-'));
  await fs.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.writeFile(path.join(root, 'real.txt'), 'a needle in a haystack\nsecond line\n');
  await fs.writeFile(path.join(root, 'sub', 'deep.txt'), 'the needle is deep\n');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('grep tool', () => {
  it('finds matches in real files, including nested ones', async () => {
    const out = await runTool('grep', { pattern: 'needle' }, ctx());
    assert.match(out, /real\.txt:1: a needle in a haystack/);
    assert.match(out, /sub[/\\]deep\.txt:1: the needle is deep/);
  });

  it('returns promptly over a tree containing a FIFO (the old forever-hang)', async () => {
    execFileSync('mkfifo', [path.join(root, 'apipe')]);
    const started = Date.now();
    const out = await runTool('grep', { pattern: 'needle' }, ctx());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `grep took ${elapsed}ms over a FIFO tree — the hang is back`);
    assert.match(out, /real\.txt:1: a needle in a haystack/);
  });

  it('does not follow symlinks out of the tree or into cycles', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), 'needle outside the workspace\n');
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));
      await fs.symlink(root, path.join(root, 'sub', 'cycle'));
      const started = Date.now();
      const out = await runTool('grep', { pattern: 'needle' }, ctx());
      assert.ok(Date.now() - started < 10_000, 'grep hung on a symlink');
      assert.ok(!out.includes('outside the workspace'), out);
      assert.ok(!out.includes('linked.txt'), out);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('skips binary files instead of decoding them as text', async () => {
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2])]));
    const out = await runTool('grep', { pattern: 'needle' }, { root, approve });
    assert.ok(!out.includes('blob.bin'), out);
  });

  it('skips files over the size cap instead of reading them whole', async () => {
    await fs.writeFile(path.join(root, 'huge.txt'), 'needle ' + 'x'.repeat(1_100_000));
    const out = await runTool('grep', { pattern: 'needle' }, ctx());
    assert.ok(!out.includes('huge.txt'), out);
    assert.match(out, /real\.txt:1/);
  });

  it('reports no matches honestly', async () => {
    const out = await runTool('grep', { pattern: 'zzz-absent-zzz' }, ctx());
    assert.equal(out, 'No matches.');
  });
});

describe('bash tool stdin', () => {
  it('a bare grep with no file target returns at once, not after the 60s timeout', async () => {
    const started = Date.now();
    const out = await runTool('bash', { command: 'grep needle' }, ctx());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `bare grep took ${elapsed}ms — stdin is open again`);
    assert.ok(out.startsWith('exit 1'), out); // EOF on stdin: no match, exit 1
  });

  it('grep with a real file target still works through bash', async () => {
    const out = await runTool('bash', { command: 'grep needle real.txt' }, ctx());
    assert.ok(out.startsWith('exit 0'), out);
    assert.match(out, /needle in a haystack/);
  });

  it('piped commands still work', async () => {
    const out = await runTool('bash', { command: 'echo hello | grep hell' }, ctx());
    assert.ok(out.startsWith('exit 0'), out);
    assert.match(out, /hello/);
  });
});
