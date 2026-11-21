/**
 * The uncensored-only policy for termux-code — ONE place, owner-editable.
 *
 * Jay's order (2026-10-29): termux-code runs ONLY on uncensored models.
 * Aligned, RLHF-tuned models that refuse (GPT, Claude, Gemini and the
 * other aligned flagships) are not in the runnable pool and are not
 * shown in any model list — not as a fallback tier, not at all. Every
 * surface that lists, picks, resolves, or runs a model enforces this:
 * lib/models.mjs (directModels, the live Kilo/Gratisfy/error-inbox
 * lists, resolveModel) and lib/failover.mjs (buildFailoverPlan drops
 * non-uncensored candidates even if a caller hands them in).
 *
 * A model counts as uncensored-lineage when ANY of these hold:
 *   1. Its provider is a curated uncensored pool (POOL_PROVIDERS):
 *      `hf` is Jay's Inbox Models uncensored section, entry for entry
 *      (Heretic / abliterated builds only).
 *   2. Its id or label carries an uncensored-lineage marker
 *      (UNCENSORED_MARK): uncensored, heretic, abliterated, dolphin,
 *      stheno, rocinante, and the uncensored families Magnum, Mythomax,
 *      Euryale, Hermes, Miqu. This is how uncensored entries present in
 *      live provider lists (Kilo, Gratisfy, error-inbox's pool, Venice).
 *   3. Its exact "provider/id" is in UNCENSORED_ALLOWLIST below — for
 *      entries whose name carries no marker. The AI Horde dispatcher and
 *      the Bro gateway are entries today, plus Pollinations' GPT-OSS
 *      route (see the allowlist comments).
 *
 * TO ADD A MODEL: give it a marker-carrying id/label, add its provider
 * to POOL_PROVIDERS if the whole provider catalogue is an uncensored
 * pool, or add one line to UNCENSORED_ALLOWLIST, e.g.
 *   'venice/<the-exact-model-id>',
 * Nothing else needs to change — every list and the failover chain read
 * this file. TO REMOVE one, delete its line / marker match here.
 */

/** Model id / label markers of the uncensored lineage. */
export const UNCENSORED_MARK =
  /uncensored|heretic|abliterat|dolphin|stheno|rocinante|magnum|mythomax|euryale|hermes|miqu/i;

/** Providers whose whole catalogue here is a curated uncensored pool. */
export const UNCENSORED_POOL_PROVIDERS = new Set(['hf']);

/**
 * Exact "provider/id" entries that are uncensored routes despite a
 * marker-less name. Keep this list short and honest: an entry here is a
 * claim that the route serves uncensored models.
 */
export const UNCENSORED_ALLOWLIST = new Set([
  // AI Horde dispatcher: callHorde requests uncensored workers first
  // (Stheno/Heretic/Rocinante names) when any are online.
  'horde/any',
  // Bro gateway: Jay's own gateway serves uncensored models only (its
  // chain is Horde uncensored workers + local Dolphin), so the route
  // itself is the uncensored claim — same shape as 'horde/any'.
  'bro/bro',
  // Pollinations 'openai' route: serves GPT-OSS 20B, an open-weight model
  // (verified live 2026-11-20: text.pollinations.ai/models lists exactly
  // one model, openai-fast = GPT-OSS 20B via OVH), the same family as
  // Bro's ovh-gpt-oss-120b / llm7-gpt-oss-20b backends. Keyless, answers
  // in seconds. Jay approved it 2026-11-20 as the fast fallback when
  // Horde flakes; Horde stays the primary (see the default pick in
  // bin/termux-code.mjs).
  'pollinations/openai',
]);

/**
 * True when a model is uncensored-lineage under the policy above.
 * Accepts anything shaped like a model ({ id, provider, label }); null,
 * missing fields, and opaque router entries that can silently land on
 * an aligned model (kilo-auto, omniroute 'auto', a bare 'openai') are
 * NOT uncensored.
 */
export function isUncensoredModel(m) {
  if (!m || typeof m !== 'object') return false;
  if (UNCENSORED_POOL_PROVIDERS.has(m.provider)) return true;
  if (m.provider && m.id && UNCENSORED_ALLOWLIST.has(`${m.provider}/${m.id}`)) return true;
  return UNCENSORED_MARK.test(m.id || '') || UNCENSORED_MARK.test(m.label || '');
}
