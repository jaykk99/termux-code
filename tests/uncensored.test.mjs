/**
 * Tests for lib/uncensored.mjs — the one owner-editable policy that
 * decides which models termux-code may list or run at all.
 * Run: node --test tests/
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUncensoredModel, UNCENSORED_ALLOWLIST, UNCENSORED_POOL_PROVIDERS } from '../lib/uncensored.mjs';

describe('isUncensoredModel()', () => {
  it('accepts the curated hf pool by provider, entry for entry', () => {
    assert.ok(UNCENSORED_POOL_PROVIDERS.has('hf'));
    assert.equal(isUncensoredModel({ id: '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF', provider: 'hf' }), true);
    assert.equal(isUncensoredModel({ id: 'someone/Swapped-Model-GGUF', provider: 'hf' }), true);
  });

  it('accepts marker-carrying ids and labels from any provider', () => {
    assert.equal(isUncensoredModel({ id: 'lab/dolphin-3:free', provider: 'kilo' }), true);
    assert.equal(isUncensoredModel({ id: 'venice/venice-uncensored', provider: 'venice' }), true);
    assert.equal(isUncensoredModel({ id: 'koboldcpp/L3-8B-Stheno-v3.2', provider: 'horde' }), true);
    assert.equal(isUncensoredModel({ id: 'koboldcpp/Llama-3-8B-Rocinante', provider: 'horde' }), true);
    assert.equal(isUncensoredModel({ id: 'x/y', provider: 'gratisfy', label: 'Y Heretic build' }), true);
    assert.equal(isUncensoredModel({ id: 'DavidAU/OpenAi-GPT-oss-20b-abliterated-uncensored-NEO', provider: 'hf' }), true);
  });

  it('accepts the AI Horde dispatcher via the allowlist', () => {
    assert.ok(UNCENSORED_ALLOWLIST.has('horde/any'));
    assert.equal(isUncensoredModel({ id: 'any', provider: 'horde', label: 'Any available worker (slow, last resort)' }), true);
  });

  it('rejects aligned flagships and aligned routes', () => {
    assert.equal(isUncensoredModel({ id: 'openai/gpt-4o-mini', provider: 'githubmodels' }), false);
    assert.equal(isUncensoredModel({ id: 'claude-opus-5', provider: 'anthropic', label: 'Claude (heavy tier)' }), false);
    assert.equal(isUncensoredModel({ id: 'gemini-2.5-flash', provider: 'gemini' }), false);
    assert.equal(isUncensoredModel({ id: 'Meta-Llama-3.3-70B-Instruct', provider: 'sambanova', label: 'Llama 3.3 70B' }), false);
    assert.equal(isUncensoredModel({ id: 'codestral-latest', provider: 'llm7', label: 'Codestral (best keyless model)' }), false);
    assert.equal(isUncensoredModel({ id: 'openai', provider: 'pollinations', label: 'Pollinations OpenAI (keyless)' }), false);
  });

  it('rejects opaque routers that can silently land on an aligned model', () => {
    assert.equal(isUncensoredModel({ id: 'kilo-auto/free', provider: 'kilo', label: 'Kilo Auto (routes to best free model)' }), false);
    assert.equal(isUncensoredModel({ id: 'auto', provider: 'omniroute', label: 'Auto (OmniRoute picks the route)' }), false);
  });

  it('rejects junk input', () => {
    assert.equal(isUncensoredModel(null), false);
    assert.equal(isUncensoredModel(undefined), false);
    assert.equal(isUncensoredModel('dolphin'), false);
    assert.equal(isUncensoredModel({}), false);
  });
});
