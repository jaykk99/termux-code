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
import { skillIndex } from '../../../../lib/skills.mjs';
import { audit } from '../../../../lib/audit.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * The hosted chatbot. Session-only — a gateway token can fetch completions
 * for the phone, but it can NEVER reach this route or its server-side
 * tools. Anonymous requests are refused before anything else happens.
 *
 * The chat is powered by Venice (VENICE_MODEL, default
 * venice-uncensored-1-2) first; if Venice errors or refuses, the repo's
 * failover chain walks the other available models and the attempts log in
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
  const index = await skillIndex().catch(() => '');
  return [
    "You are the termux-code hosted chatbot, working for Jay (GitHub: jaykk99). You run server-side with tools:",
    '- github_api: the GitHub API as Jay (reads and writes on his repos).',
    '- venice_api: the Venice AI API with the server key (images, audio, embeddings, billing, models, chat).',
    '- run_terminal: a shell in a sandbox directory on this server (no provider keys in its environment).',
    '- fetch_url / web_search: read pages and search the web.',
    '- list_skills / read_skill: Venice API skills — step-by-step instructions for each Venice surface.',
    '',
    'Venice skills available (load one with read_skill BEFORE using venice_api for that surface):',
    index || '(none installed)',
    '',
    'Rules: never print or ask for API keys or tokens. Prefer reading a skill over guessing an API shape. Keep answers tight and say plainly what you did.',
  ].join('\n');
}

const completeFn = (model, messages) =>
  complete(model, messages, process.env, serverToolsForOpenAI(), { baseTools: false });

/** Venice first, honestly: one direct attempt, then the failover chain. */
async function firstTurn(candidates, messages) {
  const attempts = [];
  const venice = candidates.find((m) => m.provider === 'venice');
  const rest = candidates.filter((m) => m !== venice);
  if (venice) {
    const started = Date.now();
    try {
      const reply = await completeFn(venice, messages);
      if (!isRefusalReply(reply)) {
        attempts.push(makeAttempt({ provider: 'venice', modelId: venice.id, ok: true, latencyMs: Date.now() - started }));
        return { model: venice, reply, attempts };
      }
      attempts.push(
        makeAttempt({ provider: 'venice', modelId: venice.id, ok: false, latencyMs: Date.now() - started, error: 'refused' })
      );
    } catch (err) {
      attempts.push(
        makeAttempt({ provider: 'venice', modelId: venice.id, ok: false, latencyMs: Date.now() - started, error: err?.message })
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
          : `Tool "${call.name}" is not available in the web chatbot.`;
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
