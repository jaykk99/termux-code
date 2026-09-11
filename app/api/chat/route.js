import { complete } from '../../../lib/agent.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Single completion, no tool execution. The Termux CLI runs tools locally and
 * posts the results back, which keeps provider keys in Vercel's environment
 * instead of sitting in a config file on the phone.
 *
 * Body: { model: <model object from /api/models>, messages: [...] }
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const { model, messages } = body;
  if (!model?.id) return Response.json({ error: 'No model given.' }, { status: 400 });
  if (!Array.isArray(messages)) return Response.json({ error: 'messages must be an array.' }, { status: 400 });

  try {
    const reply = await complete(model, messages);
    return Response.json(reply);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
