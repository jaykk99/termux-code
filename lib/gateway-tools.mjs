/**
 * Phone-side dispatch for server-side tools.
 *
 * The phone runs its filesystem tools locally (lib/tools.mjs), but Composio
 * actions must execute on the gateway, where COMPOSIO_API_KEY lives. The
 * key is never sent to the phone, so the phone cannot call Composio
 * directly — instead it posts the tool call to the gateway's
 * /api/tools/execute route, which runs it server-side and returns text.
 *
 * Everything here returns text, never throws for an expected failure: a
 * dead key, a rejected token, or a Composio error comes back as an honest
 * error message the model can show the user, never a faked success and
 * never a silent pretend result. The only thing that never leaves the
 * phone is a secret: the request carries the gateway token (the phone's
 * own auth) and the tool arguments, nothing else.
 */

export const GATEWAY_TOOL_NAMES = new Set(['composio_search', 'composio_execute']);

/** True when this tool call must go to the gateway instead of runTool. */
export function isGatewayTool(name) {
  return GATEWAY_TOOL_NAMES.has(name);
}

/**
 * Execute one gateway tool. `fetchFn` is injectable for tests; it defaults
 * to the global fetch. Returns the result text, or an honest error text
 * when the gateway or Composio fails.
 */
export async function executeGatewayTool({ gateway, gatewayToken, name, args }, fetchFn = fetch) {
  if (!GATEWAY_TOOL_NAMES.has(name)) return `Not a gateway tool: ${name}`;
  if (!gateway) {
    return (
      'Composio tools need the gateway: they run server-side, where the Composio key lives. ' +
      'Set a gateway with /gateway and a token with /gateway-token, then try again.'
    );
  }
  let res;
  try {
    res = await fetchFn(gateway.replace(/\/$/, '') + '/api/tools/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      body: JSON.stringify({ name, args: args || {} }),
    });
  } catch (err) {
    return `Gateway tool ${name} failed: could not reach the gateway (${err?.message || err}).`;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const errObj = data?.error;
    const detail =
      typeof errObj === 'object' && errObj
        ? [errObj.code, errObj.message].filter(Boolean).join(': ')
        : errObj || `Gateway returned HTTP ${res.status}.`;
    return `Gateway tool ${name} failed: ${detail}`;
  }
  // The gateway returns the upstream result as text, including Composio's
  // own HTTP status line (e.g. "HTTP 401 ...") when the key is dead — that
  // text is the honest result, passed through untouched.
  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? '');
}
