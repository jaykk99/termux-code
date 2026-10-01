/**
 * Shared helpers for the gateway API routes.
 *
 * - readJSON(req, opts): parses the body with a size cap so one bad client
 *   can't hold the function open on a multi-MB payload.
 * - bad(code, message, status): structured JSON errors, never stack traces.
 * - logRequest(req, status, ms): one line per request — method, path, status,
 *   duration. Visible in Vercel logs, cheap everywhere else.
 */

const DEFAULT_MAX_BODY_BYTES = 512 * 1024; // 512 KB is plenty for chat bodies

const CODES = {
  BAD_JSON: 400,
  BAD_MODEL: 400,
  BAD_MESSAGES: 400,
  MESSAGE_TOO_LONG: 413,
  BAD_PREFS: 400,
  NO_KEY: 401,
  TIMEOUT: 504,
  UPSTREAM: 502,
  INTERNAL: 500,
};

export function bad(code, message, status) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status: status ?? CODES[code] ?? 500 }
  );
}

/** Convenience for the older { ok:false, error:'string' } call sites. */
export function badMessage(message, status = 400, code = 'BAD_REQUEST') {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export async function readJSON(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const chunks = [];
  let bytes = 0;
  const reader = req.body?.getReader();
  if (!reader) throw bad('BAD_JSON', 'No request body.', 400);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) throw bad('MESSAGE_TOO_LONG', `Body exceeds ${maxBytes} bytes.`, 413);
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw bad('BAD_JSON', 'Body must be JSON.', 400);
  }
}

export function logRequest(req, status, ms, extra = '') {
  const url = new URL(req.url);
  const line = `${req.method} ${url.pathname} -> ${status} ${Math.round(ms)}ms${extra ? ' ' + extra : ''}`;
  if (status >= 500) console.error(line);
  else console.log(line);
}

/**
 * Map a thrown error to a structured response. Upstream timeouts become
 * 504 TIMEOUT; provider failures become 502 UPSTREAM; everything else is an
 * internal 500 with no stack detail leaked to the client.
 */
export function upstreamError(err) {
  const message = err?.message || 'Upstream request failed.';
  if (/timed out/i.test(message)) return bad('TIMEOUT', message, 504);
  return bad('UPSTREAM', message.slice(0, 500), 502);
}
