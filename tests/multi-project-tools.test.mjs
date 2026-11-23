import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool, TOOL_SCHEMA } from '../lib/tools.mjs';

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-multi-'));
  try { return await fn(root); } finally { await fs.rm(root, {recursive:true,force:true}); }
}
const ctx = root => ({root,approve:async()=>false});

test('project_map inventories modules without giant dependencies', async () => fixture(async root => {
  await fs.mkdir(path.join(root,'src'));
  await fs.mkdir(path.join(root,'node_modules'));
  await fs.writeFile(path.join(root,'src','entry.mjs'),'export const ok = true;\n');
  await fs.writeFile(path.join(root,'node_modules','noise.js'),'noise');
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
  const out=await runTool('project_map',{},ctx(root));
  assert.match(out,/src\/entry.mjs/);
  assert.match(out,/node --test/);
  assert.doesNotMatch(out,/noise.js/);
}));

test('read_files returns multiple real files and contains errors', async () => fixture(async root => {
  await fs.writeFile(path.join(root,'a.js'),'const one = 1;\n');
  await fs.writeFile(path.join(root,'b.js'),'const two = 2;\n');
  const out=await runTool('read_files',{paths:['a.js','missing.js','b.js']},ctx(root));
  assert.match(out,/a.js[\s\S]*const one/);
  assert.match(out,/missing.js: /);
  assert.match(out,/b.js[\s\S]*const two/);
  assert.match(out,/1: const one/);
}));

test('read_files rejects oversize batch and never reads outside workspace', async () => fixture(async root => {
  assert.match(await runTool('read_files',{paths:[]},ctx(root)),/1-8/);
  assert.match(await runTool('read_files',{paths:Array(9).fill('a')},ctx(root)),/1-8/);
  const out=await runTool('read_files',{paths:['../private.txt']},ctx(root));
  assert.match(out,/outside the workspace/);
  const names=TOOL_SCHEMA.map(t=>t.name);
  assert.ok(names.includes('project_map'));
  assert.ok(names.includes('read_files'));
}));
