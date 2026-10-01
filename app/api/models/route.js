import { listModels, withCapabilities } from '../../../lib/models.mjs';
import { logRequest, upstreamError } from '../../../lib/http.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const started = Date.now();
  try {
    const models = withCapabilities(await listModels());
    const direct = models.filter((m) => m.source === 'direct').length;
    logRequest(req, 200, Date.now() - started, `models=${models.length} direct=${direct}`);
    return Response.json({ ok: true, models, count: models.length });
  } catch (err) {
    const res = upstreamError(err);
    logRequest(req, res.status, Date.now() - started);
    return Response.json({ ok: false, models: [], error: { code: 'UPSTREAM', message: 'Model catalogue unavailable.' } }, { status: res.status });
  }
}
