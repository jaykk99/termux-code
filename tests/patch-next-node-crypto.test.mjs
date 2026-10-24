// Tests for scripts/patch-next-node-crypto.mjs, the build-time fix for
// the Cloudflare 1101 (`Dynamic require of "node:crypto" is not
// supported` at server boot). Uses temp files only; never touches the
// real node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patchFile, SHIM_MARKER } from '../scripts/patch-next-node-crypto.mjs';

const SHIM = `// ${SHIM_MARKER}\n// empty\n`;

function tempFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'termux-patch-test-'));
  const file = path.join(dir, 'node-crypto.js');
  writeFileSync(file, content);
  return file;
}

// Minimal stand-in for the real Next.js extension file: the unguarded
// require plus one patched function, mirroring the real file's shape.
const REAL_SHAPE = `import { io } from './utils';
if (process.env.NEXT_RUNTIME === 'edge') {
} else {
    const nodeCrypto = require('node:crypto');
    const _randomUUID = nodeCrypto.randomUUID;
}
`;

test('patchFile overwrites the extension with the shim', () => {
  const file = tempFile(REAL_SHAPE);
  assert.equal(patchFile(file, SHIM), 'patched');
  const after = readFileSync(file, 'utf8');
  assert.equal(after, SHIM);
  assert.doesNotMatch(after, /require\(['"]node:crypto['"]\)/);
});

test('patchFile is idempotent on an already-patched file', () => {
  const file = tempFile(SHIM);
  assert.equal(patchFile(file, SHIM), 'already-patched');
  assert.equal(readFileSync(file, 'utf8'), SHIM);
});

test('patchFile refuses unexpected content instead of patching blindly', () => {
  const file = tempFile('// something else entirely, no require here\n');
  assert.throws(() => patchFile(file, SHIM), /refusing to patch/);
  assert.equal(
    readFileSync(file, 'utf8'),
    '// something else entirely, no require here\n'
  );
});

test('patchFile throws when the target file is missing', () => {
  assert.throws(
    () => patchFile('/definitely/not/a/real/path/node-crypto.js', SHIM),
    /not found/
  );
});
