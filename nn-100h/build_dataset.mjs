/**
 * Build nn-100h/dataset.jsonl by running the repo's own code.
 *
 * Rows: every model in lib/models.mjs PROVIDERS (46) x every env
 * scenario. Scenarios: the 18 base ones from nn/build_dataset.mjs
 * (no keys; each of the 16 distinct envKeys set alone; all keys set)
 * PLUS 120 seeded random key-subset scenarios (each key in/out with
 * p=0.5, mulberry32 seed 42). 138 scenarios x 46 models = 6,348 rows.
 *
 * A row is one model under one env config; label 1 = directModels(env)
 * lists it, 0 = it does not. Nothing is invented: labels are
 * directModels() outputs on the real registry, features are registry
 * fields plus which keys the scenario sets.
 *
 * Run: node nn-100h/build_dataset.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDERS, directModels, capabilities } from '../lib/models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ENV_KEYS = [...new Set(
  Object.values(PROVIDERS).map((c) => c.envKey).filter(Boolean),
)].sort();

const scenarios = [{ name: 'no-keys', env: {} }];
for (const key of ENV_KEYS) scenarios.push({ name: `only-${key}`, env: { [key]: 'x' } });
scenarios.push({ name: 'all-keys', env: Object.fromEntries(ENV_KEYS.map((k) => [k, 'x'])) });

const rng = mulberry32(42);
for (let i = 0; i < 120; i++) {
  const env = {};
  for (const k of ENV_KEYS) if (rng() < 0.5) env[k] = 'x';
  scenarios.push({ name: `rand-${String(i).padStart(3, '0')}`, env });
}

const registry = [];
for (const [provider, cfg] of Object.entries(PROVIDERS)) {
  for (const m of cfg.models) {
    registry.push({
      id: m.id, label: m.label, provider,
      auth: cfg.auth, envKey: cfg.envKey || null, free: !!m.free,
      tools: capabilities({ auth: cfg.auth }).tools,
    });
  }
}

const lines = [];
for (const sc of scenarios) {
  const listed = new Set(directModels(sc.env).map((m) => `${m.provider}/${m.id}`));
  for (const m of registry) {
    lines.push(JSON.stringify({
      scenario: sc.name,
      env_keys_set: Object.keys(sc.env),
      provider: m.provider, model_id: m.id, label_text: m.label,
      auth: m.auth, env_key: m.envKey, free: m.free, tools: m.tools,
      label: listed.has(`${m.provider}/${m.id}`) ? 1 : 0,
    }));
  }
}

const nPos = lines.filter((l) => JSON.parse(l).label === 1).length;
writeFileSync(path.join(HERE, 'dataset.jsonl'), lines.join('\n') + '\n');
writeFileSync(path.join(HERE, 'dataset-meta.json'), JSON.stringify({
  built_at: new Date().toISOString(),
  source: 'lib/models.mjs PROVIDERS + directModels(env), 18 base + 120 seeded random key-subset scenarios (seed 42)',
  registry_models: registry.length,
  scenarios: scenarios.length,
  scenario_names: scenarios.map((s) => s.name),
  rows: lines.length,
  n_positive: nPos,
  n_negative: lines.length - nPos,
}, null, 2));
console.log(`wrote ${lines.length} rows (${nPos} positive) across ${scenarios.length} scenarios`);
