/**
 * Text tool-calling protocol.
 *
 * Plenty of models in the pool have no native function calling: Gemini,
 * Cohere, Horde and HF are text-only in lib/agent.mjs, and many small
 * OpenAI-shaped endpoints either ignore `tools` or 400 on it. Before this,
 * a turn on one of those models could only chat — it could not read a
 * file, edit one, or run a command.
 *
 * The fallback: describe the tools in the system prompt and ask the model
 * to write calls as plain text,
 *
 *   <tool_call>{"name": "read_file", "args": {"path": "src/app.js"}}</tool_call>
 *
 * then parse those blocks out of the reply into the same toolCalls shape
 * the native paths return. Results go back as a user message,
 *
 *   <tool_result name="read_file">...</tool_result>
 *
 * because a text-protocol call has no provider-side call id for a
 * role:"tool" message to point at (providers reject orphaned tool
 * messages outright).
 *
 * The parser is deliberately forgiving — small models wrap the JSON in
 * code fences, use "arguments"/"parameters"/"input" instead of "args",
 * pass arguments as a JSON string, or drop the closing tag at the very
 * end of the reply. All of those still parse. A block whose JSON can't be
 * recovered is reported back to the model as a parse error rather than
 * silently dropped, so it can retry with valid JSON. A tool object written
 * with no <tool_call> wrapper at all is taken too, when its name is one of
 * the tools this turn was given (see bareToolCalls).
 */

import { TOOL_SCHEMA } from './tools.mjs';

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/**
 * Accept tool definitions in any of the shapes this codebase passes
 * around — plain schema ({name, description, parameters}), OpenAI wire
 * ({type:'function', function:{...}}) or Anthropic wire ({name,
 * description, input_schema}) — and return the plain shape. The gateway
 * hands its Composio tools over in wire format, so a text-protocol model
 * can be told about them without a second schema to keep in sync.
 */
export function normalizeToolDefs(defs = []) {
  const out = [];
  for (const d of Array.isArray(defs) ? defs : []) {
    if (!d || typeof d !== 'object') continue;
    const f = d.type === 'function' && d.function ? d.function : d;
    if (typeof f.name !== 'string' || !f.name) continue;
    out.push({ name: f.name, description: f.description || '', parameters: f.parameters || f.input_schema || {} });
  }
  return out;
}

/** Compact one-line-per-tool listing of the schema for the prompt. */
export function describeTools(schema = TOOL_SCHEMA, extra = []) {
  const seen = new Set();
  const all = normalizeToolDefs([...schema, ...extra]).filter((t) => !seen.has(t.name) && seen.add(t.name));
  return all
    .map((t) => {
      const props = t.parameters?.properties || {};
      const req = new Set(t.parameters?.required || []);
      const args = Object.entries(props)
        .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type === 'array' ? 'array' : v.type || 'any'}`)
        .join(', ');
      return `- ${t.name}(${args}) — ${t.description}`;
    })
    .join('\n');
}

/**
 * One line per tool — name and arguments only, no descriptions.
 *
 * The text-protocol routes go to small models, and the full descriptions are
 * both long and loud: asked to run a command, a Horde worker answered the
 * browser paragraph instead (live 2026-11-22). Generated from the schema it
 * shares with the native-tool routes, so a new tool can never be missing here.
 */
export function describeToolSignatures(schema = TOOL_SCHEMA, extra = []) {
  const seen = new Set();
  return normalizeToolDefs([...schema, ...extra])
    .filter((t) => !seen.has(t.name) && seen.add(t.name))
    .map((t) => {
      const props = t.parameters?.properties || {};
      const req = new Set(t.parameters?.required || []);
      // Volunteer workers may have only ~4k context tokens. Truncate long
      // optional parameter lists so adding Android/MCP tools does not drown
      // out the actual user request. Required fields always come first.
      const keys = Object.keys(props);
      const preferred = [...keys.filter(k => req.has(k)), ...keys.filter(k => !req.has(k))];
      const args = preferred.slice(0, 3).map((k) => (req.has(k) ? k : `${k}?`)).join(',');
      return `- ${t.name}(${args}${preferred.length > 3 ? ',…' : ''})`;
    })
    .join('\n');
}

/** The protocol instructions appended to the system prompt. */
export function textProtocolPrompt(schema = TOOL_SCHEMA, extra = []) {
  return `

## Tools (text protocol)

You have no native function calling, so call tools by writing a block
exactly like this, with valid JSON inside:

<tool_call>{"name": "read_file", "args": {"path": "src/app.js"}}</tool_call>

Rules:
- One JSON object per block. You may write several blocks in one reply.
- After your tool calls, STOP and wait. The results come back in the next
  message as <tool_result name="...">...</tool_result>. Never write a
  <tool_result> yourself and never guess what a tool returned.
- When the task is finished, reply in plain text with no <tool_call>.

Available tools:
${describeTools(schema, extra)}${normalizeToolDefs(extra).some((t) => t.name.startsWith('composio_'))
    ? `

Connected apps: composio_search finds the right action for a task;
composio_execute runs it with the slug composio_search returned. Never
guess a slug.`
    : ''}`;
}

let counter = 0;
function nextId() {
  counter = (counter + 1) % 1e9;
  return `txt_${Date.now().toString(36)}_${counter}`;
}

/**
 * Escape raw control characters that sit INSIDE a JSON string value.
 *
 * The commonest way a tool call comes back as invalid JSON: the model puts
 * real newlines (or tabs) in an argument carrying file content —
 *
 *   {"name":"write_file","args":{"path":"a.js","content":"one
 *   two"}}
 *
 * which no JSON parser accepts. Newlines, carriage returns and tabs become
 * their escape sequences; other control characters become \uXXXX. Escapes
 * that are already in the text are copied through untouched, so valid JSON
 * is never altered.
 */
export function escapeRawControlChars(s) {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ') out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

/**
 * Recover an argument object from JSON a model got slightly wrong.
 *
 * Tries the text as-is, then with raw control characters escaped, then the
 * outermost {...} when prose surrounds the object, then each of those with
 * trailing commas dropped. Returns the object, or null when nothing usable
 * is there. Shared by the text protocol and the native OpenAI-shaped
 * arguments string, so both paths repair the same slips.
 */
export function parseToolArgs(body) {
  let s = String(body ?? '').trim();
  // ```json ... ``` fences around the object.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!s) return null;
  const tryParse = (x) => {
    try {
      const v = JSON.parse(x);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  // Trailing commas, the most common small-model JSON slip.
  const noTrailingCommas = (x) => x.replace(/,\s*([}\]])/g, '$1');
  // A Set, because escaping a clean string returns it unchanged: without
  // it the common, already-valid case is parsed four times over.
  const candidates = new Set([s, escapeRawControlChars(s)]);
  // Prose around the object: take the outermost {...}.
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const sliced = s.slice(a, b + 1);
    candidates.add(sliced).add(escapeRawControlChars(sliced));
  }
  for (const c of candidates) {
    const v = tryParse(c) ?? tryParse(noTrailingCommas(c));
    if (v) return v;
  }
  return null;
}

/** Normalize {name, args|arguments|parameters|input} into {name, args}. */
function normalizeCall(obj) {
  // {"tool": "x", ...} and {"function": {"name", "arguments"}} variants.
  if (obj.function && typeof obj.function === 'object') obj = { ...obj.function, ...obj, function: undefined };
  const name = obj.name ?? obj.tool ?? obj.tool_name;
  if (typeof name !== 'string' || !name.trim()) return null;
  let args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
  if (typeof args === 'string') {
    args = parseToolArgs(args) ?? {};
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { name: name.trim(), args };
}

/** The JSON object starting at `start`, or null when its braces never balance. */
function objectAt(src, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * Tool objects written with NO <tool_call> wrapper: a small model hands back
 * `{"name": "write_file", "args": {...}}` (often several, one after another)
 * because that is what the example inside the protocol looked like. Dropped
 * here they read as "answered without a tool call" and the model is never
 * told — seen live 2026-11-23, a Horde worker asked to make a file wrote the
 * write_file object bare and the task counted as no-tool.
 *
 * Only taken when the reply is NOTHING but those objects, separated by
 * whitespace. One word of prose, a stray bracket or a code fence means the
 * model was talking about a call rather than making one, and an example
 * inside an explanation must never run. A name that is not a real tool also
 * disqualifies the whole reply: the objects are then left visible as text.
 */
function bareToolCalls(src, knownTools) {
  const allowed = new Set(normalizeToolDefs(knownTools).map((t) => t.name));
  const calls = [];
  const body = String(src ?? '').trim();
  if (!body) return { calls, text: src };
  // Models sometimes emit a JSON ARRAY of calls instead of one object per
  // line. Only accept a complete response made solely of named, known tools.
  // Never extract arrays from prose or Markdown explanations.
  if (body.startsWith('[') && body.endsWith(']')) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 8) {
      const items = parsed.map((x) => x && typeof x === 'object' && !Array.isArray(x) ? normalizeCall(x) : null);
      if (items.every((x) => x && allowed.has(x.name))) {
        return { calls: items.map((x) => ({ id: nextId(), ...x, textProtocol: true })), text: '' };
      }
    }
    return { calls: [], text: src };
  }
  let i = 0;
  while (i < body.length) {
    if (/\s/.test(body[i])) {
      i++;
      continue;
    }
    if (body[i] !== '{') return { calls: [], text: src }; // prose, a fence, or junk
    const objText = objectAt(body, i);
    if (objText === null) return { calls: [], text: src };
    const obj = parseToolArgs(objText);
    const call = obj && normalizeCall(obj);
    if (!call || !allowed.has(call.name)) return { calls: [], text: src };
    calls.push({ id: nextId(), ...call, textProtocol: true });
    i += objText.length;
  }
  // Nothing but the calls was there, so there is nothing for the user to read.
  return { calls, text: '' };
}

/** Tool objects that name a real tool but sit in prose rather than alone. */
function bareCallsInProse(src, knownTools) {
  const allowed = new Set(normalizeToolDefs(knownTools).map((t) => t.name));
  const out = [];
  for (let i = 0; i < src.length; ) {
    const at = src.indexOf('{', i);
    if (at === -1) break;
    const body = objectAt(src, at);
    if (body === null) break;
    const obj = parseToolArgs(body);
    const call = obj && normalizeCall(obj);
    if (call && allowed.has(call.name)) out.push(body.slice(0, 300));
    i = at + body.length;
  }
  return out;
}

/**
 * Pull <tool_call> blocks out of a reply.
 *
 * Returns { text, calls, errors }:
 *   text   — the reply with every block removed (what the user should see)
 *   calls  — [{ id, name, args, textProtocol: true }]
 *   errors — raw bodies of blocks whose JSON could not be recovered
 *
 * An unterminated final block (model hit max tokens or forgot the close
 * tag) is still parsed if its JSON is complete.
 */
export function parseTextToolCalls(text, knownTools = TOOL_SCHEMA) {
  const src = String(text ?? '');
  const calls = [];
  const errors = [];
  // A model sometimes hallucinates its own results; never show or trust
  // them — including in a reply with no tool_call at all, which used to
  // return early before the strip below ran.
  const stripHallucinatedResults = (s) => s.replace(/<tool_result[\s\S]*?(<\/tool_result>|$)/g, '');
  if (!src.includes(TOOL_CALL_OPEN)) {
    const stripped = stripHallucinatedResults(src);
    const bare = bareToolCalls(stripped, knownTools);
    // A real tool object buried in prose: the strict fallback refuses the
    // reply (and rightly so), but the model was trying to act. Report it as a
    // parse error so the turn asks for the block instead of ending on text
    // nobody can act on — the "answered without a tool call" flake.
    if (!bare.calls.length) errors.push(...bareCallsInProse(stripped, knownTools));
    return { text: bare.text, calls: bare.calls, errors };
  }

  let visible = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf(TOOL_CALL_OPEN, i);
    if (open === -1) {
      visible += src.slice(i);
      break;
    }
    visible += src.slice(i, open);
    const bodyStart = open + TOOL_CALL_OPEN.length;
    let close = src.indexOf(TOOL_CALL_CLOSE, bodyStart);
    // A nested open before the close means this block never closed.
    const nextOpen = src.indexOf(TOOL_CALL_OPEN, bodyStart);
    let end;
    if (close === -1 || (nextOpen !== -1 && nextOpen < close)) {
      close = nextOpen === -1 ? src.length : nextOpen;
      end = close;
    } else {
      end = close + TOOL_CALL_CLOSE.length;
    }
    const body = src.slice(bodyStart, close);
    const obj = parseToolArgs(body);
    const call = obj && normalizeCall(obj);
    if (call) calls.push({ id: nextId(), ...call, textProtocol: true });
    else if (body.trim()) errors.push(body.trim().slice(0, 300));
    i = end;
  }
  // A model sometimes hallucinates its own results; never show or trust them.
  visible = stripHallucinatedResults(visible);
  return { text: visible.replace(/\n{3,}/g, '\n\n').trim(), calls, errors };
}

/** Escape a value for the name="" attribute. */
function attr(v) {
  return String(v ?? '').replace(/"/g, "'").slice(0, 100);
}

/** Format one tool result for a text-protocol model. */
export function formatToolResult(name, result) {
  return `<tool_result name="${attr(name)}">\n${String(result)}\n</tool_result>`;
}

/** Render a call as protocol text (for re-encoding native history). */
export function formatToolCall(name, args) {
  return `${TOOL_CALL_OPEN}${JSON.stringify({ name, args: args ?? {} })}${TOOL_CALL_CLOSE}`;
}

function safeJSON(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/**
 * Convert any history (OpenAI tool_calls / role:"tool", Anthropic
 * tool_use / tool_result blocks, or text-protocol messages) into a plain
 * alternating user/assistant transcript of strings. Text-only providers
 * use this so a session that started on a native tool-calling model and
 * failed over to a text-only one keeps every tool exchange — Gemini used
 * to drop role:"tool" messages entirely, and Cohere/Horde only ever saw
 * the last user message.
 *
 * Returns { system, messages } — system is the joined system content.
 */
export function toTextTranscript(messages) {
  const system = [];
  const out = [];
  const push = (role, content) => {
    const text = String(content ?? '').trim();
    if (!text) return;
    const last = out[out.length - 1];
    // Merge same-role neighbours: several providers require strict
    // user/assistant alternation.
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system') {
      if (typeof m.content === 'string') system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      push('user', formatToolResult(m.name || 'tool', m.content));
      continue;
    }
    if (Array.isArray(m.content)) {
      // Anthropic-native blocks.
      const parts = [];
      for (const b of m.content) {
        if (typeof b === 'string') parts.push(b);
        else if (b?.type === 'text') parts.push(b.text);
        else if (b?.type === 'tool_use') parts.push(formatToolCall(b.name, b.input));
        else if (b?.type === 'tool_result') {
          const c = Array.isArray(b.content) ? b.content.map((x) => x?.text ?? '').join('\n') : b.content;
          parts.push(formatToolResult('tool', c));
        }
      }
      push(m.role === 'assistant' ? 'assistant' : 'user', parts.join('\n'));
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [typeof m.content === 'string' ? m.content : ''];
      for (const c of m.tool_calls || []) {
        if (c?.function?.name) parts.push(formatToolCall(c.function.name, safeJSON(c.function.arguments)));
      }
      push('assistant', parts.join('\n'));
      continue;
    }
    push('user', typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
  }
  // Providers want the conversation to start with a user turn.
  while (out.length && out[0].role !== 'user') out.shift();
  return { system: system.join('\n\n'), messages: out };
}

/** Flatten a transcript into one prompt string (Horde / HF style). */
export function transcriptToPrompt({ system, messages }) {
  const lines = [];
  if (system) lines.push(system, '');
  for (const m of messages) lines.push(`### ${m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content}\n`);
  lines.push('### Assistant:\n');
  return lines.join('\n');
}
