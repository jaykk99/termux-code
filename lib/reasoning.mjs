/**
 * Observable adaptive execution policy for the Termux CLI.
 * Pure, deterministic and model-independent; does not claim to change
 * an LLM's private reasoning. Never embeds credentials or a user prompt.
 */
export const REASONING_MODES = Object.freeze(['adaptive', 'fast', 'balanced', 'deep']);
const START = '\n\n<!-- termux-code:reasoning:start -->\n';
const END = '\n<!-- termux-code:reasoning:end -->';

// Short defensive local reviews still require several independent checks.
// Do not use this classification to escalate remote assessments or access.
export function isLocalDefensiveReview(prompt) {
  const text = String(prompt ?? '');
  return /\b(?:my|our|this|local|current)\s+(?:local\s+)?(?:repo(?:sitory)?|codebase|workspace|source code|dependencies|project)\b/i.test(text)
    && /\b(?:audit|review|check|inspect|scan|test)\b/i.test(text)
    && /\b(?:security|vulnerabilit(?:y|ies)|secrets|permissions|dependencies|misconfigurations|hardening)\b/i.test(text)
    && !/https?:\/\/|\b(?:remote|external|third.party|hack|exploit|pentest|penetration)\b/i.test(text);
}

export function chooseEffort(prompt, mode = 'adaptive') {
  if (!REASONING_MODES.includes(mode)) throw new Error('Unknown reasoning mode');
  if (mode !== 'adaptive') return mode;
  const text = String(prompt ?? '').trim();
  if (!text) return 'fast';
  if (isLocalDefensiveReview(text)) return 'deep';
  const words = text.split(/\s+/).length;
  const deep = /\b(entire|architecture|refactor|migrat(?:e|ion)|security|audit|investigat|across (?:all|multiple)|multiple files|end.to.end|production|deploy|race condition)\b/i;
  const moderate = /\b(fix|implement|build|create|add|change|update|debug|test|review|write|integrat|optimi[sz]|install|configure)\b/i;
  // A long or multi-part request is more likely to require coordination.
  if (deep.test(text) || words >= 65 || (words >= 30 && moderate.test(text))) return 'deep';
  if (moderate.test(text) || words >= 16 || /\n\s*[-*0-9]/.test(text)) return 'balanced';
  return 'fast';
}

export function reasoningPolicy(prompt, mode = 'adaptive', maxSteps = 40) {
  const effort = chooseEffort(prompt, mode);
  const caps = { fast: 8, balanced: 24, deep: 40 };
  const checks = { fast: 1, balanced: 2, deep: 3 };
  return {
    mode, effort, maxSteps: Math.min(maxSteps, caps[effort]),
    maxVerifyAttempts: checks[effort],
  };
}

/** Replace, rather than accumulate, the previous turn's guidance. */
export function withReasoningNote(system, effort) {
  const base = String(system ?? '').replace(
    /\n\n<!-- termux-code:reasoning:start -->\n[\s\S]*?\n<!-- termux-code:reasoning:end -->/g, '',
  );
  const instruction = {
    fast: 'Answer or perform the requested small task directly. Use tools only when needed. Verify any edits.',
    balanced: 'Inspect relevant code first, outline a short plan if needed, implement focused changes, and run relevant checks. State what was actually verified.',
    deep: 'Inspect dependencies and evidence, plan milestones, implement incrementally, run tests, review your own diff for regressions, and report remaining uncertainty. Do not claim tests passed without outputs.',
  }[effort];
  if (!instruction) throw new Error('Unknown effort');
  return base + START + '## Execution effort: ' + effort + '\n' + instruction + END;
}
