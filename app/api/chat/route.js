import { complete } from '../../../lib/agent.mjs';
import { resolveModel } from '../../../lib/models.mjs';
import { readJSON, bad, upstreamError, logRequest } from '../../../lib/http.mjs';
import { gatewayAccess } from '../../../lib/auth.mjs';
import { cleanToolCalls } from '../../../lib/history.mjs';
import { composioToolsForOpenAI, composioToolsForAnthropic } from '../../../lib/server-tools.mjs';

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

export function sanitizeMessages(messages) {
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
    if (m.role === 'assistant') {
      // Keep the calls: a tool result without the assistant call that
      // issued it is orphaned, and providers reject it. The phone used
      // to strip these on every send, so any session with tool history
      // failed its next gateway turn.
      const toolCalls = cleanToolCalls(m.tool_calls);
      if (toolCalls) out.tool_calls = toolCalls;
    }
    if (m.role === 'tool') {
      out.tool_call_id = String(m.tool_call_id ?? '');
      if (m.name !== undefined) out.name = String(m.name).slice(0, 100);
    }
    return out;
  });
  return clean;
}

/**
 * Extra tools the gateway offers the phone's model, on top of the phone's
 * local filesystem tools (which lib/agent.mjs always includes). Only the
 * Composio pair: they execute server-side via /api/tools/execute, where
 * COMPOSIO_API_KEY lives, so the key never reaches the phone. Anthropic
 * models get the Anthropic shape; everything else gets the OpenAI shape —
 * native OpenAI-shaped models call them as functions, and text-only
 * models (Gemini, Cohere, Horde, HF) get them described in the text tool
 * protocol (lib/text-tools.mjs) and call them as <tool_call> blocks. The
 * phone dispatches these two names back to the gateway by name either
 * way, so a text-protocol call reaches Composio exactly like a native one.
 */
export function gatewayExtraTools(model) {
  if (!model || typeof model !== 'object') return [];
  if (model.auth === 'anthropic') return composioToolsForAnthropic();
  return composioToolsForOpenAI();
}

function safeArgs(args) {
  // Slicing serialized JSON and re-parsing used to throw on any args
  // over 16k (a write_file with a real file in it) and 502 the turn.
  const json = JSON.stringify(args ?? {});
  if (json.length <= 65_536) return JSON.parse(json);
  return { _error: `Tool arguments were ${json.length} characters, over the 65536 limit. Split the change into smaller edits.` };
}

export function clampReply(reply) {
  const text = typeof reply.text === 'string' && reply.text.length > MAX_REPLY_CHARS
    ? reply.text.slice(0, MAX_REPLY_CHARS) + '\n\n… [output truncated at ' + MAX_REPLY_CHARS + ' chars]'
    : reply.text;
  const toolCalls = (reply.toolCalls || []).slice(0, MAX_TOOL_CALLS).map((c) => ({
    id: String(c.id ?? '').slice(0, 200),
    name: String(c.name ?? '').slice(0, 100),
    args: safeArgs(c.args),
    ...(c.textProtocol ? { textProtocol: true } : {}),
  }));
  // The phone pushes assistantMessage straight into history, so it must
  // carry the linkage the next turn's tool results refer to. A text-only
  // assistant message used to orphan every tool result in gateway mode:
  // the follow-up completion then failed at the provider. Anthropic
  // turns keep their native blocks (tool_use included); OpenAI-shaped
  // turns rebuild tool_calls from the tool calls themselves.
  let assistantMessage;
  const native = reply.assistantMessage;
  if (reply.textProtocol) {
    // Text-protocol turn (lib/text-tools.mjs): the calls live in the raw
    // text, and the phone answers them with a <tool_result> user message.
    // Rebuilding tool_calls here would orphan-reference ids no provider
    // ever issued, so keep the raw text and nothing else.
    const raw = typeof native?.content === 'string' ? native.content : text;
    assistantMessage = { role: 'assistant', content: raw.slice(0, MAX_REPLY_CHARS) };
  } else if (native && Array.isArray(native.content)) {
    assistantMessage = { role: 'assistant', content: native.content };
  } else {
    assistantMessage = { role: 'assistant', content: text };
    if (toolCalls.length) {
      assistantMessage.tool_calls = toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }));
    }
  }
  return {
    ok: true,
    text,
    toolCalls,
    truncated: text !== reply.text,
    refused: reply.refused === true,
    ...(reply.textProtocol ? { textProtocol: true } : {}),
    ...(reply.textProtocolErrors ? { textProtocolErrors: reply.textProtocolErrors.slice(0, 5) } : {}),
    assistantMessage,
  };
}

export async function POST(req) {
  const started = Date.now();
  // Owner-gated: a browser session cookie or the phone's gateway token.
  // Anonymous completions are refused — the keys behind this route are the
  // owner's, so the route is too. The CLI sends its token as a bearer.
  if (!(await gatewayAccess(req))) {
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
    const reply = await complete(model, messages, process.env, gatewayExtraTools(model));
    const res = Response.json(clampReply(reply));
    logRequest(req, 200, Date.now() - started, `model=${model.provider}/${model.id}`);
    return res;
  } catch (err) {
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started, `model=${model.provider}/${model.id}`);
    return res;
  }
}
