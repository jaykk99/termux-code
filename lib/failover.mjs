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
 *   1. keyless + tool-capable first (Kilo, LLM7) — no key to exhaust, tools work
 *   2. keyed + tool-capable next — the paid/keyed pool
 *   3. chat-only models last (Gemini, Cohere, Horde) — the turn still gets an
 *      answer, just without tool calls
 *   4. disabled models are skipped entirely
 *   5. providers inside a cooldown (FailureTracker) drop to the back, so a
 *      provider that just 429'd three times in a row isn't tried first again
 *
 * The circuit breaker is per-process and in-memory: three consecutive
 * failures cool a provider down for ten minutes, then it becomes eligible
 * again automatically. This is deliberately simple — it resets on restart,
 * and it never persists anything that could go stale.
 */

import { capabilities } from './models.mjs';

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
    return provider === 'kilo' || provider === 'llm7' || provider === 'horde';
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
  }
}

/**
 * Order candidate models into a failover chain. Never mutates the input.
 * `tracker` is optional; without it, no cooldown demotion happens.
 */
export function buildFailoverPlan(models, tracker = null) {
  const rank = (m) => {
    if (m.disabled) return 99;
    const caps = capabilities(m);
    const keyless = m.auth === 'none' || m.auth === 'horde';
    if (caps.tools && keyless) return 0;
    if (caps.tools) return 1;
    if (keyless) return 2;
    return 3;
  };

  return [...models]
    .filter((m) => !m.disabled)
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
 * One entry in the honest attempt log. Every failed provider reports itself
 * here instead of vanishing into a generic "upstream error".
 */
export function makeAttempt({ provider, modelId, ok, latencyMs, error }) {
  return {
    provider,
    modelId,
    ok: !!ok,
    latencyMs: Math.round(latencyMs || 0),
    error: error ? String(error).slice(0, 300) : null,
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
 * Returns { model, reply, attempts } where attempts is the full log
 * (including the successful one). Throws FailoverError when every candidate
 * fails — the error carries the same attempts array, so the UI can show
 * exactly what happened instead of "something went wrong".
 *
 * Options:
 *   maxAttempts — cap how far down the chain we walk (default: whole chain)
 *   onAttempt   — called with each attempt as it lands, for live TUI updates
 */
export async function completeWithFailover(models, messages, completeFn, tracker = null, opts = {}) {
  const plan = buildFailoverPlan(models, tracker);
  const maxAttempts = opts.maxAttempts || plan.length;
  const attempts = [];
  let lastError = null;

  for (const model of plan.slice(0, maxAttempts)) {
    const started = Date.now();
    try {
      const reply = await completeFn(model, messages);
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
        error: err?.message,
      });
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      tracker?.recordFailure(model.provider);
    }
  }

  const error = new FailoverError(
    plan.length === 0
      ? 'No models available for failover.'
      : `All ${attempts.length} provider(s) failed. Last error: ${lastError?.message || 'unknown'}`,
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
