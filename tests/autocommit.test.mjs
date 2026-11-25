import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitWorkspace } from '../lib/autocommit.mjs';

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

test('commitWorkspace commits the tree and then reports it clean', () => {
  const dir = tempDir('termux-commit-');
  try {
    initRepo(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const result = commitWorkspace(dir, { message: 'termux-code: test run' });
    assert.equal(result.committed, true);
    assert.match(result.sha, /^[0-9a-f]+$/);
    assert.ok(result.files.some((line) => line.includes('a.txt')));
    assert.equal(result.message, 'termux-code: test run');

    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(subject, 'termux-code: test run');

    const again = commitWorkspace(dir, { message: 'nothing' });
    assert.equal(again.committed, false);
    assert.equal(again.reason, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitWorkspace commits from a subdirectory of the repository', () => {
  const dir = tempDir('termux-commit-sub-');
  try {
    initRepo(dir);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    const sub = path.join(dir, 'src');
    execFileSync('mkdir', ['-p', sub]);
    writeFileSync(path.join(sub, 'x.js'), 'export const x = 1;\n');
    const result = commitWorkspace(sub, { message: 'termux-code: sub dir change' });
    assert.equal(result.committed, true);
    assert.equal(result.root, dir);
    assert.ok(result.files.some((line) => line.includes('src/x.js')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitWorkspace declines outside a git repository', () => {
  const dir = tempDir('termux-commit-plain-');
  try {
    const result = commitWorkspace(dir, { message: 'nope' });
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'not-a-repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('commitWorkspace reports a real git failure instead of claiming success', () => {
  const dir = tempDir('termux-commit-noid-');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    // No user.name/user.email anywhere: git refuses the commit. The helper
    // must surface that, not swallow it. Isolate the git config so a global
    // identity on the machine running the tests cannot make this pass.
    const result = commitWorkspace(dir, {
      message: 'termux-code: should fail',
      env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'error');
    assert.ok(result.detail && result.detail.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
