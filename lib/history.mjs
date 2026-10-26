/**
 * Conversation-history hygiene for the Termux CLI.
 *
 * A poisoned history entry (an undefined assistant message saved as null,
 * from the pre-PR-14 gateway shape) used to fail gateway validation on
 * EVERY failover attempt, so one good first message was followed by all
 * later messages failing. Cleaning here means a poisoned session self-heals
 * instead of failing forever: bad entries are dropped before send and on
 * session load, never passed to a provider.
 *
 * Cleaning must NOT strip an assistant message's tool_calls: without them,
 * the tool results that follow are orphaned, and OpenAI-shaped and
 * Anthropic providers reject orphaned tool messages outright. A session
 * that survived a restart used to come back poisoned exactly this way —
 * the calls were saved on disk, but every load and every gateway send
 * dropped them.
 */

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Keep only well-formed OpenAI-shaped tool_calls entries. A malformed
 * entry is dropped, never passed through half-shaped.
 */
export function cleanToolCalls(value) {
  if (!Array.isArray(value)) return undefined;
  const kept = [];
  for (const c of value) {
    if (!c || typeof c !== 'object') continue;
    if (typeof c.id !== 'string' || !c.id) continue;
    if (!c.function || typeof c.function !== 'object') continue;
    if (typeof c.function.name !== 'string' || !c.function.name) continue;
    if (typeof c.function.arguments !== 'string') continue;
    kept.push({
      id: c.id,
      type: 'function',
      function: { name: c.function.name, arguments: c.function.arguments },
    });
  }
  return kept.length ? kept : undefined;
}

export function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (!ROLES.has(m.role)) continue;
    if (typeof m.content !== 'string' && m.content !== null && !Array.isArray(m.content)) continue;
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.role === 'assistant') {
      const toolCalls = cleanToolCalls(m.tool_calls);
      if (toolCalls) out.tool_calls = toolCalls;
    }
    if (m.role === 'tool') {
      out.tool_call_id = String(m.tool_call_id ?? '');
      if (m.name !== undefined) out.name = String(m.name).slice(0, 100);
    }
    clean.push(out);
  }
  return clean;
}

/**
 * True when a message only makes sense after an assistant tool call:
 * a tool result, or an Anthropic tool_result block. A trimmed or
 * compacted window must never START with one — the call it answers is
 * gone, and providers reject the orphan.
 */
export function isOrphanedStart(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.role === 'tool') return true;
  if (m.role === 'user' && Array.isArray(m.content)) {
    return m.content.some((b) => b && typeof b === 'object' && b.type === 'tool_result');
  }
  return false;
}

function messageChars(m) {
  if (typeof m.content === 'string') return m.content.length;
  return JSON.stringify(m.content ?? '').length;
}

// /api/chat caps at 100 messages / 100k chars and rejects over-budget
// histories outright. The phone trims below that cap before sending, so
// a long session degrades to a sliding window on the gateway instead of
// failing every gateway turn and silently losing gateway tools.
const GATEWAY_MAX_MESSAGES = 90;
const GATEWAY_MAX_CHARS = 90_000;

/**
 * Trim a cleaned history to what /api/chat accepts: the system prompt
 * plus the most recent turns inside the message/char budget, starting
 * on an exchange boundary (see isOrphanedStart). The newest message is
 * always kept, even if it alone busts the char budget — the server then
 * rejects it honestly instead of the phone silently dropping the user's
 * latest message and sending only the system prompt. The saved session
 * on disk is untouched; this only shapes what one gateway send carries.
 */
export function trimForGateway(messages, { maxMessages = GATEWAY_MAX_MESSAGES, maxChars = GATEWAY_MAX_CHARS } = {}) {
  const cleaned = cleanMessages(messages);
  if (!cleaned.length) return cleaned;
  const head = cleaned[0]?.role === 'system' ? [cleaned[0]] : [];
  const rest = cleaned.slice(head.length);
  const kept = [];
  let chars = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i];
    if (kept.length && (kept.length >= maxMessages || chars + messageChars(m) > maxChars)) break;
    kept.unshift(m);
    chars += messageChars(m);
  }
  while (kept.length && isOrphanedStart(kept[0])) kept.shift();
  return [...head, ...kept];
}
