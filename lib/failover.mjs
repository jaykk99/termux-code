/**
 * Provider failover chain for termux-code.
 *
 * Free-tier providers flap: a 429, a 502, or a 45s hang is routine. Before
 * this module, one failing provider ended the turn with a red box. Now the
 * CLI and the gateway build an ordered chain of candidate models and walk
 * it until one answers, collecting an honest attempt record along the way
 * (provider, model, latency, and the exact error that knocked it out).
 *
 * Ordering policy (buildFailoverPlan):
 *   0. uncensored-lineage models ONLY (see lib/uncensored.mjs) — aligned
 *      models are not a fallback tier, they are dropped from the plan
 *      entirely, so the chain can never run one even if a caller hands
 *      it in. Within the uncensored pool:
 *   1. keyless + tool-capable first — no key to exhaust, tools work
 *   2. keyed + tool-capable next — the paid/keyed pool
 *   3. chat-only models last — the turn still gets an answer, just
 *      without tool calls
 *   4. disabled models are skipped entirely
 *   5. providers inside a cooldown (FailureTracker) drop to the back, so a
 *      provider that just 429'd three times in a row isn't tried first again
 *   6. a model the provider rejected as unknown (BAD_MODEL) is
 *      blacklisted for the session after the first rejection — it is
 *      never retried turn after turn (a stale hardcoded id used to burn
 *      a call on every candidate walk, and each bad attempt counted
 *      against the OTHER providers' rate limits)
 *
 * The circuit breaker is per-process and in-memory: three consecutive
 * failures cool a provider down for ten minutes, then it becomes eligible
 * again automatically. This is deliberately simple — it resets on restart,
 * and it never persists anything that could go stale.
 */

import { capabilities } from './models.mjs';
import { isRefusalReply, isBlankReply } from './refusal.mjs';
import { UNCENSORED_MARK, isUncensoredModel } from './uncensored.mjs';

export { UNCENSORED_MARK, isUncensoredModel };

export const COOLDOWN_MS = 10 * 60 * 1000;
export const FAILURES_TO_TRIP = 3;

/**
 * In-memory per-provider circuit breaker.
 *
 * Keys are provider names (e.g. 'kilo'), which is the right granularity:
 * a rate limit hits the whole provider, not one model on it.
 */
export class FailureTracker {
  constructor({ now = Date.now, cooldownMs = COOLDOWN_MS } = {}) {
    this.now = now;
    this.cooldownMs = cooldownMs;
    this.state = new Map(); // provider -> { failures, cooledUntil }
  }

  /** Keyless providers never need a key, so they trip on errors, not 401s. */
  isKeyless(provider) {
    return provider === 'kilo' || provider === 'llm7' || provider === 'horde' || provider === 'hf';
  }

  recordFailure(provider) {
    const s = this.state.get(provider) || { failures: 0, cooledUntil: 0 };
    s.failures += 1;
    if (s.failures >= FAILURES_TO_TRIP && s.cooledUntil <= this.now()) {
      s.cooledUntil = this.now() + this.cooldownMs;
    }
    this.state.set(provider, s);
    return s;
  }

  recordSuccess(provider) {
    this.state.delete(provider);
  }

  isCoolingDown(provider) {
    const s = this.state.get(provider);
    if (!s) return false;
    if (s.cooledUntil <= this.now()) {
      // Cooldown expired. Keep the failure count though: if the provider
      // fails again right away it trips again immediately instead of needing
      // three fresh failures. Clear the flag so it reads clean below.
      s.cooledUntil = 0;
      this.state.set(provider, s);
      return false;
    }
    return true;
  }

  failures(provider) {
    return this.state.get(provider)?.failures || 0;
  }

  /**
   * Session blacklist of models a provider rejected as unknown
   * (BAD_MODEL / "Unknown model"). Keyed "provider/id": the rejection
   * is about that exact model id on that provider, not the provider —
   * a bad model must NOT trip the provider's circuit breaker, or one
   * stale id would cool down every good model behind it.
   */
  recordBadModel(provider, modelId) {
    if (!this.badModels) this.badModels = new Set();
    this.badModels.add(`${provider}/${modelId}`);
  }

  isBadModel(provider, modelId) {
    return !!this.badModels?.has(`${provider}/${modelId}`);
  }

  badModelList() {
    return [...(this.badModels || [])];
  }

  /** Honest status for /failover or the web console: provider -> state. */
  summary() {
    const out = [];
    for (const [provider, s] of this.state) {
      out.push({
        provider,
        failures: s.failures,
        coolingDown: s.cooledUntil > this.now(),
        coolsDownInMs: Math.max(0, s.cooledUntil - this.now()),
      });
    }
    return out;
  }

  reset() {
    this.state.clear();
    if (this.badModels) this.badModels.clear();
  }
}

/**
 * Order candidate models into a failover chain. Never mutates the input.
 * `tracker` is optional; without it, no cooldown demotion happens.
 *
 * The plan is uncensored-only (lib/uncensored.mjs): a candidate that is
 * not uncensored-lineage never enters the chain, whatever list it came
 * from — the gateway catalogue, a live provider list, or a caller's own
 * array. Disabled models and session-blacklisted BAD_MODELs are also
 * excluded here, so every walker inherits both rules.
 */
export function buildFailoverPlan(models, tracker = null) {
  const rank = (m) => {
    const caps = capabilities(m);
    const keyless = m.auth === 'none' || m.auth === 'horde';
    if (caps.tools && keyless) return 0;
    if (caps.tools) return 1;
    if (keyless) return 2;
    return 3;
  };

  return [...models]
    .filter((m) => !m.disabled && isUncensoredModel(m) && !tracker?.isBadModel(m.provider, m.id))
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      const ca = tracker?.isCoolingDown(a.provider) ? 1 : 0;
      const cb = tracker?.isCoolingDown(b.provider) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      // Free models first within a tier: nothing to lose by trying them.
      if (!!a.free !== !!b.free) return a.free ? -1 : 1;
      return 0;
    });
}

/**
 * Render any thrown value as readable one-line text, never "[object Object]".
 * Strings pass through; Errors render via their message (recursing when a
 * message was itself clobbered with an object); plain objects — a parsed
 * JSON error body, a thrown response object — render as JSON; anything else
 * falls back to String(). Circular objects degrade to String() too.
 * Callers truncate; this function does not.
 */
export function renderError(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const m = error.message;
    return typeof m === 'string' ? m : renderError(m);
  }
  try {
    const json = JSON.stringify(error);
    return json === undefined ? String(error) : json;
  } catch {
    return String(error);
  }
}

/**
 * One entry in the honest attempt log. Every failed provider reports itself
 * here instead of vanishing into a generic "upstream error".
 */
export function makeAttempt({ provider, modelId, ok, latencyMs, error }) {
  return {
    provider,
    modelId,
    ok: !!ok,
    latencyMs: Math.round(latencyMs || 0),
    error: error ? renderError(error).slice(0, 300) : null,
    at: new Date().toISOString(),
  };
}

/**
 * Walk the failover plan until a provider answers.
 *
 * completeFn(model, messages) is the per-model completion call — usually
 * complete() from lib/agent.mjs, or the gateway POST in the CLI. It must
 * return { text, toolCalls, assistantMessage } or throw.
 *
 * A completed call is not automatically a success: a model that answers
 * with a refusal ("I'm sorry, but I can't help with that") has not
 * answered at all, so a refusal counts as a FAILED attempt and the chain
 * walks on to the next candidate (see lib/refusal.mjs). A refusal is only
 * surfaced to the user when every candidate refused — in that case the
 * last refusal is returned as the reply instead of a FailoverError, since
 * "every model declined" is the honest answer. If any candidate failed
 * with a transport error, FailoverError is thrown as before and the
 * attempts log shows each refusal as `refused: ...`.
 *
 * Returns { model, reply, attempts } where attempts is the full log
 * (including the successful one). Throws FailoverError when every candidate
 * fails — the error carries the same attempts array, so the UI can show
 * exactly what happened instead of "something went wrong".
 *
 * Options:
 *   maxAttempts — cap how far down the chain we walk (default: whole chain)
 *   onAttempt   — called with each attempt as it lands, for live TUI updates
 *   sessionBadModels — a caller-owned Set of "provider/id" keys rejected
 *     as unknown models earlier in the session. Entries are skipped
 *     without a call, and new BAD_MODEL rejections are added to it (as
 *     well as to the tracker's own blacklist), so a long-lived caller
 *     like the CLI keeps the blacklist even across fresh trackers.
 *
 * A thrown error with `terminal === true` is an auth/configuration failure
 * (the gateway rejecting the token, say), not a provider outage: walking
 * the rest of the chain would just repeat the same failure, so the chain
 * stops at once and the original error is rethrown instead of a
 * FailoverError, so the caller can show the fix instead of a wall of
 * identical failures.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * True when an error looks transient: a rate limit, a 502/503/504, a
 * timeout, or a dropped connection. These are worth one retry on the same
 * model before the chain moves on — free tiers flap constantly, and a
 * single 429 must not cost a whole provider. Auth errors, bad requests,
 * unknown models, and terminal errors are NOT transient and never retry.
 */
export function isTransientError(err) {
  const msg = renderError(err).toLowerCase();
  return /429|too many requests|rate limit|rate_limit|502|503|504|timed? ?out|econnreset|etimedout|eai_again|socket hang up|fetch failed|network error|connection reset|connection refused/.test(msg);
}

/**
 * True when the provider rejected the MODEL itself as unknown — Kilo's
 * BAD_MODEL ("Unknown model. Pick one from /api/models."), OpenAI-shaped
 * model_not_found, "invalid model", and friends. This is a stale-id
 * problem, not an outage: the model goes on the session blacklist after
 * the first rejection and the chain never burns another call on it.
 * Deliberately narrow — a bare "not found" (a 404 on a URL, a missing
 * file) is not a bad-model rejection.
 */
export function isBadModelError(err) {
  const msg = renderError(err);
  if (/BAD_MODEL|model_not_found/i.test(msg)) return true;
  return /unknown model|invalid model|model .{0,40}(not found|does not exist|is not available|unavailable)/i.test(msg);
}

/**
 * The wait a rate-limited provider asked for, in milliseconds — from a
 * Retry-After header value quoted in the error body ("retry-after: 30"),
 * or phrasing like "try again in 30s" / "wait 2 minutes". Null when the
 * error carries no usable hint. LLM7's 429 quoted a ~1324s cooldown;
 * that parses here as-is — callers cap how long they will actually
 * sleep (see MAX_BACKOFF_MS) and let the circuit breaker park the
 * provider for the rest instead of stalling the turn.
 */
export function parseRetryAfterMs(err) {
  const msg = renderError(err);
  let m = /retry[- ]after["']?\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)?/i.exec(msg);
  if (!m) m = /(?:try again|retry|wait|available again|cooldown(?:\s*of)?)\D{0,20}?(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)\b/i.exec(msg);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 'ms' ? 1 : unit.startsWith('m') ? 60_000 : 1000;
  return Math.round(n * mult);
}

/**
 * The longest the chain will actually sleep on a provider's say-so.
 * Short waits (Pollinations' 30s-per-IP 402, a 5s 429) are worth
 * honouring so the next attempt isn't burned too; a 22-minute cooldown
 * is not a sleep, it's a parking — the FailureTracker handles those.
 */
export const MAX_BACKOFF_MS = 30_000;

/**
 * Call completeFn once, retrying a single time after a short delay when
 * the failure is transient. The delay honours the provider's own
 * retry-after when it gave one (capped at MAX_BACKOFF_MS), instead of
 * hammering straight back into the limit that just fired. Terminal
 * errors rethrow at once, and a BAD_MODEL rejection never retries —
 * the model is unknown, a second call would fail identically.
 */
export async function callWithTransientRetry(model, messages, completeFn) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      return await completeFn(model, messages);
    } catch (err) {
      if (err && err.terminal) throw err;
      lastErr = err;
      if (i === 0 && isTransientError(err)) {
        const hinted = parseRetryAfterMs(err);
        await sleep(hinted ? Math.min(Math.max(hinted, 1000), MAX_BACKOFF_MS) : 3000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function completeWithFailover(models, messages, completeFn, tracker = null, opts = {}) {
  let plan = buildFailoverPlan(models, tracker);
  if (opts.sessionBadModels?.size) {
    plan = plan.filter((m) => !opts.sessionBadModels.has(`${m.provider}/${m.id}`));
  }
  // The caller's chosen model goes first: /model must actually mean
  // something, so a pinned model jumps the rank order instead of the
  // chain re-sorting it to the back (that used to make /model horde
  // still try Kilo first).
  if (opts.pinFirst) {
    const idx = plan.findIndex((m) => m.id === opts.pinFirst.id && m.provider === opts.pinFirst.provider);
    if (idx > 0) {
      const [pinned] = plan.splice(idx, 1);
      plan.unshift(pinned);
    }
  }
  const maxAttempts = opts.maxAttempts || plan.length;
  const attempts = [];
  let lastError = null;
  let refusals = 0;
  let lastRefusal = null;

  for (const model of plan.slice(0, maxAttempts)) {
    const started = Date.now();
    try {
      const reply = await callWithTransientRetry(model, messages, completeFn);
      // A blank reply is a failed attempt, not an answer: a provider-side
      // filter that returns empty text must walk the chain exactly like
      // a refusal does, or the user gets a blank turn while a later
      // model would have answered. Blank attempts are NOT counted in
      // `refusals`, so an all-blank chain throws FailoverError (an
      // outage with an honest attempts log) rather than returning
      // blank text as if it were a reply.
      if (!isRefusalReply(reply) && isBlankReply(reply)) {
        const attempt = makeAttempt({
          provider: model.provider,
          modelId: model.id,
          ok: false,
          latencyMs: Date.now() - started,
          error: 'empty reply',
        });
        attempts.push(attempt);
        opts.onAttempt?.(attempt);
        tracker?.recordFailure(model.provider);
        continue;
      }
      if (isRefusalReply(reply)) {
        refusals += 1;
        lastRefusal = { model, reply };
        const snippet = String(reply?.text || 'declined').replace(/\s+/g, ' ').trim().slice(0, 80);
        const attempt = makeAttempt({
          provider: model.provider,
          modelId: model.id,
          ok: false,
          latencyMs: Date.now() - started,
          error: `refused: ${snippet}`,
        });
        attempts.push(attempt);
        opts.onAttempt?.(attempt);
        tracker?.recordFailure(model.provider);
        continue;
      }
      const attempt = makeAttempt({
        provider: model.provider,
        modelId: model.id,
        ok: true,
        latencyMs: Date.now() - started,
      });
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      tracker?.recordSuccess(model.provider);
      return { model, reply, attempts };
    } catch (err) {
      lastError = err;
      const attempt = makeAttempt({
        provider: model.provider,
        modelId: model.id,
        ok: false,
        latencyMs: Date.now() - started,
        error: err,
      });
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      if (isBadModelError(err)) {
        // The provider rejected this model id itself (stale hardcoded
        // id, delisted model). Blacklist it for the session — later
        // turns skip it without spending a call — and do NOT count it
        // against the provider's circuit breaker: the provider is
        // fine, the id is dead, and tripping the provider would park
        // every good model behind it too.
        tracker?.recordBadModel(model.provider, model.id);
        opts.sessionBadModels?.add(`${model.provider}/${model.id}`);
      } else {
        tracker?.recordFailure(model.provider);
        // A rate limit carrying a retry-after is a pacing instruction,
        // not just a failure. Honour a short one before the next
        // candidate instead of hammering on: the tightest limits here
        // are per-IP (Pollinations allows one reply per 30s per IP,
        // LLM7 429s per IP), so the next candidate can be under the
        // same cap even on a different provider. Long hints are capped
        // — the circuit breaker parks that provider, the turn moves on.
        const hinted = parseRetryAfterMs(err);
        if (hinted && attempts.length < Math.min(plan.length, maxAttempts)) {
          await sleep(Math.min(hinted, MAX_BACKOFF_MS));
        }
      }
      // Terminal errors (auth/config) must not walk the chain: every
      // remaining candidate would fail identically, and the user needs
      // the fix, not twenty copies of the same failure.
      if (err && err.terminal) throw err;
    }
  }

  // Every candidate refused and nothing failed on the wire: return the
  // last refusal as the reply. It's honest (no provider would answer)
  // and beats a red error box for what is a policy answer, not an outage.
  if (lastRefusal && refusals === attempts.length) {
    return { model: lastRefusal.model, reply: lastRefusal.reply, attempts };
  }

  const error = new FailoverError(
    plan.length === 0
      ? 'No models available for failover.'
      : `All ${attempts.length} provider(s) failed. Last error: ${renderError(lastError) || 'unknown'}`,
    attempts
  );
  throw error;
}

export class FailoverError extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'FailoverError';
    this.attempts = attempts;
  }
}

/**
 * Why a gateway failure falls back to the keyless direct chain instead of
 * ending the turn. Two cases, and only these two:
 *   - 'terminal': the gateway rejected the token (auth/config). Every
 *     model would fail identically through the same gate.
 *   - 'failover': every provider failed THROUGH the gateway (dead host,
 *     paused deployment, gateway outage). The providers themselves may
 *     be fine — the gateway path is what broke, so the direct chain
 *     still deserves a try. Without this, a dead gateway prints
 *     "failover exhausted" while a working route exists.
 * Anything else (including a lone transport error that never became a
 * FailoverError) returns null and is rethrown unchanged. A refusal is
 * never an error here: completeWithFailover returns the last refusal as
 * a reply, so it never reaches this decision.
 */
export function gatewayFallbackReason(err) {
  if (!err) return null;
  if (err.terminal) return 'terminal';
  if (err instanceof FailoverError) return 'failover';
  return null;
}

/**
 * One-line-per-attempt status for the TUI. Green check for the winner,
 * red crosses for the failures with their errors — no silent skipping.
 */
export function formatAttempts(attempts) {
  return attempts.map((a) => {
    const mark = a.ok ? 'ok' : 'fail';
    const ms = `${a.latencyMs}ms`;
    const tail = a.ok ? '' : ` — ${a.error || 'unknown error'}`;
    return `[${mark}] ${a.provider}/${a.modelId} ${ms}${tail}`;
  });
}
