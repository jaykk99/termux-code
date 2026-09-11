import { listModels } from '../../../lib/models.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const models = await listModels();
    return Response.json({ models, count: models.length });
  } catch (err) {
    return Response.json({ models: [], error: err.message }, { status: 502 });
  }
}
