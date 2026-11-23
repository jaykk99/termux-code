/**
 * Frontier tools: repo intelligence, safe file surgery, HTTP, durable notes,
 * rollback, local service checks and machine facts.
 *
 * Everything here follows the same rules as lib/tools.mjs: paths are confined
 * to the workspace root, output is clipped so one call cannot flood a phone
 * screen, directory walks are bounded (count + deadline) so a huge tree cannot
 * hang a turn, and anything that changes a file the user owns goes through the
 * approval callback. Internal notes (todo list, project memory, checkpoints)
 * live under `.termux-code/` and are additive, so they do not need a prompt.
 *
 * Zero dependencies, because the CLI installs nothing on the phone.
 */

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const MAX_OUTPUT = 20_000;
const STATE_DIR = '.termux-code';
const MAX_DOWNLOAD = 25 * 1024 * 1024;

/** Directories never worth walking: build output, dependencies, agent state. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.open-next',
  '.wrangler',
  '.cache',
  'dist',
  'build',
  'coverage',
  '.termux-code',
  '.data',
  '.sandbox',
  '__pycache__',
]);

/* ---------- shared helpers ---------- */

function resolve(root, rel) {
  const full = path.resolve(root, rel);
  const bounded = full === root || full.startsWith(root + path.sep);
  if (!bounded) throw new Error(`Path is outside the workspace: ${rel}`);
  return full;
}

function clip(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... truncated, ${s.length - limit} more characters`;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function int(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Every regular file under `dir`, depth-first, with a deadline and a count
 * cap. Hidden names are skipped unless `hidden` is set; SKIP_DIRS are always
 * skipped, and symlinks are never followed (the FIFO lesson from grep).
 */
async function filesUnder(dir, { hidden = false, deadline = Date.now() + 5000, limit = 4000 } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    if (Date.now() > deadline) break;
    const cur = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!hidden && e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && !e.isSymbolicLink()) out.push(full);
    }
  }
  return out;
}

function exec(cmd, args, cwd, timeout = 20_000) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      done({
        code: err ? (err.code ?? 1) : 0,
        output: [stdout, stderr].filter(Boolean).join('\n').trim(),
        error: err,
      });
    });
  });
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((done, fail) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', done);
    stream.on('error', fail);
  });
  return hash.digest('hex');
}

const LANGUAGES = {
  '.mjs': 'JavaScript',
  '.js': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.lua': 'Lua',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'CSS',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.toml': 'TOML',
  '.sql': 'SQL',
};

/* ---------- 1. glob ---------- */

/** Turn a shell-style glob into a regular-expression source string. */
export function globToSource(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
        continue;
      }
      out += '(?:' + pattern.slice(i + 1, close).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = close;
    } else if (c === '[') {
      const close = pattern.indexOf(']', i);
      if (close === -1) {
        out += '\\[';
        continue;
      }
      out += '[' + pattern.slice(i + 1, close).replace(/^!/, '^') + ']';
      i = close;
    } else {
      out += c.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return out;
}

/** A matcher for workspace-relative POSIX paths. A slashless pattern also
 *  matches by basename, so `glob *.mjs` finds files at any depth. */
export function globMatcher(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  const rx = new RegExp(`^${globToSource(p)}$`);
  const basenameOnly = !p.includes('/');
  return (rel) => rx.test(rel) || (basenameOnly && rx.test(path.posix.basename(rel)));
}

async function runGlob(args, root) {
  const pattern = str(args.pattern);
  if (!pattern) return 'glob needs a "pattern" string, e.g. {"pattern": "**/*.test.mjs"}.';
  let base = root;
  if (str(args.path)) base = resolve(root, args.path);
  const match = globMatcher(pattern);
  const files = await filesUnder(base, { hidden: true, limit: 5000 });
  const hits = files
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter(match)
    .sort();
  if (!hits.length) return `No files match ${pattern}.`;
  const shown = hits.slice(0, 200);
  return clip(shown.join('\n') + (hits.length > shown.length ? `\n... and ${hits.length - shown.length} more` : ''));
}

/* ---------- 2. read_range ---------- */

async function runReadRange(args, root) {
  const rel = str(args.path);
  if (!rel) return 'read_range needs a "path" string.';
  const start = int(args.start, 1);
  let end = int(args.end, start + 199);
  if (start < 1) return 'start must be a line number, 1 or greater.';
  if (end < start) return 'end must be at or after start.';
  if (end - start > 1999) end = start + 1999;
  const file = resolve(root, rel);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? `${rel} does not exist.` : `Could not read ${rel}: ${e.message}`;
  }
  const lines = text.split('\n');
  if (start > lines.length) return `${rel} has ${lines.length} lines; start ${start} is past the end.`;
  const stop = Math.min(end, lines.length);
  const body = [];
  for (let i = start; i <= stop; i++) body.push(`${String(i).padStart(5)}\t${lines[i - 1]}`);
  const tail = stop < lines.length || start > 1 ? `\n... ${rel}: lines ${start}-${stop} of ${lines.length}` : '';
  return clip(body.join('\n') + tail);
}

/* ---------- 3. file_info ---------- */

async function runFileInfo(args, root) {
  const rel = str(args.path);
  if (!rel) return 'file_info needs a "path" string.';
  const file = resolve(root, rel);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (e) {
    return e.code === 'ENOENT' ? `${rel} does not exist.` : `Could not stat ${rel}: ${e.message}`;
  }
  const ext = path.extname(file).toLowerCase();
  const lines = [];
  lines.push(`${rel}`);
  lines.push(`type: ${stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'}`);
  lines.push(`language: ${LANGUAGES[ext] || (ext ? ext.slice(1) : 'unknown')}`);
  lines.push(`size: ${bytes(stat.size)} (${stat.size} bytes)`);
  lines.push(`modified: ${stat.mtime.toISOString()}`);
  lines.push(`mode: ${(stat.mode & 0o777).toString(8)}`);
  if (stat.isFile()) {
    lines.push(`sha256: ${await sha256File(file).catch(() => 'unavailable')}`);
    if (stat.size <= 4 * 1024 * 1024) {
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text !== null) lines.push(`lines: ${text.split('\n').length}`);
      else lines.push('lines: unavailable (not UTF-8 text)');
    } else {
      lines.push('lines: not counted (file over 4 MB)');
    }
  }
  return lines.join('\n');
}

/* ---------- 4. outline ---------- */

const SYMBOL_PATTERNS = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\()/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 'type'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w:<>]*)/, 'impl'],
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'],
    [/^type\s+([A-Za-z_]\w*)/, 'type'],
  ],
  sh: [[/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/, 'function']],
  rb: [
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'def'],
    [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'class'],
  ],
};

function outlineLang(ext) {
  if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) return 'js';
  if (ext === '.py') return 'py';
  if (ext === '.rs') return 'rs';
  if (ext === '.go') return 'go';
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'sh';
  if (ext === '.rb') return 'rb';
  return null;
}

async function runOutline(args, root) {
  const rel = str(args.path);
  if (!rel) return 'outline needs a "path" string.';
  const file = resolve(root, rel);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? `${rel} does not exist.` : `Could not read ${rel}: ${e.message}`;
  }
  if (text.length > 600_000) return `${rel} is too large to outline; use grep or read_range.`;
  const lines = text.split('\n');
  const lang = outlineLang(path.extname(file).toLowerCase());
  const patterns = lang ? SYMBOL_PATTERNS[lang] : [];
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [re, kind] of patterns) {
      const m = line.match(re);
      if (m) {
        found.push(`${String(i + 1).padStart(5)}\t${kind} ${m[1]}`);
        break;
      }
    }
    if (found.length >= 250) break;
  }
  if (!found.length) {
    // No symbols: show the file's comment section headers, which is what a
    // shell script or config file uses in place of functions.
    for (let i = 0; i < lines.length && found.length < 40; i++) {
      const m = lines[i].match(/^\s*(?:#|\/\/)\s*([A-Za-z][^\n]{2,70})$/);
      if (m) found.push(`${String(i + 1).padStart(5)}\tsection ${m[1].trim()}`);
    }
  }
  if (!found.length) return `${rel}: no symbols found (${lines.length} lines).`;
  return `${rel} (${lines.length} lines)\n${found.join('\n')}`;
}

/* ---------- 5. repo_map ---------- */

const MANIFESTS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
  'vercel.json',
  'wrangler.jsonc',
  '.mcp.json',
];

async function runRepoMap(root) {
  const files = await filesUnder(root, { hidden: true, limit: 3000 });
  const extCounts = new Map();
  const dirCounts = new Map();
  let total = 0;
  let truncated = files.length >= 3000;
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const ext = path.extname(file).toLowerCase() || '(no extension)';
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    const seg = rel.split('/');
    if (seg.length > 1) {
      const top = `${seg[0]}/`;
      dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
      if (seg.length > 2) {
        const second = `${seg[0]}/${seg[1]}/`;
        dirCounts.set(second, (dirCounts.get(second) || 0) + 1);
      }
    }
    try {
      total += (await fs.stat(file)).size;
    } catch {
      /* a file that vanished mid-scan is not worth failing the map over */
    }
  }

  const exists = async (rel) => fs.stat(path.join(root, rel)).then(() => true, () => false);
  const read = async (rel) => fs.readFile(path.join(root, rel), 'utf8').then((t) => t, () => null);

  let pkg = null;
  const pkgText = await read('package.json');
  if (pkgText) {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      pkg = null;
    }
  }

  const packageManagers = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  let packageManager = null;
  for (const [file, name] of packageManagers) {
    if (await exists(file)) {
      packageManager = `${name} (${file})`;
      break;
    }
  }

  const manifests = [];
  for (const name of MANIFESTS) if (await exists(name)) manifests.push(name);

  const entryPoints = new Set();
  if (typeof pkg?.main === 'string') entryPoints.add(pkg.main);
  if (pkg?.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') entryPoints.add(v.replace(/^\.\//, ''));
  if (typeof pkg?.bin === 'string') entryPoints.add(pkg.bin);
  for (const candidate of ['index.js', 'index.mjs', 'src/index.js', 'src/index.mjs', 'src/main.ts', 'app/page.js', 'app/page.tsx', 'main.py', 'app.py', 'cmd/main.go', 'src/main.rs']) {
    if (await exists(candidate)) entryPoints.add(candidate);
  }

  const languages = [...extCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const dirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const lines = [];
  lines.push(`repo: ${path.basename(root)}`);
  lines.push(`files: ${files.length}${truncated ? '+' : ''} (${bytes(total)}${truncated ? ', scan capped' : ''})`);
  lines.push(`languages: ${languages.map(([ext, n]) => `${ext} ${n}`).join(', ') || 'none'}`);
  if (packageManager) lines.push(`package manager: ${packageManager}`);
  if (manifests.length) lines.push(`manifests: ${manifests.join(', ')}`);
  if (pkg?.name) lines.push(`name: ${pkg.name}${pkg.version ? ` ${pkg.version}` : ''}`);
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : [];
  if (scripts.length) lines.push(`scripts: ${scripts.slice(0, 12).join(', ')}${scripts.length > 12 ? ', ...' : ''}`);
  if (entryPoints.size) lines.push(`entry points: ${[...entryPoints].slice(0, 8).join(', ')}`);
  if (dirs.length) {
    lines.push('directories:');
    for (const [dir, n] of dirs) lines.push(`  ${dir} ${n}`);
  }
  return clip(lines.join('\n'));
}

/* ---------- 6-8. safe file surgery ---------- */

async function runMoveFile(args, root, allow) {
  const from = str(args.from);
  const to = str(args.to);
  if (!from || !to) return 'move_file needs "from" and "to" paths.';
  const source = resolve(root, from);
  const target = resolve(root, to);
  if (source === root) return 'Refusing to move the workspace root.';
  let stat;
  try {
    stat = await fs.stat(source);
  } catch (e) {
    return e.code === 'ENOENT' ? `${from} does not exist.` : `Could not stat ${from}: ${e.message}`;
  }
  if (!stat.isFile() && !stat.isDirectory()) return `${from} is not a regular file or directory.`;
  if (await fs.stat(target).then(() => true, () => false)) return `${to} already exists; refusing to overwrite it.`;
  const ok = await allow(`Move ${from} -> ${to}`, `${stat.isDirectory() ? 'directory' : bytes(stat.size)}`);
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.rename(source, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.cp(source, target, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
  return `Moved ${from} -> ${to}.`;
}

async function runDeleteFile(args, root, allow) {
  const rel = str(args.path);
  if (!rel) return 'delete_file needs a "path" string.';
  const file = resolve(root, rel);
  if (file === root) return 'Refusing to delete the workspace root.';
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (e) {
    return e.code === 'ENOENT' ? `${rel} does not exist.` : `Could not stat ${rel}: ${e.message}`;
  }
  const recursive = args.recursive === true;
  if (stat.isDirectory() && !recursive) {
    const entries = await fs.readdir(file).catch(() => []);
    if (entries.length) return `${rel} is a non-empty directory. Set recursive: true to delete it and its ${entries.length} entries.`;
  }
  if (stat.isSymbolicLink()) return `${rel} is a symlink; refusing to follow it. Delete it with bash if that is what you want.`;
  const ok = await allow(`Delete ${rel}`, stat.isDirectory() ? 'directory and everything inside it' : bytes(stat.size));
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  await fs.rm(file, { recursive, force: true });
  return `Deleted ${rel}.`;
}

async function runMakeDir(args, root, allow) {
  const rel = str(args.path);
  if (!rel) return 'make_dir needs a "path" string.';
  const dir = resolve(root, rel);
  const already = await fs.stat(dir).then((s) => s.isDirectory(), () => false);
  if (already) return `${rel} already exists.`;
  const ok = await allow(`Create directory ${rel}`, '');
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  await fs.mkdir(dir, { recursive: true });
  return `Created directory ${rel}.`;
}

/* ---------- 9. diff_files ---------- */

/** Line-level diff ops (LCS). Capped: past the cap every line counts as
 *  changed rather than spending a phone's memory on a 10k x 10k table. */
export function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return [...a.map((s) => ({ t: '-', s })), ...b.map((s) => ({ t: '+', s }))];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', s: a[i++] });
    } else {
      ops.push({ t: '+', s: b[j++] });
    }
  }
  while (i < n) ops.push({ t: '-', s: a[i++] });
  while (j < m) ops.push({ t: '+', s: b[j++] });
  return ops;
}

/** Unified diff text, with 3 lines of context by default. */
export function unifiedDiff(aText, bText, labelA = 'a', labelB = 'b', context = 3) {
  const split = (t) => {
    const lines = String(t).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const a = split(aText);
  const b = split(bText);
  const ops = diffOps(a, b);
  if (!ops.some((o) => o.t !== ' ')) return 'No changes.';

  // Give every op the line numbers it sits at in each side.
  let aNo = 1;
  let bNo = 1;
  const rows = ops.map((o) => {
    const row = { ...o, aNo, bNo };
    if (o.t !== '+') aNo++;
    if (o.t !== '-') bNo++;
    return row;
  });

  const changes = rows.map((r, i) => (r.t !== ' ' ? i : -1)).filter((i) => i !== -1);
  const ranges = [];
  for (const idx of changes) {
    const start = Math.max(0, idx - context);
    const end = Math.min(rows.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  for (const [start, end] of ranges) {
    const slice = rows.slice(start, end + 1);
    const aCount = slice.filter((r) => r.t !== '+').length;
    const bCount = slice.filter((r) => r.t !== '-').length;
    const aStart = slice.find((r) => r.t !== '+')?.aNo ?? rows[start].aNo;
    const bStart = slice.find((r) => r.t !== '-')?.bNo ?? rows[start].bNo;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const r of slice) out.push(`${r.t}${r.s}`);
  }
  return out.join('\n');
}

async function gitShowHead(root, rel) {
  const res = await exec('git', ['show', `HEAD:${rel}`], root);
  return res.code === 0 ? res.output : null;
}

async function runDiffFiles(args, root) {
  const a = str(args.a);
  if (!a) return 'diff_files needs "a" (and usually "b").';
  const fileA = resolve(root, a);
  const before = await fs.readFile(fileA, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (before === null) return `${a} does not exist.`;
  if (str(args.b)) {
    const after = await fs.readFile(resolve(root, args.b), 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (after === null) return `${args.b} does not exist.`;
    return clip(unifiedDiff(before, after, a, args.b));
  }
  // No second file: show the working copy against HEAD, in the usual
  // -committed / +working order so the diff reads like `git diff`.
  const fromHead = await gitShowHead(root, a.split(path.sep).join('/'));
  if (fromHead === null) return `No "b" given and ${a} is not tracked by git with a HEAD commit.`;
  return clip(unifiedDiff(fromHead, before, `${a} (HEAD)`, a));
}

/* ---------- 10. git (read-only) ---------- */

const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'remote',
  'ls-files',
  'rev-parse',
  'shortlog',
  'tag',
  'blame',
  'describe',
  'show-ref',
  'whatchanged',
]);

const GIT_WRITE_FLAGS = /^(?:-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream-to|--output|--force|-f|--amend|--hard|--soft|--mixed)$/;

/** Split a quoted argument string into argv without a shell. */
export function splitArgs(text) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

async function runGitTool(args, root) {
  const sub = str(args.subcommand);
  if (!sub) return 'git needs a "subcommand" string: status, log, diff, show, branch, ls-files, blame.';
  if (!GIT_READ.has(sub)) {
    return `git ${sub} is not read-only and is not allowed here. Commits, pushes, resets and checkouts go through bash.`;
  }
  const argv = splitArgs(args.args);
  if (argv.some((t) => GIT_WRITE_FLAGS.test(t) || t.startsWith('--output='))) {
    return `Those arguments can write; this git tool is read-only. Use bash for that command.`;
  }
  if (sub === 'log' && !argv.length) argv.push('--oneline', '-n', '20');
  if (sub === 'status' && !argv.length) argv.push('-sb');
  if (sub === 'branch' && !argv.length) argv.push('-a');
  if (sub === 'tag' && argv.some((t) => !t.startsWith('-'))) {
    return 'Creating or deleting a tag writes to the repo; this git tool is read-only.';
  }
  if (sub === 'remote' && argv.some((t) => ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune'].includes(t))) {
    return 'Changing remotes writes to the repo; this git tool is read-only.';
  }
  const res = await exec('git', ['-c', 'color.ui=false', sub, ...argv], root);
  if (res.error?.code === 'ENOENT') return 'git is not installed here. Install it with: pkg install git';
  return clip(`git ${sub}: exit ${res.code}\n${res.output || '(no output)'}`);
}

/* ---------- 11. http_request ---------- */

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

async function runHttpRequest(args, root, allow) {
  const raw = str(args.url);
  if (!raw) return 'http_request needs a "url" string.';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a full http(s) URL, e.g. https://api.example.com/status.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs are supported.';
  const method = String(args.method || 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) return `Unsupported method ${method}. Use ${[...HTTP_METHODS].join(', ')}.`;
  const headers = {};
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [k, v] of Object.entries(args.headers)) headers[String(k)] = String(v);
  }
  let body;
  if (args.json !== undefined && args.json !== null) {
    body = JSON.stringify(args.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  } else if (typeof args.body === 'string') {
    body = args.body;
  }
  if ((method === 'GET' || method === 'HEAD') && body !== undefined) return `${method} cannot carry a body; use POST, PUT or PATCH.`;
  if (method !== 'GET' && method !== 'HEAD') {
    const ok = await allow(`Send ${method} ${url.href}`, body ? clip(body, 800) : '');
    if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '(unknown)';
    let text = await res.text();
    if (/json/i.test(type) || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON after all: leave the text alone */
      }
    }
    return clip(`HTTP ${res.status} ${res.statusText}\ncontent-type: ${type}\n\n${text || '(empty body)'}`);
  } catch (e) {
    return e.name === 'AbortError' ? 'Request timed out after 20s.' : `Request failed: ${e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 12. download_file ---------- */

async function runDownloadFile(args, root, allow) {
  const raw = str(args.url);
  const rel = str(args.path);
  if (!raw || !rel) return 'download_file needs "url" and "path".';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a full http(s) URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs are supported.';
  const file = resolve(root, rel);
  const ok = await allow(`Download ${url.href} -> ${rel}`, '');
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return `Download failed: HTTP ${res.status} ${res.statusText}.`;
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD) return `Refusing to download ${bytes(declared)}; the limit is ${bytes(MAX_DOWNLOAD)}.`;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) return `Refusing to save ${bytes(buf.length)}; the limit is ${bytes(MAX_DOWNLOAD)}.`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return `Downloaded ${bytes(buf.length)} to ${rel} (sha256 ${hash.slice(0, 16)}...).`;
  } catch (e) {
    return e.name === 'AbortError' ? 'Download timed out after 60s.' : `Download failed: ${e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 13. json_query ---------- */

/** Parse `a.b[0].c` into ['a','b',0,'c']; null when the syntax is wrong. */
export function parseJsonPath(query) {
  const s = String(query ?? '').trim();
  const parts = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.' || s[i] === ' ') {
      i++;
      continue;
    }
    if (s[i] === '[') {
      const close = s.indexOf(']', i);
      if (close === -1) return null;
      const inner = s.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) parts.push(Number(inner));
      else if (/^(['"]).*\1$/.test(inner)) parts.push(inner.slice(1, -1));
      else return null;
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    let key = s.slice(i, j);
    // Quoted keys allow a space or a dot: a."b c" and a.'x.y'.
    if (/^(['"]).*\1$/.test(key)) key = key.slice(1, -1);
    parts.push(key);
    i = j;
  }
  return parts;
}

/** Walk a parsed JSON value by path; returns { value } or { error }. */
export function jsonPathGet(value, query) {
  const parts = parseJsonPath(query);
  if (!parts) return { error: `Could not read the query ${JSON.stringify(query)}; use dot paths like a.b[0].c.` };
  let cur = value;
  for (const key of parts) {
    if (cur === null || cur === undefined) return { error: `Hit null before ${JSON.stringify(key)}.` };
    if (Array.isArray(cur)) {
      if (key === 'length') {
        cur = cur.length;
        continue;
      }
      if (typeof key !== 'number') return { error: `Array needs a numeric index here, got ${JSON.stringify(key)}.` };
      if (key < 0 || key >= cur.length) return { error: `Index ${key} is outside the array (length ${cur.length}).` };
      cur = cur[key];
      continue;
    }
    if (typeof cur !== 'object') return { error: `Cannot read ${JSON.stringify(key)} from a ${typeof cur}.` };
    if (!(key in cur)) {
      const keys = Object.keys(cur).slice(0, 12);
      return { error: `${JSON.stringify(key)} is not here. Available keys: ${keys.join(', ') || '(none)'}.` };
    }
    cur = cur[key];
  }
  return { value: cur };
}

function describeJson(value) {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

async function runJsonQuery(args, root) {
  let parsed;
  if (typeof args.json === 'string' && args.json.trim()) {
    try {
      parsed = JSON.parse(args.json);
    } catch (e) {
      return `json is not valid JSON: ${e.message}`;
    }
  } else if (str(args.path)) {
    const file = resolve(root, args.path);
    const text = await fs.readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (text === null) return `${args.path} does not exist.`;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return `${args.path} is not valid JSON: ${e.message}`;
    }
  } else {
    return 'json_query needs "path" (a .json file) or "json" (a JSON string).';
  }
  const query = str(args.query);
  if (!query) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const lines = Object.entries(parsed).slice(0, 40).map(([k, v]) => `${k}: ${describeJson(v)}`);
      return lines.join('\n') || '(empty object)';
    }
    return describeJson(parsed);
  }
  const got = jsonPathGet(parsed, query);
  if (got.error) return got.error;
  const shown = JSON.stringify(got.value, null, 2);
  return clip(`${describeJson(got.value)}\n${shown === undefined ? String(got.value) : shown}`);
}

/* ---------- 14. todo ---------- */

function todoFile(root) {
  return path.join(root, STATE_DIR, 'todo.json');
}

async function readTodo(root) {
  try {
    const data = JSON.parse(await fs.readFile(todoFile(root), 'utf8'));
    if (!Array.isArray(data?.items)) return [];
    return data.items
      .filter((it) => it && typeof it.text === 'string' && it.text.trim())
      .map((it) => ({ text: it.text.trim(), done: it.done === true }));
  } catch {
    return [];
  }
}

function formatTodo(items) {
  if (!items.length) return 'No tasks yet. Use action "write" with an items array.';
  const done = items.filter((i) => i.done).length;
  return `${done}/${items.length} done\n` + items.map((it, i) => `${it.done ? '[x]' : '[ ]'} ${i + 1}. ${it.text}`).join('\n');
}

async function saveTodo(root, items) {
  const file = todoFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ items }, null, 2), 'utf8');
}

function todoItems(value) {
  if (!Array.isArray(value)) return null;
  return value
    .map((it) => (typeof it === 'string' ? { text: it.trim(), done: false } : it && typeof it.text === 'string' ? { text: it.text.trim(), done: it.done === true } : null))
    .filter((it) => it && it.text);
}

async function runTodo(args, root) {
  const action = str(args.action) || 'read';
  const items = await readTodo(root);
  if (action === 'read') return formatTodo(items);
  if (action === 'write') {
    const next = todoItems(args.items);
    if (!next) return 'action "write" needs an "items" array of strings or {text, done} objects.';
    await saveTodo(root, next);
    return `Saved the task list.\n${formatTodo(next)}`;
  }
  if (action === 'add') {
    const text = str(args.text);
    if (!text) return 'action "add" needs a "text" string.';
    const next = [...items, { text, done: false }];
    await saveTodo(root, next);
    return formatTodo(next);
  }
  if (action === 'done') {
    const index = int(args.index, 0);
    if (index < 1 || index > items.length) return `index must be between 1 and ${items.length || 0}.`;
    items[index - 1] = { ...items[index - 1], done: true };
    await saveTodo(root, items);
    return formatTodo(items);
  }
  if (action === 'clear') {
    await saveTodo(root, []);
    return 'Task list cleared.';
  }
  return 'Unknown todo action. Use read, write, add, done or clear.';
}

/* ---------- 15. remember (durable project memory) ---------- */

function memoryFile(root) {
  return path.join(root, STATE_DIR, 'memory.md');
}

async function readMemory(root) {
  try {
    return await fs.readFile(memoryFile(root), 'utf8');
  } catch {
    return '';
  }
}

async function runRemember(args, root) {
  const action = str(args.action) || 'list';
  const existing = await readMemory(root);
  if (action === 'list') {
    const lines = existing.split('\n').filter((l) => l.startsWith('- ')).slice(-40);
    return lines.length ? `Project memory (${lines.length} notes)\n${lines.join('\n')}` : 'Project memory is empty. Use action "add" with a "text" string.';
  }
  if (action === 'add') {
    const text = str(args.text);
    if (!text) return 'action "add" needs a "text" string.';
    const note = `- ${new Date().toISOString().slice(0, 10)}: ${text.replace(/\s+/g, ' ').trim()}`;
    if (existing.split('\n').some((l) => l.trim() === note)) return 'That note is already in project memory.';
    await fs.mkdir(path.dirname(memoryFile(root)), { recursive: true });
    const body = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${note}\n`;
    await fs.writeFile(memoryFile(root), body, 'utf8');
    return `Remembered: ${text.trim()}`;
  }
  if (action === 'clear') {
    await fs.rm(memoryFile(root), { force: true });
    return 'Project memory cleared.';
  }
  return 'Unknown remember action. Use add, list or clear.';
}

/**
 * The system-prompt section for this project's saved notes. Read at startup,
 * so a fact kept in one session is known in the next one without the user
 * repeating it.
 */
export async function memoryNote(root) {
  const text = await readMemory(root);
  const lines = text.split('\n').filter((l) => l.startsWith('- ')).slice(-40);
  if (!lines.length) return '';
  return (
    '\n\n## Project memory\nFacts and preferences the user asked you to keep for this project:\n' +
    lines.join('\n')
  );
}

/** Add the memory section to a system prompt, replacing any earlier copy so
 *  a resumed session never accumulates duplicates. */
export function withMemory(system, memory) {
  const base = String(system ?? '').replace(/\n\n## Project memory\n[\s\S]*$/, '');
  return memory ? base + memory : base;
}

/* ---------- 16. checkpoint (snapshot + rollback) ---------- */

function checkpointsDir(root) {
  return path.join(root, STATE_DIR, 'checkpoints');
}

async function listCheckpoints(root) {
  let names;
  try {
    names = await fs.readdir(checkpointsDir(root));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(checkpointsDir(root), name, 'manifest.json'), 'utf8'));
      out.push(manifest);
    } catch {
      /* a half-written checkpoint is not listed */
    }
  }
  return out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
}

async function createCheckpoint(root, paths) {
  let rels;
  let truncated = false;
  if (Array.isArray(paths) && paths.length) {
    rels = paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.replace(/\\/g, '/'));
  } else {
    const files = await filesUnder(root, { hidden: false, limit: 301 });
    truncated = files.length > 300;
    rels = files.slice(0, 300).map((f) => path.relative(root, f).split(path.sep).join('/'));
  }
  const entries = [];
  let total = 0;
  for (const rel of rels) {
    const full = resolve(root, rel);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      truncated = true;
      continue;
    }
    if (total + stat.size > 8 * 1024 * 1024) {
      truncated = true;
      break;
    }
    total += stat.size;
    entries.push({ path: rel, size: stat.size });
  }
  if (!entries.length) return 'Nothing to snapshot (no regular files under the size limit).';
  const id = Date.now().toString(36);
  const dir = path.join(checkpointsDir(root), id);
  for (const entry of entries) {
    const target = path.join(dir, 'files', entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(resolve(root, entry.path), target);
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, at: new Date().toISOString(), files: entries, total, truncated }, null, 2),
    'utf8'
  );
  return `Created checkpoint ${id} (${entries.length} file(s), ${bytes(total)}${truncated ? ', truncated' : ''}). /undo restores it.`;
}

async function restoreCheckpoint(root, id, allow) {
  const all = await listCheckpoints(root);
  if (!all.length) return 'No checkpoints yet. Ask the agent to run checkpoint with action "create" first.';
  const chosen = id ? all.find((c) => c.id === id) : all[0];
  if (!chosen) return `No checkpoint ${id}. Known: ${all.map((c) => c.id).join(', ')}.`;
  const ok = await allow(`Restore checkpoint ${chosen.id}`, `${chosen.files.length} file(s) will be overwritten`);
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  let restored = 0;
  const missing = [];
  for (const entry of chosen.files) {
    const source = path.join(checkpointsDir(root), chosen.id, 'files', entry.path);
    const target = resolve(root, entry.path);
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      restored++;
    } catch {
      missing.push(entry.path);
    }
  }
  return `Restored ${restored} file(s) from checkpoint ${chosen.id}${missing.length ? ` (${missing.length} could not be restored)` : ''}.`;
}

async function runCheckpoint(args, root, allow) {
  const action = str(args.action) || 'list';
  if (action === 'create') return createCheckpoint(root, args.paths);
  if (action === 'list') {
    const all = await listCheckpoints(root);
    if (!all.length) return 'No checkpoints yet.';
    return clip(
      all
        .slice(0, 20)
        .map((c) => `${c.id}  ${c.at}  ${c.files.length} file(s)${c.truncated ? ' (truncated)' : ''}`)
        .join('\n')
    );
  }
  if (action === 'restore') return restoreCheckpoint(root, str(args.id), allow);
  return 'Unknown checkpoint action. Use create, list or restore.';
}

/* ---------- 17. ports ---------- */

/** Listening TCP sockets from /proc/net/tcp{,6}. Exported for testing. */
export function parseProcNet(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [, local, , state] = cols;
    if (state !== '0A') continue; // LISTEN
    const portHex = local.split(':').pop();
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port)) continue;
    out.push({ port, addr: local.split(':')[0] });
  }
  return out;
}

async function runPorts(args, root) {
  const want = args.port === undefined || args.port === null ? null : int(args.port, 0);
  const found = [];
  let readable = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    readable = true;
    found.push(...parseProcNet(text));
  }
  if (!readable) return 'Port listing needs /proc/net/tcp (Linux/Android). On this machine, use bash: ss -ltn or lsof -iTCP -sTCP:LISTEN.';
  const ports = [...new Set(found.map((f) => f.port))].sort((a, b) => a - b);
  if (want) return `port ${want}: ${ports.includes(want) ? 'listening' : 'not listening'}.`;
  if (!ports.length) return 'No TCP ports are listening.';
  const labels = { 3000: 'common dev server', 8080: 'common HTTP alt', 5555: 'adb over network', 8788: 'wrangler dev', 3001: 'next dev alt' };
  const lines = ports.map((p) => `${p}${labels[p] ? `  (${labels[p]})` : ''}`);
  return clip(`listening TCP ports (${ports.length})\n${lines.join('\n')}\n\ncwd: ${path.basename(root)}`);
}

/* ---------- 18. sysinfo ---------- */

async function runSysinfo(root) {
  const lines = [];
  const load = os.loadavg().map((n) => n.toFixed(2)).join(', ');
  const termux = Boolean(process.env.PREFIX?.includes('com.termux') || process.env.TERMUX_VERSION);
  lines.push(`os: ${os.platform()} ${os.release()} (${os.arch()})`);
  lines.push(`node: ${process.version}`);
  lines.push(`cpus: ${os.cpus().length}${os.cpus()[0]?.model ? ` x ${os.cpus()[0].model.trim()}` : ''}`);
  lines.push(`load: ${load}`);
  lines.push(`memory: ${bytes(os.freemem())} free of ${bytes(os.totalmem())}`);
  lines.push(`uptime: ${Math.round(os.uptime() / 3600)}h`);
  lines.push(`shell: ${process.env.SHELL || '(unset)'}`);
  lines.push(`termux: ${termux ? 'yes' : 'no'}`);
  lines.push(`cwd: ${root}`);
  try {
    const stat = await fs.statfs(root);
    lines.push(`disk: ${bytes(stat.bavail * stat.bsize)} free of ${bytes(stat.blocks * stat.bsize)}`);
  } catch {
    lines.push('disk: unavailable');
  }
  return lines.join('\n');
}

/* ---------- schema + dispatch ---------- */

export const FRONTIER_SCHEMA = [
  {
    name: 'glob',
    description:
      'Find files by shell-style pattern (**/*.test.mjs, src/**/*.{js,ts}) anywhere in the workspace. Faster and more precise than listing directories one by one. Returns workspace-relative paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern like **/*.mjs; * stays within one path segment, ** crosses them, {a,b} is either.' },
        path: { type: 'string', description: 'Subdirectory to search from. Defaults to the workspace root.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_range',
    description:
      'Read a window of lines from a file with line numbers. Use this instead of read_file for a big file: start/end are 1-based and inclusive, at most 2000 lines per call.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start: { type: 'number', description: 'First line, 1-based. Defaults to 1.' },
        end: { type: 'number', description: 'Last line, inclusive. Defaults to start + 199.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_info',
    description: 'Size, line count, language, mode, modified time and sha256 of a file, without reading its contents into the conversation.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'outline',
    description:
      'List the symbols in one source file with line numbers — functions, classes, types, methods — for JS/TS, Python, Rust, Go, shell and Ruby. Use it to find the right lines before reading or editing.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'repo_map',
    description:
      'One-shot overview of the project: file count and size, languages, package manager, manifests, entry points, npm scripts and the busiest directories. Call it first in an unfamiliar repo.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory inside the workspace, creating parent folders as needed. Needs approval. Refuses to overwrite an existing path.',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file, or a directory with recursive: true. Needs approval. Refuses the workspace root, symlinks and a non-empty directory without recursive.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'make_dir',
    description: 'Create a directory, including missing parents. Needs approval.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'diff_files',
    description:
      'Unified diff of two files (a vs b), or of one file against its last committed version in git when b is omitted. Read-only; use it to check your own edit.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string', description: 'Optional second file. Omit to diff against HEAD.' } },
      required: ['a'],
    },
  },
  {
    name: 'git',
    description:
      'Read-only git: status, log, diff, show, branch, remote, ls-files, blame, describe, shortlog, tag --list. Pass subcommand and optional args. Writes (commit, push, reset, checkout) are refused — use bash for those.',
    parameters: {
      type: 'object',
      properties: {
        subcommand: { type: 'string', description: 'e.g. status, log, diff, show HEAD~1, ls-files' },
        args: { type: 'string', description: 'Flags and paths as one string, e.g. "--stat HEAD~1" or "src/app.js".' },
      },
      required: ['subcommand'],
    },
  },
  {
    name: 'http_request',
    description:
      'Call an HTTP API directly and get status, content-type and the body (JSON is pretty-printed). Supports GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS with headers, body or json. Non-GET methods need approval. 20s timeout.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'Defaults to GET.' },
        headers: { type: 'object', description: 'Extra request headers.' },
        body: { type: 'string', description: 'Raw request body.' },
        json: { description: 'JSON body; sent with Content-Type: application/json.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'download_file',
    description: 'Download an http(s) URL into the workspace at path (up to 25 MB), creating parent folders. Needs approval. Returns size and sha256.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, path: { type: 'string' } },
      required: ['url', 'path'],
    },
  },
  {
    name: 'json_query',
    description:
      'Read one value out of JSON without loading the whole thing into context. Give path (a .json file) or json (a string), plus query like "scripts.test" or "items[0].name". No query lists the top-level keys.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A .json file in the workspace.' },
        json: { type: 'string', description: 'JSON text instead of a file.' },
        query: { type: 'string', description: 'Dot/bracket path, e.g. dependencies.react or items[2].id.' },
      },
    },
  },
  {
    name: 'todo',
    description:
      'Keep a structured task list for this job under .termux-code/todo.json. action: read, write (items), add (text), done (index, 1-based), clear. Use it for multi-step work so the plan stays visible.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'add', 'done', 'clear'] },
        items: { type: 'array', items: { type: 'string' }, description: 'For write: the tasks in order.' },
        text: { type: 'string', description: 'For add: the task text.' },
        index: { type: 'number', description: 'For done: which task, 1-based.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'remember',
    description:
      'Save a durable fact or preference for this project under .termux-code/memory.md; it is added to the system prompt at the start of every later session. action: add (text), list, clear.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'clear'] },
        text: { type: 'string', description: 'For add: the fact to keep, one line.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'checkpoint',
    description:
      'Snapshot files so a risky change can be rolled back. action create (optionally paths) copies up to 300 files/8 MB under .termux-code/checkpoints; list shows them; restore (needs approval) writes them back, newest by default. /undo in the REPL does the same.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'restore'] },
        paths: { type: 'array', items: { type: 'string' }, description: 'For create: specific files. Omit to snapshot the workspace.' },
        id: { type: 'string', description: 'For restore: a checkpoint id. Defaults to the newest.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ports',
    description: 'List TCP ports listening on this machine (from /proc), or check one with port. Use it to see whether a dev server actually came up.',
    parameters: { type: 'object', properties: { port: { type: 'number', description: 'Optional single port to check.' } } },
  },
  {
    name: 'sysinfo',
    description: 'Machine facts: OS, arch, node version, cpu count, load, memory, uptime, shell, Termux detection and free disk. Use it before blaming the machine for a failure.',
    parameters: { type: 'object', properties: {} },
  },
];

/**
 * Run one frontier tool. Returns a string, or null when `name` is not one of
 * these (so lib/tools.mjs can keep its own switch authoritative).
 */
export async function runFrontierTool(name, args = {}, ctx = {}) {
  const root = ctx.root;
  const allow =
    typeof ctx.approve === 'function'
      ? (desc, detail) => ctx.approve(desc, detail)
      : async () => true;
  if (!root) return 'This tool needs a workspace root.';

  switch (name) {
    case 'glob':
      return runGlob(args, root);
    case 'read_range':
      return runReadRange(args, root);
    case 'file_info':
      return runFileInfo(args, root);
    case 'outline':
      return runOutline(args, root);
    case 'repo_map':
      return runRepoMap(root);
    case 'move_file':
      return runMoveFile(args, root, allow);
    case 'delete_file':
      return runDeleteFile(args, root, allow);
    case 'make_dir':
      return runMakeDir(args, root, allow);
    case 'diff_files':
      return runDiffFiles(args, root);
    case 'git':
      return runGitTool(args, root);
    case 'http_request':
      return runHttpRequest(args, root, allow);
    case 'download_file':
      return runDownloadFile(args, root, allow);
    case 'json_query':
      return runJsonQuery(args, root);
    case 'todo':
      return runTodo(args, root);
    case 'remember':
      return runRemember(args, root);
    case 'checkpoint':
      return runCheckpoint(args, root, allow);
    case 'ports':
      return runPorts(args, root);
    case 'sysinfo':
      return runSysinfo(root);
    default:
      return null;
  }
}
