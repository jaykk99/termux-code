import { sendToErrorInbox } from '../../../lib/agent.mjs';
import { readJSON, bad, upstreamError, logRequest } from '../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 280; // matches error-inbox's own v1/message route

/**
 * Proxies to error-inbox's real public endpoint (app/api/v1/message). This
 * talks to error-inbox's own hosted agent — its own tools, its own model
 * routing — not termux-code's local filesystem agent. Body: { message, agent? }
 */

const MAX_MESSAGE_CHARS = 20_000;

export async function POST(req) {
  const started = Date.now();
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

  const { message, agent } = body;
  if (typeof message !== 'string' || !message.trim()) {
    const res = bad('BAD_MESSAGES', "Body must include 'message'.", 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    const res = bad('MESSAGE_TOO_LONG', `Message exceeds ${MAX_MESSAGE_CHARS} characters.`, 413);
    logRequest(req, 413, Date.now() - started);
    return res;
  }
  if (agent !== undefined && (typeof agent !== 'string' || agent.length > 100)) {
    const res = bad('BAD_MESSAGES', "'agent' must be a short string.", 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }

  try {
    const reply = await sendToErrorInbox(message, { agent });
    const res = Response.json({ ok: true, reply });
    logRequest(req, 200, Date.now() - started);
    return res;
  } catch (err) {
    const message = err?.message || '';
    if (/api key/i.test(message)) {
      const res = bad('NO_KEY', message.slice(0, 300), 401);
      logRequest(req, 401, Date.now() - started);
      return res;
    }
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started);
    return res;
  }
}
