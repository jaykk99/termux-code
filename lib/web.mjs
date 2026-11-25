/**
 * Keyless web access for the phone: search, and read a page as text.
 *
 * Both are plain fetch + text extraction — no Chromium, no CDP, no gateway, no
 * API key — because that is what actually runs inside Termux (and in this repo's
 * tests). Google's Programmable Search needs a key and a CX; DuckDuckGo's HTML
 * endpoint answers an ordinary GET, so `web_search` uses that.
 *
 * These are the tools that let the agent ground an answer in a real page
 * instead of guessing from its weights, which matters most for the small
 * Horde workers that cannot know anything recent.
 *
 * A plain GET is not enough for the modern web: claude.ai, most app sites
 * and anything behind a bot check answer with an empty <div id="root">, a
 * "Just a moment…" interstitial, or a 403. Returning that empty shell made
 * the agent tell the user it "cannot go on URLs". So a read that comes back
 * empty or challenged is retried once through a keyless text reader
 * (r.jina.ai by default, overridable with TERMUX_CODE_READER_URL), which
 * renders the page and returns readable text. The result says which route
 * answered, so nothing pretends a browser session happened.
 */

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const TIMEOUT_MS = 15_000;
const READER_TIMEOUT_MS = 25_000; // the reader renders the page first; slower than a GET
const MAX_CHARS = 8000;

/**
 * Browser-shaped headers. The old UA string ("termux-code/1.0") was an
 * instant bot signal for Cloudflare-fronted sites, which is most of what
 * the owner asks about.
 */
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Keyless reader that renders JavaScript. Override to self-host. */
export const READER_BASE = process.env.TERMUX_CODE_READER_URL || 'https://r.jina.ai/';

/** Phrases a wall/interstitial page uses instead of content. */
const CHALLENGE_RE =
  /just a moment|checking your browser|verify (?:that )?you are (?:a )?human|cf-browser-verification|cf_chl_|attention required|ddos protection|unusual traffic|enable javascript|javascript (?:is|must be) (?:required|enabled)|requires javascript|you need to enable javascript|access denied/i;

/** Strip markup down to readable text, same approach as the server's fetch_url. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export function clipText(text, limit = MAX_CHARS) {
  const s = String(text ?? '');
  return s.length <= limit ? s : `${s.slice(0, limit)}\n... truncated, ${s.length - limit} more characters`;
}

async function getText(url, headers = {}, fetchFn = fetch, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      headers: { ...BROWSER_HEADERS, ...headers },
      redirect: 'follow',
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Would a direct read of this response be a wall or an empty app shell?
 * Deliberately conservative: a short but real answer ("Hi there") is
 * returned as-is, not sent to the reader.
 */
export function needsReader({ status = 0, text = '' } = {}) {
  const t = String(text ?? '').trim();
  if ([401, 403, 429, 503].includes(Number(status))) return true;
  if (t.length < 4000 && CHALLENGE_RE.test(t)) return true;
  if (!t) return true;
  if (t.length <= 160 && /^(loading|please wait|redirecting)\b/i.test(t)) return true;
  return false;
}

/** Where the reader fetches a page: <reader-base>/<full url>. */
export function readerUrl(url, base = READER_BASE) {
  return `${String(base).replace(/\/+$/, '')}/${url}`;
}

/** One reader attempt. Null when the reader is down or returns nothing. */
async function readViaReader(url, { fetchImpl, timeoutMs = READER_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await getText(readerUrl(url), { Accept: 'text/plain' }, fetchImpl || fetch, timeoutMs);
  } catch {
    return null;
  }
  if (res?.ok === false) return null;
  let text;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  text = String(text ?? '')
    .replace(/^Title:.*\n+/m, '')
    .replace(/^URL Source:.*\n+/m, '')
    .replace(/^Markdown Content:\s*\n?/m, '')
    .trim();
  if (text.length < 20) return null;
  return { status: res.status ?? 200, text };
}

/**
 * Read one http(s) page. Returns
 *   { ok:true, status, url, text, via:'direct'|'reader', unreadable? }
 *   { ok:false, reason }                     for a bad URL
 * and throws only on a network/timeout error, which the caller turns into
 * text (the gateway route relies on that to report the real failure).
 */
export async function readPageText(url, { fetchImpl, extract, timeoutMs = TIMEOUT_MS } = {}) {
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return { ok: false, reason: 'a full http(s) URL, e.g. https://example.com' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Only http and https URLs are supported.' };

  const res = await getText(u.href, {}, fetchImpl || fetch, timeoutMs);
  const raw = await res.text();
  const isHtml = (res.headers?.get?.('content-type') || '').includes('html');
  const finalUrl = res.url || u.href;
  const status = res.status ?? 200;
  const text = isHtml ? (extract || htmlToText)(raw) : raw;

  if (!needsReader({ status, text })) return { ok: true, status, url: finalUrl, text, via: 'direct' };

  const viaReader = await readViaReader(u.href, { fetchImpl });
  if (viaReader) return { ok: true, status: viaReader.status, url: finalUrl, text: viaReader.text, via: 'reader' };
  return { ok: true, status, url: finalUrl, text, via: 'direct', unreadable: true };
}

/**
 * Read one http(s) page and return its text. A page that is not HTML comes
 * back as-is (JSON, plain text, a .txt/.md file). A page that is only a
 * JavaScript shell or a bot check is re-read through the keyless reader;
 * when that also fails, the reply says what happened instead of coming
 * back empty.
 */
export async function fetchUrlText(url, { limit = MAX_CHARS, fetchImpl } = {}) {
  let page;
  try {
    page = await readPageText(url, { fetchImpl });
  } catch (err) {
    return `Could not read ${String(url ?? '').trim()}: ${err?.message || err}. Check the URL, or use web_search to find the right page.`;
  }
  if (!page.ok) {
    return page.reason.startsWith('Only')
      ? page.reason
      : `fetch_url needs ${page.reason}.`;
  }
  const body = String(page.text ?? '').trim();
  // A wall or an empty app shell is not content: saying so is better than
  // handing the model "Just a moment…" to quote as the page.
  if (!body || page.unreadable) {
    return (
      `HTTP ${page.status} ${page.url} returned no readable text: the page is a bot check or ` +
      'a JavaScript app, and the text reader could not get it either. Try web_search for a ' +
      'copy of the content, or the browser tool (which needs Chromium: pkg install chromium).'
    );
  }
  const via = page.via === 'reader' ? ' (read via text reader — the page needs JavaScript)' : '';
  return clipText(`HTTP ${page.status} ${page.url}${via}\n${body}`, limit);
}

/**
 * DuckDuckGo HTML search: title, URL and snippet for the top results. The
 * result links are wrapped in a redirect (`/l/?uddg=<encoded>`), so the real
 * URL is unwrapped before it is shown — a model that copies the wrapper into
 * fetch_url would otherwise read DuckDuckGo's redirect page, not the result.
 */
export async function ddgSearch(query, { limit = 8, fetchImpl } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return 'web_search needs a non-empty query.';
  let html;
  try {
    const res = await getText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {},
      fetchImpl || fetch
    );
    html = await res.text();
  } catch (err) {
    return `web_search failed: ${err?.message || err}`;
  }
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/g;
  let m;
  while ((m = re.exec(html)) && results.length < limit) {
    let href = m[1];
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      href = u.searchParams.get('uddg') || u.href;
    } catch {
      /* keep the raw href */
    }
    const title = htmlToText(m[2]);
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : '';
    results.push(`${results.length + 1}. ${title}\n   ${href}${snippet ? `\n   ${snippet}` : ''}`);
  }
  if (!results.length) return 'No results parsed. Try fetch_url on a known page instead.';
  return clipText(results.join('\n\n'));
}
