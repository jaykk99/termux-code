import {
  oauthConfigured,
  exchangeGithubCode,
  fetchGithubUser,
  createSession,
  ownerLogin,
  callbackUrl,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  SESSION_COOKIE,
  STATE_COOKIE,
} from '../../../../lib/auth.mjs';
import { logRequest } from '../../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(req, message, status = 403) {
  const secure = new URL(req.url).protocol === 'https:';
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8' });
  headers.append('Set-Cookie', clearCookieHeader(STATE_COOKIE, { secure }));
  headers.append('Set-Cookie', clearCookieHeader(SESSION_COOKIE, { secure }));
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:2rem">` +
      `<h1>Sign-in failed</h1><p>${message}</p><p><a style="color:#7ee787" href="/">Back to sign in</a></p></body></html>`,
    { status, headers }
  );
}

/**
 * GitHub OAuth callback: exchange the code, read the login, and let in
 * ONLY the owner allowlist (OWNER_GITHUB_LOGIN, default jaykk99). Anyone
 * else who completes GitHub sign-in gets a refusal page and no session —
 * this is a single-owner app.
 */
export async function GET(req) {
  const started = Date.now();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(req.headers.get('cookie'));
  const secure = url.protocol === 'https:';

  if (!oauthConfigured()) {
    logRequest(req, 503, Date.now() - started);
    return fail(req, 'GitHub sign-in is not configured on this deployment yet.', 503);
  }
  if (!code || !state || !cookies[STATE_COOKIE] || state !== cookies[STATE_COOKIE]) {
    logRequest(req, 400, Date.now() - started);
    return fail(req, 'The sign-in link expired or did not match. Try again.', 400);
  }

  let user;
  try {
    const accessToken = await exchangeGithubCode({
      code,
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      redirectUri: callbackUrl(req),
    });
    // Used once, here, and never stored: the session is ours, not GitHub's.
    user = await fetchGithubUser(accessToken);
  } catch (err) {
    logRequest(req, 502, Date.now() - started);
    return fail(req, `GitHub sign-in failed: ${String(err?.message || err).slice(0, 200)}`, 502);
  }

  if (user.login !== ownerLogin()) {
    logRequest(req, 403, Date.now() - started, `login=${user.login} refused`);
    return fail(req, `This app is private. GitHub account "${user.login}" is not the owner.`, 403);
  }

  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', sessionCookieHeader(createSession(user.login), { secure }));
  headers.append('Set-Cookie', clearCookieHeader(STATE_COOKIE, { secure }));
  logRequest(req, 302, Date.now() - started, `login=${user.login}`);
  return new Response(null, { status: 302, headers });
}
