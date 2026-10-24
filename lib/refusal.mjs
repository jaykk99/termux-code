/**
 * Refusal detection for termux-code.
 *
 * Ported from error-inbox's detector (lib/refusal.ts → isRefusalResponse,
 * originally lib/llm/refusal.ts in PR #116). error-inbox learned this the
 * hard way: when the skip was removed, a refusal from a lightly-filtered
 * backstop model reached the user verbatim instead of falling through to
 * the next model. termux-code shipped with the same hole — the failover
 * chain treated any completed reply as a success, refusal text included,
 * so the chain never walked. lib/failover.mjs imports this detector and
 * treats a refusal as a failed attempt.
 *
 * Why the patterns are shaped this way: real refusals almost never start
 * with the exact phrase — a model prefixes a sentence of preamble ("I
 * understand what you're asking, but I can't help with that", "Unfortunately,
 * as an AI, I'm not able to...") and the refusal slides straight past a
 * start-anchored pattern. So we scan the LEADING region of the reply (a
 * refusal is essentially always up front) against patterns that pair a
 * refusal verb with a help/assist/task object, plus the unmistakable
 * disclaimer phrasings. Bounding to the head keeps a long, genuinely
 * helpful answer that merely mentions "I can't reproduce this bug" deep
 * in its body from being misread as a refusal.
 */

const REFUSAL_PATTERNS = [
  // "I'm sorry, but ..." — the classic refusal preface. Sorry alone is not
  // enough (an answer can open "I'm sorry, I forgot to mention ..." and
  // go on to be fully helpful), so this needs the "but" pivot...
  /\bi'?m (really |very |so )?sorry,?\s*but\b/i,
  // ...or "I'm sorry, I <refusal modal> ..." ("I'm sorry, I won't be able
  // to complete that request").
  /\bi'?m (really |very |so )?sorry,?\s+i\s+(?:can'?t|cannot|can ?not|won'?t|will not|am unable|am not able|am not willing|am not comfortable|must decline|have to decline)\b/i,
  // "I('m) (can't/cannot/won't/unable/not able/not going/not willing/not
  // comfortable) (to) (be able to) <help|assist|provide|create|write|
  // generate|comply/...>". "help" carries a negative lookahead: the idiom
  // "I can't help but notice ..." is an observation, not a refusal.
  /\bi(?:'?m| am)?\s+(?:can'?t|cannot|can ?not|won'?t|will not|am unable|unable|am not able|am not going|am not willing|am not comfortable)\s+(?:to\s+)?(?:be able to\s+)?(?:help(?!\s+but\b)|assist|provide|comply|create|write|generate|produce|continue|do that|fulfil|fulfill|support|engage|participate|answer that)/i,
  // "I can't/cannot help you with that/this".
  /\bi (?:can'?t|cannot|can ?not) (?:help|assist) (?:you )?with (?:that|this)/i,
  // "as an AI ... can't/cannot/unable/won't" (the disclaimer-then-refusal combo).
  /\bas an ai\b[^.?!]{0,60}\b(?:can'?t|cannot|unable|not able|won'?t|will not)\b/i,
  // "I must/have to/will have to decline".
  /\bi (?:must|have to|will have to|am going to have to) decline\b/i,
  // "I cannot and will not ..." and hard "cannot comply/fulfill/assist".
  /\bi cannot (?:and will not|comply|fulfil|fulfill|assist|help|provide|create)/i,
  // "against/violates my/our/the [safety|content] guidelines|policy|
  // principles|programming". "principles of <topic>" is rhetorical essay
  // usage ("against my principles of clean code, I'd still ship it"), so
  // principles only counts when it isn't qualified that way.
  /\b(?:against|violates?|contrary to|would violate) (?:my|our|the) (?:safety |content |community |usage )?(?:guidelines|policy|policies|principles(?!\s+of\b)|programming|content policy|values)\b/i,
  // "I don't feel comfortable <generating|creating|helping|...>". Bare
  // "feel comfortable" is not enough: "I don't feel comfortable merging
  // this without tests" is engineering judgment, not a refusal.
  /\bi (?:do not|don'?t) feel comfortable\s+(?:generating|creating|writing|helping|providing|producing|continuing|doing that|with that|with this)/i,
  // "I don't think it's appropriate (for me) to <task verb>". The verb is
  // required: "I don't think it's appropriate to use a global here" is a
  // code review, not a refusal.
  /\bi (?:do not|don'?t) think (?:it'?s|that'?s|it is) appropriate\s+(?:for (?:me|an ai) )?to\s+(?:help|assist|provide|create|write|generate|produce|comply|continue|do)\b/i,
  // "I'm not comfortable <helping|generating|...> / to <task verb>".
  /\bi(?:'?m| am) not comfortable\s+(?:generating|creating|writing|helping|providing|producing|continuing|doing|to\s+(?:help|assist|provide|create|write|generate))/i,
  // "I'm not going/able/willing to <task>" (redundant safety net).
  /\bi'?m not (?:able|going|willing)\s+to\b[^.?!]{0,40}\b(?:help|assist|provide|create|write|generate|comply|continue|do)\b/i,
  // "I can't provide/assist with/help with that" (the original, un-anchored).
  /\bi (?:can'?t|cannot) (?:provide|assist with|help with) that\b/i,
  // "I do not provide assistance/help with that/this ..." (flat statement form).
  /\bi (?:do not|don'?t) (?:provide|offer)\s+(?:assistance|help|support|information)?\s*(?:with|for|on) (?:that|this|requests?)\b/i,
  // "My guidelines/policy don't allow me to ..." (rule-citing form).
  /\bmy (?:guidelines|policies|policy|programming) (?:don'?t|do not|does not|doesn'?t|won'?t|will not) allow\b/i,
  // "I'm not allowed/permitted to <task verb>".
  /\bi(?:'?m| am) not (?:allowed|permitted) to\s+(?:help|assist|provide|create|write|generate|discuss|share)/i,
  // "I don't think I can <help|assist|do that|...>" (hedged refusal).
  /\bi (?:do not|don'?t) think i (?:can|could)\b[^.?!]{0,40}\b(?:help|assist|provide|do that|comply)\b/i,
  // --- Added 2026-10-24 (follow-up audit): refusal phrasings the set above
  // missed outright, so the chain stopped at the first model and surfaced
  // the refusal instead of walking to a model that would answer. Each is
  // guarded to a refusal-shaped object so near-miss legit answers still
  // pass (see tests): "refuse to" needs a task verb (not "refuse to
  // merge"), "not something I can help with" excludes "...with alone",
  // "can't do this" needs a sentence end / "for you" / "because" (not
  // "do this alone" or "do this justice"), and the bare "Unable to ..."
  // fragment must be sentence-initial with a bare demonstrative object
  // (not "Unable to comply with that approach — use X instead").
  // "I refuse to <task verb>".
  /\bi refuse to (?:help|assist|provide|create|write|generate|produce|comply|discuss|share|do that|do this|participate|engage)\b/i,
  // "That's not something I can help with" / "not something I can do".
  /\bnot something i (?:can|could) (?:help|assist) with(?!\s+alone\b)/i,
  /\bnot something i (?:can|could) do(?!\s+alone\b)/i,
  // "I can't do this." / "I cannot do this for you" / "...because ...".
  /\bi (?:can'?t|cannot) do this(?: for you)?(?:\s*[.!]|\s+because\b|$)/i,
  // Sentence-initial "Unable to comply/help with this request." (a
  // provider-style fragment with no subject at all).
  /^\s*(?:unfortunately,?\s*)?unable to (?:comply|help|assist|provide|fulfil|fulfill|generate|create|discuss|share)(?: with (?:this|that|this request|that request))?[.!]/i,
  // "I'm not in a position to <task verb>".
  /\bi(?:'?m| am)? not in a position to (?:help|assist|provide|create|write|generate|comply|discuss|share|do)\b/i,
  // "My safety guidelines prohibit / my programming prevents ...".
  /\bmy (?:safety |content )?(?:guidelines|policies|policy|programming)\b[^.?!]{0,40}\b(?:prohibits?|prevents?|forbids?|bars?)\b/i,
  // "I won't be doing that".
  /\bi (?:won'?t|will not) be (?:doing|providing|generating|creating) (?:that|this)\b/i,
  // "I can't show/share/tell you that" — the object must end the clause,
  // so "I can't share that file until Friday, but here's the draft" (a
  // partial answer, not a refusal) still passes.
  /\bi (?:can'?t|cannot) (?:show|share|tell) (?:you )?(?:that|this|it)(?=\s*[.!?,;:]|\s*$)/i,
  // "I don't provide <help|instructions|...> for/on that" (demonstrative
  // object required: "I don't provide legal advice" with no object, or
  // "...for making X", stays a pass).
  /\bi (?:do not|don'?t) provide (?:assistance|help|support|information|instructions|guidance|advice)\s+(?:with|for|on) (?:that|this|such|it)\b/i,
  // Bare "Sorry, can't help with that" (no "I'm" lead-in). The help
  // lookaheads keep "Sorry, can't help but notice ..." an observation.
  /\bsorry,?\s+(?:i\s+)?can'?t (?:help(?!\s+but\b)(?!\s+notic\w*\b)|assist|provide|do that|generate|create)\b/i,
];

/**
 * A reply that is short enough to be scanned whole and ENDS on a bare
 * "I can't / I cannot" ("As much as I'd like to help, I can't.") is a
 * refusal with the object left implicit. Only applied to short replies:
 * in a long answer the same trailing words can be one scoped limitation
 * among many real answers.
 */
const TRAILING_BARE_REFUSAL = /\bi (?:can'?t|cannot)\.?\s*$/i;

/** How much of the reply's head to scan — roughly the first two sentences. */
export const REFUSAL_HEAD_CHARS = 320;

/**
 * True when the reply is a model refusal / guardrail disclaimer rather
 * than a real answer. Scans only the leading region so a genuinely
 * helpful answer that mentions a limitation deep in its body isn't
 * misclassified.
 */
export function isRefusalResponse(text) {
  if (!text) return false;
  const norm = String(text).trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const head = norm.slice(0, REFUSAL_HEAD_CHARS);
  if (REFUSAL_PATTERNS.some((p) => p.test(head))) return true;
  if (norm.length <= REFUSAL_HEAD_CHARS && TRAILING_BARE_REFUSAL.test(norm)) return true;
  return false;
}

/**
 * True when a completion reply is a refusal. Two signals:
 *   - the provider said so outright (reply.refused — e.g. Anthropic's
 *     stop_reason: 'refusal', flagged in lib/agent.mjs), or
 *   - the reply has no tool calls and its text reads as a refusal.
 * A reply carrying tool calls is a model at work, never a refusal, even
 * if its text contains a sorry-sounding aside.
 */
export function isRefusalReply(reply) {
  if (!reply) return false;
  if (reply.refused === true) return true;
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) return false;
  return isRefusalResponse(reply.text || '');
}

/**
 * True when a reply carries no answer at all: no tool calls and blank,
 * whitespace-only, or missing text. This is NOT a refusal — it is a
 * provider-side block that came back empty (e.g. Gemini returning zero
 * candidates on a safety block, or an OpenAI-shaped reply with null
 * content). lib/failover.mjs and the hosted chat's preferred leg treat
 * it as a failed attempt (error 'empty reply') so the chain walks on,
 * instead of surfacing a blank turn as a success. Kept separate from
 * isRefusalReply so the attempts log stays honest about what happened.
 */
export function isBlankReply(reply) {
  if (!reply) return true;
  if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) return false;
  return !String(reply.text ?? '').trim();
}
