/**
 * Build nn/dataset.json by running the repo's own code.
 *
 * Rows: every model in lib/models.mjs PROVIDERS (46) x every env
 * scenario (18) = 828 rows. A row is one model under one env config;
 * label 1 = directModels(env) lists it, 0 = it does not.
 *
 * Env scenarios (from .env.example's real key names): no keys set,
 * each of the 16 distinct envKeys set alone, and all keys set.
 * Nothing is invented: labels are directModels() outputs, features
 * are registry fields (provider, auth, free, id/label text) plus
 * which keys the scenario sets. Run: node nn/build_dataset.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDERS, directModels, capabilities } from '../lib/models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = [...new Set(
  Object.values(PROVIDERS).map((c) => c.envKey).filter(Boolean),
)].sort();

const scenarios = [{ name: 'no-keys', env: {} }];
for (const key of ENV_KEYS) scenarios.push({ name: `only-${key}`, env: { [key]: 'x' } });
scenarios.push({ name: 'all-keys', env: Object.fromEntries(ENV_KEYS.map((k) => [k, 'x'])) });

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

const rows = [];
for (const sc of scenarios) {
  const listed = new Set(directModels(sc.env).map((m) => `${m.provider}/${m.id}`));
  for (const m of registry) {
    rows.push({
      scenario: sc.name,
      env_keys_set: Object.keys(sc.env),
      provider: m.provider, model_id: m.id, label_text: m.label,
      auth: m.auth, env_key: m.envKey, free: m.free, tools: m.tools,
      label: listed.has(`${m.provider}/${m.id}`) ? 1 : 0,
    });
  }
}

const nPos = rows.filter((r) => r.label === 1).length;
const out = {
  built_at: new Date().toISOString(),
  source: 'lib/models.mjs PROVIDERS + directModels(env), 18 env scenarios',
  scenarios: scenarios.map((s) => s.name),
  registry_models: registry.length,
  rows: rows.length,
  n_positive: nPos,
  n_negative: rows.length - nPos,
  rows_data: rows,
};
writeFileSync(path.join(HERE, 'dataset.json'), JSON.stringify(out, null, 2));
console.log(`models=${registry.length} scenarios=${scenarios.length} rows=${rows.length} listed=${nPos} not-listed=${rows.length - nPos}`);
