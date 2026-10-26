import test from 'node:test';
import assert from 'node:assert/strict';
import { composioToolsForOpenAI, composioToolsForAnthropic, COMPOSIO_TOOL_NAMES } from '../lib/server-tools.mjs';
import { toolsForOpenAI } from '../lib/tools.mjs';
import { gatewayExtraTools } from '../app/api/chat/route.js';
import { isGatewayTool, executeGatewayTool, GATEWAY_TOOL_NAMES } from '../lib/gateway-tools.mjs';

// The phone path offers exactly the Composio pair, and nothing else from
// the server toolbox: github_api, run_terminal, fetch_url and web_search
// stay hosted-bot-only.
test('composio tools for OpenAI are exactly search + execute', () => {
  const tools = composioToolsForOpenAI();
  assert.deepEqual(
    tools.map((t) => t.function.name).sort(),
    ['composio_execute', 'composio_search']
  );
  const search = tools.find((t) => t.function.name === 'composio_search');
  assert.deepEqual(search.function.parameters.required, ['query']);
  const execute = tools.find((t) => t.function.name === 'composio_execute');
  assert.deepEqual(execute.function.parameters.required, ['tool_slug']);
  assert.equal(tools.every((t) => t.type === 'function'), true);
});

test('composio tools for Anthropic use input_schema, not parameters', () => {
  const tools = composioToolsForAnthropic();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['composio_execute', 'composio_search']
  );
  assert.ok(tools.every((t) => t.input_schema && !t.parameters));
  assert.deepEqual(COMPOSIO_TOOL_NAMES, GATEWAY_TOOL_NAMES);
});

test('local phone tools are unchanged: six filesystem tools, no Composio', () => {
  const names = toolsForOpenAI().map((t) => t.function.name).sort();
  assert.deepEqual(names, ['bash', 'edit_file', 'grep', 'list_dir', 'read_file', 'write_file']);
});

test('gateway offers Composio tools to tool-capable models, none to text-only ones', () => {
  assert.equal(gatewayExtraTools({ auth: 'bearer' }).length, 2);
  assert.equal(gatewayExtraTools({ auth: 'none' }).length, 2);
  assert.equal(gatewayExtraTools({ auth: 'anthropic' }).length, 2);
  assert.ok(gatewayExtraTools({ auth: 'anthropic' }).every((t) => t.input_schema));
  for (const auth of ['gemini', 'cohere', 'horde', 'hf']) {
    assert.deepEqual(gatewayExtraTools({ auth }), [], auth);
  }
  assert.deepEqual(gatewayExtraTools(null), []);
});

test('isGatewayTool routes only the Composio pair to the gateway', () => {
  assert.equal(isGatewayTool('composio_search'), true);
  assert.equal(isGatewayTool('composio_execute'), true);
  for (const name of ['list_dir', 'bash', 'github_api', 'run_terminal', 'fetch_url', 'web_search']) {
    assert.equal(isGatewayTool(name), false, name);
  }
});

function stubFetch(capture, { ok = true, status = 200, body = {} } = {}) {
  return async (url, options) => {
    capture.url = url;
    capture.options = options;
    return {
      ok,
      status,
      json: async () => body,
    };
  };
}

test('gateway execution posts the call with the gateway token and no Composio key', async () => {
  const capture = {};
  const out = await executeGatewayTool(
    { gateway: 'https://termux-code.pages.dev/', gatewayToken: 'tc_v1_test', name: 'composio_execute', args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.c' } } },
    stubFetch(capture, { body: { ok: true, result: 'HTTP 200\n{"sent":true}' } })
  );
  assert.equal(out, 'HTTP 200\n{"sent":true}');
  assert.equal(capture.url, 'https://termux-code.pages.dev/api/tools/execute');
  assert.equal(capture.options.headers.Authorization, 'Bearer tc_v1_test');
  assert.equal(capture.options.headers['x-api-key'], undefined);
  const sent = JSON.parse(capture.options.body);
  assert.equal(sent.name, 'composio_execute');
  assert.equal(JSON.stringify(sent).includes('COMPOSIO'), false);
});

test('a dead Composio key surfaces as honest error text, never faked success', async () => {
  // The gateway passes Composio's own status line through as result text.
  const passthrough = await executeGatewayTool(
    { gateway: 'https://example.invalid', gatewayToken: 't', name: 'composio_execute', args: { tool_slug: 'GMAIL_SEND_EMAIL' } },
    stubFetch({}, { body: { ok: true, result: 'HTTP 401\n{"error":"invalid api key"}' } })
  );
  assert.ok(passthrough.includes('HTTP 401'));

  // And a gateway-level rejection is an honest failure, not a result.
  const rejected = await executeGatewayTool(
    { gateway: 'https://example.invalid', gatewayToken: 'bad', name: 'composio_search', args: { query: 'send mail' } },
    stubFetch({}, { ok: false, status: 401, body: { ok: false, error: { code: 'NO_KEY', message: 'Sign in or a gateway token is required.' } } })
  );
  assert.ok(rejected.includes('failed'));
  assert.ok(rejected.includes('NO_KEY'));
});

test('no gateway means an honest needs-gateway message and no fetch', async () => {
  let called = false;
  const out = await executeGatewayTool(
    { gateway: undefined, gatewayToken: undefined, name: 'composio_search', args: { query: 'x' } },
    async () => {
      called = true;
      throw new Error('should not fetch');
    }
  );
  assert.equal(called, false);
  assert.ok(out.includes('need the gateway'));
});

test('an unreachable gateway is an honest failure, not a throw', async () => {
  const out = await executeGatewayTool(
    { gateway: 'https://example.invalid', gatewayToken: 't', name: 'composio_search', args: { query: 'x' } },
    async () => {
      throw new Error('network down');
    }
  );
  assert.ok(out.includes('could not reach the gateway'));
});

test('non-gateway tool names are refused by the dispatcher', async () => {
  const out = await executeGatewayTool(
    { gateway: 'https://example.invalid', gatewayToken: 't', name: 'bash', args: { command: 'ls' } },
    async () => {
      throw new Error('should not fetch');
    }
  );
  assert.ok(out.includes('Not a gateway tool'));
});
