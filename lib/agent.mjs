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
 *   - horde          : async submit-then-poll queue, single-shot, no tools.
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

If a request is ambiguous, ask one question rather than guessing.`;

const MAX_TOKENS = 4096;

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

async function callOpenAIShaped(model, messages, env) {
  const key = keyFor(model, env);
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(urlFor(model, env), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.id,
      messages,
      tools: toolsForOpenAI(),
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

async function callAnthropic(model, messages, env) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const rest = messages.filter((m) => m.role !== 'system');

  const res = await fetch(urlFor(model, env), {
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
      tools: toolsForAnthropic(),
      max_tokens: MAX_TOKENS,
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const blocks = data.content || [];
  if (data.stop_reason === 'refusal') {
    return { text: 'Anthropic declined this request.', toolCalls: [], assistantMessage: { role: 'assistant', content: blocks } };
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

  const res = await fetch(`${urlFor(model, env)}/${model.id}:generateContent?key=${key}`, {
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

  const res = await fetch(urlFor(model, env), {
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

async function callHorde(model, messages, env) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content || '';
  const key = env.AIHORDE_API_KEY || '0000000000';
  const headers = { apikey: key, 'Content-Type': 'application/json', 'Client-Agent': 'termux-code:1.0' };

  const submit = await fetch(urlFor(model, env), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt: `${system}\n\n${user}\n\n`,
      params: { max_length: 512, max_context_length: 4096, temperature: 0.7 },
    }),
  });
  if (!submit.ok) throw new Error(`Horde ${submit.status}: queue rejected the job.`);
  const { id } = await submit.json();
  if (!id) throw new Error('Horde: no job id returned.');

  const statusUrl = urlFor(model, env).replace('/async', `/status/${id}`);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(statusUrl, { headers });
    const body = await poll.json().catch(() => ({}));
    if (body.done) {
      const text = body.generations?.[0]?.text?.trim() || '';
      return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text } };
    }
  }
  throw new Error('Horde timed out waiting in the queue.');
}

/* ---------- dispatch ---------- */

export function complete(model, messages, env = process.env) {
  switch (model.auth) {
    case 'anthropic':
      return callAnthropic(model, messages, env);
    case 'gemini':
      return callGemini(model, messages, env);
    case 'cohere':
      return callCohere(model, messages, env);
    case 'horde':
      return callHorde(model, messages, env);
    default:
      return callOpenAIShaped(model, messages, env); // 'bearer' | 'none'
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
  const url = (baseUrl || process.env.ERROR_INBOX_URL || 'https://error-inbox.vercel.app').replace(/\/$/, '');
  const key = apiKey || process.env.ERROR_INBOX_KEY;
  if (!key) throw new Error('No Error Inbox API key set (ERROR_INBOX_KEY, an eibx_... token from its Settings page).');

  const res = await fetch(`${url}/api/v1/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, agent }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Error Inbox returned ${res.status}.`);
  return data.reply;
}
