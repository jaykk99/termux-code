import {
  oauthConfigured,
  githubAuthorizeUrl,
  callbackUrl,
  newOAuthState,
  STATE_COOKIE,
} from '../../../../lib/auth.mjs';
import { bad, logRequest } from '../../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Starts GitHub OAuth: sets a short-lived state cookie and redirects to
 * GitHub. The OAuth app itself is created once in Jay's GitHub settings
 * with the callback <site>/api/auth/callback.
 */
export async function GET(req) {
  const started = Date.now();
  if (!oauthConfigured()) {
    logRequest(req, 503, Date.now() - started);
    return bad(
      'OAUTH_NOT_CONFIGURED',
      'GitHub sign-in is not configured on this deployment yet (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET are unset).',
      503
    );
  }
  const state = newOAuthState();
  const url = githubAuthorizeUrl({
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
    redirectUri: callbackUrl(req),
    state,
  });
  const secure = new URL(req.url).protocol === 'https:';
  const headers = new Headers({ Location: url });
  headers.append(
    'Set-Cookie',
    `${STATE_COOKIE}=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`
  );
  logRequest(req, 302, Date.now() - started);
  return new Response(null, { status: 302, headers });
}
