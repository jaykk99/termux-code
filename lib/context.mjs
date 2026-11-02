/**
 * Context management: automatic compaction for long conversations.
 *
 * Before this, a long session only ever lost context by sliding-window
 * trimming (lib/history.mjs trimForGateway): the oldest turns fell off
 * the front with nothing left behind, so the model forgot which files it
 * had already changed and what the user originally asked for. And in
 * direct mode nothing trimmed at all — the full history went to models
 * with small context windows until they errored.
 *
 * Now, when the live history passes a size budget, the older part is
 * replaced by ONE summary message:
 *
 *   1. a deterministic digest built from the messages themselves — every
 *      user request, files read / created / edited, commands run and
 *      their exit codes. Always available, costs nothing, can't be wrong
 *      about what happened.
 *   2. a model-written summary of decisions and open threads, when a
 *      summarizer is supplied and answers in time. Optional: if it fails
 *      or times out, the digest alone is used.
 *
 * The recent tail is kept verbatim and always starts on an exchange
 * boundary, so no tool result is left without the call that issued it.
 */

import { parseTextToolCalls, toTextTranscript, transcriptToPrompt } from './text-tools.mjs';
import { isOrphanedStart } from './history.mjs';

export const COMPACT_AT_CHARS = 60_000;
export const COMPACT_AT_MESSAGES = 80;
export const KEEP_RECENT_CHARS = 18_000;
export const SUMMARY_MARK = '[Earlier conversation, compacted]';

export function messageChars(m) {
  if (!m) return 0;
  if (typeof m.content === 'string') return m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  return JSON.stringify(m.content ?? '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
}

export function contextChars(messages) {
  return (messages || []).reduce((n, m) => n + messageChars(m), 0);
}

export function needsCompaction(messages, { maxChars = COMPACT_AT_CHARS, maxMessages = COMPACT_AT_MESSAGES } = {}) {
  return contextChars(messages) > maxChars || (messages?.length || 0) > maxMessages;
}

function safeJSON(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/** Every tool call in a message, whatever format it was recorded in. */
function callsIn(m) {
  const out = [];
  if (m.role !== 'assistant') return out;
  for (const c of m.tool_calls || []) {
    if (c?.function?.name) out.push({ name: c.function.name, args: safeJSON(c.function.arguments) });
  }
  if (Array.isArray(m.content)) {
    for (const b of m.content) if (b?.type === 'tool_use') out.push({ name: b.name, args: b.input || {} });
  } else if (typeof m.content === 'string' && m.content.includes('<tool_call>')) {
    for (const c of parseTextToolCalls(m.content).calls) out.push({ name: c.name, args: c.args });
  }
  return out;
}

function isPlainUser(m) {
  return m?.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('<tool_result') && !m.content.startsWith('[verify]');
}

const clipLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Deterministic digest of what happened in a slice of history. */
export function digest(messages) {
  const requests = [];
  const read = new Set();
  const changed = new Map(); // path -> verb
  const commands = [];
  let pendingCmd = null;
  for (const m of messages) {
    if (isPlainUser(m)) {
      const text = m.content.startsWith(SUMMARY_MARK) ? null : m.content;
      if (text) requests.push(clipLine(text, 300));
      continue;
    }
    for (const c of callsIn(m)) {
      const p = c.args?.path;
      if (c.name === 'read_file' && p) read.add(p);
      else if (c.name === 'write_file' && p) changed.set(p, changed.get(p) || 'wrote');
      else if ((c.name === 'edit_file' || c.name === 'multi_edit') && p) changed.set(p, 'edited');
      else if (c.name === 'apply_patch' && typeof c.args?.patch === 'string') {
        for (const mm of c.args.patch.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (mm[1] !== '/dev/null') changed.set(mm[1], 'patched');
      } else if (c.name === 'bash' && c.args?.command) {
        pendingCmd = { cmd: clipLine(c.args.command, 120), exit: '?' };
        commands.push(pendingCmd);
      }
    }
    // Pick up the exit code of the most recent command from its result.
    const resultText =
      m.role === 'tool' ? String(m.content ?? '')
      : m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<tool_result name="bash"') ? m.content
      : m.role === 'user' && Array.isArray(m.content) ? m.content.map((b) => (typeof b?.content === 'string' ? b.content : '')).join('\n')
      : '';
    const ex = resultText.match(/(?:^|\n)exit (\d+)/);
    if (ex && pendingCmd && pendingCmd.exit === '?') pendingCmd.exit = ex[1];
  }
  const lines = [];
  if (requests.length) {
    lines.push('User requests, oldest first:');
    // The first request usually defines the whole task, so it survives
    // even when the middle is elided.
    const shown = requests.length > 12 ? [...requests.slice(0, 2), `(${requests.length - 12} more)`, ...requests.slice(-10)] : requests;
    for (const r of shown) lines.push(`- ${r}`);
  }
  if (changed.size) lines.push(`Files changed: ${[...changed].map(([p, v]) => `${p} (${v})`).slice(-40).join(', ')}`);
  if (read.size) lines.push(`Files read: ${[...read].slice(-40).join(', ')}`);
  if (commands.length) {
    lines.push('Commands run (exit code):');
    for (const c of commands.slice(-15)) lines.push(`- ${c.cmd} → ${c.exit}`);
  }
  return lines.join('\n');
}

/**
 * Choose where the verbatim tail starts: the newest point that keeps at
 * most keepChars and begins on a clean boundary — a plain user message
 * if one is in range, otherwise an assistant message (never a tool
 * result, which would be orphaned). Returns an index into messages, or
 * -1 when there is nothing worth compacting.
 */
export function chooseCut(messages, start, keepChars = KEEP_RECENT_CHARS) {
  let used = 0;
  let firstFit = messages.length;
  for (let i = messages.length - 1; i >= start; i--) {
    used += messageChars(messages[i]);
    if (used > keepChars && i < messages.length - 1) break;
    firstFit = i;
  }
  // Prefer a plain user message at or after firstFit.
  for (let i = firstFit; i < messages.length; i++) if (isPlainUser(messages[i])) return i > start ? i : -1;
  for (let i = firstFit; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !isOrphanedStart(messages[i])) return i > start ? i : -1;
  }
  return -1;
}

export const SUMMARY_SYSTEM =
  'You compress a coding session so it can continue with less context. Write a terse summary (under 250 words): the goal, decisions made, what was changed and why, what is still broken or unfinished, and anything the user asked to avoid. No preamble. Plain text, no tool calls.';

/**
 * Compact messages in place when they exceed the budget.
 *
 * opts.summarize(prompt) → Promise<string> is optional; it gets a text
 * transcript of the part being dropped. Returns null when nothing was
 * done, else { dropped, before, after, usedModel }.
 */
export async function compactInPlace(messages, opts = {}) {
  const { summarize, keepChars = KEEP_RECENT_CHARS, timeoutMs = 40_000, force = false } = opts;
  if (!force && !needsCompaction(messages, opts)) return null;
  const head = messages[0]?.role === 'system' ? 1 : 0;
  const cut = chooseCut(messages, head, keepChars);
  if (cut === -1) return null;

  const old = messages.slice(head, cut);
  const before = contextChars(messages);
  // A previous summary is folded into the new one, not stacked.
  const prior = old.find((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_MARK));
  const priorText = prior ? prior.content.split('\n[Current]')[0].slice(SUMMARY_MARK.length).trim() : '';

  let modelSummary = '';
  if (typeof summarize === 'function') {
    const t = toTextTranscript(old);
    const transcript = transcriptToPrompt({ system: '', messages: t.messages }).slice(-24_000);
    try {
      modelSummary = await Promise.race([
        summarize(`${priorText ? `Earlier summary:\n${priorText}\n\n` : ''}Transcript to compress:\n${transcript}`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('summary timed out')), timeoutMs)),
      ]);
      modelSummary = String(modelSummary || '').replace(/<tool_call>[\s\S]*$/, '').trim().slice(0, 3000);
    } catch {
      modelSummary = '';
    }
  }

  const parts = [SUMMARY_MARK];
  if (modelSummary) parts.push(modelSummary);
  else if (priorText) parts.push(priorText);
  const d = digest(old);
  if (d) parts.push(d);
  parts.push(`(${old.length} older messages were compacted. Re-read any file before editing it; do not rely on remembered contents.)`);
  const summaryText = parts.join('\n\n');

  const tail = messages.slice(cut);
  let rebuilt;
  if (isPlainUser(tail[0])) {
    // Fold into the first kept request so roles still alternate.
    rebuilt = [{ ...tail[0], content: `${summaryText}\n[Current]\n${tail[0].content}` }, ...tail.slice(1)];
  } else {
    rebuilt = [{ role: 'user', content: summaryText }, ...tail];
  }
  const sys = messages.slice(0, head);
  messages.length = 0;
  messages.push(...sys, ...rebuilt);
  return { dropped: old.length, before, after: contextChars(messages), usedModel: Boolean(modelSummary) };
}
