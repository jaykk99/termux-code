import { browserRead } from '../../../../lib/server-tools.mjs';
import { audit } from '../../../../lib/audit.mjs';
import { readJSON, bad, logRequest } from '../../../../lib/http.mjs';
import { gatewayAccess } from '../../../../lib/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Gateway-side page read for the phone's browser tool.
 *
 * The phone's browser tool drives Chromium locally when it is
 * installed (lib/browser.mjs). When it is NOT installed, open/read
 * would be dead — so the phone posts the URL here instead, and the
 * gateway fetches the page server-side and returns readability text.
 * This is a read-only fetch of a public page: no cookies are sent, no
 * form is submitted, and the reply is extracted text, never raw HTML.
 *
 * Access: the same gate as /api/tools/execute — a browser session
 * cookie or the phone's gateway token. The /api/tools/execute
 * allowlist stays exactly the two Composio tools; this separate route
 * exists so that allowlist never has to grow a fetch-shaped hole.
 *
 * Body: { url: 'https://…' }
 * Reply: { ok: true, result: '<text>' }. A bad or unreachable URL
 * comes back as honest error text the model can show the user.
 */

export function validatePageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

export async function POST(req) {
  const started = Date.now();
  const access = await gatewayAccess(req);
  if (!access) {
    const res = bad('NO_KEY', 'Sign in or a gateway token is required.', 401);
    logRequest(req, 401, Date.now() - started);
    return res;
  }
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

  const url = validatePageUrl(body?.url);
  if (!url) {
    const res = bad('BAD_URL', 'url must be a full http(s) URL.', 400);
    logRequest(req, 400, Date.now() - started);
    return res;
  }

  let result;
  let ok = true;
  try {
    result = await browserRead({ url });
  } catch (err) {
    ok = false;
    result = `Browser read failed: ${err?.message || err}`;
  }
  await audit(
    { login: access.login || 'gateway', tool: 'browser_read', args: url.slice(0, 200), ok, ms: Date.now() - started },
    process.env
  );
  const res = Response.json({ ok: true, result });
  logRequest(req, 200, Date.now() - started, `browser_read ${url.slice(0, 120)}`);
  return res;
}
