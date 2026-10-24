/**
 * Server-side tools for the hosted agent.
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
 *   - composio_search / composio_execute — the owner's Composio workspace
 *                   (backend.composio.dev), key from COMPOSIO_API_KEY.
 *                   App actions (Gmail, Google Calendar, Facebook, the
 *                   other connected apps) are discovered with
 *                   composio_search, then run through Composio's
 *                   COMPOSIO_MULTI_EXECUTE_TOOL — the only execution route
 *                   that resolves app tools in this workspace. GitHub
 *                   actions through Composio also need the connection's
 *                   connected_account_id (and its account name) or they
 *                   fail silently.
 *   - run_terminal— a shell in a sandboxed directory on the host
 *                   (TERMINAL_SANDBOX_DIR or ./.sandbox), 30s cap, with a
 *                   scrubbed environment: no provider keys are passed in.
 *   - fetch_url   — read a web page as text (http/https only).
 *   - web_search  — DuckDuckGo HTML search, no key required.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { audit } from './audit.mjs';

const MAX_RESULT = 16_000;
const FETCH_TIMEOUT_MS = 20_000;
const TERMINAL_TIMEOUT_MS = 30_000;
const COMPOSIO_BASE = 'https://backend.composio.dev';

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
    name: 'composio_search',
    description:
      'Search the owner\'s Composio workspace for the right app tool BEFORE executing one. query: a plain-language use case like "send an email with Gmail" or "list upcoming Google Calendar events". Returns candidate tools with their slugs and input schemas. Always search first — guessing a tool slug fails.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The use case to find a tool for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'composio_execute',
    description:
      'Run one app action through the owner\'s Composio workspace (Gmail, Google Calendar, Facebook, Outlook and his other connected apps). tool_slug: a slug returned by composio_search (e.g. GMAIL_SEND_EMAIL). arguments: the tool\'s arguments object. connected_account_id: the connection id for the app when Composio asks for one — GitHub actions in particular need connected_account_id plus account set to the connection\'s account name or they fail silently. Execution goes through COMPOSIO_MULTI_EXECUTE_TOOL. Returns the HTTP status and response.',
    parameters: {
      type: 'object',
      properties: {
        tool_slug: { type: 'string', description: 'Tool slug from composio_search' },
        arguments: { type: 'object', description: 'Arguments for the tool' },
        connected_account_id: { type: 'string', description: 'Optional Composio connected account id for the app' },
        account: { type: 'string', description: 'Optional connection account name (needed by some GitHub actions)' },
      },
      required: ['tool_slug'],
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

/**
 * One Composio meta-tool call. App tools in this workspace only resolve
 * through the meta tools (COMPOSIO_SEARCH_TOOLS to find them,
 * COMPOSIO_MULTI_EXECUTE_TOOL to run them) — executing an app slug
 * directly returns "Tool not found". The key is read from the server env
 * and sent as the x-api-key header; it is never logged or returned.
 */
async function composioExecuteMeta(metaSlug, metaArguments, ctx, connectedAccountId) {
  const key = ctx.env.COMPOSIO_API_KEY;
  if (!key) {
    return 'COMPOSIO_API_KEY is not set on the server, so the Composio tools are off. Tell the owner the Composio key needs to be set in the deployment environment.';
  }
  const body = { arguments: metaArguments };
  if (connectedAccountId) body.connected_account_id = connectedAccountId;
  const res = await fetchWithTimeout(`${COMPOSIO_BASE}/api/v3.1/tools/execute/${metaSlug}`, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
      'User-Agent': 'termux-code',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return clip(`HTTP ${res.status}\n${text}`);
}

async function composioSearch(args, ctx) {
  const query = String(args.query || '').trim();
  if (!query) return 'query is required.';
  return composioExecuteMeta('COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: query }] }, ctx);
}

async function composioExecute(args, ctx) {
  const slug = String(args.tool_slug || '').trim();
  if (!slug) return 'tool_slug is required. Find one with composio_search first.';
  const tool = { tool_slug: slug, arguments: args.arguments || {} };
  if (args.connected_account_id) tool.connected_account_id = String(args.connected_account_id);
  if (args.account) tool.account = String(args.account);
  return composioExecuteMeta(
    'COMPOSIO_MULTI_EXECUTE_TOOL',
    { tools: [tool] },
    ctx,
    args.connected_account_id ? String(args.connected_account_id) : undefined
  );
}

export function terminalSandboxDir(env = process.env) {
  return env.TERMINAL_SANDBOX_DIR || path.join(process.cwd(), '.sandbox');
}

async function runTerminal(args, ctx) {
  const command = String(args.command || '').trim();
  if (!command) return 'command is required.';
  // Cloudflare Workers/Pages has no shell and no filesystem: say so plainly
  // instead of letting a low-level "not implemented" error leak through.
  // (On the Node/Docker deployment this check never fires and the terminal
  // works as before.)
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return 'run_terminal is unavailable on this runtime: the Cloudflare deployment has no shell, so commands cannot be executed here.';
  }
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
    case 'composio_search':
      return String(args.query || '').slice(0, 200);
    case 'composio_execute':
      return String(args.tool_slug || '').slice(0, 200);
    case 'run_terminal':
      return String(args.command || '').slice(0, 200);
    case 'fetch_url':
      return String(args.url || '').slice(0, 200);
    case 'web_search':
      return String(args.query || '').slice(0, 200);
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
      case 'composio_search':
        result = await composioSearch(args, { env });
        break;
      case 'composio_execute':
        result = await composioExecute(args, { env });
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
