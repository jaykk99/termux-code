# termux-code NN — model-availability predictor

Small pure-Python-stdlib neural network (tanh hidden, sigmoid out, SGD),
in the style of the ReconAnything NN scorer. Zero dependencies.

## Prediction task

Given a registry model and an env configuration (which provider keys
are set), predict whether `lib/models.mjs` `directModels(env)` **lists
the model as usable**.

## Dataset (real repo data only)

- 26 models in the `PROVIDERS` registry in `lib/models.mjs` (uncensored
  lineage only — an aligned model is not registered at all).
- 9 env scenarios: no keys set, each distinct env key of a provider that
  registers a model set alone, all keys set (key names from
  `.env.example`).
- 234 rows: **59 listed / 175 not-listed (25.2% positive)**.
- Labels come from running the repo's own `directModels(env)`; rebuild
  with `node nn/build_dataset.mjs`.
- Stratified split: 187 train / 47 test. Train positives are
  duplicated to 20% so the network sees the minority class at all;
  the test set is never oversampled and stays at natural prevalence.

## What the data says

Only **`horde/any` is listed under every env**: every other registry
model appears once its own key is set. Nothing is dropped by the
uncensored-only filter (`lib/uncensored.mjs`) any more — the registry
itself carries uncensored-lineage models only, so what the network
learns is the key gating on top of that.

## Honest limits

- **Labels are rule-derived.** A high score means the network
  reproduced `directModels()`' gating + the uncensored filter, not a
  discovery. 100% test accuracy is the rule-reproduction flag, not
  a win.
- **Skew.** Majority baseline is 74.5%; accuracy alone means
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
