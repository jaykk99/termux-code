/**
 * Tests for lib/token-store-fs.mjs — the filesystem gateway-token store
 * (Node and tests only; the worker uses the KV branch instead).
 * Run: node --test tests/token-store-fs.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultStorePath, fsReadStore, fsWriteStore } from '../lib/token-store-fs.mjs';

describe('defaultStorePath', () => {
  it('points at .data/gateway-tokens.json under the cwd', () => {
    assert.equal(defaultStorePath(), path.join(process.cwd(), '.data', 'gateway-tokens.json'));
  });
});

describe('fsReadStore / fsWriteStore', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'termux-code-tokens-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads an empty store for a missing file', async () => {
    assert.deepEqual(await fsReadStore(path.join(dir, 'missing.json')), { tokens: [] });
  });

  it('reads an empty store for malformed JSON', async () => {
    const file = path.join(dir, 'bad.json');
    await writeFile(file, '{not json', 'utf8');
    assert.deepEqual(await fsReadStore(file), { tokens: [] });
  });

  it('reads an empty store when tokens is not an array', async () => {
    const file = path.join(dir, 'wrong-shape.json');
    await writeFile(file, JSON.stringify({ tokens: 'nope' }), 'utf8');
    assert.deepEqual(await fsReadStore(file), { tokens: [] });
  });

  it('reads an empty store for a JSON array at the top level', async () => {
    const file = path.join(dir, 'array.json');
    await writeFile(file, JSON.stringify([{ hash: 'abc' }]), 'utf8');
    assert.deepEqual(await fsReadStore(file), { tokens: [] });
  });

  it('round-trips a token document', async () => {
    const file = path.join(dir, 'tokens.json');
    const doc = { tokens: [{ hash: 'abc', created: '2026-11-20', label: 'phone' }] };
    await fsWriteStore(file, doc);
    assert.deepEqual(await fsReadStore(file), doc);
    // The file on disk is pretty-printed JSON.
    assert.match(await readFile(file, 'utf8'), /\n  "tokens"/);
  });

  it('overwrites a previous document on write', async () => {
    const file = path.join(dir, 'overwrite.json');
    await fsWriteStore(file, { tokens: [{ hash: 'one' }] });
    await fsWriteStore(file, { tokens: [{ hash: 'two' }, { hash: 'three' }] });
    assert.deepEqual(await fsReadStore(file), { tokens: [{ hash: 'two' }, { hash: 'three' }] });
  });

  it('creates parent directories on write', async () => {
    const file = path.join(dir, 'deep', 'nested', 'tokens.json');
    await fsWriteStore(file, { tokens: [] });
    assert.deepEqual(await fsReadStore(file), { tokens: [] });
  });
});
