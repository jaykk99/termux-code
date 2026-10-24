import { complete, appendToolResult } from '../../../../lib/agent.mjs';
import { directModels } from '../../../../lib/models.mjs';
import {
  completeWithFailover,
  makeAttempt,
  FailureTracker,
} from '../../../../lib/failover.mjs';
import { isRefusalReply } from '../../../../lib/refusal.mjs';
import { readJSON, bad, upstreamError, logRequest } from '../../../../lib/http.mjs';
import { ownerSession } from '../../../../lib/auth.mjs';
import {
  runServerTool,
  serverToolsForOpenAI,
  summarizeArgs,
  SERVER_TOOL_NAMES,
} from '../../../../lib/server-tools.mjs';
import { audit } from '../../../../lib/audit.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The hosted chatbot. Session-only — a gateway token can fetch completions
 * for the phone, but it can NEVER reach this route or its server-side
 * tools. Anonymous requests are refused before anything else happens.
 *
 * The chat is powered first by Jay's first uncensored pick from his Inbox
 * Models pool, served through error-inbox's Hugging Face catalog route
 * (HF_MODEL, default 0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored
 * -GGUF). If it errors or refuses, the repo's failover chain walks the
 * other available models — the rest of the uncensored HF list in pool
 * order, then everything else in the EI pool — and the attempts log in
 * the response says honestly which model answered. Tool calls execute
 * server-side via lib/server-tools.mjs and every one is audit-logged.
 */

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TOOL_STEPS = 8;
const tracker = new FailureTracker();

function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw bad('BAD_MESSAGES', 'messages must be a non-empty array.', 400);
  }
  if (messages.length > MAX_MESSAGES) {
    throw bad('BAD_MESSAGES', `messages limited to ${MAX_MESSAGES} entries.`, 400);
  }
  return messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw bad('BAD_MESSAGES', 'Each message needs role "user" or "assistant" and string content.', 400);
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      throw bad('MESSAGE_TOO_LONG', `One message exceeds ${MAX_MESSAGE_CHARS} characters.`, 413);
    }
    return { role: m.role, content: m.content };
  });
}

async function systemPrompt() {
  return [
    "You are the termux-code hosted agent, working for Jay (GitHub: jaykk99). You run server-side with tools:",
    '- github_api: the GitHub API as Jay (reads and writes on his repos).',
    "- composio_search / composio_execute: Jay's connected apps through his Composio workspace (Gmail, Google Calendar, Facebook, Outlook and more). Always composio_search for the right tool slug first, then composio_execute it — never guess a slug. GitHub actions through Composio need the connection's connected_account_id (and its account name) or they fail silently.",
    '- run_terminal: a shell in a sandbox directory on this server (no provider keys in its environment).',
    '- fetch_url / web_search: read pages and search the web.',
    '',
    'Rules: never print or ask for API keys or tokens. Keep answers tight and say plainly what you did.',
  ].join('\n');
}

const completeFn = (model, messages) =>
  complete(model, messages, process.env, serverToolsForOpenAI(), { baseTools: false });

/**
 * Primary first, honestly: one direct attempt on the default model (the
 * first `hf` candidate — Jay's first uncensored pool pick), then the
 * failover chain over everything else.
 */
async function firstTurn(candidates, messages) {
  const attempts = [];
  const primary = candidates.find((m) => m.provider === 'hf');
  const rest = candidates.filter((m) => m !== primary);
  if (primary) {
    const started = Date.now();
    try {
      const reply = await completeFn(primary, messages);
      if (!isRefusalReply(reply)) {
        attempts.push(makeAttempt({ provider: primary.provider, modelId: primary.id, ok: true, latencyMs: Date.now() - started }));
        return { model: primary, reply, attempts };
      }
      attempts.push(
        makeAttempt({ provider: primary.provider, modelId: primary.id, ok: false, latencyMs: Date.now() - started, error: 'refused' })
      );
    } catch (err) {
      attempts.push(
        makeAttempt({ provider: primary.provider, modelId: primary.id, ok: false, latencyMs: Date.now() - started, error: err?.message })
      );
    }
  }
  if (rest.length === 0) {
    const last = attempts[attempts.length - 1];
    throw new Error(last?.error || 'No models are available.');
  }
  const out = await completeWithFailover(rest, messages, completeFn, tracker);
  return { model: out.model, reply: out.reply, attempts: [...attempts, ...out.attempts] };
}

export async function POST(req) {
  const started = Date.now();
  const session = ownerSession(req);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in with GitHub first. The chatbot and its tools are owner-only.', 401);
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

  let clientMessages;
  try {
    clientMessages = sanitizeMessages(body.messages);
  } catch (res) {
    if (res instanceof Response) {
      logRequest(req, res.status || 400, Date.now() - started);
      return res;
    }
    throw res;
  }

  const candidates = directModels();
  if (candidates.length === 0) {
    logRequest(req, 503, Date.now() - started);
    return bad('NO_MODELS', 'No models are available on this deployment.', 503);
  }

  const convo = [{ role: 'system', content: await systemPrompt() }, ...clientMessages];
  try {
    let { model, reply, attempts } = await firstTurn(candidates, convo);
    const steps = [];
    if (reply.toolCalls?.length) convo.push(reply.assistantMessage);
    let guard = 0;
    while (reply.toolCalls?.length && guard < MAX_TOOL_STEPS) {
      guard += 1;
      for (const call of reply.toolCalls) {
        const result = SERVER_TOOL_NAMES.has(call.name)
          ? await runServerTool(call.name, call.args, { login: session.login })
          : `Tool "${call.name}" is not available in the hosted agent.`;
        steps.push({ tool: call.name, args: summarizeArgs(call.name, call.args), result: result.slice(0, 2000) });
        appendToolResult(convo, model, call, result);
      }
      reply = await completeFn(model, convo);
      if (reply.toolCalls?.length) convo.push(reply.assistantMessage);
    }
    await audit(
      { login: session.login, tool: 'bot_chat', args: `model=${model.provider}/${model.id} steps=${steps.length}`, ok: true, ms: Date.now() - started },
      process.env
    );
    logRequest(req, 200, Date.now() - started, `model=${model.provider}/${model.id} steps=${steps.length}`);
    return Response.json({
      ok: true,
      text: reply.text || '',
      model: { provider: model.provider, id: model.id },
      attempts,
      steps,
    });
  } catch (err) {
    await audit(
      { login: session.login, tool: 'bot_chat', args: 'failed', ok: false, ms: Date.now() - started },
      process.env
    );
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started);
    return res;
  }
}
