/**
 * The agent loop, shared by the CLI and the web gateway.
 *
 * Every provider's request shape here matches error-inbox's actual dispatch
 * (lib/llm.ts → callOne), pulled from source rather than guessed:
 *
 *   - bearer / none : POST {url}, OpenAI chat/completions shape, optional
 *                      `Authorization: Bearer <key>` (omitted for Kilo, LLM7,
 *                      Horde-adjacent keyless providers).
 *   - gemini         : POST {url}/{model}:generateContent?key={key}, Google's
 *                      own systemInstruction/contents shape.
 *   - cohere         : POST api.cohere.com/v2/chat, OpenAI-shaped messages but
 *                      content comes back as an array of parts.
 *   - anthropic      : POST api.anthropic.com/v1/messages, native tool_use.
 *   - horde          : async submit-then-poll queue, single-shot, no tools;
 *                      requests uncensored workers first when any are online.
 *   - hf             : error-inbox's Hugging Face catalog route — POST
 *                      api-inference.huggingface.co/models/{id} with
 *                      { inputs, parameters }, keyless; text-only.
 *
 * error-inbox itself never sends a `tools` field — its own agents don't need
 * function-calling at the completion layer. termux-code does (it needs the
 * model to drive read/write/edit/grep/bash), so `tools` is added here for
 * every OpenAI-shaped endpoint. Gemini, Cohere and Horde are left text-only:
 * their function-calling shapes diverge enough from OpenAI's that wiring them
 * without being able to test against a live key risks shipping something
 * subtly wrong. A model without tool support still answers in plain text —
 * it just can't touch the filesystem or shell for that turn.
 */

import { toolsForOpenAI, toolsForAnthropic } from './tools.mjs';
import { PROVIDERS } from './models.mjs';
import { renderError, UNCENSORED_MARK } from './failover.mjs';

export const SYSTEM_PROMPT = `You are a coding agent running inside Termux on an Android phone.

Environment notes that matter here:
- The shell is Termux. Package manager is \`pkg\`, not apt-get or brew.
- The workspace root is the directory the user launched you from. Stay inside it.
- There is no sudo, no systemd, and /usr does not exist. Home is $HOME.
- Screen width is roughly 50 characters. Keep output tight. No banners.

How to work:
- Read before you write. Never guess at a file's contents.
- Prefer edit_file over write_file on existing files, so you don't lose code.
- Make one change at a time and check it before moving on.
- Run the project's own tests or build if it has them.
- When you are done, say what changed in one or two lines. No summaries of
  your own process, no bullet-point recaps of what the user just watched.

If a request is ambiguous, ask one question rather than guessing.

Connected apps (commands, not files):
- For actions on your connected apps — sending mail, calendar events,
  social posts, and similar — use composio_search first to find the right
  tool, then composio_execute to run it. Never guess a tool slug.
- Those two tools run on the server through the gateway, not on the
  phone: the phone holds no Composio key, and you must never ask for
  one or print one. If a Composio call comes back with an error (a dead
  key, a failed action), say so plainly instead of pretending it worked.
- When there is no gateway configured, the Composio tools are not
  offered at all — only the local file and shell tools work.

Small talk first:
- If the user just greets you or chats casually, reply in plain text
  and ask what they want to work on. Do NOT call any tool, run any
  command, or look anything up for a greeting.
- Never fetch, guess, or report the user's IP address, location, or
  device identity unless they explicitly ask for it.`;

const MAX_TOKENS = 4096;

// Upstream free-tier providers flap or hang; never let one burn the whole
// serverless function duration. Completion calls get 45s (under the 60s
// maxDuration on /api/chat), error-inbox's own agent gets a longer budget.
const COMPLETION_TIMEOUT_MS = 45_000;
const ERROR_INBOX_TIMEOUT_MS = 270_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = COMPLETION_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Upstream timed out after ${Math.round(timeoutMs / 1000)}s (${url}).`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function keyFor(model, env) {
  const cfg = PROVIDERS[model.provider];
  if (!cfg?.envKey) return null; // keyless provider
  return env[cfg.envKey] || null;
}

function urlFor(model, env) {
  if (model.url) return model.url; // Gratisfy's live-discovered models carry their own
  if (model.provider === 'omniroute') return `${env.OMNIROUTE_BASE_URL}/v1/chat/completions`;
  return PROVIDERS[model.provider]?.url;
}

/* ---------- OpenAI-shaped (bearer or none) — Kilo, LLM7, Groq, Cerebras, etc. ---------- */

async function callOpenAIShaped(model, messages, env, extraTools = [], opts = {}) {
  const key = keyFor(model, env);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  // opts.baseTools === false drops the phone's filesystem tools — the hosted
  // chatbot passes its own server-side tools as extraTools instead, and
  // offering tools nobody there can execute would strand the model.
  const baseTools = opts.baseTools === false ? [] : toolsForOpenAI();

  const res = await fetchWithTimeout(urlFor(model, env), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.id,
      messages,
      tools: [...baseTools, ...extraTools],
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`${model.providerLabel} ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    text: stripThinking(msg.content || ''),
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeParse(c.function.arguments),
    })),
    assistantMessage: msg,
  };
}

/* ---------- Anthropic messages ---------- */

async function callAnthropic(model, messages, env, extraTools = [], opts = {}) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const rest = messages.filter((m) => m.role !== 'system');
  const baseTools = opts.baseTools === false ? [] : toolsForAnthropic();

  const res = await fetchWithTimeout(urlFor(model, env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': keyFor(model, env) || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model.id,
      system,
      messages: rest,
      tools: [...baseTools, ...extraTools],
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const blocks = data.content || [];
  if (data.stop_reason === 'refusal') {
    // Flagged, not just phrased: lib/failover.mjs treats `refused: true`
    // as a failed attempt and walks the chain, so this text only reaches
    // the user if every other candidate refuses too.
    return { text: 'Anthropic declined this request.', toolCalls: [], refused: true, assistantMessage: { role: 'assistant', content: blocks } };
  }
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
    assistantMessage: { role: 'assistant', content: blocks },
  };
}

/* ---------- Gemini — text-only here; its function-calling shape differs from OpenAI's ---------- */

async function callGemini(model, messages, env) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const rest = messages.filter((m) => m.role !== 'system' && (m.role === 'user' || m.role === 'assistant'));
  const key = keyFor(model, env);

  const res = await fetchWithTimeout(`${urlFor(model, env)}/${model.id}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: rest.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      })),
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
}

/* ---------- Cohere v2/chat — text-only; content returns as an array of parts ---------- */

async function callCohere(model, messages, env) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content || '';

  const res = await fetchWithTimeout(urlFor(model, env), {
    method: 'POST',
    headers: { Authorization: `Bearer ${keyFor(model, env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Cohere ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const parts = data?.message?.content || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
}

/* ---------- AI Horde — async submit-then-poll queue, last resort, no tools ---------- */

/** Pick the uncensored Horde workers to ask for: online workers only,
 * fastest-queue first. All of them, not just the top 3: anonymous jobs
 * sit at the back of Horde's queue, so one slow worker must not be the
 * only chance the job has. Empty when nothing uncensored is online. */
export function pickHordeUncensoredModels(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.name === 'string' && (r.count || 0) > 0 && UNCENSORED_MARK.test(r.name))
    .sort((x, y) => (x.eta ?? Infinity) - (y.eta ?? Infinity))
    .slice(0, 10)
    .map((r) => r.name);
}

async function fetchHordeUncensoredModels(asyncUrl, headers) {
  const statusUrl = asyncUrl.replace('/generate/text/async', '/status/models?type=text');
  const res = await fetchWithTimeout(statusUrl, { headers }, 10_000);
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  return pickHordeUncensoredModels(rows);
}

/** Horde's anonymous key: the keyless route needs no account at all. */
export const HORDE_ANON_KEY = '0000000000';

/**
 * One Horde submit attempt. On rejection the thrown error carries
 * Horde's OWN response (status, rc, message) — the old code threw a
 * generic "queue rejected the job" for every non-2xx, which hid the
 * actual cause (a flagged key, an upfront-kudos gate, a bad payload)
 * behind the same words and made a live 403 undiagnosable.
 */
async function hordeSubmitOnce(url, headers, body) {
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    if (!data?.id) throw new Error('Horde: no job id returned.');
    return data.id;
  }
  const raw = await res.text().catch(() => '');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* non-JSON error body — the raw text below still carries it */
  }
  const rc = typeof parsed?.rc === 'string' ? parsed.rc : null;
  const message =
    (typeof parsed?.message === 'string' && parsed.message) || raw.slice(0, 200) || 'queue rejected the job.';
  const err = new Error(`Horde ${res.status}${rc ? ` (${rc})` : ''}: ${message}`);
  err.status = res.status;
  err.rc = rc;
  throw err;
}

async function callHorde(model, messages, env) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  const configuredKey = typeof env.AIHORDE_API_KEY === 'string' && env.AIHORDE_API_KEY ? env.AIHORDE_API_KEY : null;
  const headersFor = (key) => ({ apikey: key, 'Content-Type': 'application/json', 'Client-Agent': 'termux-code:1.0' });

  // Horde is the keyless uncensored route now that HF's endpoint is dead:
  // ask for uncensored workers specifically when any are online, so the
  // answer comes from Stheno/Heretic-lineage models instead of whatever
  // worker happens to be free. Falls back to any worker when the status
  // fetch fails or no uncensored worker is online.
  const probeHeaders = headersFor(configuredKey || HORDE_ANON_KEY);
  const uncensored = await fetchHordeUncensoredModels(urlFor(model, env), probeHeaders).catch(() => []);

  const baseBody = {
    prompt: `${system}\n\n${user}\n\n`,
    params: { max_length: 512, max_context_length: 4096, temperature: 0.7 },
  };

  // Submit ladder. A single rejected submit must not kill the only
  // keyless route, and the two rejection modes seen live are both
  // recoverable by changing the request, not by giving up:
  //   1. A configured AIHORDE_API_KEY that Horde rejects (401/403 — a
  //      stale or flagged key sitting in a gateway's env) must not take
  //      the keyless route down with it: retry as anonymous, which
  //      needs no key at all.
  //   2. A models-restricted submit can be gated by the requested
  //      workers themselves (e.g. a 403 KudosUpfront from workers that
  //      demand upfront kudos an anonymous account does not have):
  //      retry unrestricted, open to any worker.
  // Ladder order keeps the best answer first: configured key +
  // uncensored workers, then each single relaxation, ending at
  // anonymous + any worker. The last error (with Horde's own rc and
  // message, via hordeSubmitOnce) is what surfaces if all rungs fail.
  const keys = configuredKey && configuredKey !== HORDE_ANON_KEY ? [configuredKey, HORDE_ANON_KEY] : [HORDE_ANON_KEY];
  const bodies = uncensored.length ? [{ ...baseBody, models: uncensored }, baseBody] : [baseBody];
  let id = null;
  let winHeaders = null;
  let lastErr = null;
  outer: for (const key of keys) {
    for (const body of bodies) {
      try {
        id = await hordeSubmitOnce(urlFor(model, env), headersFor(key), body);
        winHeaders = headersFor(key);
        break outer;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (!id) throw lastErr || new Error('Horde: queue rejected the job.');

  const statusUrl = urlFor(model, env).replace('/async', `/status/${id}`);
  // Horde generation takes a while; 45s almost never completed a
  // 512-token job, so the uncensored route gets real headroom.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetchWithTimeout(statusUrl, { headers: winHeaders }, 15_000);
    const body = await poll.json().catch(() => ({}));
    // A faulted job never completes: fail fast with what Horde said
    // instead of polling a dead job for the full two minutes.
    if (body.faulted) {
      throw new Error(`Horde: job faulted in the queue${body.generations?.[0]?.state ? ` (${body.generations[0].state})` : ''}.`);
    }
    if (body.done) {
      const text = body.generations?.[0]?.text?.trim() || '';
      if (!text) throw new Error('Horde: job finished with an empty generation.');
      return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
    }
  }
  throw new Error('Horde timed out waiting in the queue.');
}

/* ---------- Hugging Face, error-inbox catalog shape — text-only, keyless ---------- */

/**
 * Mirrors error-inbox's huggingfaceChat adapter (lib/llm/adapters.ts)
 * exactly: same endpoint, same { inputs, parameters } body, same optional
 * bearer (HF_TOKEN / HUGGINGFACE_API_KEY upgrade the quota; the call works
 * with neither set), same generated_text parsing. Two deliberate
 * differences, both for chat use: max_new_tokens is 1024 instead of 512,
 * and the echoed prompt is stripped off generated_text (the text-generation
 * API returns prompt + completion; error-inbox only keeps the last 2000
 * chars, which for a chatbot would read as the conversation repeated back).
 */
async function callHuggingFaceEI(model, messages, env) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = env.HF_TOKEN || env.HUGGINGFACE_API_KEY;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const inputs = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

  const res = await fetchWithTimeout(`${urlFor(model, env)}/${model.id}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inputs, parameters: { max_new_tokens: 1024 } }),
  });

  if (!res.ok) {
    throw new Error(`Hugging Face ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  }
  const d = await res.json().catch(() => null);
  if (d?.error) throw new Error(`Hugging Face: ${renderError(d.error).slice(0, 300)}`);
  let text = Array.isArray(d) ? d[0]?.generated_text : d?.generated_text;
  if (typeof text !== 'string' || !text) throw new Error('Hugging Face: empty response');
  if (text.startsWith(inputs)) text = text.slice(inputs.length);
  text = stripThinking(text).replace(/^(assistant|model)\s*:\s*/i, '');
  return { text: text.slice(-2000), toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
}

/* ---------- dispatch ---------- */

/**
 * `extraTools` carries MCP tools, already in this model's wire format. Only
 * the two tool-calling paths receive them: Gemini, Cohere and Horde are
 * text-only here, so passing tools they can't use would just waste tokens.
 */
export function complete(model, messages, env = process.env, extraTools = [], opts = {}) {
  switch (model.auth) {
    case 'anthropic':
      return callAnthropic(model, messages, env, extraTools, opts);
    case 'gemini':
      return callGemini(model, messages, env);
    case 'cohere':
      return callCohere(model, messages, env);
    case 'horde':
      return callHorde(model, messages, env);
    case 'hf':
      return callHuggingFaceEI(model, messages, env);
    default:
      return callOpenAIShaped(model, messages, env, extraTools, opts); // 'bearer' | 'none'
  }
}

/** Error Inbox's small free models sometimes emit reasoning tags; strip them. */
export function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

/** Append a tool result in whichever format this model speaks. */
export function appendToolResult(messages, model, call, result) {
  if (model.auth === 'anthropic') {
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, content: String(result) }],
    });
  } else {
    messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: String(result) });
  }
  return messages;
}

/**
 * Send a message through error-inbox's own public agent instead of calling a
 * provider directly. This is error-inbox's real programmatic endpoint
 * (app/api/v1/message/route.ts) — same brains as its in-app DM, chief
 * delegation included. It does NOT accept a chosen model: error-inbox routes
 * internally across its own pool, and does NOT run termux-code's local tools
 * (read/write/edit/grep/bash) — it has its own, separate, server-side tools.
 * Use this for "ask my error-inbox agent" rather than "edit files on my phone".
 */
export async function sendToErrorInbox(message, { agent, baseUrl, apiKey } = {}) {
  const url = (baseUrl || process.env.ERROR_INBOX_URL || 'https://error-inbox.onrender.com').replace(/\/$/, '');
  const key = apiKey || process.env.ERROR_INBOX_KEY;
  if (!key) throw new Error('No Error Inbox API key set (ERROR_INBOX_KEY, an eibx_... token from its Settings page).');

  const res = await fetchWithTimeout(`${url}/api/v1/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, agent }),
  }, ERROR_INBOX_TIMEOUT_MS);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ? renderError(data.error) : `Error Inbox returned ${res.status}.`);
  return data.reply;
}
