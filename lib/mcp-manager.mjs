/**
 * Interactive MCP server management — add / test / list / remove / reload
 * remote MCP servers from inside the CLI.
 *
 * The client itself lives in lib/mcp.mjs (McpServer, connectAll). This
 * module owns the part the CLI was missing: validating a server entry,
 * keeping the persisted `mcpServers` map in ~/.termux-code/config.json
 * well-formed, and reconnecting the live session after a change — without
 * ever printing an auth header back. Server entries are { url, headers? },
 * the same shape loadMcpConfig() already accepts, so a server added here
 * behaves exactly like one written into config.json by hand.
 *
 * All map functions are pure: they return a new object and never mutate
 * the one passed in, so a failed add cannot half-edit the live config.
 */
import { McpServer, connectAll } from './mcp.mjs';

/** Safe inside a qualified tool name (mcp__<server>__<tool>). */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A header a user may pass on the command line: `Name: value`. */
const HEADER_PATTERN = /^([A-Za-z0-9-]+):\s*(\S.*)$/;

export function validateServerName(name) {
  const value = String(name || '').trim();
  if (!NAME_PATTERN.test(value)) {
    throw new Error(
      `Invalid MCP server name ${JSON.stringify(value)}: use letters, digits, "-" or "_", starting with a letter or digit.`
    );
  }
  // A server named mcp__x would qualify its tools as mcp__mcp__x__<tool>,
  // which parseQualified() reads back as server "mcp" — every tool call
  // would be routed to the wrong server. Keep the prefix reserved.
  if (value.startsWith('mcp__')) {
    throw new Error(
      `Invalid MCP server name ${JSON.stringify(value)}: names starting with "mcp__" would collide with qualified tool names.`
    );
  }
  return value;
}

export function validateServerUrl(url) {
  const value = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid MCP server URL ${JSON.stringify(value)}: give a full http(s) URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid MCP server URL ${JSON.stringify(value)}: only http(s) URLs are allowed.`);
  }
  return parsed.href;
}

/**
 * Parse one `Name: value` header argument (e.g. `Authorization: Bearer X`).
 * Returns { name, value }; the header name is normalised to its canonical
 * casing so the same header cannot be stored twice under two spellings.
 */
export function parseHeaderArg(arg) {
  const m = HEADER_PATTERN.exec(String(arg || '').trim());
  if (!m) throw new Error(`Invalid header ${JSON.stringify(arg)}: use "Name: value".`);
  const name = m[1]
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
  return { name, value: m[2].trim() };
}

/**
 * Add a server to the map. `headers` is an object of header name → value
 * (from parseHeaderArg, or {}). Throws on a bad name, bad URL, or a name
 * that is already configured. Returns a new map; the input is untouched.
 */
export function addMcpServer(servers, name, url, headers = {}) {
  const cleanName = validateServerName(name);
  const cleanUrl = validateServerUrl(url);
  const current = { ...(servers || {}) };
  if (Object.prototype.hasOwnProperty.call(current, cleanName)) {
    throw new Error(`MCP server "${cleanName}" is already configured. Remove it first to replace it.`);
  }
  const entry = { url: cleanUrl };
  const cleanHeaders = Object.fromEntries(
    Object.entries(headers || {}).filter(([, v]) => typeof v === 'string' && v.trim() !== '')
  );
  if (Object.keys(cleanHeaders).length) entry.headers = cleanHeaders;
  return { ...current, [cleanName]: entry };
}

/** Remove a server from the map. Returns { servers, removed }. */
export function removeMcpServer(servers, name) {
  const cleanName = validateServerName(name);
  const current = { ...(servers || {}) };
  if (!Object.prototype.hasOwnProperty.call(current, cleanName)) {
    return { servers: current, removed: false };
  }
  delete current[cleanName];
  return { servers: current, removed: true };
}

/**
 * Sorted, display-safe server list. Header values are never included —
 * `hasAuth` only says whether any header is stored.
 */
export function listMcpServers(servers) {
  return Object.entries(servers || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      name,
      url: entry?.url || '',
      hasAuth: Boolean(entry?.headers && Object.keys(entry.headers).length),
    }));
}

/** One display line per server, for the `/mcp` list output. */
export function formatServerList(servers) {
  const list = listMcpServers(servers);
  if (!list.length) return ['  No MCP servers configured. Add one with /mcp add <name> <url>.'];
  return list.map(
    (s) => `  ${s.name}  ${s.url}${s.hasAuth ? '  (auth header saved)' : ''}`
  );
}

/**
 * Connect to one configured server and report what it offers. Never
 * throws: an unreachable server comes back as { ready: false, error } so
 * `/mcp test` can name the failure instead of dying on it.
 */
export async function testMcpServer(name, entry) {
  const cleanName = validateServerName(name);
  const url = validateServerUrl(entry?.url);
  const server = new McpServer(cleanName, { url, headers: entry?.headers || {} });
  await server.connect();
  return {
    name: cleanName,
    url,
    ready: server.ready,
    tools: server.ready ? server.tools.map((t) => t.name) : [],
    error: server.ready ? null : server.error,
  };
}

/**
 * Reconnect every configured server, returning a fresh array of McpServer
 * instances. Per-server failures are captured (see connectAll), so one
 * dead server does not stop the rest from reconnecting.
 */
export async function reconnectMcpServers(config = {}) {
  return connectAll(config);
}
