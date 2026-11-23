/**
 * Adaptive task effort. This is an observable execution policy, not a claim
 * to control a model's inaccessible internal chain of thought.
 *
 * System preferences are selected per user turn, never copied into a global
 * session prompt where they could spill into later unrelated requests.
 */
const COMPLEX = /\b(?:entire|whole|full[- ]stack|end[- ]to[- ]end|multi[- ](?:step|file|module)|many files|multiple files|architecture|migrate|rewrite|integrat(?:e|ion)|refactor|debug|fix all|all tests|production|deploy|research deeply|audit|complex|long[- ]running|autonomous)\b/i;
const CODE = /\b(?:repo|repository|project|code|program|application|app|website|backend|frontend|cli|function|script|module|feature|test|bug)\b/i;
const SIMPLE = /^(?:hi|hello|hey|thanks|thank you|yes|no|ok|okay|what is|define |explain |how do i |where is |list |tell me )/i;

export const EFFORT_MODES = ['auto','fast','balanced','deep'];

export function selectEffort(prompt, preference = 'auto') {
  if (!EFFORT_MODES.includes(preference)) throw new Error('Invalid effort mode');
  if (preference !== 'auto') return preference;
  const message = String(prompt || '').trim();
  if (COMPLEX.test(message) && (CODE.test(message) || message.length > 120)) return 'deep';
  if (CODE.test(message) || message.length > 180 || /https?:\/\//.test(message)) return 'balanced';
  if (SIMPLE.test(message) || message.length < 100) return 'fast';
  return 'balanced';
}

export function effortConfig(mode) {
  const configs = {
    fast: { maxAttempts: 2, maxRetryDelayMs: 800, transientRetries: 0, refusalRetry: false },
    balanced: { maxAttempts: 4, maxRetryDelayMs: 1500, transientRetries: 1, refusalRetry: false },
    deep: { maxAttempts: 7, maxRetryDelayMs: 2500, transientRetries: 1, refusalRetry: true },
  };
  return configs[mode] || configs.balanced;
}

export function effortInstruction(mode) {
  switch (mode) {
    case 'fast':
      return '[Execution mode: fast] Reply promptly. Use only the necessary tools. Do not spend a turn announcing a plan. Do not claim unexecuted work is complete.';
    case 'deep':
      return '[Execution mode: deep] Inspect the repository and relevant URLs, break the work into explicit dependent steps, implement all required modules, run checks, repair failures and report concrete evidence. Avoid repeated planning-only responses.';
    default:
      return '[Execution mode: balanced] Inspect relevant files, make a concise plan when useful, implement focused changes, and verify. Prefer acting over lengthy preambles.';
  }
}
