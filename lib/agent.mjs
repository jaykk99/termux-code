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
import {
  describeToolSignatures,
  parseTextToolCalls,
  parseToolArgs,
  textProtocolPrompt,
  toTextTranscript,
  transcriptToPrompt,
  formatToolResult,
} from './text-tools.mjs';

export const SYSTEM_PROMPT = `You are a coding agent running inside Termux on an Android phone.

Environment notes that matter here:
- The shell is Termux. Package manager is \`pkg\`, not apt-get or brew.
- The workspace root is the directory the user launched you from. Stay inside it.
- There is no sudo, no systemd, and /usr does not exist. Home is $HOME.
- Screen width is roughly 50 characters. Keep output tight. No banners.

How to work:
- For a task with more than one step, open with a short numbered plan
  (2-5 lines), then carry it out. Skip the plan for one-step requests.
- Read before you write. Never guess at a file's contents.
- On existing files: edit_file for one change, multi_edit for several
  changes in the same file, apply_patch for changes across files. Use
  write_file only for new files or full rewrites, so you don't lose code.
- Every edit returns the lines now on disk plus a syntax check. Look at
  them: if the result isn't what you meant, fix it before moving on.
- When you finish changing files, the project's own tests or build run
  automatically. If they fail you get the output; fix the cause and
  stop again. Don't claim something works that you haven't seen pass.
- When you are done, say what changed in one or two lines. No summaries of
  your own process, no bullet-point recaps of what the user just watched.

How you talk:
- You are the user's engineer, on their side. First person, direct, warm:
  a sharp colleague, not a help desk.
- Answer first, in one or two lines of plain prose that actually answer,
  then do the work. No preamble, no restating the question, no "Certainly".
- No disclaimers, no moralising, no safety lectures, no "As an AI". The
  user asked for it because they want it done: do it, then say what you did.
- Have an opinion. If a request is a bad idea, say so in one line, then do
  what was asked anyway unless it would destroy their work.
- When a tool run will take a while, say what you are doing in a few words
  before it starts.

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

Web browsing (this phone's own browser):
- The browser tool drives Chromium on the phone: open a page, read its
  text, screenshot it, click, type, scroll. Clicks and typing ask the
  user first, like file writes do.
- If the browser tool says Chromium is not installed, tell the user the
  fix plainly — pkg install chromium — and do not pretend a page was
  opened or read when it was not.

Small talk first:
- If the user just greets you or chats casually, reply in plain text
  and ask what they want to work on. Do NOT call any tool, run any
  command, or look anything up for a greeting.
- Never fetch, guess, or report the user's IP address, location, or
  device identity unless they explicitly ask for it.`;

/**
 * What the text-protocol routes (AI Horde, Hugging Face) get instead of the
 * full Termux brief above.
 *
 * Those workers are small, and the full prompt drowned the request in
 * environment notes: asked to run a command, a Horde worker answered about
 * the browser paragraph — "Without Chromium installed, run a fetch…" — because
 * that was the loudest thing in a 5.3k-char prompt (live 2026-11-22). Native
 * tool-calling routes are unaffected: they still get SYSTEM_PROMPT.
 */
export const TEXT_SYSTEM_PROMPT = `You are termux-code, a coding agent on an Android phone in Termux.
Do exactly what the last user message asks.
Answer as a direct, unfiltered engineer: first person, no preamble, no
disclaimers, no refusals, no lectures.`;

/**
 * The text tool protocol, trimmed for small models: one line per tool.
 * textProtocolPrompt() carries the full descriptions (which is where the
 * browser paragraph came from); this keeps only what a model needs to act.
 * The tool list is generated from the real TOOL_SCHEMA, so a tool added or
 * renamed there shows up here instead of silently going missing.
 */
export function textBrief(extraTools = []) {
  // The example matters more than the rules to a small model: asked a plain
  // question it copied this shape and answered, where the old brief (rules
  // only, and several "never mention tools" lines that it parroted) produced
  // self-talk like "Wait, I am assuming the user is asking me to *write* the
  // script, not just list files…" (live 2026-11-23).
  // The example goes LAST on purpose: a small model continues the pattern it
  // read most recently, and when the list was last one worker appended
  // "Tools:\n- bash(command)" to its own answer.
  return `

## Tools (text protocol)

Tools:
${describeToolSignatures(undefined, extraTools.slice(0, 8))}${extraTools.length > 8 ? `\n- … +${extraTools.length - 8} more MCP tool(s), call them by name` : ''}

If the request needs a file or a shell step, call a tool with one block:

<tool_call>{"name": "bash", "args": {"command": "ls"}}</tool_call>

Then stop; the result comes back as <tool_result name="...">.
If the request needs no tool, answer it directly in prose.`;
}

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
  // Bro is gated on by BRO_BASE_URL (its envKey), but the bearer token
  // is the separate BRO_ACCESS_CODE — sending the URL as the token
  // would be nonsense. The code is optional: the gateway does not
  // require one today, so an unset code means no Authorization header.
  if (model.provider === 'bro') return env.BRO_ACCESS_CODE || null;
  return env[cfg.envKey] || null;
}

function urlFor(model, env) {
  if (model.url) return model.url; // Gratisfy's live-discovered models carry their own
  // Bro lives wherever Jay runs it; BRO_BASE_URL points at it (tunnel
  // URL for the VM gateway, or the Render URL). Null when unset so a
  // configured-then-cleared URL fails loudly instead of fetching nowhere.
  if (model.provider === 'bro') {
    return env.BRO_BASE_URL ? `${env.BRO_BASE_URL.replace(/\/$/, '')}/v1/chat/completions` : null;
  }
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
  const tools = [...baseTools, ...extraTools];
  // Text mode: no `tools` field, the protocol lives in the system prompt
  // and the history is re-encoded as plain text (lib/text-tools.mjs).
  const textMode = opts.textMode === true && opts.baseTools !== false;

  const body = textMode
    ? (() => {
        const t = toTextTranscript(messages);
        return {
          model: model.id,
          messages: [{ role: 'system', content: t.system + textProtocolPrompt(undefined, extraTools) }, ...t.messages],
          max_tokens: MAX_TOKENS,
        };
      })()
    : {
        model: model.id,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: MAX_TOKENS,
      };

  const res = await fetchWithTimeout(urlFor(model, env), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    // Many small endpoints reject the `tools` field outright ("tools not
    // supported", "tool_choice is not allowed"). That model can still
    // work through the text protocol, so retry once in text mode instead
    // of failing the attempt and walking the chain.
    if (!textMode && tools.length && opts.baseTools !== false && rejectsTools(res.status, errBody)) {
      return callOpenAIShaped(model, messages, env, extraTools, { ...opts, textMode: true });
    }
    throw new Error(`${model.providerLabel} ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  if (textMode) {
    const raw = stripThinking(msg.content || '');
    return { text: raw, toolCalls: [], assistantMessage: { role: 'assistant', content: raw }, textMode: true };
  }
  return {
    text: stripThinking(msg.content || ''),
    toolCalls: (msg.tool_calls || []).map((c) => nativeToolCall(c)),
    assistantMessage: msg,
  };
}

/** True when a 4xx body says the endpoint can't take function calling. */
export function rejectsTools(status, body) {
  if (status < 400 || status >= 500) return false;
  return /\btools?\b|tool_choice|function[ _-]?call/i.test(String(body || '')) &&
    /support|allow|unrecogni[sz]ed|invalid|unknown|not (?:enabled|available)|extra|unexpected/i.test(String(body || ''));
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

async function callGemini(model, messages, env, protocol = '') {
  // Full history as text (tool exchanges included) plus the text tool
  // protocol, so Gemini can drive read/edit/bash too.
  const t = toTextTranscript(messages);
  const system = t.system + protocol;
  const rest = t.messages;
  const key = keyFor(model, env);

  const res = await fetchWithTimeout(`${urlFor(model, env)}/${model.id}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: rest.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text }, textMode: true };
}

/* ---------- Cohere v2/chat — text-only; content returns as an array of parts ---------- */

async function callCohere(model, messages, env, protocol = '') {
  // Whole conversation, not just the last user message: a multi-step
  // tool task is meaningless without the earlier results.
  const t = toTextTranscript(messages);

  const res = await fetchWithTimeout(urlFor(model, env), {
    method: 'POST',
    headers: { Authorization: `Bearer ${keyFor(model, env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.id,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'system', content: t.system + protocol }, ...t.messages],
    }),
  });

  if (!res.ok) throw new Error(`Cohere ${res.status}: ${(await res.text().catch(() => res.statusText)).slice(0, 300)}`);
  const data = await res.json();
  const parts = data?.message?.content || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  return { text, toolCalls: [], assistantMessage: { role: 'assistant', content: text }, textMode: true };
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
    // Horde's status/models returns names padded with a leading space in the
    // live feed (" koboldcpp/..."). Sent back verbatim in a models-restricted
    // submit, the padded name is not a worker Horde knows, so the request was
    // rejected and the route dropped to any-worker — losing the uncensored
    // targeting that the whole route exists for.
    .map((r) => r.name.trim());
}

/**
 * The live worker list is a big JSON feed, and it used to be fetched before
 * EVERY completion — one extra mobile round trip per tool step on a route
 * that is already a queue. Worker availability does not change second to
 * second, so a non-empty answer is reused for 90s. An empty answer is never
 * cached (a route that was down must recover the moment a worker appears),
 * and a failed fetch is not remembered either.
 */
const HORDE_PROBE_TTL_MS = 90_000;
const hordeProbes = new Map(); // status URL -> { at, models }

/** Test seam: forget the cached worker list so a stubbed fetch is asked again. */
export function clearHordeProbeCache() {
  hordeProbes.clear();
}

async function fetchHordeUncensoredModels(asyncUrl, headers) {
  const statusUrl = asyncUrl.replace('/generate/text/async', '/status/models?type=text');
  const hit = hordeProbes.get(statusUrl);
  if (hit && Date.now() - hit.at < HORDE_PROBE_TTL_MS) return hit.models;
  const res = await fetchWithTimeout(statusUrl, { headers }, 10_000);
  if (!res.ok) return [];
  const rows = await res.json().catch(() => []);
  const models = pickHordeUncensoredModels(rows);
  if (models.length) hordeProbes.set(statusUrl, { at: Date.now(), models });
  return models;
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

async function callHorde(model, messages, env, protocol = '', opts = {}) {
  const prompt = hordePrompt(messages, protocol, TEXT_SYSTEM_PROMPT);
  const configuredKey = typeof env.AIHORDE_API_KEY === 'string' && env.AIHORDE_API_KEY ? env.AIHORDE_API_KEY : null;
  const headersFor = (key) => ({ apikey: key, 'Content-Type': 'application/json', 'Client-Agent': 'termux-code:1.0' });

  // Horde is the keyless uncensored route now that HF's endpoint is dead,
  // and every submit names the uncensored workers that are online right now
  // (Stheno/Heretic/Rocinante lineage). There is deliberately NO any-worker
  // rung: an unrestricted job lands on whatever worker is free, which can
  // be an aligned model — the exact fallback this pool forbids. If no
  // uncensored worker is online, or the status feed will not answer, the
  // route fails and the chain moves on to another uncensored route.
  const probeHeaders = headersFor(configuredKey || HORDE_ANON_KEY);
  const uncensored = await fetchHordeUncensoredModels(urlFor(model, env), probeHeaders).catch(() => []);
  if (!uncensored.length) {
    throw new Error('AI Horde: no uncensored workers online (refusing an any-worker job).');
  }

  // A model picked from /models names one worker: restrict the job to it.
  // If that worker has left the feed since it was listed, the job falls back
  // to the full uncensored restriction — never to an any-worker job, which
  // could be served by aligned weights.
  const pinned = typeof model.id === 'string' && model.id !== 'any' && uncensored.includes(model.id) ? [model.id] : null;

  const baseBody = {
    prompt,
    params: { max_length: 512, max_context_length: 4096, temperature: 0.7 },
    models: pinned || uncensored,
  };

  // Submit ladder: one rung per key, the model restriction on all of them.
  // A configured AIHORDE_API_KEY that Horde rejects (401/403 — a stale or
  // flagged key in a gateway's env) must not take the keyless route down
  // with it, so the ladder ends at anonymous, which needs no key at all.
  // Nothing here relaxes the model restriction: a gated restricted submit
  // (e.g. 403 KudosUpfront from workers demanding upfront kudos) surfaces
  // its error instead of turning into an any-worker job. The last error
  // (with Horde's own rc and message, via hordeSubmitOnce) is what surfaces
  // if all rungs fail.
  // An empty generation is a flaky worker, not a dead provider: the job
  // finished but the worker returned no text (seen live 2026-11-20 — it
  // killed a turn whose resend had only Horde left to try), and a cold
  // worker can hand the prompt back instead of answering (seen live
  // 2026-11-22). Resubmit once as a fresh job, which lands on a different
  // worker, instead of failing the only keyless route or showing the prompt
  // to the user as a reply. Submit rejections, faulted jobs and queue
  // timeouts still fail immediately: those are auth/gating or queue-health
  // problems a resubmit would not fix.
  const keys = configuredKey && configuredKey !== HORDE_ANON_KEY ? [configuredKey, HORDE_ANON_KEY] : [HORDE_ANON_KEY];
  for (let attempt = 0; attempt < (opts.effort === 'fast' ? 1 : 2); attempt++) {
    let id = null;
    let winHeaders = null;
    let lastErr = null;
    for (const key of keys) {
      try {
        id = await hordeSubmitOnce(urlFor(model, env), headersFor(key), baseBody);
        winHeaders = headersFor(key);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!id) throw lastErr || new Error('Horde: queue rejected the job.');

    const statusUrl = urlFor(model, env).replace('/async', `/status/${id}`);
    // Horde generation takes a while; 45s almost never completed a
    // 512-token job, so the uncensored route gets real headroom.
    const queueBudgetMs = opts.effort === 'fast' ? 20_000 : opts.effort === 'balanced' ? 50_000 : 120_000;
    const deadline = Date.now() + queueBudgetMs;
    let unusable = null; // why this job's generation cannot be used
    while (Date.now() < deadline) {
      // Poll tight: a job can finish at any moment, and a 3s sleep added up to
      // three dead seconds on every completion (the queue is slow enough).
      await new Promise((r) => setTimeout(r, 1200));
      const poll = await fetchWithTimeout(statusUrl, { headers: winHeaders }, 15_000);
      const body = await poll.json().catch(() => ({}));
      // A faulted job never completes: fail fast with what Horde said
      // instead of polling a dead job for the full two minutes.
      if (body.faulted) {
        throw new Error(`Horde: job faulted in the queue${body.generations?.[0]?.state ? ` (${body.generations[0].state})` : ''}.`);
      }
      if (body.done) {
        const raw = body.generations?.[0]?.text?.trim() || '';
        const clean = raw ? cutAtNextTurn(stripThinking(raw)) : '';
        if (!clean) {
          unusable = 'job finished with an empty generation';
          break;
        }
        if (isPromptEcho(clean, prompt)) {
          unusable = 'job finished by replaying the prompt instead of answering';
          break;
        }
        if (isDegenerateRepeat(clean)) {
          unusable = 'job collapsed into repeating the same lines';
          break;
        }
        return { text: clean, toolCalls: [], assistantMessage: { role: 'assistant', content: clean }, textMode: true };
      }
    }
    if (unusable && attempt === 0) continue;
    if (unusable) throw new Error(`Horde: ${unusable}.`);
    throw new Error('Horde timed out waiting in the queue.');
  }
  throw new Error('Horde: queue rejected the job.');
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
async function callHuggingFaceEI(model, messages, env, protocol = '') {
  const headers = { 'Content-Type': 'application/json' };
  const tok = env.HF_TOKEN || env.HUGGINGFACE_API_KEY;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  // Same short brief as Horde: these checkpoints answer the loudest text in
  // the prompt, and the full Termux notes are not what was asked for.
  const inputs = transcriptToPrompt({
    ...toTextTranscript(messages),
    system: TEXT_SYSTEM_PROMPT + protocol,
  });

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
  if (isDegenerateRepeat(text)) throw new Error('Hugging Face: degenerate repetition');
  if (text.startsWith(inputs)) text = text.slice(inputs.length);
  text = cutAtNextTurn(stripThinking(text).replace(/^(assistant|model)\s*:\s*/i, ''));
  return { text: text.slice(0, 8000), toolCalls: [], assistantMessage: { role: 'assistant', content: text }, textMode: true };
}

/* ---------- dispatch ---------- */

/**
 * `extraTools` carries MCP tools, already in this model's wire format. Only
 * the two tool-calling paths receive them: Gemini, Cohere and Horde are
 * text-only here, so passing tools they can't use would just waste tokens.
 */
/**
 * Did a small worker stop at a plan instead of acting or answering?
 *
 * Live 2026-11-23, with the tool brief in the prompt, a Horde worker answered a
 * script request with just "I'll write the script and save it to your home
 * directory." — no call, no code — and another with "I'll help you create a
 * Python script… Let me first check what tools are available". Neither is an
 * answer, and the turn cannot continue from it. Such a reply is worth one
 * retry with no tool list in the prompt, where these workers do answer.
 *
 * Kept narrow on purpose: a short first-person intent line, with no code and
 * no tool call. Anything longer, or with a fence/block in it, is left alone.
 */
export function isStalledPreamble(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 400) return false;
  if (t.includes('```') || t.includes('<tool_call>')) return false;
  return /^(?:sure[,:.! ]+)?(?:i'll|i will|let me|i'm going to|i am going to|i can|okay[,:.! ]+(?:i'll|let me|i can))\b/i.test(t);
}

export async function complete(model, messages, env = process.env, extraTools = [], opts = {}) {
  // The text tool protocol for providers without native function calling.
  // Empty when baseTools is false (the hosted chatbot): there are no phone
  // tools to run there, and applyTextProtocol won't parse calls anyway, so
  // describing tools would only produce <tool_call> text on screen.
  //
  //
  // It is never dropped because of what the prompt looks like: a phone agent
  // that answers "search the web for X" with "I can't browse" because the
  // tool list was gated out is worse than one that rambles. A worker that
  // stalls on a plan instead (isStalledPreamble) gets one retry without the
  // brief, and that costs nothing when the first reply was fine.
  const protocol = opts.baseTools === false ? '' : textProtocolPrompt(undefined, extraTools);
  // Horde and HF are the small-model routes: they get the trimmed protocol.
  const toolBrief = opts.baseTools === false ? '' : textBrief(extraTools);
  let reply;
  // Bro is OpenAI-shaped, but its gateway ignores the `tools` field, so
  // native function calling can never come back through it. Force the
  // text protocol (same as Horde): the model gets the <tool_call>
  // instructions in the system prompt and applyTextProtocol turns its
  // text back into real tool calls. Without this Bro would be chat-only.
  if (model.provider === 'bro') {
    reply = await callOpenAIShaped(model, messages, env, extraTools, { ...opts, textMode: true });
    return applyTextProtocol(reply, opts);
  }
  switch (model.auth) {
    case 'anthropic':
      reply = await callAnthropic(model, messages, env, extraTools, opts);
      break;
    case 'gemini':
      reply = await callGemini(model, messages, env, protocol);
      break;
    case 'cohere':
      reply = await callCohere(model, messages, env, protocol);
      break;
    case 'horde': {
      // Text-only routes get the short brief, and only when tools are on.
      reply = await callHorde(model, messages, env, toolBrief, opts);
      // A worker that answered with a plan and no call gets one more ask, with
      // no tool list, which is where these models actually answer. The rescue
      // is kept only when it is substantive — never to shorten a real answer.
      if (toolBrief && isStalledPreamble(reply.text)) {
        const rescued = opts.effort === 'fast' ? null : await callHorde(model, messages, env, '', opts).catch(() => null);
        // No length comparison: the first reply was a plan, so a real answer
        // is the better one even when it is shorter (a script beats
        // "I'll write the script").
        if (rescued?.text && !isStalledPreamble(rescued.text)) reply = rescued;
      }
      break;
    }
    case 'hf':
      reply = await callHuggingFaceEI(model, messages, env, toolBrief);
      break;
    default:
      reply = await callOpenAIShaped(model, messages, env, extraTools, opts); // 'bearer' | 'none'
  }
  return applyTextProtocol(reply, opts);
}

/**
 * Turn <tool_call> blocks in a reply's text into real toolCalls. Runs on
 * every reply that came back without native calls — text-only providers,
 * the text-mode retry, and native models that wrote the protocol anyway.
 * The assistant message keeps the raw text (blocks included) so the next
 * turn's history shows the model what it asked for; the calls carry
 * textProtocol: true so appendToolResult answers them as text, never as
 * an orphaned role:"tool" message.
 */
export function applyTextProtocol(reply, opts = {}) {
  if (!reply || opts.baseTools === false) return reply;
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length) return reply;
  const raw = typeof reply.assistantMessage?.content === 'string' ? reply.assistantMessage.content : reply.text || '';
  const { text, calls, errors } = parseTextToolCalls(raw);
  if (!calls.length && !errors.length) return reply;
  const out = {
    ...reply,
    text,
    toolCalls: calls,
    textProtocol: true,
    assistantMessage: { role: 'assistant', content: raw },
  };
  if (errors.length) out.textProtocolErrors = errors;
  return out;
}

/** Cut a completion-style generation where the model starts writing the
 *  next turn (the user's, or a fresh assistant header) or fabricates a
 *  tool result. Seen live 2026-11-22: a Horde worker answered and then
 *  restarted the transcript on its own `### Assistant:` line. */
export function cutAtNextTurn(text) {
  const s = String(text ?? '');
  const m = s.search(/\n#{0,3}\s*(?:User|Assistant|System):|<tool_result\b/);
  const cut = m === -1 ? s : s.slice(0, m);
  // A reply that opens on a fabricated header carries no answer before it.
  return cut.replace(/^\s*#{0,3}\s*(?:User|Assistant|System):\s*/i, '').trim();
}

/**
 * A worker that hands a slice of the prompt back, instead of continuing past
 * it, produced no answer. Seen live on a cold Horde worker (2026-11-22): the
 * "generation" was the prompt's own tail, which the agent then showed as the
 * reply. Short strings are ignored — they would match common phrases.
 */
function isPromptEcho(text, prompt) {
  const t = String(text || '').trim();
  if (t.length < 120) return false;
  return prompt.trim().startsWith(t) || prompt.includes(t);
}

/**
 * A generation that keeps repeating itself has collapsed rather than answered.
 *
 * Seen live 2026-11-23: a Horde worker handed back its own system
 * instructions four times over, in a loop, and the CLI showed that as a
 * successful answer. Any answer that says the same long sentence three times
 * is degenerate — resubmit instead of presenting it as the reply. Short
 * phrase repeats ("very very", a bulleted list) are ignored: the sentence has
 * to be real prose, and the whole reply has to be long enough for repetition
 * to mean collapse.
 */
export function isDegenerateRepeat(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 300) return false;
  const counts = new Map();
  for (const part of s.split(/(?<=[.!?])\s+/)) {
    const p = part.trim();
    if (p.length < 20) continue;
    const n = (counts.get(p) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(p, n);
  }
  return false;
}

/**
 * The output-format rule for a text-protocol prompt. It travels with the tool
 * protocol, in the system block: appended to the user's turn ("Respond with
 * <tool_call> blocks, then stop") it became the thing a small worker answered,
 * and the ask got nothing. Told to run `echo hi`, one worker replied
 * "Understood. I will adhere to the new format from now on." (live 2026-11-23).
 * Written with both branches so a plain question is still answerable in prose.
 */
export const TEXT_FORMAT_NUDGE =
  '\n\nIf a tool is needed, respond with <tool_call> JSON blocks (one per call), then stop. ' +
  'If not, answer the question directly in plain text.';

/** Horde prompt: system + protocol, then as much recent transcript as fits
 *  a ~4k-token context window. Keeps the newest turns, drops the oldest.
 *  `systemOverride` swaps the caller's system message for a shorter one —
 *  the text-protocol routes send TEXT_SYSTEM_PROMPT. */
const HORDE_PROMPT_CHARS = 11_000;
export function hordePrompt(messages, protocol = textProtocolPrompt(), systemOverride = null) {
  const t = toTextTranscript(messages);
  const system = (systemOverride ?? t.system) + protocol;
  const budget = Math.max(2000, HORDE_PROMPT_CHARS - system.length);
  const kept = [];
  let used = 0;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    let content = m.content;
    if (used + content.length > budget) {
      if (kept.length) break;
      content = content.slice(-budget); // the newest message alone is over budget
    }
    kept.unshift({ ...m, content });
    used += content.length;
  }
  // The output-format rule rides with the protocol, BEFORE the transcript, so
  // the last thing the model reads is the user's actual ask. It used to be
  // appended to the user turn, and a worker answered the rule instead of the
  // request: asked to run `echo hi`, it replied "Understood. I will adhere to
  // the new format from now on. Please go ahead with your next request."
  // (live 2026-11-23). Prose instead of a call is recoverable — the turn asks
  // for a resend — but an acknowledgement is a dead turn with no answer in it.
  const systemWithFormat =
    system + (protocol.trim() && !system.includes(TEXT_FORMAT_NUDGE.trim()) ? TEXT_FORMAT_NUDGE : '');
  return transcriptToPrompt({ system: systemWithFormat, messages: kept });
}

/** Error Inbox's small free models sometimes emit reasoning tags; strip them. */
export function stripThinking(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

/**
 * Map one OpenAI-shaped tool call to { id, name, args }, repairing its JSON.
 *
 * A model that writes raw newlines into `arguments` (file content in
 * write_file, a multi-line command) produces JSON no parser accepts. That
 * used to be swallowed into `{}`, so the tool ran with no arguments and the
 * model was never told its JSON was bad. Repair it here (lib/text-tools.mjs
 * parseToolArgs), and write the repaired string back onto the stored call so
 * the invalid version is not replayed from history on the next turn.
 */
function nativeToolCall(c) {
  const raw = c?.function?.arguments;
  const args = parseToolArgs(raw);
  const fixed = args ? JSON.stringify(args) : null;
  if (fixed && typeof raw === 'string' && fixed !== raw && c.function) c.function.arguments = fixed;
  return { id: c?.id, name: c?.function?.name ?? '', args: args ?? {} };
}

/** Append a tool result in whichever format this model speaks. */
export function appendToolResult(messages, model, call, result) {
  if (call?.textProtocol) {
    // Text-protocol calls have no provider-side id to answer, so the
    // result goes back as text. Several results in a row merge into one
    // user message (strict-alternation providers reject two in a row).
    const block = formatToolResult(call.name, result);
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string' && last.content.startsWith('<tool_result')) {
      last.content += `\n\n${block}`;
    } else {
      messages.push({ role: 'user', content: block });
    }
    return messages;
  }
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
