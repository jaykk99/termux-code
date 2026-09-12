/**
 * A minimal MCP client — JSON-RPC 2.0 over Streamable HTTP.
 *
 * Zero dependencies, like the rest of this CLI. The official SDK pulls a tree
 * of packages for what is three RPC methods over fetch: initialize, tools/list,
 * tools/call.
 *
 * Servers may answer with plain JSON or with an SSE stream (Content-Type
 * text/event-stream) depending on the transport they negotiated, so both are
 * parsed. Sessions are kept via the Mcp-Session-Id header when a server issues
 * one — stateless servers (error-inbox's is stateless by design) simply never
 * send it, and everything still works.
 */

const PROTOCOL = '2025-06-18';
const TIMEOUT_MS = 60_000;

/** Namespaced so an MCP tool can never collide with a local one. */
export const qualify = (server, tool) => `mcp__${server}__${tool}`;

export function parseQualified(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** One configured server. `headers` carries auth, e.g. a Composio bearer key. */
export class McpServer {
  constructor(name, { url, headers = {} } = {}) {
    this.name = name;
    this.url = url;
    this.headers = headers;
    this.session = null;
    this.tools = [];
    this.ready = false;
    this.error = null;
    this.id = 0;
  }

  async rpc(method, params) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        signal: ctl.signal,
        headers: {
          'Content-Type': 'application/json',
          // Both, so a server may answer either way.
          Accept: 'application/json, text/event-stream',
          ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      });

      const sid = res.headers.get('mcp-session-id');
      if (sid) this.session = sid;

      if (!res.ok) {
        throw new Error(`${res.status} ${(await res.text().catch(() => res.statusText)).slice(0, 200)}`);
      }

      const body = await res.text();
      const payload = (res.headers.get('content-type') || '').includes('text/event-stream')
        ? parseSSE(body)
        : JSON.parse(body);

      if (payload?.error) throw new Error(payload.error.message || 'MCP error');
      return payload?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Handshake, then cache the tool list. */
  async connect() {
    try {
      await this.rpc('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        clientInfo: { name: 'termux-code', version: '0.1.0' },
      });
      const listed = await this.rpc('tools/list', {});
      this.tools = listed?.tools || [];
      this.ready = true;
      this.error = null;
    } catch (err) {
      this.ready = false;
      this.error = err.message;
      this.tools = [];
    }
    return this;
  }

  async call(tool, args) {
    const result = await this.rpc('tools/call', { name: tool, arguments: args || {} });
    return renderContent(result);
  }
}

/** Pull the last complete JSON-RPC message out of an SSE body. */
function parseSSE(body) {
  let last = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      last = JSON.parse(data);
    } catch {
      /* partial frame, keep going */
    }
  }
  if (!last) throw new Error('MCP server sent no parsable SSE data frame.');
  return last;
}

/** MCP results are content blocks; flatten to text the agent loop can pass on. */
function renderContent(result) {
  if (!result) return '(no result)';
  const blocks = result.content || [];
  const text = blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'resource') return b.resource?.text || `[resource ${b.resource?.uri || ''}]`;
      return `[${b.type}]`;
    })
    .filter(Boolean)
    .join('\n');
  const body = text || JSON.stringify(result).slice(0, 4000);
  return result.isError ? `Tool reported an error:\n${body}` : body;
}

/**
 * Connect every configured server. Failures are captured per-server rather
 * than thrown: one unreachable MCP shouldn't stop the CLI from starting.
 */
export async function connectAll(config = {}) {
  const entries = Object.entries(config);
  if (!entries.length) return [];
  return Promise.all(entries.map(([name, cfg]) => new McpServer(name, cfg).connect()));
}

/** MCP tools in OpenAI function-calling shape, namespaced by server. */
export function toolsForOpenAI(servers) {
  return servers.flatMap((s) =>
    s.tools.map((t) => ({
      type: 'function',
      function: {
        name: qualify(s.name, t.name),
        description: `[${s.name}] ${t.description || t.name}`.slice(0, 1000),
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }))
  );
}

/** Same list in Anthropic messages shape. */
export function toolsForAnthropic(servers) {
  return servers.flatMap((s) =>
    s.tools.map((t) => ({
      name: qualify(s.name, t.name),
      description: `[${s.name}] ${t.description || t.name}`.slice(0, 1000),
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }))
  );
}

/**
 * Run a namespaced MCP tool call.
 *
 * `approve` is required and is NOT optional by design. An MCP server is remote
 * code with side effects that this CLI cannot inspect — some servers expose
 * account creation, credential entry, or outbound posting behind an innocuous
 * tool name. Local read-only tools (read_file, grep) skip approval because
 * their blast radius is known; nothing from a remote server gets that
 * treatment, regardless of what the tool claims to do.
 */
export async function runMcpTool(servers, name, args, approve) {
  const parsed = parseQualified(name);
  if (!parsed) return `Not an MCP tool: ${name}`;

  const server = servers.find((s) => s.name === parsed.server);
  if (!server) return `No MCP server named "${parsed.server}" is configured.`;
  if (!server.ready) return `MCP server "${server.name}" is not connected: ${server.error}`;

  const preview = JSON.stringify(args ?? {}, null, 1).slice(0, 800);
  const ok = await approve(`${server.name} → ${parsed.tool}`, preview);
  if (!ok) return 'Declined by the user. Ask what they would prefer instead.';

  try {
    return await server.call(parsed.tool, args);
  } catch (err) {
    return `MCP call failed: ${err.message}`;
  }
}
