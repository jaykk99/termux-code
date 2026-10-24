import { clearCookieHeader, SESSION_COOKIE } from '../../../../lib/auth.mjs';
import { logRequest } from '../../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Clears the session cookie and returns to the sign-in screen. */
export async function POST(req) {
  const started = Date.now();
  const secure = new URL(req.url).protocol === 'https:';
  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', clearCookieHeader(SESSION_COOKIE, { secure }));
  logRequest(req, 302, Date.now() - started);
  return new Response(null, { status: 302, headers });
}
