import { sendToErrorInbox } from '../../../lib/agent.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 280; // matches error-inbox's own v1/message route

/**
 * Proxies to error-inbox's real public endpoint (app/api/v1/message). This
 * talks to error-inbox's own hosted agent — its own tools, its own model
 * routing — not termux-code's local filesystem agent. Body: { message, agent? }
 */
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Body must be JSON.' }, { status: 400 });
  }
  const { message, agent } = body;
  if (!message) return Response.json({ ok: false, error: "Body must include 'message'." }, { status: 400 });

  try {
    const reply = await sendToErrorInbox(message, { agent });
    return Response.json({ ok: true, reply });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 502 });
  }
}
