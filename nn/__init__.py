"""Availability-prediction network for termux-code (pure Python stdlib).

Predicts whether a registry model is listed by lib/models.mjs
directModels() under a given env configuration. Triage / pre-check
only: it never enables a model and never overrides directModels(),
which stays the authority.

Layout (same shape as the ReconAnything NN scorer):
- mlp.py: tanh hidden, sigmoid out, SGD, pure stdlib (reusable as-is)
- features.py: (registry model, env scenario) -> numeric vector
- data.py: loads nn/dataset.json, stratified split, train-only
  oversampling of the minority class
- build_dataset.mjs: rebuilds nn/dataset.json by running the repo's
  own directModels(env) on the real PROVIDERS registry
- train.py: trains, writes weights.json + viewer-data.json
- score.py: scores one model or ranks all models under a scenario
- viewer.html: metrics viewer (open as file://)
- dataset.json: the 828 labeled rows + build provenance

Train: node nn/build_dataset.mjs && python3 -m nn.train
Score: python3 -m nn.score --scenario no-keys --all
"""
