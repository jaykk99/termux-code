/**
 * Casual-chat conveniences.
 *
 * Two things used to live here, and only one survives.
 *
 * Gone: a "guard" that refused any bash command touching a public-IP
 * service unless the user's own message asked for it. It was a hard block
 * in the tool loop, and a hard block is the one thing this agent must not
 * have: the owner's rule is fully uncensored, no hardblocks, no
 * normal-AI safety layer between them and their own machine. Every tool
 * call now goes to the ordinary approval prompt, where the person who is
 * actually there decides.
 *
 * Kept: bare greetings ("yo", "hey") get a short conversational reply
 * instead of a full model turn. That is not a block on anything. It is
 * just a cheaper, faster answer to "hi" than spinning up a tool-enabled
 * model, which the small free models would answer by inventing a job for
 * themselves.
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
