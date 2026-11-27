/**
 * The agent's tools. Filesystem work is confined to the directory the CLI was
 * launched in — paths that escape it are rejected before anything is read or
 * written. Shell commands and writes go through an approval callback so nothing
 * touches your phone without you seeing it first.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { runBrowser } from './browser.mjs';
import { runPhone } from './phone.mjs';
import { DEVICE_TOOL, runDevice } from './device.mjs';
import { applyPatchText, parsePatch } from './patch.mjs';
import { ddgSearch, fetchUrlText } from './web.mjs';
import { detectVerifyCommand } from './verify.mjs';
import { FRONTIER_SCHEMA, runFrontierTool } from './frontier.mjs';
import { RECON_TOOL, runReconTool } from './recon.mjs';
import { SECURITY_AUDIT_TOOL, auditWorkspace } from './security-audit.mjs';

const MAX_READ = 120_000;
const MAX_OUTPUT = 20_000;
const CMD_TIMEOUT = 60_000;
// grep bounds: a file bigger than this is skipped rather than read
// whole into memory, and the whole scan gives up at the deadline and
// returns what it has. A search must never be the thing that hangs
// the session (see the grep case below for the failure this prevents).
const GREP_MAX_FILE_BYTES = 1_000_000;
const GREP_DEADLINE_MS = 15_000;

const CORE_TOOL_SCHEMA = [
  {
    name: 'list_dir',
    description: 'List files and folders at a path relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path. Defaults to "."' } },
    },
  },
  {
    name: 'project_map',
    description: 'Quick read-only overview of a repository: bounded file tree, key manifest scripts. Use this before planning a multi-file change.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative folder; defaults to workspace root.' } } },
  },
  {
    name: 'read_files',
    description: 'Read 1-8 repository files in one call, capped to fit model context. Missing or oversized files are reported independently.',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } }, required: ['paths'] },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file. Returns the contents with line numbers.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a file or replace its entire contents. Needs approval.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact string in a file. old_string must appear exactly once unless replace_all is true. Needs approval. Returns the edited lines so you can check the result.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'multi_edit',
    description:
      'Make several exact-string replacements in ONE file in one step. Edits apply in order; if any edit fails to match, nothing is written. Needs approval. Prefer this over several edit_file calls on the same file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'apply_patch',
    description:
      'Apply a unified diff (--- a/file, +++ b/file, @@ hunks) across one or more files. Use /dev/null to create or delete a file. Context lines must match; small line-number drift is tolerated. All-or-nothing. Needs approval.',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents for a regular expression across the workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory to search. Defaults to "."' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Use for git, npm, pkg, tests. Needs approval.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web (DuckDuckGo) and return the top results: title, real URL and snippet. No key, no browser install, no gateway — it is a plain HTTP GET, so it works anywhere. Use it for anything current or outside this workspace, then read a result with fetch_url.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch an http(s) page and return its text, markup stripped (JSON and plain text come back as-is). Works with no key and no browser, and JavaScript-only or bot-checked pages (claude.ai, app sites) are re-read through a text reader. Use it whenever the user names a URL, and to ground an answer in the real page instead of guessing — quote what it says.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL.' } },
      required: ['url'],
    },
  },
  {
    name: 'run_tests',
    description:
      "Run the project's own check (package.json test script, make test, pytest, cargo test, go test) and return its output. Needs approval. Use this instead of guessing a command, and read the failure before changing code.",
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Optional override; defaults to the detected check.' } },
      required: [],
    },
  },
  {
    name: 'task',
    description:
      'Spawn a sub-agent with a fresh context for one focused job (read a repo, research something, draft code) and get a short report back. It cannot see this conversation — put everything it needs in prompt and context.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The one job for the sub-agent.' },
        context: { type: 'string', description: 'Extra facts it needs (paths, constraints, what you already know).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'phone',
    description: 'Android phone capabilities through Termux:API. status checks installed commands; own_number reads carrier-exposed number only with approval; send_sms requires approval; compose_email opens an editable email draft in the installed Android email app, without sending. Never claims to create a new phone number or email account.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'own_number', 'send_sms', 'compose_email'] },
        to: { type: 'string', description: 'SMS phone number or email recipient.' },
        subject: { type: 'string', description: 'Required for compose_email.' },
        message: { type: 'string', description: 'Required for send_sms and compose_email.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser',
    description:
      'Drive the phone\'s own Chromium browser (lib/browser.mjs). action: open (load a url), read (current page text — pass a url to read a page directly), screenshot (save a PNG into the workspace), click (a CSS selector, or text=visible text), type (selector + text), scroll (direction up/down, amount in px). click and type need approval; open, read, screenshot and scroll do not. Without Chromium installed, open/read fall back to a gateway fetch and the rest report the pkg install line.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'read', 'screenshot', 'click', 'type', 'scroll'] },
        url: { type: 'string', description: 'Full http(s) URL. Required for open; optional for read/screenshot/click/type (defaults to the open page).' },
        selector: { type: 'string', description: 'CSS selector, or text=visible text to match. Required for click and type.' },
        text: { type: 'string', description: 'Text to type. Required for type.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction. Defaults to down.' },
        amount: { type: 'number', description: 'Scroll distance in pixels. Defaults to 800.' },
        path: { type: 'string', description: 'Screenshot output path inside the workspace. Defaults to browser-screenshot.png.' },
      },
      required: ['action'],
    },
  },
  RECON_TOOL,
  DEVICE_TOOL,
  SECURITY_AUDIT_TOOL,
];

/**
 * The tools the model is offered: the core file/shell/browser set above, then
 * the frontier set from lib/frontier.mjs (repo intelligence, safe surgery,
 * HTTP, notes and rollback). Keeping them in a second module means a new tool
 * is one schema entry plus one case, not another 60 lines in this switch.
 */
export const TOOL_SCHEMA = [...CORE_TOOL_SCHEMA, ...FRONTIER_SCHEMA];

const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);

function resolve(root, rel = '.') {
  const full = path.resolve(root, rel);
  const bounded = full === root || full.startsWith(root + path.sep);
  if (!bounded) throw new Error(`Path is outside the workspace: ${rel}`);
  return full;
}

function clip(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n... truncated, ${text.length - limit} more characters`;
}

async function walk(dir, root, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    // Regular files only, and symlinks are never followed. Anything
    // else — a FIFO, a device, a socket, a link to any of those or to
    // a directory outside the tree — used to be handed to readFile by
    // the grep tool: reading a FIFO blocks until a writer shows up,
    // which on a phone workspace is never, so one stray pipe file
    // hung the whole session with no timeout anywhere to save it.
    else if (e.isFile() && !e.isSymbolicLink()) out.push(full);
    if (out.length > 4000) return out;
  }
  return out;
}

/**
 * Tool arguments come from a model, so nothing is guaranteed to have the
 * JSON type the schema asked for. `exec` throws a TypeError on a non-string
 * command and fs throws on a non-string path, and the model is then handed a
 * Node internals message that tells it nothing — so it repeats the same call
 * (seen live 2026-11-22: three identical failing `bash` calls in one turn).
 * Normalise here and answer with what to send instead.
 */
function commandText(value) {
  if (typeof value === 'string') return value.trim() ? value : null;
  // Models often send argv as an array; joining with spaces is what a shell
  // would have done with it.
  if (Array.isArray(value) && value.length && value.every((v) => typeof v === 'string')) {
    return value.join(' ').trim() || null;
  }
  return null;
}

/** A filesystem argument, or null when the model sent something else. */
function pathText(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** How to name a malformed argument back to the model. */
function describeArg(value) {
  let shown;
  try {
    shown = JSON.stringify(value);
  } catch {
    shown = String(value);
  }
  if (shown === undefined) shown = value === undefined ? 'nothing' : String(value);
  return shown.length > 120 ? `${shown.slice(0, 120)}…` : shown;
}

/** Run a shell command in the workspace (also used by the verify step,
 *  which needs a longer timeout than an interactive command). */
export function run(command, cwd, timeoutMs = CMD_TIMEOUT) {
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.resolve('Command must be a string of shell text.');
  }
  return new Promise((resolvePromise) => {
    const child = exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8, shell: '/bin/sh' },
      (err, stdout, stderr) => {
        const body = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && err.killed) return resolvePromise(`Command timed out after ${Math.round(timeoutMs / 1000)}s.\n${body}`);
        const code = err ? (err.code ?? 1) : 0;
        resolvePromise(clip(`exit ${code}\n${body || '(no output)'}`));
      }
    );
    // Close the child's stdin NOW. exec() pipes stdin and leaves it
    // open (its stdio option does not change that), so a command that
    // reads stdin — a bare `grep pattern` with no file target, `cat`
    // with no file — used to sit waiting on that pipe until the 60s
    // timeout killed it: a full minute of "stuck" per call, and the
    // model would often retry it. EOF at once means it answers (or
    // exits) immediately, like it would in a real terminal.
    child.stdin?.end();
  });
}

/** Lines [from, to] (1-based, inclusive) with numbers, for showing an edit. */
export function excerptLines(text, from, to, pad = 2) {
  const lines = text.split('\n');
  const a = Math.max(1, from - pad);
  const b = Math.min(lines.length, to + pad);
  const out = [];
  for (let i = a; i <= b; i++) out.push(`${String(i).padStart(5)}\t${lines[i - 1]}`);
  return out.join('\n');
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Apply exact-string edits to text in memory. Returns { text, spans } or
 * { error }. spans are [startIndex, endIndex] of each inserted new_string
 * in the FINAL text, for the post-edit excerpt.
 */
export function applyEdits(text, edits) {
  let cur = text;
  const spans = [];
  for (let n = 0; n < edits.length; n++) {
    const e = edits[n] || {};
    const label = edits.length > 1 ? `Edit ${n + 1}: ` : '';
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      return { error: `${label}old_string and new_string must both be strings.` };
    }
    if (e.old_string === '') return { error: `${label}old_string is empty. Use write_file to create a file.` };
    if (e.old_string === e.new_string) return { error: `${label}old_string and new_string are identical; nothing to change.` };
    const hits = cur.split(e.old_string).length - 1;
    if (hits === 0) {
      const ws = cur.replace(/[ \t]+/g, ' ').includes(e.old_string.replace(/[ \t]+/g, ' '));
      return {
        error: `${label}old_string was not found.${ws ? ' It matches if whitespace is ignored — copy the exact indentation from read_file.' : ' Read the file again and retry.'}`,
      };
    }
    if (hits > 1 && !e.replace_all) {
      return { error: `${label}old_string appears ${hits} times. Add surrounding context to make it unique, or set replace_all.` };
    }
    // Every hit position in the CURRENT text (just the first unless replace_all).
    const hitsAt = [];
    for (let from = 0, i; (i = cur.indexOf(e.old_string, from)) !== -1; from = i + e.old_string.length) {
      hitsAt.push(i);
      if (!e.replace_all) break;
    }
    const delta = e.new_string.length - e.old_string.length;
    // Remap earlier spans: each hit before a span moves it by delta.
    for (const sp of spans) {
      const before = hitsAt.filter((h) => h < sp[0]).length;
      sp[0] += before * delta;
      sp[1] += before * delta;
    }
    let out = '';
    let from = 0;
    hitsAt.forEach((h, k) => {
      out += cur.slice(from, h) + e.new_string;
      const start = h + k * delta;
      spans.push([start, start + e.new_string.length]);
      from = h + e.old_string.length;
    });
    cur = out + cur.slice(from);
  }
  return { text: cur, spans };
}

/**
 * Cheap syntax check after a write, for the file types where one is
 * reliable and fast on a phone. Returns an error string or ''.
 */
export async function syntaxCheck(file, text) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text);
      return '';
    } catch (e) {
      return `JSON syntax error: ${e.message}`;
    }
  }
  const cmd =
    ['.js', '.mjs', '.cjs'].includes(ext) ? [process.execPath, ['--check', file]]
    : ext === '.py' ? ['python3', ['-m', 'py_compile', file]]
    : ext === '.sh' ? ['sh', ['-n', file]]
    : null;
  if (!cmd) return '';
  return new Promise((done) => {
    execFile(cmd[0], cmd[1], { timeout: 10_000 }, (err, _out, stderr) => {
      if (!err) return done('');
      if (err.code === 'ENOENT') return done(''); // checker not installed — skip, don't fail
      done(`Syntax check failed:\n${clip(String(stderr || err.message).trim(), 1500)}`);
    });
  });
}

/**
 * Re-read a file after a write and report what is actually on disk: the
 * edited lines with numbers, and a syntax error if there is one. The
 * model sees the real result instead of trusting that the write did what
 * it meant — mismatched indentation and broken brackets show up here,
 * one step after they happen, instead of three steps later.
 */
async function verifyWrite(file, rel, expected, spans) {
  const actual = await fs.readFile(file, 'utf8');
  if (actual !== expected) {
    return `WARNING: ${rel} on disk does not match what was written (another process changed it?). Read it again before continuing.`;
  }
  const parts = [];
  if (spans?.length) {
    const ranges = spans
      .map(([a, b]) => [lineOf(actual, a), lineOf(actual, Math.max(a, b - 1))])
      .sort((x, y) => x[0] - y[0]);
    // Merge overlapping/near ranges so the excerpt stays short.
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 5) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    const shown = merged.slice(0, 6).map(([a, b]) => excerptLines(actual, a, Math.min(b, a + 40)));
    parts.push(shown.join('\n  ...\n'));
    if (merged.length > 6) parts.push(`  ... and ${merged.length - 6} more edited regions`);
  }
  const syntax = await syntaxCheck(file, actual);
  if (syntax) parts.push(syntax);
  return parts.join('\n');
}

/**
 * @param {string} name
 * @param {object} args
 * @param {{root:string, approve:(desc:string, detail:string)=>Promise<boolean>, gateway?:string, gatewayToken?:string, browserDeps?:object}} ctx
 *   gateway/gatewayToken/browserDeps are only used by the browser tool:
 *   the gateway pair powers its no-Chromium read fallback, browserDeps
 *   is the test seam lib/browser.mjs injects its plumbing through.
 */
export async function runTool(name, args, ctx) {
  const { root, approve } = ctx;

  switch (name) {
    case 'security_audit':
      return JSON.stringify(await auditWorkspace(root), null, 2);
    case 'project_map': {
      const rel = args.path == null ? '.' : pathText(args.path);
      if (!rel) return 'project_map path must be a string.';
      const start = resolve(root, rel);
      const queue = [[start, 0]];
      const lines = [];
      while (queue.length && lines.length < 200) {
        const [dir, depth] = queue.shift();
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch (err) { return 'Could not map ' + rel + ': ' + err.message; }
        for (const e of entries.sort((a,b) => a.name.localeCompare(b.name))) {
          if (e.name.startsWith('.') || IGNORE.has(e.name) || e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          lines.push(path.relative(root, full) + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && depth < 3) queue.push([full, depth + 1]);
          if (lines.length >= 200) break;
        }
      }
      let scripts = '';
      try {
        const pkg = JSON.parse(await fs.readFile(resolve(root, 'package.json'), 'utf8'));
        scripts = '\npackage.json scripts: ' + JSON.stringify(pkg.scripts || {}).slice(0, 2000);
      } catch { /* this may not be a JS project */ }
      return clip('Workspace map (' + rel + '):\n' + lines.join('\n') + (queue.length ? '\n... more files omitted' : '') + scripts);
    }

    case 'read_files': {
      if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 8 ||
          args.paths.some(p => typeof p !== 'string' || !p.trim())) {
        return 'read_files needs paths: an array of 1-8 relative file names.';
      }
      const reports = [];
      for (const rel of args.paths) {
        let file;
        try { file = resolve(root, rel); }
        catch (err) { reports.push(rel + ': ' + err.message); continue; }
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile()) { reports.push(rel + ': not a regular file'); continue; }
          if (stat.size > MAX_READ) { reports.push(rel + ': too large (' + stat.size + ' bytes)'); continue; }
          const body = await fs.readFile(file, 'utf8');
          const numbered = body.slice(0, 5000).split('\n').map((line,i) => (i+1) + ': ' + line).join('\n');
          reports.push('--- ' + rel + ' ---\n' + numbered + (body.length > 5000 ? '\n... truncated' : ''));
        } catch (err) { reports.push(rel + ': ' + err.message); }
      }
      return clip(reports.join('\n\n'));
    }

    case 'list_dir': {
      const rel = args.path === undefined || args.path === null ? '.' : pathText(args.path);
      if (!rel) return `path must be a string. You sent ${describeArg(args.path)}.`;
      const dir = resolve(root, rel);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !IGNORE.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.length ? lines.join('\n') : '(empty directory)';
    }

    case 'read_file': {
      const rel = pathText(args.path);
      if (!rel) return `path must be a string. You sent ${describeArg(args.path)}.`;
      const file = resolve(root, rel);
      const stat = await fs.stat(file);
      if (stat.size > MAX_READ) return `File is ${stat.size} bytes, too large to read whole.`;
      const text = await fs.readFile(file, 'utf8');
      return clip(
        text
          .split('\n')
          .map((l, i) => `${String(i + 1).padStart(5)}\t${l}`)
          .join('\n')
      );
    }

    case 'write_file': {
      if (typeof args.content !== 'string') return 'content must be a string.';
      const rel = pathText(args.path);
      if (!rel) return `path must be a string. You sent ${describeArg(args.path)}.`;
      const file = resolve(root, rel);
      const exists = await fs.stat(file).then(() => true, () => false);
      const ok = await approve(
        `${exists ? 'Overwrite' : 'Create'} ${args.path}`,
        clip(args.content, 1200)
      );
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content, 'utf8');
      const check = await verifyWrite(file, args.path, args.content, null);
      const lines = args.content.split('\n').length;
      return `Wrote ${lines} lines (${args.content.length} characters) to ${args.path}.${check ? `\n${check}` : ''}`;
    }

    case 'edit_file':
    case 'multi_edit': {
      const rel = pathText(args.path);
      if (!rel) return `path must be a string. You sent ${describeArg(args.path)}.`;
      const file = resolve(root, rel);
      const edits = name === 'edit_file'
        ? [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all === true }]
        : Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length) return 'edits must be a non-empty array of {old_string, new_string}.';
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (e) {
        return e.code === 'ENOENT' ? `${args.path} does not exist. Use write_file to create it.` : `Could not read ${args.path}: ${e.message}`;
      }
      const result = applyEdits(text, edits);
      if (result.error) return `${result.error} Nothing was written.`;
      const preview = edits
        .map((e) => `- ${clip(e.old_string, 400)}\n+ ${clip(e.new_string, 400)}`)
        .join('\n\n');
      const ok = await approve(
        `Edit ${args.path}${edits.length > 1 ? ` (${edits.length} changes)` : ''}`,
        clip(preview, 1600)
      );
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      await fs.writeFile(file, result.text, 'utf8');
      const check = await verifyWrite(file, args.path, result.text, result.spans);
      return `Edited ${args.path}${edits.length > 1 ? ` (${edits.length} changes)` : ''}. Now on disk:\n${check}`;
    }

    case 'apply_patch': {
      if (typeof args.patch !== 'string' || !args.patch.trim()) return 'patch must be a unified diff string.';
      let files;
      try {
        files = parsePatch(args.patch);
      } catch (e) {
        return `Could not parse the patch: ${e.message}`;
      }
      if (!files.length) return 'The patch contains no file changes. Use --- a/path, +++ b/path and @@ hunk headers.';
      // Resolve and apply everything in memory first: all-or-nothing.
      const planned = [];
      for (const f of files) {
        const rel = f.newPath ?? f.oldPath;
        const target = resolve(root, rel);
        let before = '';
        if (f.oldPath !== null) {
          try {
            before = await fs.readFile(resolve(root, f.oldPath), 'utf8');
          } catch (e) {
            return `${f.oldPath}: ${e.code === 'ENOENT' ? 'does not exist' : e.message}. Nothing was written.`;
          }
        }
        const applied = applyPatchText(before, f.hunks);
        if (applied.error) return `${rel}: ${applied.error} Nothing was written.`;
        planned.push({ f, rel, target, before, after: applied.text, spans: applied.spans });
      }
      const summary = planned
        .map((p) => (p.f.newPath === null ? `delete ${p.rel}` : p.f.oldPath === null ? `create ${p.rel}` : `modify ${p.rel}`))
        .join(', ');
      const ok = await approve(`Apply patch: ${summary}`, clip(args.patch, 1600));
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      const reports = [];
      for (const p of planned) {
        if (p.f.newPath === null) {
          await fs.unlink(resolve(root, p.f.oldPath));
          reports.push(`Deleted ${p.rel}.`);
          continue;
        }
        await fs.mkdir(path.dirname(p.target), { recursive: true });
        await fs.writeFile(p.target, p.after, 'utf8');
        if (p.f.oldPath !== null && p.f.oldPath !== p.f.newPath) await fs.unlink(resolve(root, p.f.oldPath));
        const check = await verifyWrite(p.target, p.rel, p.after, p.spans);
        reports.push(`${p.f.oldPath === null ? 'Created' : 'Patched'} ${p.rel}.${check ? `\n${check}` : ''}`);
      }
      return clip(reports.join('\n\n'));
    }

    case 'grep': {
      const pattern = pathText(args.pattern);
      if (!pattern) return `pattern must be a string. You sent ${describeArg(args.pattern)}.`;
      const rel = args.path === undefined || args.path === null ? '.' : pathText(args.path);
      if (!rel) return `path must be a string. You sent ${describeArg(args.path)}.`;
      const dir = resolve(root, rel);
      let re;
      try {
        re = new RegExp(pattern, 'i');
      } catch (e) {
        return `Invalid regular expression: ${e.message}`;
      }
      // Bounded on purpose: walk() yields regular files only (no
      // FIFOs/devices/symlinks — reading one of those is what used to
      // hang this tool forever), oversized files are skipped instead
      // of being read whole, binary files are skipped after a NUL
      // sniff, and the scan stops at GREP_DEADLINE_MS and returns
      // what it has rather than running unbounded.
      const files = await walk(dir, root);
      const hits = [];
      const deadline = Date.now() + GREP_DEADLINE_MS;
      let truncated = false;
      for (const f of files) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        let buf;
        try {
          const stat = await fs.stat(f);
          if (!stat.isFile() || stat.size > GREP_MAX_FILE_BYTES) continue;
          buf = await fs.readFile(f);
        } catch {
          continue;
        }
        if (buf.subarray(0, 8192).includes(0)) continue; // binary — not searchable text
        buf
          .toString('utf8')
          .split('\n')
          .forEach((line, i) => {
            if (re.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
          });
        if (hits.length > 200) break;
      }
      const note = truncated ? '\n... search stopped at the 15s limit, results may be incomplete' : '';
      return hits.length ? clip(hits.join('\n')) + note : truncated ? `No matches found before the 15s search limit.` : 'No matches.';
    }

    case 'bash': {
      const command = commandText(args.command);
      if (!command) {
        return `bash needs "command" as one string of shell text, e.g. {"command": "node -v"}. You sent ${describeArg(args.command)}.`;
      }
      const ok = await approve('Run a shell command', command);
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      return run(command, root);
    }

    case 'run_tests': {
      const cmd = commandText(args.command) || (await detectVerifyCommand(root));
      if (!cmd) {
        return 'No test command found here: no package.json test script, no Makefile test target, no pytest/cargo/go project.';
      }
      const ok = await approve('Run the project checks', cmd);
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      return run(cmd, root);
    }

    case 'task': {
      const prompt = commandText(args.prompt);
      if (!prompt) return 'task needs a "prompt" string: the one job for the sub-agent.';
      if (typeof ctx.spawn !== 'function') return 'Sub-agents are not available in this session.';
      return ctx.spawn(prompt, commandText(args.context));
    }

    case 'web_search': {
      const query = commandText(args.query);
      if (!query) return 'web_search needs a "query" string.';
      return ddgSearch(query);
    }

    case 'fetch_url': {
      const url = commandText(args.url);
      if (!url) return 'fetch_url needs a "url" string, e.g. {"url": "https://example.com"}.';
      return fetchUrlText(url);
    }

    case 'phone': {
      return runPhone(args, ctx, ctx.phoneDeps || {});
    }

    case 'device': {
      return runDevice(args, ctx, ctx.deviceDeps || {});
    }

    case 'recon_anything': {
      return runReconTool(args, ctx);
    }

    case 'browser': {
      // All of the browser logic (CDP session, one-shot fallback,
      // gateway fallback, its own approval gate for click/type) lives
      // in lib/browser.mjs; this is only the dispatch.
      return runBrowser(args, ctx, ctx.browserDeps || {});
    }

    default: {
      const frontier = await runFrontierTool(name, args, ctx);
      if (frontier !== null) return frontier;
      return `Unknown tool: ${name}`;
    }
  }
}

/** OpenAI function-calling shape. */
export function toolsForOpenAI() {
  return TOOL_SCHEMA.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Anthropic messages shape. */
export function toolsForAnthropic() {
  return TOOL_SCHEMA.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
