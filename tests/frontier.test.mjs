/**
 * Tests for the frontier tools (lib/frontier.mjs) and their registration in
 * lib/tools.mjs, plus the two REPL commands that pair with them (/map, /undo).
 *
 * Each test works in its own temp directory, because half of these tools
 * mutate the tree. Nothing here touches the network: the HTTP tests run a
 * throwaway server on 127.0.0.1, and the git tests init a repo locally.
 *
 * Run: node --test tests/frontier.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runTool, TOOL_SCHEMA, toolsForOpenAI, toolsForAnthropic } from '../lib/tools.mjs';
import {
  globMatcher,
  parseJsonPath,
  jsonPathGet,
  unifiedDiff,
  splitArgs,
  parseProcNet,
  memoryNote,
  withMemory,
} from '../lib/frontier.mjs';
import { HELP } from '../bin/termux-code.mjs';

const NEW_TOOLS = [
  'glob',
  'read_range',
  'file_info',
  'outline',
  'repo_map',
  'move_file',
  'delete_file',
  'make_dir',
  'diff_files',
  'git',
  'http_request',
  'download_file',
  'json_query',
  'todo',
  'remember',
  'checkpoint',
  'ports',
  'sysinfo',
];

let root;
const approve = async () => true;
const ctx = (overrides = {}) => ({ root, approve, ...overrides });

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-frontier-test-'));
  await fs.mkdir(path.join(root, 'src', 'lib'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'app.js'),
    'export function greet(name) {\n  return `hi ${name}`;\n}\n\nexport class Store {\n  get() { return 1; }\n}\n\nexport const add = (a, b) => a + b;\n'
  );
  await fs.writeFile(path.join(root, 'src', 'lib', 'util.mjs'), 'export const twice = (n) => n * 2;\n');
  await fs.writeFile(path.join(root, 'src', 'thing.py'), 'class Thing:\n    def go(self):\n        pass\n');
  await fs.writeFile(path.join(root, 'docs', 'readme.md'), '# docs\n');
  await fs.writeFile(path.join(root, 'data.json'), JSON.stringify({ items: [{ name: 'first', id: 7 }], count: 2 }, null, 2));
  await fs.writeFile(path.join(root, 'lines.txt'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', main: 'src/app.js', bin: { demo: './bin/demo.mjs' }, scripts: { test: 'node -e 0', build: 'node -e 0' } }, null, 2)
  );
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}');
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('registration', () => {
  it('every frontier tool is in the schema, for OpenAI and Anthropic', () => {
    const names = TOOL_SCHEMA.map((t) => t.name);
    for (const name of NEW_TOOLS) {
      assert.ok(names.includes(name), `${name} missing from TOOL_SCHEMA`);
      assert.ok(toolsForOpenAI().some((t) => t.function.name === name), `${name} missing from toolsForOpenAI`);
      const anthropic = toolsForAnthropic().find((t) => t.name === name);
      assert.ok(anthropic?.input_schema, `${name} missing input_schema`);
    }
    // The old tools are still there.
    for (const name of ['read_file', 'write_file', 'bash', 'browser', 'task']) assert.ok(names.includes(name));
  });

  it('an unknown tool still says so instead of falling through', async () => {
    assert.equal(await runTool('not_a_tool', {}, ctx()), 'Unknown tool: not_a_tool');
  });

  it('the REPL advertises /map and /undo', () => {
    const cmds = HELP.map(([cmd]) => cmd);
    assert.ok(cmds.includes('/map'));
    assert.ok(cmds.some((c) => c.startsWith('/undo')));
  });
});

describe('glob', () => {
  it('matches across directories and by basename', async () => {
    assert.equal(await runTool('glob', { pattern: '**/*.mjs' }, ctx()), 'src/lib/util.mjs');
    assert.equal(await runTool('glob', { pattern: '*.js' }, ctx()), 'src/app.js');
    assert.match(await runTool('glob', { pattern: '**/*.{js,py}' }, ctx()), /src\/app\.js[\s\S]*src\/thing\.py/);
  });

  it('scopes to a subdirectory and reports an empty result clearly', async () => {
    assert.equal(await runTool('glob', { pattern: '**/*', path: 'docs' }, ctx()), 'docs/readme.md');
    assert.match(await runTool('glob', { pattern: '**/*.rs' }, ctx()), /No files match/);
  });

  it('refuses to escape the workspace', async () => {
    await assert.rejects(() => runTool('glob', { pattern: '*', path: '../..' }, ctx()), /outside the workspace/);
  });

  it('the matcher itself follows * / ** / ? rules', () => {
    assert.equal(globMatcher('src/*.js')('src/app.js'), true);
    assert.equal(globMatcher('src/*.js')('src/lib/app.js'), false);
    assert.equal(globMatcher('src/**/*.js')('src/lib/app.js'), true);
    assert.equal(globMatcher('a?.txt')('ab.txt'), true);
    assert.equal(globMatcher('a?.txt')('abc.txt'), false);
  });
});

describe('read_range and file_info', () => {
  it('reads a numbered window and says where it stopped', async () => {
    const out = await runTool('read_range', { path: 'lines.txt', start: 4, end: 6 }, ctx());
    assert.match(out, /4\tline 4/);
    assert.match(out, /6\tline 6/);
    assert.match(out, /lines 4-6 of 300/);
    assert.doesNotMatch(out, /line 7/);
  });

  it('validates the window and the file', async () => {
    assert.match(await runTool('read_range', { path: 'lines.txt', start: 0 }, ctx()), /1 or greater/);
    assert.match(await runTool('read_range', { path: 'lines.txt', start: 9, end: 3 }, ctx()), /at or after start/);
    assert.match(await runTool('read_range', { path: 'nope.txt' }, ctx()), /does not exist/);
  });

  it('reports size, language, line count and a sha256', async () => {
    const out = await runTool('file_info', { path: 'src/app.js' }, ctx());
    assert.match(out, /language: JavaScript/);
    assert.match(out, /lines: 10/);
    assert.match(out, /sha256: [a-f0-9]{64}/);
    assert.match(out, /modified: \d{4}-\d{2}-\d{2}T/);
  });
});

describe('outline', () => {
  it('lists JS functions, classes and arrow constants with line numbers', async () => {
    const out = await runTool('outline', { path: 'src/app.js' }, ctx());
    assert.match(out, /1\tfunction greet/);
    assert.match(out, /5\tclass Store/);
    assert.match(out, /9\tfunction add/);
  });

  it('lists Python classes and defs, and handles an unknown language', async () => {
    const py = await runTool('outline', { path: 'src/thing.py' }, ctx());
    assert.match(py, /1\tclass Thing/);
    assert.match(py, /2\tdef go/);
    const md = await runTool('outline', { path: 'docs/readme.md' }, ctx());
    assert.match(md, /section docs|no symbols found/);
  });
});

describe('repo_map', () => {
  it('summarizes files, languages, manifests, scripts and entry points', async () => {
    const out = await runTool('repo_map', {}, ctx());
    assert.match(out, /repo: tc-frontier-test-/);
    assert.match(out, /languages: .*\.js 1/);
    assert.match(out, /package manager: npm \(package-lock\.json\)/);
    assert.match(out, /manifests: package\.json/);
    assert.match(out, /name: demo 1\.0\.0/);
    assert.match(out, /scripts: test, build/);
    assert.match(out, /entry points: .*src\/app\.js/);
    assert.match(out, /directories:/);
  });
});

describe('file surgery', () => {
  it('moves, creates directories and deletes after approval', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-surgery-'));
    await fs.writeFile(path.join(dir, 'old.txt'), 'payload');
    const c = { root: dir, approve };
    try {
      assert.match(await runTool('move_file', { from: 'old.txt', to: 'sub/new.txt' }, c), /^Moved old\.txt -> sub\/new\.txt\./);
      assert.equal(await fs.readFile(path.join(dir, 'sub', 'new.txt'), 'utf8'), 'payload');
      assert.match(await runTool('make_dir', { path: 'deep/er' }, c), /^Created directory deep\/er\./);
      assert.match(await runTool('delete_file', { path: 'sub/new.txt' }, c), /^Deleted sub\/new\.txt\./);
      await assert.rejects(() => fs.stat(path.join(dir, 'sub', 'new.txt')), /ENOENT/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite, to delete the root, and a non-empty dir without recursive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-surgery2-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    await fs.writeFile(path.join(dir, 'b.txt'), 'b');
    await fs.mkdir(path.join(dir, 'full'));
    await fs.writeFile(path.join(dir, 'full', 'x.txt'), 'x');
    const c = { root: dir, approve };
    try {
      assert.match(await runTool('move_file', { from: 'a.txt', to: 'b.txt' }, c), /already exists/);
      assert.match(await runTool('delete_file', { path: '.' }, c), /workspace root/);
      assert.match(await runTool('delete_file', { path: 'full' }, c), /recursive: true/);
      assert.match(await runTool('delete_file', { path: 'full', recursive: true }, c), /^Deleted full\./);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('honours a declined approval and writes nothing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-surgery3-'));
    await fs.writeFile(path.join(dir, 'keep.txt'), 'keep');
    const c = { root: dir, approve: async () => false };
    try {
      assert.match(await runTool('delete_file', { path: 'keep.txt' }, c), /Declined/);
      assert.equal(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('diff_files and git', () => {
  it('produces a unified diff of two files', async () => {
    await fs.writeFile(path.join(root, 'diff-a.txt'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(root, 'diff-b.txt'), 'one\nTWO\nthree\nfour\n');
    const out = await runTool('diff_files', { a: 'diff-a.txt', b: 'diff-b.txt' }, ctx());
    assert.match(out, /^--- diff-a\.txt/);
    assert.match(out, /^\+\+\+ diff-b\.txt/m);
    assert.match(out, /^-two$/m);
    assert.match(out, /^\+TWO$/m);
    assert.match(out, /^\+four$/m);
    assert.match(out, /^ one$/m);
  });

  it('says so when the two files are identical', () => {
    assert.equal(unifiedDiff('same\n', 'same\n'), 'No changes.');
  });

  it('reads a real repo and refuses write subcommands', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      await fs.writeFile(path.join(repo, 'a.txt'), 'one\n');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first commit'], { cwd: repo });
      const c = { root: repo, approve };
      await fs.writeFile(path.join(repo, 'untracked.txt'), 'new\n');
      assert.match(await runTool('git', { subcommand: 'status' }, c), /untracked\.txt/);
      assert.match(await runTool('git', { subcommand: 'log' }, c), /first commit/);
      assert.match(await runTool('git', { subcommand: 'commit', args: '-m x' }, c), /not read-only/);
      assert.match(await runTool('git', { subcommand: 'branch', args: '-D main' }, c), /read-only/);
      // diff_files with no b compares the working copy against HEAD.
      await fs.writeFile(path.join(repo, 'a.txt'), 'ONE\n');
      const d = await runTool('diff_files', { a: 'a.txt' }, c);
      assert.match(d, /^--- a\.txt \(HEAD\)/m);
      assert.match(d, /^-one$/m);
      assert.match(d, /^\+ONE$/m);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it('splits quoted git arguments without a shell', () => {
    assert.deepEqual(splitArgs('--stat "HEAD~1"'), ['--stat', 'HEAD~1']);
    assert.deepEqual(splitArgs("'src/a b.js'"), ['src/a b.js']);
  });
});

describe('http_request and download_file', () => {
  let server;
  let base;
  const hits = [];

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push({ method: req.method, url: req.url });
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, method: req.method }));
        return;
      }
      if (req.url === '/file.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('payload-bytes');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GETs JSON and pretty-prints it', async () => {
    const out = await runTool('http_request', { url: `${base}/json` }, ctx());
    assert.match(out, /^HTTP 200 OK/);
    assert.match(out, /content-type: application\/json/);
    assert.match(out, /"ok": true/);
    assert.equal(hits.at(-1).method, 'GET');
  });

  it('POSTs a JSON body and gates it behind approval', async () => {
    const out = await runTool('http_request', { url: `${base}/json`, method: 'POST', json: { a: 1 } }, ctx());
    assert.match(out, /"method": "POST"/);
    const denied = await runTool(
      'http_request',
      { url: `${base}/json`, method: 'POST', json: { a: 1 } },
      { root, approve: async () => false }
    );
    assert.match(denied, /Declined/);
  });

  it('rejects a non-http URL and a GET with a body', async () => {
    assert.match(await runTool('http_request', { url: 'file:///etc/passwd' }, ctx()), /Only http and https/);
    assert.match(await runTool('http_request', { url: `${base}/json`, body: 'x' }, ctx()), /cannot carry a body/);
  });

  it('downloads a file into the workspace with a hash', async () => {
    const out = await runTool('download_file', { url: `${base}/file.bin`, path: 'dl/file.bin' }, ctx());
    assert.match(out, /^Downloaded 13 B to dl\/file\.bin \(sha256 [a-f0-9]{16}/);
    assert.equal(await fs.readFile(path.join(root, 'dl', 'file.bin'), 'utf8'), 'payload-bytes');
    assert.match(
      await runTool('download_file', { url: 'https://127.0.0.1/x', path: 'y' }, { root, approve: async () => false }),
      /Declined/
    );
  });
});

describe('json_query', () => {
  it('walks dot and bracket paths', () => {
    assert.deepEqual(parseJsonPath('items[0].name'), ['items', 0, 'name']);
    assert.deepEqual(parseJsonPath('a."b c"'), ['a', 'b c']);
    assert.equal(parseJsonPath('a['), null);
    assert.equal(jsonPathGet({ a: { b: [1, 2] } }, 'a.b[1]').value, 2);
    assert.match(jsonPathGet({ a: 1 }, 'b').error, /Available keys: a/);
  });

  it('queries a JSON file and lists top-level keys without a query', async () => {
    assert.equal(await runTool('json_query', { path: 'data.json', query: 'items[0].name' }, ctx()), 'string\n"first"');
    const keys = await runTool('json_query', { path: 'data.json' }, ctx());
    assert.match(keys, /items: array\(1\)/);
    assert.match(keys, /count: number/);
    assert.match(await runTool('json_query', { json: '{bad' }, ctx()), /not valid JSON/);
  });
});

describe('todo and remember', () => {
  it('keeps a structured task list across calls', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-todo-'));
    const c = { root: dir, approve };
    try {
      assert.match(await runTool('todo', { action: 'read' }, c), /No tasks yet/);
      assert.match(await runTool('todo', { action: 'write', items: ['read code', 'fix bug'] }, c), /0\/2 done/);
      assert.match(await runTool('todo', { action: 'done', index: 1 }, c), /1\/2 done[\s\S]*\[x\] 1\. read code/);
      assert.match(await runTool('todo', { action: 'add', text: 'run tests' }, c), /1\/3 done/);
      assert.match(await runTool('todo', { action: 'read' }, c), /3\. run tests/);
      assert.match(await runTool('todo', { action: 'done', index: 9 }, c), /between 1 and 3/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('saves memory once, and the prompt section replaces rather than duplicates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-memory-'));
    const c = { root: dir, approve };
    try {
      assert.match(await runTool('remember', { action: 'add', text: 'Use pnpm' }, c), /^Remembered: Use pnpm/);
      assert.match(await runTool('remember', { action: 'add', text: 'Use pnpm' }, c), /already/);
      const note = await memoryNote(dir);
      assert.match(note, /## Project memory/);
      assert.match(note, /- \d{4}-\d{2}-\d{2}: Use pnpm/);
      const once = withMemory('SYSTEM', note);
      assert.equal(withMemory(once, note), once);
      assert.equal(withMemory(once, ''), 'SYSTEM');
      assert.match(await runTool('remember', { action: 'clear' }, c), /cleared/);
      assert.equal(await memoryNote(dir), '');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('checkpoint', () => {
  it('snapshots and restores files, newest by default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-checkpoint-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'original\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'second\n');
    const c = { root: dir, approve };
    try {
      assert.match(await runTool('checkpoint', { action: 'list' }, c), /No checkpoints/);
      const created = await runTool('checkpoint', { action: 'create', paths: ['a.txt', 'b.txt'] }, c);
      assert.match(created, /^Created checkpoint \w+ \(2 file\(s\)/);
      const id = created.match(/checkpoint (\w+)/)[1];

      await fs.writeFile(path.join(dir, 'a.txt'), 'BROKEN\n');
      assert.match(await runTool('checkpoint', { action: 'restore' }, c), new RegExp(`^Restored 2 file\\(s\\) from checkpoint ${id}`));
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'original\n');
      assert.match(await runTool('checkpoint', { action: 'list' }, c), new RegExp(id));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not restore when approval is declined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-checkpoint2-'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'original\n');
    try {
      const created = await runTool('checkpoint', { action: 'create' }, { root: dir, approve });
      assert.match(created, /Created checkpoint/);
      await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n');
      assert.match(await runTool('checkpoint', { action: 'restore' }, { root: dir, approve: async () => false }), /Declined/);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'changed\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ports and sysinfo', () => {
  it('parses listening sockets out of /proc/net/tcp', () => {
    const sample = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0FA0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1',
      '   1: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 2',
      '   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3',
    ].join('\n');
    const rows = parseProcNet(sample);
    assert.deepEqual(rows.map((r) => r.port), [4000, 80]);
  });

  it('reports a listening state for a port it can see, and lists or explains', async () => {
    const all = await runTool('ports', {}, ctx());
    assert.match(all, /listening TCP ports|No TCP ports|needs \/proc/);
    assert.match(await runTool('ports', { port: 65000 }, ctx()), /not listening|needs \/proc/);
  });

  it('reports the machine it is running on', async () => {
    const out = await runTool('sysinfo', {}, ctx());
    assert.match(out, /^os: /);
    assert.match(out, new RegExp(`node: ${process.version.replace(/\./g, '\\.')}`));
    assert.match(out, /cpus: \d+/);
    assert.match(out, /memory: /);
    assert.match(out, new RegExp(`cwd: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});
