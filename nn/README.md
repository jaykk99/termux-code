# termux-code NN — model-availability predictor

Small pure-Python-stdlib neural network (tanh hidden, sigmoid out, SGD),
in the style of the ReconAnything NN scorer. Zero dependencies.

## Prediction task

Given a registry model and an env configuration (which provider keys
are set), predict whether `lib/models.mjs` `directModels(env)` **lists
the model as usable**.

## Dataset (real repo data only)

- 46 models in the `PROVIDERS` registry in `lib/models.mjs`.
- 18 env scenarios: no keys set, each of the 16 distinct env keys set
  alone, all keys set (key names from `.env.example`).
- 828 rows: **30 listed / 798 not-listed (3.6% positive)**.
- Labels come from running the repo's own `directModels(env)`; rebuild
  with `node nn/build_dataset.mjs`.
- Stratified split: 662 train / 166 test. Train positives are
  duplicated to 20% so the network sees the minority class at all;
  the test set is never oversampled and stays at natural prevalence.

## What the data says

Only **7 of the 46 registry models are ever listed**: `horde/any`
under every env, and the 6 `hf` models only when `HF_TOKEN` is set.
Everything else is dropped by the uncensored-only filter
(`lib/uncensored.mjs`) or by key gating. That is the repo's real
behavior, and the main thing this network learns is that interaction.

## Honest limits

- **Labels are rule-derived.** A high score means the network
  reproduced `directModels()`' gating + the uncensored filter, not a
  discovery. 100% test accuracy is the rule-reproduction flag, not
  a win.
- **Severe skew.** Majority baseline is 96.4%; accuracy alone means
  nothing. Judge by listed-class recall and ROC AUC.
- **Pre-check only.** The model never enables anything;
  `directModels()` stays the authority.
- Features are raw inputs only (auth, key required/set, free,
  tool-capable, uncensored-marker text, provider). The gating verdict
  itself is never a feature.

## Use

```
node nn/build_dataset.mjs   # rebuild dataset.json from the registry
python3 -m nn.train         # retrain, refresh viewer-data.json
python3 -m nn.score --scenario no-keys --all
python3 -m nn.score --scenario only-HF_TOKEN --model hf/DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF
```

Open `nn/viewer.html` as `file://` for the metrics.
