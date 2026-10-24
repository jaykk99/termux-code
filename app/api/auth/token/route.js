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
 * POST mints (replacing any previous token — one active token per owner)
 * and returns the plaintext exactly once; GET lists metadata; DELETE
 * revokes.
 *
 * The token store lives in a KV namespace bound as GATEWAY_KV on
 * Cloudflare Pages/Workers (no filesystem there); on Node/Docker it is
 * the .data JSON file. If the store write fails, the handler answers a
 * JSON 500 — never an empty body, which is what used to surface in the
 * browser as "Unexpected end of JSON input" when the filesystem write
 * threw on Cloudflare.
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
