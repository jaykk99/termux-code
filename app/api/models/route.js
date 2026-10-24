import { listModels, withCapabilities } from '../../../lib/models.mjs';
import { logRequest, upstreamError, bad } from '../../../lib/http.mjs';
import { gatewayAccess } from '../../../lib/auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const started = Date.now();
  if (!(await gatewayAccess(req))) {
    logRequest(req, 401, Date.now() - started);
    return bad('NO_KEY', 'Sign in or a gateway token is required.', 401);
  }
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
