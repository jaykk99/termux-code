import {
  ownerSession,
  issueGatewayToken,
  listGatewayTokens,
  revokeGatewayTokens,
} from '../../../../lib/auth.mjs';
import { bad, logRequest } from '../../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Gateway tokens for the phone CLI. Session-only: minting, listing and
 * revoking happen from the signed-in browser, never with a token itself.
 * POST mints a stateless signed token and returns the plaintext exactly
 * once; GET lists stored (legacy) tokens' metadata; DELETE revokes
 * stored (legacy) tokens. Stateless tokens are not listed or revoked
 * here — they live until expiry or until the signing secret rotates
 * (see lib/auth.mjs).
 *
 * The token store lives in a KV namespace bound as GATEWAY_KV on
 * Cloudflare Pages/Workers (no filesystem there); on Node/Docker it is
 * the .data JSON file. That store is now legacy-only: minting no longer
 * needs it, so a missing store must never 500 a mint. GET/DELETE still
 * answer STORE_FAILED only if the store itself throws.
 */
async function routeEnv() {
  // Only the KV binding comes from the worker env: bindings are objects,
  // not strings, so they never arrive via process.env. Everything else
  // stays on process.env, which keeps plain Node/Docker runs and the
  // test suite (which sets GATEWAY_TOKEN_STORE on process.env) working
  // unchanged. Dynamic import so runtimes without the adapter package
  // fall back silently instead of crashing the route at import time.
  try {
    const mod = await import('@opennextjs/cloudflare');
    const ctx = await mod.getCloudflareContext();
    if (ctx?.env?.GATEWAY_KV) return { ...process.env, GATEWAY_KV: ctx.env.GATEWAY_KV };
  } catch {}
  return process.env;
}

function storeFailed() {
  return bad(
    'STORE_FAILED',
    'Token storage is unavailable on this deployment. Bind a KV namespace as GATEWAY_KV (see DEPLOY-CLOUDFLARE.md).',
    500
  );
}

export async function POST(req) {
  const started = Date.now();
  const env = await routeEnv();
  const session = ownerSession(req, env);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  try {
    const token = await issueGatewayToken(session.login, env);
    logRequest(req, 200, Date.now() - started, `login=${session.login}`);
    return Response.json({ ok: true, token });
  } catch (err) {
    logRequest(req, 500, Date.now() - started, `mint failed: ${err?.message || err}`);
    return storeFailed();
  }
}

export async function GET(req) {
  const started = Date.now();
  const env = await routeEnv();
  const session = ownerSession(req, env);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  try {
    const tokens = await listGatewayTokens(session.login, env);
    logRequest(req, 200, Date.now() - started);
    return Response.json({ ok: true, tokens });
  } catch (err) {
    logRequest(req, 500, Date.now() - started, `list failed: ${err?.message || err}`);
    return storeFailed();
  }
}

export async function DELETE(req) {
  const started = Date.now();
  const env = await routeEnv();
  const session = ownerSession(req, env);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  try {
    const revoked = await revokeGatewayTokens(session.login, env);
    logRequest(req, 200, Date.now() - started, `revoked=${revoked}`);
    return Response.json({ ok: true, revoked });
  } catch (err) {
    logRequest(req, 500, Date.now() - started, `revoke failed: ${err?.message || err}`);
    return storeFailed();
  }
}
