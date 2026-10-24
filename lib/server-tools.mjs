/**
 * Server-side tools for the hosted chatbot.
 *
 * Unlike lib/tools.mjs (which runs on the phone, under the CLI user's own
 * yes/no), these run HERE, in the hosted app's environment, and are only
 * reachable through /api/bot/chat behind the owner's GitHub session. Every
 * call is audit-logged (lib/audit.mjs) with the owner login and an argument
 * summary. The tools:
 *
 *   - github_api  — api.github.com as the owner. Token from GITHUB_TOKEN
 *                   (the owner's own token, server env only, never sent to
 *                   the browser and never logged). Host is hardcoded, so
 *                   the model can only ever talk to GitHub's API.
 *   - venice_api  — api.venice.ai as the owner, key from VENICE_API_KEY.
 *                   This is what the vendored Venice skills (skills/venice/)
 *                   describe: the model reads a skill, then calls the API
 *                   surface it documents through this one tool.
 *   - run_terminal— a shell in a sandboxed directory on the host
 *                   (TERMINAL_SANDBOX_DIR or ./.sandbox), 30s cap, with a
 *                   scrubbed environment: no provider keys are passed in.
 *   - fetch_url   — read a web page as text (http/https only).
 *   - web_search  — DuckDuckGo HTML search, no key required.
 *   - list_skills / read_skill — the vendored Venice skills, loaded on
 *                   demand exactly as the Agent Skills format intends.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.mjs';
import { listSkills, loadSkill } from './skills.mjs';

const MAX_RESULT = 16_000;
const FETCH_TIMEOUT_MS = 20_000;
const TERMINAL_TIMEOUT_MS = 30_000;

function clip(text, max = MAX_RESULT) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + `\n… [truncated at ${max} chars]` : s;
}

export const SERVER_TOOL_SCHEMA = [
  {
    name: 'github_api',
    description:
      'Call the GitHub API as the signed-in owner (jaykk99). method: GET/POST/PATCH/PUT/DELETE. path: an api.github.com path like /user, /user/repos, /repos/jaykk99/termux-code/contents/README.md. body: optional JSON object for writes. Returns the HTTP status and JSON response.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'Path on api.github.com, starting with /' },
        body: { type: 'object', description: 'Optional JSON body for write methods' },
      },
      required: ['path'],
    },
  },
  {
    name: 'venice_api',
    description:
      'Call the Venice AI API with the server key. path: a path under https://api.venice.ai/api/v1 like /models, /billing/balance, /image/generate, /audio/speech, /embeddings. Read the matching skill first (read_skill) for the exact request shape. Returns the HTTP status and response.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'] },
        path: { type: 'string', description: 'Path under /api/v1, starting with /' },
        body: { type: 'object', description: 'Optional JSON body for POST' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_terminal',
    description:
      'Run a shell command on the server, inside a sandboxed working directory. 30 second limit. Provider API keys are NOT present in this environment. Returns the exit code and combined output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch an http(s) URL server-side and return its text content (HTML stripped).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo). Returns the top results with titles, URLs and snippets.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'list_skills',
    description: 'List the Venice API skills available to load (name + what each covers).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_skill',
    description:
      'Load the full instructions of one Venice skill by name (from list_skills). Load the relevant skill BEFORE calling venice_api for that surface.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

/** OpenAI function-calling shape, same mapping as lib/tools.mjs. */
export function serverToolsForOpenAI() {
  return SERVER_TOOL_SCHEMA.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export const SERVER_TOOL_NAMES = new Set(SERVER_TOOL_SCHEMA.map((t) => t.name));

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function apiPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes('://') || raw.includes('..')) return null;
  return raw;
}

async function githubApi(args, ctx) {
  const token = ctx.env.GITHUB_TOKEN;
  if (!token) return 'GITHUB_TOKEN is not set on the server, so the GitHub tool is off. Tell the owner to set it in the deployment environment.';
  const p = apiPath(args.path);
  if (!p) return 'path must be an api.github.com path starting with a single /.';
  const method = (args.method || 'GET').toUpperCase();
  const res = await fetchWithTimeout(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'termux-code',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: args.body && method !== 'GET' ? JSON.stringify(args.body) : undefined,
  });
  const text = await res.text();
  return clip(`HTTP ${res.status}\n${text}`);
}

async function veniceApi(args, ctx) {
  const key = ctx.env.VENICE_API_KEY;
  if (!key) return 'VENICE_API_KEY is not set on the server, so the Venice tool is off.';
  const p = apiPath(args.path);
  if (!p) return 'path must be a Venice /api/v1 path starting with a single /.';
  const method = (args.method || 'GET').toUpperCase();
  const res = await fetchWithTimeout(`https://api.venice.ai/api/v1${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: args.body && method !== 'GET' ? JSON.stringify(args.body) : undefined,
  });
  const text = await res.text();
  return clip(`HTTP ${res.status}\n${text}`);
}

export function terminalSandboxDir(env = process.env) {
  return env.TERMINAL_SANDBOX_DIR || path.join(process.cwd(), '.sandbox');
}

async function runTerminal(args, ctx) {
  const command = String(args.command || '').trim();
  if (!command) return 'command is required.';
  const cwd = terminalSandboxDir(ctx.env);
  await fs.mkdir(cwd, { recursive: true });
  return new Promise((resolvePromise) => {
    exec(
      command,
      {
        cwd,
        timeout: TERMINAL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4,
        shell: '/bin/sh',
        // Scrubbed on purpose: the terminal gets a PATH and a HOME, never
        // the deployment's provider keys.
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: cwd, TERMUX_CODE_SANDBOX: '1' },
      },
      (err, stdout, stderr) => {
        const body = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err && err.killed) return resolvePromise(clip(`Command timed out after 30s.\n${body}`));
        const code = err ? (err.code ?? 1) : 0;
        resolvePromise(clip(`exit ${code}\n${body || '(no output)'}`));
      }
    );
  });
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrl(args) {
  let url;
  try {
    url = new URL(String(args.url));
  } catch {
    return 'url is not a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Only http and https URLs can be fetched.';
  const res = await fetchWithTimeout(url.href, {
    headers: { 'User-Agent': 'termux-code/1.0 (+https://github.com/jaykk99/termux-code)' },
  });
  const raw = await res.text();
  const isHtml = (res.headers.get('content-type') || '').includes('html');
  return clip(`HTTP ${res.status} ${url.href}\n${isHtml ? htmlToText(raw) : raw}`);
}

async function webSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) return 'query is required.';
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'termux-code/1.0' },
  });
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 8) {
    let href = m[1];
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      href = u.searchParams.get('uddg') || u.href;
    } catch {
      /* keep the raw href */
    }
    results.push(`${results.length + 1}. ${htmlToText(m[2])}\n   ${href}`);
  }
  return results.length ? results.join('\n') : 'No results parsed. Try fetch_url on a known page instead.';
}

/** Short, secret-free summary of a tool call for the audit log and UI. */
export function summarizeArgs(name, args = {}) {
  switch (name) {
    case 'github_api':
      return `${(args.method || 'GET').toUpperCase()} ${args.path || ''}`.trim();
    case 'venice_api':
      return `${(args.method || 'GET').toUpperCase()} ${args.path || ''}`.trim();
    case 'run_terminal':
      return String(args.command || '').slice(0, 200);
    case 'fetch_url':
      return String(args.url || '').slice(0, 200);
    case 'web_search':
      return String(args.query || '').slice(0, 200);
    case 'read_skill':
      return String(args.name || '');
    default:
      return '';
  }
}

/**
 * Execute one server tool. ctx: { login, env }. Always audit-logged;
 * always returns text (errors come back as text the model can react to,
 * never as throws that would kill the chat turn).
 */
export async function runServerTool(name, args = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const started = Date.now();
  let result;
  let ok = true;
  try {
    switch (name) {
      case 'github_api':
        result = await githubApi(args, { env });
        break;
      case 'venice_api':
        result = await veniceApi(args, { env });
        break;
      case 'run_terminal':
        result = await runTerminal(args, { env });
        break;
      case 'fetch_url':
        result = await fetchUrl(args);
        break;
      case 'web_search':
        result = await webSearch(args);
        break;
      case 'list_skills': {
        const skills = await listSkills(env);
        result = skills.length
          ? skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
          : 'No skills are installed.';
        break;
      }
      case 'read_skill': {
        const skill = await loadSkill(args.name, env);
        result = skill ? skill.body : `No skill named "${args.name}". Use list_skills to see what exists.`;
        break;
      }
      default:
        ok = false;
        result = `Unknown tool "${name}". Available: ${[...SERVER_TOOL_NAMES].join(', ')}.`;
    }
  } catch (err) {
    ok = false;
    result = `Tool ${name} failed: ${err?.message || err}`;
  }
  await audit(
    { login: ctx.login || 'unknown', tool: name, args: summarizeArgs(name, args), ok, ms: Date.now() - started },
    env
  );
  return result;
}
