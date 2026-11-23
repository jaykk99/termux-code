import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGithubRepo, connectGithubRepo, resolveLocalRepo } from '../lib/repo-connector.mjs';

test('normalizes GitHub repository identifiers', () => {
  assert.deepEqual(parseGithubRepo('owner/project'), { owner:'owner', repo:'project', url:'https://github.com/owner/project.git' });
  assert.equal(parseGithubRepo('https://github.com/owner/project.git').repo, 'project');
  for (const bad of ['https://token@github.com/owner/repo', 'https://evil.com/owner/repo', '../repo', 'owner/repo/tree/main', 'https://github.com/owner/repo?token=x']) {
    assert.throws(() => parseGithubRepo(bad));
  }
});

test('clone requires approval and does not execute if declined', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tc-repo-'));
  let called = false;
  try {
    const result = await connectGithubRepo('owner/repo', { home, approve: async () => false,
      execFn: async () => { called = true; } });
    assert.equal(result.connected, false);
    assert.equal(called, false);
  } finally { await rm(home, { recursive:true, force:true }); }
});

test('connects a clone to a real working directory', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tc-repo-'));
  let cloneCount = 0;
  const execFn = async (_bin, args) => {
    if (args[0] === 'clone') {
      cloneCount++;
      assert.equal(args[2], 'https://github.com/owner/repo.git');
      await mkdir(args[3], { recursive:true });
      return {stdout:''};
    }
    if (args.includes('rev-parse')) return { stdout: path.join(home, '.termux-code', 'repos', 'owner', 'repo') + '\n' };
    throw new Error('unexpected invocation: ' + args.join(' '));
  };
  try {
    const first = await connectGithubRepo('owner/repo', {home, approve:async()=>true, execFn});
    assert.equal(first.connected, true);
    assert.equal(first.cloned, true);
    const second = await connectGithubRepo('owner/repo', {home, approve:async()=>true, execFn});
    assert.equal(second.cloned, false);
    assert.equal(cloneCount, 1);
  } finally { await rm(home, {recursive:true, force:true}); }
});
