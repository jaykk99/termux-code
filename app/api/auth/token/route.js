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
 */
export async function POST(req) {
  const started = Date.now();
  const session = ownerSession(req);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  const token = await issueGatewayToken(session.login);
  logRequest(req, 200, Date.now() - started, `login=${session.login}`);
  return Response.json({ ok: true, token });
}

export async function GET(req) {
  const started = Date.now();
  const session = ownerSession(req);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  const tokens = await listGatewayTokens(session.login);
  logRequest(req, 200, Date.now() - started);
  return Response.json({ ok: true, tokens });
}

export async function DELETE(req) {
  const started = Date.now();
  const session = ownerSession(req);
  if (!session) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in first.', 401);
  }
  const revoked = await revokeGatewayTokens(session.login);
  logRequest(req, 200, Date.now() - started, `revoked=${revoked}`);
  return Response.json({ ok: true, revoked });
}
