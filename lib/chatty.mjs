/**
 * Casual-chat guards.
 *
 * Why this exists: the agent is a coding agent with shell tools attached,
 * and the small free models behind the keyless chain are trigger-happy
 * with them. A bare greeting like "yo" used to go straight to the model
 * with tools on, and the model would invent a job for itself — typically
 * narrating that it will grab the user's IP, then calling bash to fetch
 * it from a public IP service. Nothing in the code ever asked for that:
 * there is no startup environment recon and no IP tool. The model just
 * fills silence with tool calls.
 *
 * Two deterministic guards, both phone-side so they cover direct and
 * gateway mode (tools always execute on the phone):
 *
 * 1. Pure greetings never reach the model. They get a short conversational
 *    reply that asks what the user is working on. Zero tool calls, by
 *    construction — no completion happens at all.
 * 2. A bash command that fetches the public IP (or location) from an
 *    outside service is refused in the tool loop unless the user's own
 *    message explicitly asked for it. The refusal goes back as a tool
 *    result, so the model answers in text instead of retrying the fetch.
 *
 * Explicit task requests are untouched: the guards only fire on bare
 * greetings and on identity lookups nobody asked for.
 */

const GREETING_WORDS = new Set([
  'yo', 'hey', 'hi', 'hello', 'sup', 'howdy', 'hiya', 'wassup',
  'whats up', "what's up", 'good morning', 'good afternoon', 'good evening',
]);

/** Normalize chat input for greeting matching: lowercase, no emoji, single spaces. */
export function normalizeChat(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[.?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True only for a bare greeting: one greeting word, optionally repeated
 * ("yo yo") or followed by "bro". Anything with more content ("yo, check
 * the repo", "yo what's new with the build") is NOT a greeting — it goes
 * to the model as a real message.
 */
export function isGreeting(text) {
  let t = normalizeChat(text);
  if (!t) return false;
  if (t.endsWith(' bro')) t = t.slice(0, -4).trim();
  if (GREETING_WORDS.has(t)) return true;
  // Repeated "yo": yo, yo yo, yo yo yo.
  if (/^(yo\s+)+yo$/.test(t)) return true;
  return false;
}

/** The greeting reply: short, conversational, and it asks what comes next. */
export function greetingReply() {
  return "Yo. What's up, what are you working on?";
}

// Public IP / location lookup services. Deliberately narrow: only outside
// services that report the caller's public IP or location. Local interface
// listings (ip addr, hostname -I) are NOT here — they are legitimate
// network debugging, and they were never the complaint.
const IP_SERVICE_RE =
  /(ifconfig\.me|ipinfo\.io|icanhazip|api\.ipify\.org|checkip\.amazonaws\.com|ident\.me|ifconfig\.co|ip-api\.com|ipapi\.co|whatismyipaddress\.com|myip\.com)/i;

/** True when a shell command fetches the public IP/location from an outside service. */
export function looksLikeIdentityLookup(command) {
  return IP_SERVICE_RE.test(String(command || ''));
}

// The user explicitly asking for their own IP or location.
const ASKED_IDENTITY_RE =
  /\bmy\s+(public\s+)?ip(\s+address)?\b|\bwhere am i\b|\bmy location\b|\bshow (me )?my ip\b|\bget my ip\b/i;

/** True when the user's own message explicitly asks for their IP or location. */
export function userAskedForIdentity(text) {
  return ASKED_IDENTITY_RE.test(String(text || ''));
}

/**
 * True when a tool call must be refused instead of executed: a bash
 * identity lookup that nobody asked for. Everything else passes through
 * unchanged, including the same command when the user did ask for it.
 */
export function shouldRefuseToolCall(call, latestUserMessage) {
  if (!call || call.name !== 'bash') return false;
  if (!looksLikeIdentityLookup(call.args?.command || '')) return false;
  return !userAskedForIdentity(latestUserMessage || '');
}
