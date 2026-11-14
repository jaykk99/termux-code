/**
 * Tests for nn/ — the model-availability predictor.
 * Run: node --test tests/nn-availability.test.mjs
 *
 * Checks the dataset the generator built from the real registry, then
 * smoke-trains the Python network for 2 epochs into a temp dir and
 * checks the artifacts land with sane metrics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const dataset = JSON.parse(readFileSync(path.join(ROOT, 'nn', 'dataset.json'), 'utf-8'));

describe('nn/dataset.json (built from lib/models.mjs)', () => {
  it('has 828 rows: 46 registry models x 18 env scenarios', () => {
    assert.equal(dataset.registry_models, 46);
    assert.equal(dataset.scenarios.length, 18);
    assert.equal(dataset.rows, 828);
    assert.equal(dataset.rows_data.length, 828);
  });

  it('has both classes, with the small positive class the filter explains', () => {
    assert.equal(dataset.n_positive, 30);
    assert.equal(dataset.n_negative, 798);
    const listed = new Set(
      dataset.rows_data.filter((r) => r.label === 1)
        .map((r) => `${r.provider}/${r.model_id}`),
    );
    // Only horde/any (always) + the 6 hf models (HF_TOKEN set) survive
    // the uncensored-only filter + key gating.
    assert.equal(listed.size, 7);
    assert.ok(listed.has('horde/any'));
    for (const m of listed) {
      assert.ok(m.startsWith('horde/') || m.startsWith('hf/'), m);
    }
  });

  it('labels match directModels() on a spot check', async () => {
    const { directModels } = await import('../lib/models.mjs');
    const listed = new Set(
      directModels({ HF_TOKEN: 'x' }).map((m) => `${m.provider}/${m.id}`),
    );
    for (const row of dataset.rows_data.filter((r) => r.scenario === 'only-HF_TOKEN')) {
      assert.equal(row.label, listed.has(`${row.provider}/${row.model_id}`) ? 1 : 0,
        `${row.provider}/${row.model_id}`);
    }
  });
});

describe('nn/train.py smoke train', () => {
  it('trains 2 epochs and writes weights + viewer data', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tc-nn-'));
    try {
      execFileSync('python3', ['-m', 'nn.train', '--epochs', '2', '--out', dir],
        { cwd: ROOT, encoding: 'utf-8', timeout: 110_000 });
      assert.ok(existsSync(path.join(dir, 'weights.json')));
      const viewer = JSON.parse(readFileSync(path.join(dir, 'viewer-data.json'), 'utf-8'));
      assert.equal(viewer.test_rows, 166);
      assert.ok(viewer.test_metrics.roc_auc >= 0 && viewer.test_metrics.roc_auc <= 1);
      assert.ok(viewer.test_metrics.accuracy >= 0 && viewer.test_metrics.accuracy <= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
