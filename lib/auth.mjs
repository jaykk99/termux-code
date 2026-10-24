/**
 * Owner authentication for the hosted app.
 *
 * Three pieces, all deliberately small:
 *
 *   1. GitHub OAuth sign-in. The hosted chatbot is a single-owner app: only
 *      OWNER_GITHUB_LOGIN (default jaykk99) may sign in. GitHub is the
 *      identity provider; this module builds the authorize URL, exchanges
 *      the callback code, and reads the user's login. No OAuth app secrets
 *      ever leave the server, and the GitHub access token from the exchange
 *      is used once (to read the login) and then discarded.
 *
 *   2. Sessions. A signed, expiring cookie: base64url(JSON {login, exp})
 *      plus an HMAC-SHA256 of the payload, keyed by SESSION_SECRET (or the
 *      OAuth client secret, or a per-process random secret as a dev
 *      fallback — sessions then die on restart, which is the honest
 *      behaviour for an unconfigured deployment). Verification also
 *      re-checks the allowlist, so a cookie minted for anyone else is void.
 *
 *   3. Gateway tokens for the phone CLI. The CLI can't do a browser OAuth
 *      dance, so after signing in the owner mints a gateway token on the
 *      /chat page and pastes it into the CLI (or into the install command).
 *      Tokens are stored hashed (SHA-256) in a small JSON file, one active
 *      token per owner: minting a new one revokes the old. Gateway routes
 *      accept a session cookie OR a gateway token; the chatbot's tool
 *      routes accept the session ONLY — a gateway token can fetch
 *      completions for the phone, it can never drive server-side tools.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'tc_session';
export const STATE_COOKIE = 'tc_oauth_state';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'tc_';

/** The one GitHub login allowed into the hosted app. */
export function ownerLogin(env = process.env) {
  return env.OWNER_GITHUB_LOGIN || 'jaykk99';
}

/** True when the GitHub OAuth env pair is present. */
export function oauthConfigured(env = process.env) {
  return !!(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
}

let ephemeralSecret = null;
export function sessionSecret(env = process.env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.GITHUB_OAUTH_CLIENT_SECRET) return env.GITHUB_OAUTH_CLIENT_SECRET;
  // Dev fallback: stable for the life of the process, gone on restart.
  if (!ephemeralSecret) ephemeralSecret = crypto.randomBytes(32).toString('hex');
  return ephemeralSecret;
}

function hmac(payload, env) {
  return crypto.createHmac('sha256', sessionSecret(env)).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/* ---------- sessions ---------- */

export function createSession(login, env = process.env, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ login, exp: now + SESSION_TTL_MS })
  ).toString('base64url');
  return `${payload}.${hmac(payload, env)}`;
}

/** Returns { login, exp } for a valid owner session token, else null. */
export function verifySession(token, env = process.env, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload, env))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.login !== 'string' || typeof data.exp !== 'number') return null;
  if (data.exp <= now) return null;
  if (data.login !== ownerLogin(env)) return null; // allowlist re-checked every time
  return { login: data.login, exp: data.exp };
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name) out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Session from a Fetch Request (API routes) — null when signed out. */
export function sessionFromRequest(req, env = process.env) {
  const cookies = parseCookies(req.headers.get('cookie'));
  return verifySession(cookies[SESSION_COOKIE], env);
}

/** Session from a cookie value (server components via next/headers). */
export function sessionFromCookieValue(value, env = process.env) {
  return verifySession(value, env);
}

export function sessionCookieHeader(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader(name, { secure = false } = {}) {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- GitHub OAuth ---------- */

export function githubAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeGithubCode({ code, clientId, clientSecret, redirectUri }, fetchFn = fetch) {
  const res = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `GitHub token exchange failed (${res.status}).`);
  }
  return data.access_token;
}

export async function fetchGithubUser(accessToken, fetchFn = fetch) {
  const res = await fetchFn('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'termux-code',
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status}).`);
  const user = await res.json();
  if (!user || typeof user.login !== 'string') throw new Error('GitHub /user returned no login.');
  return user;
}

/** The OAuth callback URL for a request, honoring NEXT_PUBLIC_SITE_URL. */
export function callbackUrl(req, env = process.env) {
  const base = (env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  return `${base}/api/auth/callback`;
}

export function newOAuthState() {
  return crypto.randomBytes(16).toString('hex');
}

/* ---------- gateway tokens (phone CLI) ---------- */

export function tokenStorePath(env = process.env) {
  return env.GATEWAY_TOKEN_STORE || path.join(process.cwd(), '.data', 'gateway-tokens.json');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function readStore(env) {
  try {
    const data = JSON.parse(await fs.readFile(tokenStorePath(env), 'utf8'));
    return Array.isArray(data.tokens) ? data : { tokens: [] };
  } catch {
    return { tokens: [] };
  }
}

async function writeStore(env, store) {
  const file = tokenStorePath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Mint a gateway token for the owner. One active token per login: any
 * previous tokens for that login are revoked first, so the token shown on
 * the /chat page is always the only one that works. The plaintext is
 * returned exactly once; only its hash is stored.
 */
export async function issueGatewayToken(login, env = process.env) {
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');
  const store = await readStore(env);
  store.tokens = store.tokens.filter((t) => t.login !== login);
  store.tokens.push({
    hash: hashToken(token),
    login,
    prefix: token.slice(0, TOKEN_PREFIX.length + 4),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  await writeStore(env, store);
  return token;
}

/** { login } when the token is a live gateway token, else null. */
export async function verifyGatewayToken(token, env = process.env) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const store = await readStore(env);
  const hit = store.tokens.find((t) => safeEqual(t.hash, hashToken(token)));
  if (!hit) return null;
  hit.lastUsedAt = new Date().toISOString();
  // Awaited on purpose: a fire-and-forget write here raced the next store
  // read (list/revoke) and could hand back a half-written file.
  await writeStore(env, store).catch(() => {});
  return { login: hit.login };
}

/** Metadata only — never enough of a token to use it. */
export async function listGatewayTokens(login, env = process.env) {
  const store = await readStore(env);
  return store.tokens
    .filter((t) => t.login === login)
    .map(({ prefix, createdAt, lastUsedAt }) => ({ prefix, createdAt, lastUsedAt }));
}

export async function revokeGatewayTokens(login, env = process.env) {
  const store = await readStore(env);
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => t.login !== login);
  await writeStore(env, store);
  return before - store.tokens.length;
}

/* ---------- gate helpers for API routes ---------- */

export function bearerToken(req) {
  const auth = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : null;
}

/**
 * Gateway access: a browser session cookie OR a phone gateway token.
 * Returns { login, via } or null. Used by /api/chat, /api/ask,
 * /api/models and /api/models/prefs.
 */
export async function gatewayAccess(req, env = process.env) {
  const session = sessionFromRequest(req, env);
  if (session) return { ...session, via: 'session' };
  const token = bearerToken(req);
  if (token) {
    const hit = await verifyGatewayToken(token, env);
    if (hit) return { login: hit.login, via: 'token' };
  }
  return null;
}

/**
 * Owner-session-only access for the chatbot and its tool routes. A gateway
 * token is NOT enough here: server-side tools only ever run behind the
 * signed-in browser session.
 */
export function ownerSession(req, env = process.env) {
  return sessionFromRequest(req, env);
}
