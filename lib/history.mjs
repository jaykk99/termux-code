/**
 * Conversation-history hygiene for the Termux CLI.
 *
 * A poisoned history entry (an undefined assistant message saved as null,
 * from the pre-PR-14 gateway shape) used to fail gateway validation on
 * EVERY failover attempt, so one good first message was followed by all
 * later messages failing. Cleaning here means a poisoned session self-heals
 * instead of failing forever: bad entries are dropped before send and on
 * session load, never passed to a provider.
 */

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

export function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (!ROLES.has(m.role)) continue;
    if (typeof m.content !== 'string' && m.content !== null && !Array.isArray(m.content)) continue;
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.role === 'tool') {
      out.tool_call_id = String(m.tool_call_id ?? '');
      if (m.name !== undefined) out.name = String(m.name).slice(0, 100);
    }
    clean.push(out);
  }
  return clean;
}
