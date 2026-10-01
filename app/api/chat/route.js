import { complete } from '../../../lib/agent.mjs';
import { resolveModel } from '../../../lib/models.mjs';
import { readJSON, bad, upstreamError, logRequest } from '../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Single completion, no tool execution. The Termux CLI runs tools locally and
 * posts the results back, which keeps provider keys in Vercel's environment
 * instead of sitting in a config file on the phone.
 *
 * Body: { model: { id, provider, source }, messages: [...] }
 *
 * The model reference is resolved server-side against the registry — a
 * client-supplied `url` is never trusted, so the gateway can't be pointed
 * at internal addresses. Messages are validated: known roles only, bounded
 * count, bounded total length. Reply text is clamped so a runaway upstream
 * can't hand back megabytes through the function.
 */

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 32_768;
const MAX_TOTAL_CHARS = 100_000;
const MAX_REPLY_CHARS = 32_768;
const MAX_TOOL_CALLS = 20;

function messageChars(m) {
  if (typeof m.content === 'string') return m.content.length;
  return JSON.stringify(m.content ?? '').length;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) throw bad('BAD_MESSAGES', 'messages must be an array.', 400);
  if (messages.length === 0) throw bad('BAD_MESSAGES', 'messages must not be empty.', 400);
  if (messages.length > MAX_MESSAGES) {
    throw bad('BAD_MESSAGES', `messages limited to ${MAX_MESSAGES} entries.`, 400);
  }
  let total = 0;
  const clean = messages.map((m) => {
    if (!m || typeof m !== 'object') throw bad('BAD_MESSAGES', 'Each message must be an object.', 400);
    if (!ROLES.has(m.role)) throw bad('BAD_MESSAGES', `Bad role "${m.role}".`, 400);
    if (typeof m.content !== 'string' && m.content !== null && typeof m.content !== 'object') {
      throw bad('BAD_MESSAGES', 'Message content must be a string, array, or null.', 400);
    }
    const chars = messageChars(m);
    if (chars > MAX_MESSAGE_CHARS) {
      throw bad('MESSAGE_TOO_LONG', `One message exceeds ${MAX_MESSAGE_CHARS} characters.`, 413);
    }
    total += chars;
    if (total > MAX_TOTAL_CHARS) {
      throw bad('MESSAGE_TOO_LONG', `Conversation exceeds ${MAX_TOTAL_CHARS} characters.`, 413);
    }
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.role === 'tool') {
      out.tool_call_id = String(m.tool_call_id ?? '');
      if (m.name !== undefined) out.name = String(m.name).slice(0, 100);
    }
    return out;
  });
  return clean;
}

function clampReply(reply) {
  const text = typeof reply.text === 'string' && reply.text.length > MAX_REPLY_CHARS
    ? reply.text.slice(0, MAX_REPLY_CHARS) + '\n\n… [output truncated at ' + MAX_REPLY_CHARS + ' chars]'
    : reply.text;
  const toolCalls = (reply.toolCalls || []).slice(0, MAX_TOOL_CALLS).map((c) => ({
    id: String(c.id ?? '').slice(0, 200),
    name: String(c.name ?? '').slice(0, 100),
    args: JSON.parse(JSON.stringify(c.args ?? {}).slice(0, 16_384)),
  }));
  return { ok: true, text, toolCalls, truncated: text !== reply.text };
}

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

  const model = await resolveModel(body.model);
  if (!model) {
    const res = bad('BAD_MODEL', 'Unknown model. Pick one from /api/models.', 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }

  let messages;
  try {
    messages = sanitizeMessages(body.messages);
  } catch (res) {
    if (res instanceof Response) {
      logRequest(req, res.status || 400, Date.now() - started, `model=${model.provider}/${model.id}`);
      return res;
    }
    throw res;
  }

  try {
    const reply = await complete(model, messages);
    const res = Response.json(clampReply(reply));
    logRequest(req, 200, Date.now() - started, `model=${model.provider}/${model.id}`);
    return res;
  } catch (err) {
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started, `model=${model.provider}/${model.id}`);
    return res;
  }
}
