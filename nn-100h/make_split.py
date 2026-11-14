"""Frozen grouped split for the termux-code 100h trainer.

Honest split: leave-MODELS-out. The label (listed by directModels)
is a deterministic function of the features, so a random row split
lets the network memorise (model, scenario) pairs and score 1.000
without learning anything transferable. Holding out whole models
forces the network to generalise the gating rule to models it has
never seen.

Test models (seed 42, stratified by ever-listed): 2 of the 7
ever-listed models + 7 never-listed models = 9 held-out models.
Train = the other 37 models x all scenarios. Test = 9 models x all
scenarios. The split is deterministic from seed 42; rerunning this
script reproduces the same split.json.
"""
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = 42
N_TEST_MODELS = 9


def main():
    rows = [json.loads(l) for l in open(HERE / "dataset.jsonl")]
    by_model = {}
    for r in rows:
        by_model.setdefault(f"{r['provider']}/{r['model_id']}", []).append(r)
    ever_listed = sorted(m for m, rs in by_model.items()
                         if any(r["label"] == 1 for r in rs))
    never_listed = sorted(m for m, rs in by_model.items()
                          if not any(r["label"] == 1 for r in rs))
    rng = random.Random(SEED)
    rng.shuffle(ever_listed)
    rng.shuffle(never_listed)
    test_models = sorted(ever_listed[:2] + never_listed[:7])
    train_models = sorted(set(by_model) - set(test_models))
    split = {
        "seed": SEED,
        "method": "grouped leave-models-out",
        "test_models": test_models,
        "train_models": train_models,
        "n_train_rows": sum(len(by_model[m]) for m in train_models),
        "n_test_rows": sum(len(by_model[m]) for m in test_models),
        "test_positive": sum(r["label"] for m in test_models
                             for r in by_model[m]),
        "train_positive": sum(r["label"] for m in train_models
                              for r in by_model[m]),
    }
    with open(HERE / "split.json", "w") as fh:
        json.dump(split, fh, indent=2)
    print(f"train models: {len(train_models)} ({split['n_train_rows']} rows, "
          f"{split['train_positive']} pos)")
    print(f"test models: {len(test_models)} ({split['n_test_rows']} rows, "
          f"{split['test_positive']} pos)")
    print("test models:", ", ".join(test_models))


if __name__ == "__main__":
    main()
