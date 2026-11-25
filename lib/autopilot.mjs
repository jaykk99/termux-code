/**
 * Autopilot: one durable objective, many turns, a wall-clock budget, and an
 * explicit way for the model to say it is done. Modelled on the long-task
 * loop OpenClaw uses (goal + automatic continuation + stop rules) but kept
 * as pure helpers: bin/termux-code.mjs owns the turn loop, the tools and the
 * git commit, so this module stays testable without a model or a network.
 */

/** Default cap for `--autopilot` without `--for`. Long enough for a real
 *  refactor, short enough that a runaway loop on a phone has a ceiling. */
export const AUTOPILOT_DEFAULT_MS = 2 * 60 * 60 * 1000;
/** Hard ceiling on outer cycles. Even with a huge --for, this stops a loop
 *  that keeps producing turns without ever finishing or blocking. */
export const AUTOPILOT_MAX_CYCLES = 40;

const UNITS = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 });
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;

/**
 * Parse a human duration: `90s`, `30m`, `2h`, `1h30m`, `1.5h`.
 * A bare number means minutes (`--for 45` === 45m), which is the unit people
 * actually reach for when they say "work for 45".
 * @returns {number|null} milliseconds, or null when the text is not a duration
 */
export function parseDuration(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const minutes = Number(text);
    return minutes > 0 ? Math.round(minutes * UNITS.m) : null;
  }
  const compact = text.replace(/\s+/g, '');
  let total = 0;
  let at = 0;
  for (const part of compact.matchAll(DURATION_PART)) {
    // The whole string must be duration parts: `30minutes` or `1h then tea`
    // are rejected instead of silently becoming 30m / 1h.
    if (part.index !== at) return null;
    at += part[0].length;
    total += Number(part[1]) * UNITS[part[2]];
  }
  if (at !== compact.length || total <= 0) return null;
  return Math.round(total);
}

/** Milliseconds to `2h 5m` / `45m` / `90s`; used for logs, never for parsing. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds && !hours) parts.push(`${seconds}s`);
  return parts.join(' ') || '0s';
}

/**
 * The persistent goal instruction. It rides on the system prompt for the
 * whole run so every tool result the model reads back still carries the
 * stop rules; a note put only in the first user message scrolls out of
 * relevance after the first few steps.
 */
export const AUTOPILOT_NOTE = `

## Autopilot
You are running one long task across several turns. The user's objective is
the request that started this run; keep it in view for the entire run.
- Work in small, verified steps and keep going until the objective is met.
  Do not stop after one edit, one file or one passing check.
- Keep multi-part work in the todo tool and mark steps done as they land.
- Run the project's own checks after changes and fix what fails.
- When the objective is fully achieved and verified, end your reply with a
  line that says exactly: TASK COMPLETE
- If only the user can unblock you (a missing credential, permission or
  device), end your reply with: BLOCKED: <one-line reason>
- Never claim work you did not do.`;

/**
 * Detect a conversational time-boxed request in the REPL, so the user can say
 * "work on the parser for 30 minutes" instead of learning a flag. Deliberately
 * narrow: it needs an imperative work verb and an explicit `for <duration>`
 * with a unit, so "I worked on this for 3 hours" and "fix the parser" do not
 * silently become autonomous runs.
 * @returns {{budgetMs:number, durationText:string}|null}
 */
export function detectAutopilotRequest(text) {
  const value = String(text ?? '');
  if (!/\b(?:work|keep\s+working|keep\s+going|continue\s+working)\b/i.test(value)) return null;
  const match = value.match(
    /\bfor\s+((?:the\s+next\s+|another\s+)?\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s))?)/i
  );
  if (!match) return null;
  const normalized = match[1]
    .replace(/the\s+next\s+|another\s+/gi, '')
    .replace(/hours?|hrs?/gi, 'h')
    .replace(/minutes?|mins?/gi, 'm')
    .replace(/seconds?|secs?/gi, 's')
    .replace(/\s+/g, '');
  const budgetMs = parseDuration(normalized);
  return budgetMs ? { budgetMs, durationText: match[1].trim() } : null;
}

/** Add or remove the autopilot note (idempotent both ways). */
export function withAutopilotNote(system, on) {
  const base = String(system ?? '').split(AUTOPILOT_NOTE).join('');
  return on ? base + AUTOPILOT_NOTE : base;
}

/** True when the model's final reply carries the completion marker. */
export function isTaskComplete(text) {
  return /^\s*(?:\*\*|__)?\s*task[ _-]?complete\s*(?:\*\*|__)?\s*[.!]?\s*(?:\[\[)?\s*$/im.test(
    String(text ?? '')
  ) || /^\s*\[\[\s*task[ _-]?complete\s*\]\]\s*[.!]?\s*$/im.test(String(text ?? ''));
}

/** The one-line blocker reason from a final reply, or null. */
export function taskBlockedReason(text) {
  const match = String(text ?? '').match(
    /^\s*(?:\*\*|__)?\s*blocked\s*(?:\*\*|__)?\s*[:—-]\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/im
  );
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}

/**
 * The hidden nudge queued between cycles. It carries the remaining budget and
 * repeats the two stop markers, because the system note alone is easy for a
 * small model to skim past after a long tool result.
 */
export function autopilotContinuation({ cycle = 1, remainingMs = 0 } = {}) {
  return (
    `[Autopilot cycle ${cycle} · ${formatDuration(remainingMs)} remaining] ` +
    "Continue implementing the user's objective in this workspace. Do not repeat the plan or re-read files " +
    'you already know; take the next concrete step, run the relevant check, and repair any failure. ' +
    'If the whole objective is now complete and verified, end this reply with a line exactly: TASK COMPLETE. ' +
    'If something only the user can fix blocks you, end with: BLOCKED: <one-line reason>.'
  );
}

/**
 * Run cycles until the goal is complete, a blocker is reported, the budget is
 * spent, the cycle ceiling is hit, or a cycle returns nothing and made no
 * progress. `runCycle` owns all model/tool work and reports `{answer,
 * progressed}`; keeping it injected means the stop rules are testable with a
 * fake clock and no network.
 */
export async function runAutopilotLoop({
  budgetMs,
  runCycle,
  now = () => Date.now(),
  maxCycles = AUTOPILOT_MAX_CYCLES,
} = {}) {
  if (typeof runCycle !== 'function') throw new Error('runAutopilotLoop needs a runCycle function');
  const budget = Number(budgetMs);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Autopilot budget must be positive');

  const startedAt = now();
  const deadline = startedAt + budget;
  const cycles = [];
  let lastAnswer = null;
  let complete = false;
  let blocked = null;
  let reason = null;
  let error = null;

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      reason = 'budget';
      break;
    }
    let outcome;
    try {
      outcome = await runCycle({ cycle, remainingMs, startedAt, deadline });
    } catch (err) {
      error = err;
      reason = 'error';
      break;
    }
    const answer = typeof outcome?.answer === 'string' ? outcome.answer : null;
    const progressed = Boolean(outcome?.progressed);
    cycles.push({ cycle, remainingMs, answerChars: answer ? answer.length : 0, progressed });

    if (answer) {
      lastAnswer = answer;
      if (isTaskComplete(answer)) {
        complete = true;
        reason = 'complete';
        break;
      }
      const blocker = taskBlockedReason(answer);
      if (blocker) {
        blocked = blocker;
        reason = 'blocked';
        break;
      }
      // A normal reply is not proof of completion under autopilot: the loop
      // advances the same goal in the next cycle until the marker or the clock.
    } else if (!progressed) {
      // Failed provider turn with no new messages: continuing would just
      // repeat the same failure until the budget died. Hand it back.
      reason = 'stalled';
      break;
    }
  }

  if (!reason) reason = 'cycle-limit';
  return { startedAt, deadline, endedAt: now(), budgetMs: budget, cycles, lastAnswer, complete, blocked, reason, error };
}

/**
 * Commit subject for the work. One line, capped so `git log --oneline` stays
 * readable on a phone; the full objective is still in the session transcript.
 */
export function commitMessageFor(objective, { maxLength = 72 } = {}) {
  const first = String(objective ?? '').replace(/\s+/g, ' ').trim();
  const subject = first ? `termux-code: ${first}` : 'termux-code: autonomous run';
  if (subject.length <= maxLength) return subject;
  return subject.slice(0, maxLength - 1).trimEnd() + '…';
}
