/**
 * Audit log for the hosted chatbot's server-side tools.
 *
 * One JSON line per event, appended to AUDIT_LOG_PATH (default
 * .data/audit.log). Every tool call the agent makes — terminal commands,
 * GitHub API calls, Composio calls, fetches, searches — lands here
 * with the owner login, the tool name, a short argument summary, and the
 * outcome. Secrets are never logged: call sites pass summaries (method +
 * path, a clipped command), and this module additionally strips any key
 * whose name smells like a credential before writing.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function auditPath(env = process.env) {
  return env.AUDIT_LOG_PATH || path.join(process.cwd(), '.data', 'audit.log');
}

const SECRET_KEY = /token|secret|password|authorization|api[-_]?key|credential|cookie|private[-_]?key/i;
// Free-form arguments can contain arbitrary credentials, not just recognizable tokens.
const FREE_TEXT = /^(args|command|url|query|body|headers)$/i;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : FREE_TEXT.test(k) && typeof v === 'string' ? '[omitted]' : scrub(v);
    }
    return out;
  }
  return value;
}

/** Fire-and-forget: auditing must never break the tool it records. */
export async function audit(event, env = process.env) {
  try {
    const file = auditPath(env);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...scrub(event) });
    await appendFile(file, line + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* nowhere safe to report this; the tool result stands on its own */
  }
}
