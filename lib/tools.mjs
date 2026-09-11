/**
 * The agent's tools. Filesystem work is confined to the directory the CLI was
 * launched in — paths that escape it are rejected before anything is read or
 * written. Shell commands and writes go through an approval callback so nothing
 * touches your phone without you seeing it first.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

const MAX_READ = 120_000;
const MAX_OUTPUT = 20_000;
const CMD_TIMEOUT = 60_000;

export const TOOL_SCHEMA = [
  {
    name: 'list_dir',
    description: 'List files and folders at a path relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path. Defaults to "."' } },
    },
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
      'Replace one exact string in a file. old_string must appear exactly once. Needs approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
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
];

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
    else out.push(full);
    if (out.length > 4000) return out;
  }
  return out;
}

function run(command, cwd) {
  return new Promise((resolvePromise) => {
    exec(
      command,
      { cwd, timeout: CMD_TIMEOUT, maxBuffer: 1024 * 1024 * 8, shell: '/bin/sh' },
      (err, stdout, stderr) => {
        const body = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && err.killed) return resolvePromise(`Command timed out after 60s.\n${body}`);
        const code = err ? (err.code ?? 1) : 0;
        resolvePromise(clip(`exit ${code}\n${body || '(no output)'}`));
      }
    );
  });
}

/**
 * @param {string} name
 * @param {object} args
 * @param {{root:string, approve:(desc:string, detail:string)=>Promise<boolean>}} ctx
 */
export async function runTool(name, args, ctx) {
  const { root, approve } = ctx;

  switch (name) {
    case 'list_dir': {
      const dir = resolve(root, args.path || '.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries
        .filter((e) => !IGNORE.has(e.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.length ? lines.join('\n') : '(empty directory)';
    }

    case 'read_file': {
      const file = resolve(root, args.path);
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
      const file = resolve(root, args.path);
      const exists = await fs.stat(file).then(() => true, () => false);
      const ok = await approve(
        `${exists ? 'Overwrite' : 'Create'} ${args.path}`,
        clip(args.content, 1200)
      );
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, args.content, 'utf8');
      return `Wrote ${args.content.length} characters to ${args.path}.`;
    }

    case 'edit_file': {
      const file = resolve(root, args.path);
      const text = await fs.readFile(file, 'utf8');
      const hits = text.split(args.old_string).length - 1;
      if (hits === 0) return 'old_string was not found. Read the file again and retry.';
      if (hits > 1) return `old_string appears ${hits} times. Add surrounding context to make it unique.`;
      const ok = await approve(
        `Edit ${args.path}`,
        `- ${clip(args.old_string, 500)}\n+ ${clip(args.new_string, 500)}`
      );
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      await fs.writeFile(file, text.replace(args.old_string, args.new_string), 'utf8');
      return `Edited ${args.path}.`;
    }

    case 'grep': {
      const dir = resolve(root, args.path || '.');
      let re;
      try {
        re = new RegExp(args.pattern, 'i');
      } catch (e) {
        return `Invalid regular expression: ${e.message}`;
      }
      const files = await walk(dir, root);
      const hits = [];
      for (const f of files) {
        let text;
        try {
          text = await fs.readFile(f, 'utf8');
        } catch {
          continue;
        }
        text.split('\n').forEach((line, i) => {
          if (re.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
        });
        if (hits.length > 200) break;
      }
      return hits.length ? clip(hits.join('\n')) : 'No matches.';
    }

    case 'bash': {
      const ok = await approve('Run a shell command', args.command);
      if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
      return run(args.command, root);
    }

    default:
      return `Unknown tool: ${name}`;
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
