import { setErrorInboxPrefs } from '../../../../lib/models.mjs';
import { readJSON, bad, upstreamError, logRequest } from '../../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pins or disables models on error-inbox's own live pool. This is a thin
 * proxy to error-inbox's real POST /api/models — the same call its own
 * settings page makes. Body: { pinned: "provider/model" | null, disabled: [...] }
 */
export async function POST(req) {
  const started = Date.now();
  let body;
  try {
    body = await readJSON(req);
  } catch (res) {
    if (res instanceof Response) {
      logRequest(req, res.status || 400, Date.now() - started);
      return res;
    }
    throw res;
  }

  const { pinned, disabled } = body;
  if (pinned !== null && (typeof pinned !== 'string' || pinned.length > 200)) {
    const res = bad('BAD_PREFS', "'pinned' must be a model key string or null.", 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }
  if (!Array.isArray(disabled) || disabled.some((d) => typeof d !== 'string' || d.length > 200)) {
    const res = bad('BAD_PREFS', "'disabled' must be an array of model key strings.", 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }

  try {
    const result = await setErrorInboxPrefs({ pinned, disabled });
    const res = Response.json(result && typeof result === 'object' ? result : { ok: false });
    logRequest(req, res.status, Date.now() - started);
    return res;
  } catch (err) {
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started);
    return res;
  }
}
