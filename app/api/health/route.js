import { listModels } from '../../../lib/models.mjs';
import { logRequest } from '../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STARTED_AT = Date.now();

/** Liveness + readiness in one cheap call. No keys, no upstream fan-out. */
export async function GET(req) {
  const started = Date.now();
  let modelCount = null;
  try {
    modelCount = (await listModels()).length;
  } catch {
    /* health still reports; the count is best-effort */
  }
  const payload = {
    ok: true,
    service: 'termux-code-gateway',
    version: '0.2.0',
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    modelCount,
    node: process.version,
  };
  logRequest(req, 200, Date.now() - started);
  return Response.json(payload);
}
