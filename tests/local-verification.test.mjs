import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyLocalProject } from '../lib/local-verification.mjs';

test('automatically checks supported local files without executing code',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-verify-'));
  try {
    await mkdir(path.join(root,'src'));
    await writeFile(path.join(root,'package.json'),'{}');
    await writeFile(path.join(root,'src','valid.mjs'),'throw new Error("must not execute");');
    await writeFile(path.join(root,'src','broken.cjs'),'const = ;');
    await mkdir(path.join(root,'node_modules'));
    await writeFile(path.join(root,'node_modules','ignored.mjs'),'const = ;');
    await symlink(path.join(root,'src','broken.cjs'),path.join(root,'linked.mjs'));
    const result=await verifyLocalProject(root);
    assert.equal(result.complete,true);
    assert.equal(result.ok,false);
    assert.equal(result.checked,3);
    assert.equal(result.failed,1);
    assert.equal(result.checks.find(c=>c.path==='src/valid.mjs').status,'passed');
    assert.equal(result.checks.find(c=>c.path==='src/broken.cjs').status,'failed');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('does not claim success on empty or unsupported workspaces',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-empty-'));
  try {
    const result=await verifyLocalProject(root);
    assert.equal(result.complete,false);
    assert.equal(result.ok,false);
    assert.equal(result.stopReason,'no_supported_files');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('valid manifests and explicit module syntax pass',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-good-'));
  try {
    await writeFile(path.join(root,'package.json'),'{"name":"fixture"}');
    await writeFile(path.join(root,'main.cjs'),'module.exports = 1;');
    const result=await verifyLocalProject(root);
    assert.equal(result.ok,true);
    assert.equal(result.checked,2);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('checks ordinary JS using nearest explicit package type',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-js-scope-'));
  try {
    await writeFile(path.join(root,'package.json'),'{"type":"module"}');
    await mkdir(path.join(root,'nested'));
    await writeFile(path.join(root,'nested','module.js'),'export const x = 1;');
    await mkdir(path.join(root,'common'));
    await writeFile(path.join(root,'common','package.json'),'{"type":"commonjs"}');
    await writeFile(path.join(root,'common','bad.js'),'export const x = 1;');
    const result=await verifyLocalProject(root);
    assert.equal(result.complete,true);
    assert.equal(result.failed,1);
    assert.equal(result.checks.find(c=>c.path==='nested/module.js').status,'passed');
    assert.equal(result.checks.find(c=>c.path==='common/bad.js').status,'failed');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('ambiguous JS files cannot silently pass as verified',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-js-ambiguous-'));
  try {
    await writeFile(path.join(root,'package.json'),'{}');
    await writeFile(path.join(root,'index.js'),'const x = 1;');
    const result=await verifyLocalProject(root);
    assert.equal(result.complete,false);
    assert.equal(result.ok,false);
    assert.equal(result.checks.find(c=>c.path==='index.js').status,'ambiguous_module_mode');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('reports excluded, unsupported and linked entries separately from checked files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'tc-skip-counts-'));
  try {
    await writeFile(path.join(root,'main.mjs'),'export const x = 1;');
    await writeFile(path.join(root,'view.jsx'),'not checked');
    await writeFile(path.join(root,'.hidden.mjs'),'not checked');
    await mkdir(path.join(root,'node_modules'));
    await symlink(path.join(root,'main.mjs'),path.join(root,'link.mjs'));
    const result=await verifyLocalProject(root);
    assert.equal(result.complete,true);
    assert.equal(result.checked,1);
    assert.deepEqual(result.skipped,{excluded:2,symlinks:1,unsupportedFiles:1,specialFiles:0});
  } finally {await rm(root,{recursive:true,force:true});}
});
