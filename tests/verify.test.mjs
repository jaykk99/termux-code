/**
 * Tests for lib/verify.mjs — plan-and-verify: detect the project's own
 * check command, parse its outcome, and hand failures back to the model.
 * Run: node --test tests/verify.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WRITE_TOOLS,
  wroteFiles,
  pathsFromCall,
  detectVerifyCommand,
  exitCodeOf,
  tailForModel,
  failureMessage,
} from '../lib/verify.mjs';

describe('wroteFiles', () => {
  it('is true for write tools whose result reports a write', () => {
    for (const name of WRITE_TOOLS) {
      for (const result of ['Wrote src/a.js', 'Edited src/a.js', 'Created src/a.js', 'Patched src/a.js', 'Deleted src/a.js']) {
        assert.equal(wroteFiles(name, result), true, `${name}: ${result}`);
      }
    }
  });

  it('is false for read-only tools and for non-write results', () => {
    assert.equal(wroteFiles('read_file', 'Wrote src/a.js'), false);
    assert.equal(wroteFiles('bash', 'Wrote src/a.js'), false);
    assert.equal(wroteFiles('write_file', 'Failed: permission denied'), false);
    assert.equal(wroteFiles('write_file', ''), false);
    assert.equal(wroteFiles('write_file', null), false);
    // A lowercase "wrote" is not the tool's own success line.
    assert.equal(wroteFiles('write_file', 'wrote it'), false);
  });
});

describe('pathsFromCall', () => {
  it('returns the path for single-file tools', () => {
    assert.deepEqual(pathsFromCall({ name: 'write_file', args: { path: 'src/a.js' } }), ['src/a.js']);
    assert.deepEqual(pathsFromCall({ name: 'read_file', args: { path: 'src/a.js' } }), ['src/a.js']);
  });

  it('pulls every +++ path out of an apply_patch diff', () => {
    const patch = [
      '--- a/one.js',
      '+++ b/one.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/two.js',
      '+++ b/two.js',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    assert.deepEqual(pathsFromCall({ name: 'apply_patch', args: { patch } }), ['one.js', 'two.js']);
  });

  it('skips /dev/null (create/delete) and returns [] with no path', () => {
    const patch = '--- /dev/null\n+++ b/brand-new.js\n@@ -0,0 +1 @@\n+new\n';
    assert.deepEqual(pathsFromCall({ name: 'apply_patch', args: { patch } }), ['brand-new.js']);
    assert.deepEqual(pathsFromCall({ name: 'bash', args: { command: 'ls' } }), []);
    assert.deepEqual(pathsFromCall({}), []);
    assert.deepEqual(pathsFromCall(null), []);
  });
});

describe('detectVerifyCommand', () => {
  let root;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'termux-code-verify-'));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const subdir = async (name) => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  it('prefers npm test when the script is real', async () => {
    const dir = await subdir('npm-test');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(await detectVerifyCommand(dir), 'npm test');
  });

  it('ignores the npm-init placeholder test script', async () => {
    const dir = await subdir('placeholder');
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } })
    );
    assert.equal(await detectVerifyCommand(dir), 'npm run build');
  });

  it('falls through typecheck, check, lint, build in order', async () => {
    const dir = await subdir('fallthrough');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', build: 'vite build' } }));
    assert.equal(await detectVerifyCommand(dir), 'npm run lint');
  });

  it('finds make test', async () => {
    const dir = await subdir('make');
    await writeFile(path.join(dir, 'Makefile'), 'test:\n\tgo test ./...\n');
    assert.equal(await detectVerifyCommand(dir), 'make test');
  });

  it('does not mistake a Makefile without a test target', async () => {
    const dir = await subdir('make-no-test');
    await writeFile(path.join(dir, 'Makefile'), 'build:\n\tgo build\n');
    assert.equal(await detectVerifyCommand(dir), null);
  });

  it('finds pytest via pytest.ini, pyproject, or a tests dir', async () => {
    const a = await subdir('pytest-ini');
    await writeFile(path.join(a, 'pytest.ini'), '[pytest]\n');
    assert.equal(await detectVerifyCommand(a), 'python -m pytest -q');

    const b = await subdir('pytest-pyproject');
    await writeFile(path.join(b, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    assert.equal(await detectVerifyCommand(b), 'python -m pytest -q');

    const c = await subdir('pytest-tests-dir');
    await mkdir(path.join(c, 'tests'));
    await writeFile(path.join(c, 'tests', 'test_thing.py'), 'def test_x(): pass\n');
    assert.equal(await detectVerifyCommand(c), 'python -m pytest -q');
  });

  it('does not claim pytest for a pyproject without pytest', async () => {
    const dir = await subdir('pyproject-no-pytest');
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    assert.equal(await detectVerifyCommand(dir), null);
  });

  it('finds cargo and go projects', async () => {
    const c = await subdir('cargo');
    await writeFile(path.join(c, 'Cargo.toml'), '[package]\n');
    assert.equal(await detectVerifyCommand(c), 'cargo test');

    const g = await subdir('go');
    await writeFile(path.join(g, 'go.mod'), 'module example.com/x\n');
    assert.equal(await detectVerifyCommand(g), 'go test ./...');
  });

  it('returns null for an empty directory', async () => {
    const dir = await subdir('empty');
    assert.equal(await detectVerifyCommand(dir), null);
  });

  it('returns null for a nonexistent directory', async () => {
    assert.equal(await detectVerifyCommand(path.join(root, 'does-not-exist')), null);
  });
});

describe('exitCodeOf', () => {
  it('parses a leading "exit N" line', () => {
    assert.equal(exitCodeOf('exit 3\nsome output'), 3);
    assert.equal(exitCodeOf('exit 0'), 0);
    assert.equal(exitCodeOf('exit 127\ncommand not found'), 127);
  });

  it('maps a timeout to 124', () => {
    assert.equal(exitCodeOf('Command timed out after 60s'), 124);
    assert.equal(exitCodeOf('TIMED OUT'), 124);
  });

  it('defaults to 1 for anything else', () => {
    assert.equal(exitCodeOf('some failure'), 1);
    assert.equal(exitCodeOf(''), 1);
    assert.equal(exitCodeOf(null), 1);
  });
});

describe('tailForModel', () => {
  it('passes short output through untouched', () => {
    assert.equal(tailForModel('ok'), 'ok');
    assert.equal(tailForModel('x'.repeat(6000)), 'x'.repeat(6000));
  });

  it('keeps the tail of a long log and says how much was omitted', () => {
    const out = 'FAILURE HERE' + 'A'.repeat(5000) + 'B'.repeat(5000);
    const tail = tailForModel(out);
    assert.match(tail, /earlier characters omitted/);
    assert.ok(tail.endsWith('B'.repeat(1000)), 'ends with the log tail');
    assert.doesNotMatch(tail, /FAILURE HERE/);
    assert.ok(tail.length < out.length);
  });

  it('honours a custom limit', () => {
    assert.equal(tailForModel('1234567890', 5).endsWith('67890'), true);
  });
});

describe('failureMessage', () => {
  it('names the command, exit code, attempt, and changed files', () => {
    const msg = failureMessage('npm test', 'exit 1\nAssertionError: boom', 2, 3, new Set(['src/a.js', 'src/b.js']));
    assert.match(msg, /\[verify\] `npm test` failed \(exit 1\)/);
    assert.match(msg, /Attempt 2 of 3/);
    assert.match(msg, /src\/a\.js, src\/b\.js/);
    assert.match(msg, /AssertionError: boom/);
    assert.match(msg, /already failing/);
  });

  it('handles an empty changed set and a timeout', () => {
    const msg = failureMessage('make test', 'Command timed out after 60s', 1, 3, new Set());
    assert.match(msg, /exit 124/);
    assert.match(msg, /the project/);
  });
});
