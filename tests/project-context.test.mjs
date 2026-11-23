import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readProjectMemory, projectInstructions, applyProjectInstructions } from '../lib/project-context.mjs';

describe('project-scoped instructions', () => {
  it('keeps memory separate for two repositories', async () => {
    const a = await mkdtemp(path.join(os.tmpdir(), 'tc-proj-a-'));
    const b = await mkdtemp(path.join(os.tmpdir(), 'tc-proj-b-'));
    try {
      await writeFile(path.join(a, 'MEMORY.md'), 'Project A uses Python.');
      await writeFile(path.join(b, 'MEMORY.md'), 'Project B uses JavaScript.');
      assert.match(await projectInstructions(a), /Project A uses Python/);
      assert.doesNotMatch(await projectInstructions(b), /Project A uses Python/);
      assert.match(await projectInstructions(b), /Project B uses JavaScript/);
    } finally { await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
  });
  it('does not fail for an absent memory file', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'tc-no-memory-'));
    try { assert.equal(await readProjectMemory(d), ''); } finally { await rm(d, { recursive: true, force: true }); }
  });
  it('replaces stale session context instead of duplicating it', () => {
    const msgs = [{ role: 'system', content: 'Old project data' }, { role: 'user', content: 'continue' }];
    applyProjectInstructions(msgs, 'Base', '\nNew project data');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, 'Base\nNew project data');
    applyProjectInstructions(msgs, 'Base', '\nNew project data');
    assert.equal(msgs.length, 2);
  });
  it('truncates memory before injection', async () => {
    const d = await mkdtemp(path.join(os.tmpdir(), 'tc-big-memory-'));
    try {
      await writeFile(path.join(d, 'MEMORY.md'), 'x'.repeat(17000));
      assert.equal((await readProjectMemory(d)).length, 12000);
    } finally { await rm(d, { recursive: true, force: true }); }
  });
});
