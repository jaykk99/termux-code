# termux-code 100h dataset

## Source (real data only)
`dataset.jsonl`, built by `node nn-100h/build_dataset.mjs` from the
repo's own `lib/models.mjs`: 46 registry models x 138 env scenarios
= 6,348 rows. Scenarios: the 18 base ones (no keys; each of the 16
distinct envKeys set alone; all keys set) plus 120 seeded random
key-subset scenarios (mulberry32 seed 42, each key in/out p=0.5).
Label 1 = the repo's own `directModels(env)` lists the model under
that env, 0 = it does not. Nothing is invented.

## Label skew
Only 7 of the 46 models are ever listed (horde/any under every env;
the 6 hf models only when HF_TOKEN is set). Positive rows are a
small minority; the trainer oversamples positives in the TRAIN set
only (to 20%). The test sets stay at natural prevalence.

## Honest split (split.json, seed 42)
Grouped leave-models-out: 9 whole models held out as test (2 of the
7 ever-listed + 7 never-listed), 37 models train. The label is a
deterministic function of the features, so a random row split scores
1.000 by memorising (model, scenario) pairs — that is rule
reproduction, not learning, and is NOT reported as a win. The
grouped-test number is the honest metric: it measures transfer of
the gating rule to models the network never saw. A random-split
test set is evaluated alongside each experiment only as the
memorisation check.

## Files
- `dataset.jsonl` — one row per line (scenario, env_keys_set,
  provider, model_id, label_text, auth, env_key, free, tools, label)
- `dataset-meta.json` — build provenance
- `split.json` — frozen grouped split (train/test model lists)
