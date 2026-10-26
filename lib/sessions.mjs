/**
 * Multi-session conversation persistence for termux-code.
 *
 * /clear used to throw the whole conversation away. This module keeps every
 * session on disk as JSONL under ~/.termux-code/sessions/, so the CLI can
 * resume, list, rename, delete and export past conversations.
 *
 * File layout per session <id>.jsonl:
 *   line 1: {"type":"meta","id","title","created","updated"}
 *   rest:   {"type":"msg","role","content",...} — one message per line
 *
 * JSONL means a corrupt line can't take the whole session with it: bad lines
 * are skipped on load, good ones survive. Messages are written with an
 * atomic rename so a killed process can't leave a half-written file.
 *
 * Tool-result messages can get large; append() compacts a session when it
 * passes MAX_MESSAGES by dropping the oldest messages and leaving a short
 * placeholder note, keeping the most recent turns intact. This is lossy on
 * purpose — the alternative is unbounded disk growth on a phone.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isOrphanedStart } from './history.mjs';

const META_TYPE = 'meta';
const MSG_TYPE = 'msg';
const MAX_MESSAGES = 400; // compact above this many messages
const KEEP_RECENT = 200; // keep this many after compaction

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
  }

  sessionPath(id) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Bad session id.');
    return path.join(this.dir, `${id}.jsonl`);
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Create a session. Returns the meta record. */
  async create(title = 'untitled') {
    await this.ensureDir();
    const now = new Date().toISOString();
    const meta = { id: randomUUID().slice(0, 8), title: title.slice(0, 80) || 'untitled', created: now, updated: now };
    await this._writeAll(meta, []);
    return meta;
  }

  async _writeAll(meta, messages) {
    const lines = [JSON.stringify({ type: META_TYPE, ...meta })];
    for (const m of messages) lines.push(JSON.stringify({ type: MSG_TYPE, ...m }));
    const tmp = path.join(this.dir, `.${meta.id}.tmp`);
    await fs.writeFile(tmp, lines.join('\n') + '\n', 'utf8');
    await fs.rename(tmp, this.sessionPath(meta.id)); // atomic swap
  }

  /**
   * Load a session. Returns { meta, messages } or null when the file is
   * missing. Corrupt message lines are skipped, never fatal.
   */
  async load(id) {
    let text;
    try {
      text = await fs.readFile(this.sessionPath(id), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
    let meta = null;
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // one bad line doesn't kill the session
      }
      if (obj.type === META_TYPE && !meta) {
        meta = { id: obj.id || id, title: obj.title || 'untitled', created: obj.created, updated: obj.updated };
      } else if (obj.type === MSG_TYPE) {
        const { type, ...msg } = obj;
        messages.push(msg);
      }
    }
    if (!meta) meta = { id, title: 'untitled', created: null, updated: null };
    return { meta, messages };
  }

  /** Append messages to a session, compacting when it grows too large. */
  async append(id, newMessages) {
    const loaded = await this.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    const messages = [...loaded.messages, ...newMessages.filter(Boolean)];
    const compacted = compact(messages);
    const meta = { ...loaded.meta, updated: new Date().toISOString() };
    await this._writeAll(meta, compacted);
    return { meta, messages: compacted };
  }

  /** Replace the whole message list (used after a turn mutates in place). */
  async save(id, messages) {
    const loaded = await this.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    const meta = { ...loaded.meta, updated: new Date().toISOString() };
    await this._writeAll(meta, compact(messages));
    return meta;
  }

  /** List sessions, most recently updated first. */
  async list() {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      try {
        const loaded = await this.load(id);
        if (loaded) out.push({ ...loaded.meta, messages: loaded.messages.length });
      } catch {
        // unreadable session: report it rather than hiding it
        out.push({ id, title: '(unreadable)', created: null, updated: null, messages: 0 });
      }
    }
    out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
    return out;
  }

  async rename(id, title) {
    const loaded = await this.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    // Rename must not bump `updated`: resume picks the most recently
    // updated session, so renaming an old session used to hijack the
    // next startup and bury the conversation Jay was actually in.
    const meta = { ...loaded.meta, title: title.slice(0, 80) || loaded.meta.title };
    await this._writeAll(meta, loaded.messages);
    return meta;
  }

  async delete(id) {
    try {
      await fs.unlink(this.sessionPath(id));
      return true;
    } catch (err) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Drop sessions older than maxAgeMs, but always keep at least keepN of
   * the most recent ones. Returns the number removed.
   */
  async prune({ maxAgeMs = 30 * 24 * 3600 * 1000, keepN = 20 } = {}) {
    const sessions = await this.list();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [i, s] of sessions.entries()) {
      if (i < keepN) continue;
      const updated = s.updated ? Date.parse(s.updated) : 0;
      if (updated < cutoff && (await this.delete(s.id))) removed++;
    }
    return removed;
  }

  /** Newest session with at least one real (non-system) message, for resume. */
  async newestNonEmpty() {
    const sessions = await this.list();
    for (const s of sessions) {
      const loaded = await this.load(s.id);
      if (loaded && loaded.messages.some((m) => m.role !== 'system')) return loaded;
    }
    return null;
  }

  /** Export a session as a readable Markdown transcript. */
  async exportMarkdown(id) {
    const loaded = await this.load(id);
    if (!loaded) throw new Error(`Session not found: ${id}`);
    const lines = [`# ${loaded.meta.title}`, '', `_exported ${new Date().toISOString()}_`, ''];
    for (const m of loaded.messages) {
      if (m.role === 'system') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
      lines.push(`## ${who}`, '');
      lines.push(renderContent(m.content));
      lines.push('');
    }
    return lines.join('\n');
  }
}

function renderContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text;
        if (b?.type === 'tool_use') return `[tool ${b.name}] ${JSON.stringify(b.input).slice(0, 500)}`;
        if (b?.type === 'tool_result') return `[tool result] ${String(b.content).slice(0, 500)}`;
        return JSON.stringify(b).slice(0, 500);
      })
      .join('\n');
  }
  return JSON.stringify(content).slice(0, 1000);
}

/**
 * Drop old messages when a session passes MAX_MESSAGES. Keeps the system
 * prompt (index 0) and the most recent KEEP_RECENT messages; the middle
 * is dropped and replaced by a placeholder note the model can still see
 * as context. The kept window is aligned to an exchange boundary: it
 * never starts with a tool result whose assistant call was dropped,
 * because providers reject orphaned tool messages and a resumed session
 * would then fail every turn.
 */
export function compact(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const recent = messages.slice(-KEEP_RECENT);
  while (recent.length && isOrphanedStart(recent[0])) recent.shift();
  const dropped = messages.length - head.length - recent.length;
  if (dropped <= 0) return messages;
  const toolCalls = messages
    .slice(head.length, messages.length - recent.length)
    .filter((m) => m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content)))
    .length;
  const note = {
    role: 'user',
    content: `[session compacted: ${dropped} older messages dropped (${toolCalls} tool exchanges). Continuing from recent context.]`,
  };
  return [...head, note, ...recent];
}

/**
 * Derive a readable title from the first user message. Falls back to the
 * model label when there is nothing to title from yet.
 */
export function deriveTitle(messages, fallback = 'untitled') {
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first) return fallback;
  const line = first.content.trim().split('\n')[0];
  return line.length > 60 ? line.slice(0, 57) + '...' : line;
}
