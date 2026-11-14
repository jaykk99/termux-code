"""Training data: real registry models under real env configurations.

Source: nn/dataset.json, built by nn/build_dataset.mjs, which runs the
repo's own lib/models.mjs directModels(env) on the real PROVIDERS
registry. 46 models x 18 env scenarios (no keys; each of the 16
distinct envKeys set alone; all keys set) = 828 rows. Label 1 = the
model is listed by directModels() under that env, 0 = it is not.

The uncensored-only filter (lib/uncensored.mjs) is the reason the
positive class is small: only 7 of the 46 registry models are ever
listed (horde/any, always; the 6 hf models, only when HF_TOKEN is
set). That is the repo's real behavior, not a data quirk, and the
training report says so.
"""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Dict, List, Tuple

HERE = Path(__file__).resolve().parent
DATASET_PATH = HERE / "dataset.json"


def load_dataset(path: str | Path = DATASET_PATH) -> Dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    rows = data["rows_data"]
    stats = {
        "registry_models": data["registry_models"],
        "scenarios": len(data["scenarios"]),
        "scenario_names": data["scenarios"],
        "built_at": data.get("built_at"),
        "train_rows": len(rows),
        "n_positive": sum(1 for r in rows if r["label"] == 1),
        "n_negative": sum(1 for r in rows if r["label"] == 0),
        "distinct_listed_models": len(
            {f"{r['provider']}/{r['model_id']}" for r in rows
             if r["label"] == 1}),
    }
    return {"rows": rows, "stats": stats}


def stratified_split(rows: List[Dict], test_frac: float = 0.2,
                     seed: int = 42) -> Tuple[List[Dict], List[Dict]]:
    """Stratified train/test split (keeps the class ratio in both)."""
    rng = random.Random(seed)
    by_label: Dict[int, List[Dict]] = {}
    for r in rows:
        by_label.setdefault(r["label"], []).append(r)
    train: List[Dict] = []
    test: List[Dict] = []
    for label, items in by_label.items():
        items = list(items)
        rng.shuffle(items)
        n_test = max(1, round(len(items) * test_frac)) if len(items) > 1 else 0
        test.extend(items[:n_test])
        train.extend(items[n_test:])
    rng.shuffle(train)
    rng.shuffle(test)
    return train, test


def balance_train(rows: List[Dict], target_pos_frac: float = 0.2,
                  seed: int = 42) -> Tuple[List[Dict], Dict]:
    """Oversample the minority class in the TRAIN set only, by
    duplicating positive rows (seeded). The test set is never touched
    and stays at natural prevalence. Returns (rows, info)."""
    rng = random.Random(seed)
    pos = [r for r in rows if r["label"] == 1]
    neg = [r for r in rows if r["label"] == 0]
    if not pos or not neg:
        return rows, {"balanced": False, "reason": "single class"}
    cur = len(pos) / len(rows)
    if cur >= target_pos_frac:
        return rows, {"balanced": False, "reason": "already balanced",
                      "train_pos_frac_before": round(cur, 3)}
    want_pos = int(round(len(neg) * target_pos_frac / (1 - target_pos_frac)))
    extra = []
    while len(pos) + len(extra) < want_pos:
        extra.append(rng.choice(pos))
    out = rows + extra
    rng.shuffle(out)
    return out, {"balanced": True,
                 "train_pos_frac_before": round(cur, 3),
                 "train_pos_frac_after": round(
                     (len(pos) + len(extra)) / len(out), 3),
                 "duplicated_rows": len(extra)}
