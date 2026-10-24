import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteContent,
  hasBuiltinRequire,
  CHILD_PROCESS_SHIM,
} from '../scripts/rewrite-worker-requires.mjs';

test('rewrites builtin requires to ESM imports, leaves other requires alone', () => {
  const input = [
    'import { handler } from "./server.js";',
    'const a = require("node:fs");',
    "const b = require('path');",
    'const c = require("node:fs/promises");',
    'const d = require("@builder.io/partytown/integration");',
    'export { handler };',
  ].join('\n');
  const { content, counts, nonBuiltins, changed } = rewriteContent(input, 'test.mjs');
  assert.equal(changed, true);
  assert.equal(counts.get('node:fs'), 1);
  assert.equal(counts.get('node:path'), 1);
  assert.equal(counts.get('node:fs/promises'), 1);
  assert.deepEqual([...nonBuiltins], ['@builder.io/partytown/integration']);
  assert.match(content, /import \* as __termux_node_fs from "node:fs";/);
  assert.match(content, /import \* as __termux_node_path from "node:path";/);
  assert.match(content, /import \* as __termux_node_fs_promises from "node:fs\/promises";/);
  assert.match(content, /const a = __termux_node_fs;/);
  assert.match(content, /const b = __termux_node_path;/);
  assert.match(content, /const c = __termux_node_fs_promises;/);
  assert.match(content, /require\("@builder\.io\/partytown\/integration"\)/);
  assert.equal(hasBuiltinRequire(content), false);
});

test('child_process requires are rerouted to the shim, not imported', () => {
  const input = [
    'import { handler } from "./server.js";',
    'const cp = require("node:child_process");',
    'export { handler };',
  ].join('\n');
  const { content, counts, changed, shimNeeded } = rewriteContent(input, 'test.mjs');
  assert.equal(changed, true);
  assert.equal(shimNeeded, true);
  assert.equal(counts.get('__termux_child_process_shim'), 1);
  assert.match(content, /import \* as __termux_child_process_shim from "\.\/__termux_child_process_shim\.mjs";/);
  assert.match(content, /const cp = __termux_child_process_shim;/);
  assert.equal(hasBuiltinRequire(content), false);
  assert.match(CHILD_PROCESS_SHIM, /child_process is unavailable in Cloudflare Workers/);
});

test('rewrite is idempotent: a second pass changes nothing', () => {
  const input = [
    'import { handler } from "./server.js";',
    'const a = require("node:fs");',
    'export { handler };',
  ].join('\n');
  const first = rewriteContent(input, 'test.mjs');
  const second = rewriteContent(first.content, 'test.mjs');
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test('files without builtin requires are untouched', () => {
  const input = 'import { handler } from "./server.js";\nexport { handler };\n';
  const { changed, content } = rewriteContent(input, 'test.mjs');
  assert.equal(changed, false);
  assert.equal(content, input);
});

test('builtin require in a non-ESM file fails loudly instead of corrupting it', () => {
  const input = 'const fs = require("node:fs");\nmodule.exports = fs;\n';
  assert.throws(() => rewriteContent(input, 'test.cjs'), /does not look like an ESM file/);
});

test('generated identifiers avoid collisions with existing names', () => {
  const input = [
    'import { handler } from "./server.js";',
    'const __termux_node_fs = 1;',
    'const a = require("node:fs");',
    'export { handler };',
  ].join('\n');
  const { content } = rewriteContent(input, 'test.mjs');
  assert.match(content, /import \* as __termux_node_fs_2 from "node:fs";/);
  assert.match(content, /const a = __termux_node_fs_2;/);
  assert.equal(hasBuiltinRequire(content), false);
});
