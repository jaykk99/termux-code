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
 * silently dropped, so it can retry with valid JSON.
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

/** Try hard to turn a block body into an object. Returns null on failure. */
function parseLoose(body) {
  let s = String(body).trim();
  // ```json ... ``` fences inside the block.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tryParse = (x) => {
    try {
      return JSON.parse(x);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  if (v === undefined) {
    // Trailing commas, the most common small-model JSON slip.
    v = tryParse(s.replace(/,\s*([}\]])/g, '$1'));
  }
  if (v === undefined) {
    // Prose around the object: take the outermost {...}.
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) v = tryParse(s.slice(a, b + 1)) ?? tryParse(s.slice(a, b + 1).replace(/,\s*([}\]])/g, '$1'));
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

/** Normalize {name, args|arguments|parameters|input} into {name, args}. */
function normalizeCall(obj) {
  // {"tool": "x", ...} and {"function": {"name", "arguments"}} variants.
  if (obj.function && typeof obj.function === 'object') obj = { ...obj.function, ...obj, function: undefined };
  const name = obj.name ?? obj.tool ?? obj.tool_name;
  if (typeof name !== 'string' || !name.trim()) return null;
  let args = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input ?? {};
  if (typeof args === 'string') {
    const parsed = parseLoose(args);
    args = parsed ?? {};
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  return { name: name.trim(), args };
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
export function parseTextToolCalls(text) {
  const src = String(text ?? '');
  const calls = [];
  const errors = [];
  if (!src.includes(TOOL_CALL_OPEN)) return { text: src, calls, errors };

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
    const obj = parseLoose(body);
    const call = obj && normalizeCall(obj);
    if (call) calls.push({ id: nextId(), ...call, textProtocol: true });
    else if (body.trim()) errors.push(body.trim().slice(0, 300));
    i = end;
  }
  // A model sometimes hallucinates its own results; never show or trust them.
  visible = visible.replace(/<tool_result[\s\S]*?(<\/tool_result>|$)/g, '');
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
