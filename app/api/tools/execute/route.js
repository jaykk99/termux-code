import { runServerTool, COMPOSIO_TOOL_NAMES, summarizeArgs } from '../../../../lib/server-tools.mjs';
import { readJSON, bad, logRequest } from '../../../../lib/http.mjs';
import { gatewayAccess } from '../../../../lib/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Execute one server-side Composio tool for the phone.
 *
 * This is the missing half of the phone's Composio wiring. The gateway's
 * /api/chat route offers composio_search / composio_execute to the phone's
 * model, but the phone cannot run them: COMPOSIO_API_KEY lives only in the
 * deployment environment, and it must never be sent to the phone. So the
 * phone posts the tool call back here, and it executes server-side through
 * lib/server-tools.mjs — the same code path the hosted bot uses — with
 * the same audit log. The Composio key is read from process.env on the
 * server and is never returned, logged, or echoed in the result.
 *
 * Access: the same gate as /api/chat — a browser session cookie or the
 * phone's gateway token. Unlike /api/bot/chat, a gateway token IS enough
 * here, because this route is built for the phone and its allowlist is
 * exactly the two Composio tools: no GitHub API, no server terminal, no
 * fetch, no web search.
 *
 * Body: { name: 'composio_search' | 'composio_execute', args: {...} }
 * Reply: { ok: true, result: '<text>' }. Failures come back as text the
 * model can react to — a dead or unset key surfaces as an honest error
 * message, never a faked success.
 */

const MAX_ARGS_CHARS = 16_384;

export async function POST(req) {
  const started = Date.now();
  const access = await gatewayAccess(req);
  if (!access) {
    const res = bad('NO_KEY', 'Sign in or a gateway token is required.', 401);
    logRequest(req, 401, Date.now() - started);
    return res;
  }
  let body;
  try {
    body = await readJSON(req);
  } catch (res) {
    if (res instanceof Response) {
      logRequest(req, res.status || 400, Date.now() - started);
      return res;
    }
    throw res;
  }

  const name = String(body?.name || '');
  if (!COMPOSIO_TOOL_NAMES.has(name)) {
    const res = bad('BAD_TOOL', 'Only composio_search and composio_execute run through this route.', 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  if (JSON.stringify(args).length > MAX_ARGS_CHARS) {
    const res = bad('ARGS_TOO_LONG', 'Tool arguments are too large.', 413);
    logRequest(req, 413, Date.now() - started);
    return res;
  }

  // runServerTool audit-logs the call (login, tool, arg summary) itself.
  // The Composio key is never in the reply: runServerTool returns only the
  // upstream status and body text, and the key is never logged anywhere.
  const result = await runServerTool(name, args, { login: access.login || 'gateway', env: process.env });
  const res = Response.json({ ok: true, result });
  logRequest(req, 200, Date.now() - started, `${name} ${summarizeArgs(name, args)}`);
  return res;
}
