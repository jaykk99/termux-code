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
 */

const UA = 'Mozilla/5.0 (Linux; Android 14) termux-code/1.0';
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 8000;

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

async function getText(url, headers = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'follow',
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one http(s) page and return its text. A page that is not HTML comes
 * back as-is (JSON, plain text, a .txt/.md file).
 */
export async function fetchUrlText(url, { limit = MAX_CHARS } = {}) {
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return 'fetch_url needs a full http(s) URL, e.g. https://example.com.';
  }
  if (!/^https?:$/.test(u.protocol)) return 'Only http and https URLs are supported.';
  try {
    const res = await getText(u.href);
    const raw = await res.text();
    const isHtml = (res.headers.get('content-type') || '').includes('html');
    return clipText(`HTTP ${res.status} ${u.href}\n${isHtml ? htmlToText(raw) : raw}`, limit);
  } catch (err) {
    return `fetch_url failed for ${u.href}: ${err?.message || err}`;
  }
}

/**
 * DuckDuckGo HTML search: title, URL and snippet for the top results. The
 * result links are wrapped in a redirect (`/l/?uddg=<encoded>`), so the real
 * URL is unwrapped before it is shown — a model that copies the wrapper into
 * fetch_url would otherwise read DuckDuckGo's redirect page, not the result.
 */
export async function ddgSearch(query, { limit = 8 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) return 'web_search needs a non-empty query.';
  let html;
  try {
    const res = await getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
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
