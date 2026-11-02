/**
 * Tests for the browser tool (lib/browser.mjs) and its gateway read
 * route. No real Chromium exists on the test machine, so every rung is
 * exercised through the deps seam the module exposes:
 *   - rung 1 (CDP) against a scripted fake WebSocket + fake spawn,
 *   - rung 2 (one-shot headless) against a fake execFile,
 *   - rung 3 (gateway read) against a fake fetch.
 * What is asserted is the behaviour Jay depends on: the schema the
 * model sees, validation before anything spawns, the approval gate on
 * click/type (and only those), honest fallback text, and the exact
 * commands/CDP calls each action constructs.
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TOOL_SCHEMA, toolsForOpenAI, toolsForAnthropic, runTool } from '../lib/tools.mjs';
import {
  BROWSER_ACTIONS,
  isStateChangingAction,
  validateBrowserArgs,
  buildCdpLaunchArgs,
  buildDumpDomArgs,
  buildScreenshotArgs,
  findElementExpr,
  clickExpr,
  runBrowser,
  _resetBrowserSession,
} from '../lib/browser.mjs';
import { pageTextFromHtml } from '../lib/server-tools.mjs';
import { validatePageUrl } from '../app/api/browser/read/route.js';

const ROOT = '/tmp/tc-browser-root';
const approveYes = async () => true;

function ctxSpy(overrides = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      root: ROOT,
      approve: async (desc, detail) => {
        calls.push({ desc, detail });
        return overrides.approveResult !== false;
      },
      gateway: overrides.gateway,
      gatewayToken: overrides.gatewayToken,
    },
  };
}

/* ---------- schema + validation ---------- */

test('browser is in the local tool schema with all six actions', () => {
  const tool = TOOL_SCHEMA.find((t) => t.name === 'browser');
  assert.ok(tool, 'browser tool missing from TOOL_SCHEMA');
  assert.deepEqual(tool.parameters.properties.action.enum, BROWSER_ACTIONS);
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.ok(toolsForOpenAI().some((t) => t.function.name === 'browser'));
  const anthropic = toolsForAnthropic().find((t) => t.name === 'browser');
  assert.ok(anthropic && anthropic.input_schema && !anthropic.parameters);
});

test('validateBrowserArgs rejects bad calls before anything runs', () => {
  assert.match(validateBrowserArgs({}).error, /must be one of/);
  assert.match(validateBrowserArgs({ action: 'dance' }).error, /must be one of/);
  assert.match(validateBrowserArgs({ action: 'open' }).error, /needs a url/);
  assert.match(validateBrowserArgs({ action: 'open', url: 'ftp://x' }).error, /http\(s\)/);
  assert.match(validateBrowserArgs({ action: 'click' }).error, /needs a selector/);
  assert.match(validateBrowserArgs({ action: 'type', selector: '#a' }).error, /text to type/);
  assert.match(validateBrowserArgs({ action: 'scroll', direction: 'left' }).error, /up.*down/);
  const ok = validateBrowserArgs({ action: 'scroll' });
  assert.equal(ok.direction, 'down');
  assert.equal(ok.amount, 800);
  const typed = validateBrowserArgs({ action: 'type', selector: '#q', text: 'hi' });
  assert.deepEqual([typed.action, typed.selector, typed.text], ['type', '#q', 'hi']);
});

test('only click and type are state-changing', () => {
  assert.equal(isStateChangingAction('click'), true);
  assert.equal(isStateChangingAction('type'), true);
  for (const a of ['open', 'read', 'screenshot', 'scroll']) {
    assert.equal(isStateChangingAction(a), false, a);
  }
});

/* ---------- command construction ---------- */

test('CDP launch args carry the debug port and profile dir', () => {
  const args = buildCdpLaunchArgs({ userDataDir: '/data/profile', url: 'about:blank' });
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--user-data-dir=/data/profile'));
  assert.equal(args.at(-1), 'about:blank');
});

test('one-shot args: dump-dom reads, screenshot captures with a window size', () => {
  const dom = buildDumpDomArgs('https://example.com');
  assert.equal(dom.at(-1), 'https://example.com');
  assert.ok(dom.includes('--dump-dom'));
  const shot = buildScreenshotArgs('https://example.com', '/tmp/out.png');
  assert.ok(shot.includes('--screenshot=/tmp/out.png'));
  assert.ok(shot.includes('--window-size=1280,2000'));
  assert.ok(buildDumpDomArgs('https://example.com', { legacy: true })[0] === '--headless');
});

test('selectors are embedded as JSON, never raw string concat', () => {
  const expr = clickExpr('a[title="x"]; evil()');
  assert.ok(expr.includes(JSON.stringify('a[title="x"]; evil()')));
  assert.ok(findElementExpr('text=Sign in').includes('text='));
});

/* ---------- rung 3: no Chromium — gateway read or honest install text ---------- */

const noChromiumDeps = { whichFn: async () => null };

test('no Chromium and no gateway: read reports the install line, no approval asked', async () => {
  const { ctx, calls } = ctxSpy();
  const out = await runBrowser({ action: 'read', url: 'https://example.com' }, ctx, noChromiumDeps);
  assert.ok(out.includes('pkg install chromium'), out);
  assert.equal(calls.length, 0, 'read actions must never prompt');
});

test('no Chromium: click reports the install line (after approval), screenshot too', async () => {
  const { ctx, calls } = ctxSpy();
  const click = await runBrowser({ action: 'click', selector: '#go' }, ctx, noChromiumDeps);
  assert.ok(click.includes('pkg install chromium'), click);
  assert.equal(calls.length, 1, 'click must go through the approval gate even when it will fail');
  const shot = await runBrowser({ action: 'screenshot', url: 'https://example.com' }, ctx, noChromiumDeps);
  assert.ok(shot.includes('pkg install chromium'), shot);
});

test('no Chromium but a gateway: read goes through /api/browser/read with the token', async () => {
  const seen = {};
  const fetchFn = async (url, options) => {
    seen.url = url;
    seen.options = options;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: 'HTTP 200 https://example.com\nExample body' }) };
  };
  const { ctx } = ctxSpy({ gateway: 'https://gw.example/', gatewayToken: 'tc_v1_x' });
  const out = await runBrowser({ action: 'read', url: 'https://example.com' }, ctx, { ...noChromiumDeps, fetchFn });
  assert.ok(out.includes('Example body'), out);
  assert.ok(out.includes('via the gateway'), out);
  assert.equal(seen.url, 'https://gw.example/api/browser/read');
  assert.equal(seen.options.headers.Authorization, 'Bearer tc_v1_x');
  assert.deepEqual(JSON.parse(seen.options.body), { url: 'https://example.com' });
});

test('a declined click never touches any rung', async () => {
  let fetched = false;
  let execed = false;
  const { ctx } = ctxSpy({ approveResult: false });
  const out = await runBrowser({ action: 'click', selector: '#go', url: 'https://example.com' }, ctx, {
    whichFn: async () => {
      execed = true;
      return null;
    },
    fetchFn: async () => {
      fetched = true;
      throw new Error('unreachable');
    },
  });
  assert.ok(out.startsWith('Declined by the user'), out);
  assert.equal(fetched, false);
  assert.equal(execed, false);
});

/* ---------- rung 2: Chromium present, CDP unavailable ---------- */

function oneShotDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      whichFn: async () => 'chromium',
      WebSocketImpl: null, // forces the one-shot rung
      execFileFn: async (file, args) => {
        calls.push({ file, args });
        if (args.includes('--dump-dom')) {
          return { stdout: '<html><head><style>x</style></head><body><p>Needle in the page</p><script>bad()</script></body></html>', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    },
  };
}

test('one-shot read strips the page to text', async () => {
  const { ctx, calls: approvals } = ctxSpy();
  const { deps, calls } = oneShotDeps();
  const out = await runBrowser({ action: 'read', url: 'https://example.com' }, ctx, deps);
  assert.equal(out, 'Needle in the page');
  assert.ok(calls[0].args.includes('--dump-dom'));
  assert.equal(approvals.length, 0);
});

test('one-shot screenshot writes through the chromium flag, inside the workspace', async () => {
  const { ctx } = ctxSpy();
  const { deps, calls } = oneShotDeps();
  const out = await runBrowser({ action: 'screenshot', url: 'https://example.com' }, ctx, deps);
  assert.ok(out.includes('browser-screenshot.png'), out);
  const shot = calls.find((c) => c.args.some((a) => a.startsWith('--screenshot=')));
  assert.ok(shot.args.includes(`--screenshot=${ROOT}/browser-screenshot.png`), shot.args.join(' '));
  const escaped = await runBrowser({ action: 'screenshot', url: 'https://example.com', path: '../evil.png' }, ctx, deps);
  assert.ok(escaped.includes('outside the workspace'), escaped);
});

test('one-shot click/type/scroll refuse plainly: they need the live session', async () => {
  const { ctx } = ctxSpy();
  const { deps } = oneShotDeps();
  for (const args of [
    { action: 'click', selector: '#a' },
    { action: 'type', selector: '#a', text: 'x' },
    { action: 'scroll' },
  ]) {
    const out = await runBrowser(args, ctx, deps);
    assert.ok(out.includes('needs the live browser session'), `${args.action}: ${out}`);
  }
});

/* ---------- rung 1: live CDP session over a fake WebSocket ---------- */

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = {};
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => this.emit('open', {}), 0);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  emit(name, ev) {
    for (const fn of this.listeners[name] || []) fn(ev);
  }
  send(str) {
    const msg = JSON.parse(str);
    this.sent.push(msg);
    const reply = (result) =>
      setTimeout(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result }) }), 0);
    switch (msg.method) {
      case 'Target.createTarget':
        return reply({ targetId: 'T1' });
      case 'Target.attachToTarget':
        return reply({ sessionId: 'S1' });
      case 'Runtime.evaluate': {
        const e = msg.params.expression;
        // Action expressions first: the shared findElementExpr helper
        // mentions innerText (its text= branch), so the page-text
        // branch below would otherwise swallow click/focus calls.
        if (e.includes('.click()')) {
          return reply({ result: { value: e.includes('missing') ? 'not-found' : 'clicked' } });
        }
        if (e.includes('.focus()')) return reply({ result: { value: !e.includes('missing') } });
        if (e.includes('scrollBy')) return reply({ result: { value: 800 } });
        if (e.includes('readyState')) return reply({ result: { value: 'complete' } });
        if (e.includes('document.title')) return reply({ result: { value: 'Fake Title' } });
        if (e.includes('innerText')) return reply({ result: { value: 'Hello from the fake page' } });
        return reply({ result: { value: true } });
      }
      case 'Page.captureScreenshot':
        return reply({ data: Buffer.from('PNGDATA').toString('base64') });
      default:
        return reply({});
    }
  }
  close() {
    this.readyState = 3;
  }
}

function fakeProc() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  setTimeout(() => proc.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n'), 0);
  return proc;
}

function cdpDeps(writes) {
  FakeWS.instances = [];
  return {
    whichFn: async () => 'chromium',
    WebSocketImpl: FakeWS,
    spawnFn: () => fakeProc(),
    userDataDir: '/tmp/tc-fake-profile',
    writeFileFn: async (dest, buf) => writes.push({ dest, buf }),
  };
}

test('CDP: open navigates, read returns page text, session is reused', async (t) => {
  _resetBrowserSession();
  t.after(() => _resetBrowserSession());
  const writes = [];
  const deps = cdpDeps(writes);
  const { ctx } = ctxSpy();
  const opened = await runBrowser({ action: 'open', url: 'https://example.com' }, ctx, deps);
  assert.ok(opened.includes('Opened https://example.com'), opened);
  assert.ok(opened.includes('Fake Title'), opened);
  const read = await runBrowser({ action: 'read' }, ctx, deps);
  assert.equal(read, 'Hello from the fake page');
  assert.equal(FakeWS.instances.length, 1, 'second call must reuse the session, not relaunch');
  const ws = FakeWS.instances[0];
  assert.ok(ws.sent.some((m) => m.method === 'Page.navigate' && m.params.url === 'https://example.com'));
});

test('CDP: click approves first, then clicks; a missing element is reported', async (t) => {
  _resetBrowserSession();
  t.after(() => _resetBrowserSession());
  const deps = cdpDeps([]);
  const { ctx, calls } = ctxSpy();
  await runBrowser({ action: 'open', url: 'https://example.com' }, ctx, deps);
  const clicked = await runBrowser({ action: 'click', selector: '#buy' }, ctx, deps);
  assert.ok(clicked.startsWith('Clicked #buy'), clicked);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].desc, 'Browser click');
  const missing = await runBrowser({ action: 'click', selector: '#missing' }, ctx, deps);
  assert.ok(missing.includes('No element matched'), missing);
});

test('CDP: type focuses the field and inserts the text through Input.insertText', async (t) => {
  _resetBrowserSession();
  t.after(() => _resetBrowserSession());
  const deps = cdpDeps([]);
  const { ctx } = ctxSpy();
  await runBrowser({ action: 'open', url: 'https://example.com' }, ctx, deps);
  const out = await runBrowser({ action: 'type', selector: '#q', text: 'termux browser' }, ctx, deps);
  assert.ok(out.startsWith('Typed into #q'), out);
  const ws = FakeWS.instances[0];
  const insert = ws.sent.find((m) => m.method === 'Input.insertText');
  assert.ok(insert, 'Input.insertText was never sent');
  assert.equal(insert.params.text, 'termux browser');
});

test('CDP: screenshot lands in the workspace; scroll reports the new position', async (t) => {
  _resetBrowserSession();
  t.after(() => _resetBrowserSession());
  const writes = [];
  const deps = cdpDeps(writes);
  const { ctx } = ctxSpy();
  await runBrowser({ action: 'open', url: 'https://example.com' }, ctx, deps);
  const shot = await runBrowser({ action: 'screenshot' }, ctx, deps);
  assert.ok(shot.includes('browser-screenshot.png'), shot);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].dest, `${ROOT}/browser-screenshot.png`);
  assert.equal(writes[0].buf.toString(), 'PNGDATA');
  const scrolled = await runBrowser({ action: 'scroll' }, ctx, deps);
  assert.ok(scrolled.includes('y=800'), scrolled);
});

/* ---------- dispatch through runTool, and the gateway route ---------- */

test('runTool dispatches browser with the ctx seam', async () => {
  const out = await runTool(
    'browser',
    { action: 'read', url: 'https://example.com' },
    { root: ROOT, approve: approveYes, browserDeps: noChromiumDeps }
  );
  assert.ok(out.includes('pkg install chromium'), out);
});

test('gateway read route validates URLs', () => {
  assert.equal(validatePageUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(validatePageUrl('http://example.com'), 'http://example.com/');
  assert.equal(validatePageUrl('file:///etc/passwd'), null);
  assert.equal(validatePageUrl('javascript:alert(1)'), null);
  assert.equal(validatePageUrl('not a url'), null);
  assert.equal(validatePageUrl(undefined), null);
});

test('pageTextFromHtml drops page chrome and keeps the article', () => {
  const html =
    '<html><body><nav>Menu junk</nav><header>Site banner</header>' +
    '<article><p>The real story lives here.</p></article>' +
    '<footer>Copyright junk</footer><script>track()</script></body></html>';
  const text = pageTextFromHtml(html);
  assert.ok(text.includes('The real story lives here.'), text);
  assert.ok(!text.includes('Menu junk'), text);
  assert.ok(!text.includes('Copyright junk'), text);
  assert.ok(!text.includes('Site banner'), text);
});
