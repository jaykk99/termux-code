/**
 * The browser tool: drives the phone's own Chromium from the CLI.
 *
 * Three rungs, in the order they are tried — the tool is honest about
 * which rung answered, because pretending a page was browsed when only
 * a static fetch happened is how agents end up hallucinating clicks:
 *
 *   1. CDP (the real browser). Chromium is spawned once per CLI session
 *      with --remote-debugging-port=0 and driven over the DevTools
 *      protocol (Target/Page/Runtime/Input) through Node's global
 *      WebSocket. This is the only rung that can click, type and
 *      scroll: it keeps a live page, cookies and all. The browser
 *      process is reused across calls and killed when the CLI exits.
 *   2. Headless one-shots. When CDP is unavailable (no WebSocket in
 *      this Node, Chromium too old to speak it, the debug port never
 *      came up), `chromium --headless --dump-dom` still reads a page
 *      and `--screenshot` still captures one. There is no live page,
 *      so click/type/scroll refuse plainly instead of faking it.
 *   3. The gateway. When Chromium is not installed at all, open/read
 *      fall back to the gateway's /api/browser/read route, which
 *      fetches the page server-side and returns readability text. The
 *      phone still holds no keys; the request carries the gateway
 *      token, exactly like the Composio dispatch. Screenshot and the
 *      interactive actions cannot be served this way and say so.
 *
 * Approvals match the other local tools: click and type change page
 * state, so they go through the same yes/no gate as a file write or a
 * shell command, BEFORE anything is attempted. open, read, screenshot
 * and scroll are reads and never prompt.
 *
 * Zero dependencies, like the rest of the CLI: no puppeteer, no ws
 * package — CDP is JSON over the platform WebSocket, and the fallback
 * rungs are Chromium's own headless flags.
 */

import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 20_000; // match lib/tools.mjs clipping
const CDP_TIMEOUT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 10_000;
const SHELL_TIMEOUT_MS = 30_000;
const DEFAULT_SCREENSHOT = 'browser-screenshot.png';

export const BROWSER_ACTIONS = ['open', 'read', 'screenshot', 'click', 'type', 'scroll'];
const STATE_CHANGING = new Set(['click', 'type']);

/** Actions that change page state and therefore need the yes/no gate. */
export function isStateChangingAction(action) {
  return STATE_CHANGING.has(action);
}

function clip(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n... truncated, ${s.length - limit} more characters`;
}

/** Tag-stripper, same approach as the server's fetch_url text path. */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalize and validate the model's arguments BEFORE any approval
 * prompt or process spawn, so a malformed call fails as text the model
 * can fix, not as a stack trace. Returns { error } or the clean args.
 */
export function validateBrowserArgs(args = {}) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!BROWSER_ACTIONS.includes(action)) {
    return { error: `browser action must be one of: ${BROWSER_ACTIONS.join(', ')}.` };
  }
  const out = { action };
  if (args.url !== undefined && args.url !== '') {
    if (!isHttpUrl(args.url)) return { error: 'url must be a full http(s) URL.' };
    out.url = String(args.url);
  }
  if (action === 'open' && !out.url) return { error: 'browser open needs a url.' };
  if (action === 'read' && args.url !== undefined && !out.url) {
    return { error: 'url must be a full http(s) URL.' };
  }
  if (action === 'click' || action === 'type') {
    const selector = String(args.selector || '').trim();
    if (!selector) return { error: `browser ${action} needs a selector (CSS, or text=visible text).` };
    out.selector = selector;
  }
  if (action === 'type') {
    if (typeof args.text !== 'string' || args.text === '') {
      return { error: 'browser type needs the text to type.' };
    }
    out.text = args.text;
  }
  if (action === 'scroll') {
    const direction = String(args.direction || 'down').trim().toLowerCase();
    if (direction !== 'up' && direction !== 'down') {
      return { error: 'scroll direction must be "up" or "down".' };
    }
    out.direction = direction;
    const amount = Number(args.amount);
    out.amount = Number.isFinite(amount) && amount > 0 ? Math.min(Math.floor(amount), 20_000) : 800;
  }
  if (action === 'screenshot' && args.path !== undefined && args.path !== '') {
    out.path = String(args.path);
  }
  return out;
}

/* ---------- Chromium discovery + command construction ---------- */

export const CHROMIUM_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

/** Launch flags for the CDP rung. Port 0: Chromium picks a free port
 *  and prints the DevTools URL on stderr, so nothing collides with a
 *  browser the user already has open. */
export function buildCdpLaunchArgs({ userDataDir, url = 'about:blank' } = {}) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-first-run',
    url,
  ];
}

/** One-shot page read. `legacy` drops the `=new` headless spelling for
 *  old Chromium builds that reject it. */
export function buildDumpDomArgs(url, { legacy = false } = {}) {
  return [
    legacy ? '--headless' : '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--dump-dom',
    url,
  ];
}

export function buildScreenshotArgs(url, outPath, { width = 1280, height = 2000, legacy = false } = {}) {
  return [
    legacy ? '--headless' : '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    `--screenshot=${outPath}`,
    `--window-size=${width},${height}`,
    url,
  ];
}

/* ---------- CDP expressions (pure builders, unit-tested) ---------- */

/** A selector is CSS, or `text=...` to match by visible text. The
 *  selector is embedded via JSON.stringify, never string concat, so a
 *  quote in the selector cannot break out of the expression. */
export function findElementExpr(selector) {
  const sel = JSON.stringify(String(selector));
  return `(() => {
    const sel = ${sel};
    let el = null;
    if (sel.startsWith('text=')) {
      const want = sel.slice(5).trim().toLowerCase();
      el = [...document.querySelectorAll('a, button, input, [role="button"], [onclick]')]
        .find((n) => (n.innerText || n.value || '').trim().toLowerCase().includes(want)) || null;
    } else {
      el = document.querySelector(sel);
    }
    return el;
  })()`;
}

export function pageTextExpr() {
  return `document.body ? document.body.innerText : ''`;
}

export function readyStateExpr() {
  return `document.readyState`;
}

export function clickExpr(selector) {
  return `(() => {
    const el = ${findElementExpr(selector)};
    if (!el) return 'not-found';
    el.scrollIntoView({ block: 'center' });
    el.click();
    return 'clicked';
  })()`;
}

export function focusExpr(selector) {
  return `(() => {
    const el = ${findElementExpr(selector)};
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.focus();
    if (typeof el.select === 'function') el.select();
    return true;
  })()`;
}

/** After Input.insertText, pages that listen for framework events need
 *  the input/change pair or the typed text never registers. */
export function dispatchInputEventsExpr(selector) {
  return `(() => {
    const el = ${findElementExpr(selector)};
    if (!el) return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

export function scrollExpr(deltaY) {
  return `(() => { window.scrollBy(0, ${Number(deltaY) || 0}); return window.scrollY; })()`;
}

/* ---------- process plumbing (injectable for tests) ---------- */

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 16, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function defaultWhich(candidate) {
  try {
    const { stdout } = await defaultExecFile('which', [candidate]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** First installed Chromium candidate, or null. TERMUX_CODE_CHROMIUM
 *  wins when set, so a user with a wrapped build can point at it. */
export async function findChromiumBinary(deps = {}) {
  const which = deps.whichFn || defaultWhich;
  const override = process.env.TERMUX_CODE_CHROMIUM;
  if (override) return override;
  for (const cand of CHROMIUM_CANDIDATES) {
    const found = await which(cand);
    if (found) return cand;
  }
  return null;
}

/* ---------- the CDP session (one per CLI process) ---------- */

let session = null; // { ws, proc, nextId, pending, sessionId, url, binary }
let exitHookArmed = false;

function armExitHook() {
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.once('exit', () => {
    try {
      session?.proc?.kill();
    } catch {
      /* already gone */
    }
  });
}

function cdpSend(sess, method, params = {}, sessionId = sess.sessionId) {
  return new Promise((resolvePromise, reject) => {
    const id = ++sess.nextId;
    const timer = setTimeout(() => {
      sess.pending.delete(id);
      reject(new Error(`CDP ${method} timed out.`));
    }, CDP_TIMEOUT_MS);
    sess.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    sess.ws.send(JSON.stringify(msg));
  });
}

async function launchCdpSession(binary, deps) {
  // deps.WebSocketImpl is the test seam: undefined means "the platform
  // WebSocket", an explicit null means "none" (older Node), which is
  // exactly the rung-2 condition.
  const WebSocketImpl = deps.WebSocketImpl !== undefined ? deps.WebSocketImpl : globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') return null; // no WS in this Node — rung 2
  const spawnFn = deps.spawnFn || spawn;
  const userDataDir =
    deps.userDataDir || path.join(os.tmpdir(), 'termux-code-browser');
  const proc = spawnFn(binary, buildCdpLaunchArgs({ userDataDir }), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const wsUrl = await new Promise((resolvePromise) => {
    let buf = '';
    const timer = setTimeout(() => resolvePromise(null), LAUNCH_TIMEOUT_MS);
    proc.stderr?.on('data', (chunk) => {
      buf += String(chunk);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolvePromise(m[1]);
      }
    });
    proc.once?.('exit', () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    proc.once?.('error', () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
  });
  if (!wsUrl) {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    return null;
  }

  const ws = new WebSocketImpl(wsUrl);
  const sess = { ws, proc, nextId: 0, pending: new Map(), sessionId: null, url: '', binary };
  ws.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (data.id && sess.pending.has(data.id)) {
      const p = sess.pending.get(data.id);
      sess.pending.delete(data.id);
      if (data.error) p.reject(new Error(`CDP: ${data.error.message || 'protocol error'}`));
      else p.resolve(data.result || {});
    }
  });
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket connect timed out.')), CDP_TIMEOUT_MS);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP websocket failed to connect.'));
    });
  });

  const { targetId } = await cdpSend(sess, 'Target.createTarget', { url: 'about:blank' }, null);
  const { sessionId } = await cdpSend(sess, 'Target.attachToTarget', { targetId, flatten: true }, null);
  sess.sessionId = sessionId;
  await cdpSend(sess, 'Page.enable');
  await cdpSend(sess, 'Runtime.enable');
  session = sess;
  armExitHook();
  return sess;
}

/** Reuse the live session, or launch one. { sess } on success,
 *  { binary } when Chromium exists but CDP could not be established,
 *  { noChromium: true } when there is no browser on the phone at all. */
async function ensureSession(deps) {
  if (session && session.ws && session.ws.readyState !== 3 /* CLOSED */) {
    return { sess: session };
  }
  session = null;
  const binary = await findChromiumBinary(deps);
  if (!binary) return { noChromium: true };
  try {
    const sess = await launchCdpSession(binary, deps);
    if (sess) return { sess };
  } catch {
    /* fall through to the one-shot rung */
  }
  return { binary };
}

async function cdpEvaluate(sess, expression) {
  const res = await cdpSend(sess, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Page evaluation failed: ${res.exceptionDetails.text || 'exception'}`);
  }
  return res.result?.value;
}

async function cdpNavigate(sess, url) {
  await cdpSend(sess, 'Page.navigate', { url });
  sess.url = url;
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await cdpEvaluate(sess, readyStateExpr()).catch(() => 'complete');
    if (state === 'complete' || state === 'interactive') break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ---------- rung 2: one-shot headless commands ---------- */

async function runOneShot(binary, args, deps) {
  const execFileFn = deps.execFileFn || defaultExecFile;
  try {
    return await execFileFn(binary, args);
  } catch (err) {
    // Old Chromium builds reject --headless=new; retry once legacy.
    if (args[0] === '--headless=new') {
      return execFileFn(binary, ['--headless', ...args.slice(1)]);
    }
    throw err;
  }
}

async function oneShotText(binary, url, deps) {
  const { stdout } = await runOneShot(binary, buildDumpDomArgs(url), deps);
  return htmlToText(stdout);
}

/* ---------- rung 3: the gateway read route ---------- */

async function gatewayRead(url, ctx, deps) {
  const fetchFn = deps.fetchFn || fetch;
  if (!ctx.gateway) {
    return (
      'No Chromium on this phone and no gateway configured, so the page could not be fetched. ' +
      'Install the browser with: pkg install chromium — or set a gateway with /gateway and try again.'
    );
  }
  let res;
  try {
    res = await fetchFn(ctx.gateway.replace(/\/$/, '') + '/api/browser/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.gatewayToken ? { Authorization: `Bearer ${ctx.gatewayToken}` } : {}),
      },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    return `Browser read via the gateway failed: could not reach the gateway (${err?.message || err}).`;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const errObj = data?.error;
    const detail =
      typeof errObj === 'object' && errObj
        ? [errObj.code, errObj.message].filter(Boolean).join(': ')
        : errObj || `Gateway returned HTTP ${res.status}.`;
    return `Browser read via the gateway failed: ${detail}`;
  }
  return typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? '');
}

const INSTALL_HINT =
  'Chromium is not installed on this phone, and this action needs the real browser. Install it with: pkg install chromium, then try again.';

/* ---------- the tool itself ---------- */

/**
 * @param {object} args  model-supplied arguments (see TOOL_SCHEMA)
 * @param {{root:string, approve:(desc:string, detail:string)=>Promise<boolean>, gateway?:string, gatewayToken?:string}} ctx
 * @param {object} [deps] test seam: { whichFn, spawnFn, WebSocketImpl, execFileFn, fetchFn, writeFileFn, userDataDir }
 */
export async function runBrowser(args, ctx, deps = {}) {
  const clean = validateBrowserArgs(args);
  if (clean.error) return clean.error;
  const { action } = clean;

  // The approval gate fires before any rung is attempted, so a declined
  // click never even launches the browser.
  if (isStateChangingAction(action)) {
    const detail =
      action === 'click'
        ? `Selector: ${clean.selector}${clean.url ? `\nOn page: ${clean.url}` : ''}`
        : `Selector: ${clean.selector}\nText: ${clip(clean.text, 300)}`;
    const ok = await ctx.approve(`Browser ${action}`, detail);
    if (!ok) return 'Declined by the user. Ask what they would prefer instead.';
  }

  const state = await ensureSession(deps);
  const sess = state.sess;

  /* ----- rung 1: live CDP session ----- */
  if (sess) {
    try {
      switch (action) {
        case 'open': {
          await cdpNavigate(sess, clean.url);
          const title = await cdpEvaluate(sess, `document.title`).catch(() => '');
          return clip(`Opened ${clean.url}${title ? `\nTitle: ${title}` : ''}\nUse browser read to get the page text, or click/type/screenshot next.`);
        }
        case 'read': {
          if (clean.url && clean.url !== sess.url) await cdpNavigate(sess, clean.url);
          if (!sess.url) return 'No page is open yet. Use browser open with a url first.';
          return clip(await cdpEvaluate(sess, pageTextExpr())) || '(page has no readable text)';
        }
        case 'screenshot': {
          if (clean.url && clean.url !== sess.url) await cdpNavigate(sess, clean.url);
          if (!sess.url) return 'No page is open yet. Use browser open with a url first.';
          const shot = await cdpSend(sess, 'Page.captureScreenshot', { format: 'png' });
          const rel = clean.path || DEFAULT_SCREENSHOT;
          const dest = resolveInRoot(ctx.root, rel);
          if (!dest) return `Screenshot path is outside the workspace: ${rel}`;
          const writeFileFn = deps.writeFileFn || fs.writeFile;
          await writeFileFn(dest, Buffer.from(shot.data, 'base64'));
          return `Screenshot saved to ${rel} (${Math.round(Buffer.from(shot.data, 'base64').length / 1024)} KB).`;
        }
        case 'click': {
          if (clean.url && clean.url !== sess.url) await cdpNavigate(sess, clean.url);
          if (!sess.url) return 'No page is open yet. Use browser open with a url first.';
          const out = await cdpEvaluate(sess, clickExpr(clean.selector));
          return out === 'clicked'
            ? `Clicked ${clean.selector} on ${sess.url}.`
            : `No element matched ${clean.selector} on ${sess.url}. Read the page and try a different selector.`;
        }
        case 'type': {
          if (clean.url && clean.url !== sess.url) await cdpNavigate(sess, clean.url);
          if (!sess.url) return 'No page is open yet. Use browser open with a url first.';
          const focused = await cdpEvaluate(sess, focusExpr(clean.selector));
          if (!focused) return `No element matched ${clean.selector} on ${sess.url}. Read the page and try a different selector.`;
          await cdpSend(sess, 'Input.insertText', { text: clean.text });
          await cdpEvaluate(sess, dispatchInputEventsExpr(clean.selector)).catch(() => {});
          return `Typed into ${clean.selector} on ${sess.url}.`;
        }
        case 'scroll': {
          if (!sess.url) return 'No page is open yet. Use browser open with a url first.';
          const delta = clean.direction === 'up' ? -clean.amount : clean.amount;
          const y = await cdpEvaluate(sess, scrollExpr(delta));
          return `Scrolled ${clean.direction} on ${sess.url} (now at y=${y}).`;
        }
      }
    } catch (err) {
      return `Browser ${action} failed in the live browser: ${err?.message || err}`;
    }
  }

  /* ----- no Chromium at all ----- */
  if (state.noChromium) {
    if (action === 'open' || action === 'read') {
      if (!clean.url) return 'No page is open (there is no browser session). Give a url to read it through the gateway.';
      const text = await gatewayRead(clean.url, ctx, deps);
      return text.startsWith('Browser read via the gateway failed') || text.startsWith('No Chromium')
        ? text
        : clip(`(via the gateway — Chromium is not installed on this phone)\n${text}`);
    }
    return INSTALL_HINT;
  }

  /* ----- rung 2: one-shot headless (Chromium present, no CDP) ----- */
  const binary = state.binary;
  try {
    switch (action) {
      case 'open':
      case 'read': {
        if (!clean.url) return 'No page is open (the live browser session is unavailable). Give a url to read.';
        const text = await oneShotText(binary, clean.url, deps);
        return clip(text) || '(page has no readable text)';
      }
      case 'screenshot': {
        if (!clean.url) return 'Screenshot needs a url when the live browser session is unavailable.';
        const rel = clean.path || DEFAULT_SCREENSHOT;
        const dest = resolveInRoot(ctx.root, rel);
        if (!dest) return `Screenshot path is outside the workspace: ${rel}`;
        await runOneShot(binary, buildScreenshotArgs(clean.url, dest), deps);
        return `Screenshot saved to ${rel}.`;
      }
      default:
        return (
          `Browser ${action} needs the live browser session (CDP), which is unavailable here — ` +
          'only open, read and screenshot work in one-shot mode. Check that Chromium is current ' +
          '(pkg upgrade chromium) and that this Node has WebSocket support, then try again.'
        );
    }
  } catch (err) {
    return `Browser ${action} failed: ${err?.stderr?.trim() || err?.message || err}`;
  }
}

/** Screenshot output stays inside the workspace, like every other
 *  file the local tools touch. Null when the path escapes. */
function resolveInRoot(root, rel) {
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/** Test seam: drop the cached CDP session between test cases. */
export function _resetBrowserSession() {
  if (session) {
    try {
      session.proc?.kill();
    } catch {
      /* already gone */
    }
    try {
      session.ws?.close();
    } catch {
      /* already gone */
    }
  }
  session = null;
}
