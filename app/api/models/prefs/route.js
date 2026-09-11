import { setErrorInboxPrefs } from '../../../../lib/models.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pins or disables models on error-inbox's own live pool. This is a thin
 * proxy to error-inbox's real POST /api/models — the same call its own
 * settings page makes. Body: { pinned: "provider/model" | null, disabled: [...] }
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Body must be JSON.' }, { status: 400 });
  }
  try {
    const result = await setErrorInboxPrefs(body);
    return Response.json(result);
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 502 });
  }
}
