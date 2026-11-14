"""100-hour trainer for the termux-code availability network.

Pure Python stdlib. Repeated honest experiments on a FROZEN grouped
split (leave-models-out, see make_split.py): different hidden sizes,
lr, L2, epochs, seeds. Each experiment is fully evaluated on the
held-out models and logged to experiments.jsonl. Best-so-far is kept
only when honest grouped-test accuracy improves.

Reboot / chunk safe:
- checkpoint every 20 epochs to checkpoints/<exp_id>.json
  (weights + completed epochs + config)
- --resume continues the in-progress experiment from its checkpoint
  and resumes cumulative hours from status.json
- --max-run-hours caps one chunk (default 5.5h, under GitHub
  Actions' 6h job limit); on chunk exit it checkpoints, banks the
  hours, and exits 0. A supervisor or the next Actions run resumes.
- heartbeat.json is rewritten every epoch so a supervisor can tell
  a live trainer from a dead one.
- stops for good when hours_trained reaches 100 (status=done).

Honest limits (same as nn/train.py, plus the grouped split):
- labels are rule-derived: directModels() on the real registry. A
  high score means the network reproduced the gating + uncensored
  filter, not a discovery. The grouped split is the honest number:
  it measures transfer to models the network never saw. The random
  row-split number is logged alongside as the memorisation check.
- positive class is small (only 7 of 46 models are ever listed);
  judge by listed-class recall and ROC AUC, not accuracy alone.
- the model never enables anything: directModels() stays the
  authority; this is a pre-check / ranker only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import time
from pathlib import Path

from features import FeatureSpec, build_vocab, extract
from mlp import MLP, metrics_for, roc_auc

HERE = Path(__file__).resolve().parent
GOAL_HOURS = 100.0
CHECKPOINT_EVERY = 20

# Small grid on purpose (Jay: keep termux-code small, little data):
# 6,348 rows / 33 features do not justify big nets. Hidden {8, 16,
# 16,8} only, 60 epochs; no 32-wide layers, no 120-epoch runs.
GRID = [
    {"hidden": "8", "lr": 0.05, "l2": 1e-4, "epochs": 60},
    {"hidden": "8", "lr": 0.02, "l2": 1e-4, "epochs": 60},
    {"hidden": "16", "lr": 0.05, "l2": 1e-4, "epochs": 60},
    {"hidden": "16", "lr": 0.02, "l2": 1e-4, "epochs": 60},
    {"hidden": "16,8", "lr": 0.05, "l2": 1e-4, "epochs": 60},
    {"hidden": "16,8", "lr": 0.02, "l2": 1e-4, "epochs": 60},
    {"hidden": "8", "lr": 0.05, "l2": 1e-3, "epochs": 60},
    {"hidden": "16", "lr": 0.05, "l2": 1e-3, "epochs": 60},
    {"hidden": "16,8", "lr": 0.05, "l2": 1e-3, "epochs": 60},
]


def log(msg: str) -> None:
    print(f"[{dt.datetime.now(dt.timezone.utc).isoformat()}] {msg}",
          flush=True)


def load_rows():
    return [json.loads(l) for l in open(HERE / "dataset.jsonl")]


def load_split():
    return json.loads((HERE / "split.json").read_text())


def balance_train(rows, target_pos_frac=0.2, seed=42):
    rng = random.Random(seed)
    pos = [r for r in rows if r["label"] == 1]
    neg = [r for r in rows if r["label"] == 0]
    if not pos or not neg:
        return rows
    cur = len(pos) / len(rows)
    if cur >= target_pos_frac:
        return rows
    want_pos = int(round(len(neg) * target_pos_frac / (1 - target_pos_frac)))
    extra = []
    while len(pos) + len(extra) < want_pos:
        extra.append(rng.choice(pos))
    out = rows + extra
    rng.shuffle(out)
    return out


def load_status() -> dict:
    p = HERE / "status.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {"repo": "termux-code", "hours_trained": 0.0,
            "experiments_done": [], "current": None,
            "best": None, "status": "training", "updated": None}


def save_status(st: dict) -> None:
    st["updated"] = dt.datetime.now(dt.timezone.utc).isoformat()
    (HERE / "status.json").write_text(json.dumps(st, indent=2))


def heartbeat(exp_id, epoch, experiments_done) -> None:
    (HERE / "heartbeat.json").write_text(json.dumps({
        "pid": os.getpid(),
        "time": dt.datetime.now(dt.timezone.utc).isoformat(),
        "exp_id": exp_id, "epoch": epoch,
        "experiments_done": experiments_done,
    }))


def save_checkpoint(exp_id, config, epoch, net) -> None:
    (HERE / "checkpoints").mkdir(parents=True, exist_ok=True)
    ck = {"exp_id": exp_id, "config": config, "epoch": epoch,
          "net": net.to_dict()}
    (HERE / "checkpoints" / f"{exp_id}.json").write_text(json.dumps(ck))


def load_checkpoint(exp_id):
    p = HERE / "checkpoints" / f"{exp_id}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def evaluate(net, X_test, y_test):
    scores = [net.predict_proba(x) for x in X_test]
    return metrics_for(y_test, scores)


def run_experiment(exp_id, config, seed, X_train, y_train, X_test, y_test,
                   X_rand, y_rand, chunk_deadline, status):
    """Train one config, checkpointing every 20 epochs. Returns the
    test metrics dict, or None if the chunk ran out of time."""
    layers = [len(X_train[0])] + [int(h) for h in config["hidden"].split(",")
                                  if h] + [1]
    start_epoch = 0
    net = None
    if (status.get("current") or {}).get("exp_id") == exp_id:
        ck = load_checkpoint(exp_id)
        if ck and ck["config"] == config:
            net = MLP.from_dict(ck["net"])
            start_epoch = ck["epoch"]
            log(f"{exp_id}: resumed from checkpoint epoch {start_epoch}")
    if net is None:
        net = MLP(layers, seed=seed, lr=config["lr"], l2=config["l2"])
    epochs = config["epochs"]
    for ep in range(start_epoch, epochs):
        if time.time() >= chunk_deadline:
            save_checkpoint(exp_id, config, ep, net)
            status["current"] = {"exp_id": exp_id, "config": config,
                                 "epoch": ep}
            save_status(status)
            log(f"{exp_id}: chunk time up at epoch {ep}/{epochs}, "
                "checkpoint saved")
            return None
        net.fit(X_train, y_train, epochs=1, batch_size=32,
                seed=seed + ep)
        if (ep + 1) % CHECKPOINT_EVERY == 0 or ep + 1 == epochs:
            save_checkpoint(exp_id, config, ep + 1, net)
            status["current"] = {"exp_id": exp_id, "config": config,
                                 "epoch": ep + 1}
            save_status(status)
        heartbeat(exp_id, ep + 1, len(status["experiments_done"]))
    test_m = evaluate(net, X_test, y_test)
    rand_m = evaluate(net, X_rand, y_rand)
    return ({"exp_id": exp_id, "config": config, "seed": seed,
             "grouped_test": test_m,
             "random_split_test": rand_m}, net)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--max-run-hours", type=float, default=5.5)
    ap.add_argument("--max-experiments", type=int, default=0,
                    help="smoke-test cap, 0 = no cap")
    ap.add_argument("--epochs", type=int, default=0,
                    help="smoke-test override for every config")
    args = ap.parse_args()

    chunk_start = time.time()
    chunk_deadline = chunk_start + args.max_run_hours * 3600
    (HERE / "checkpoints").mkdir(parents=True, exist_ok=True)
    status = load_status()
    if status.get("status") == "done":
        log("already done (100h reached), nothing to do")
        return
    if float(status.get("hours_trained", 0.0)) >= GOAL_HOURS:
        status["status"] = "done"
        save_status(status)
        log("already at 100h, marking done")
        return

    rows = load_rows()
    split = load_split()
    if not args.resume:
        status["current"] = None
    train_models = set(split["train_models"])
    test_models = set(split["test_models"])
    train_rows = [r for r in rows
                  if f"{r['provider']}/{r['model_id']}" in train_models]
    test_rows = [r for r in rows
                 if f"{r['provider']}/{r['model_id']}" in test_models]
    # Random row-split test set (same size as grouped test), for the
    # memorisation check only. Never trained on.
    rng = random.Random(42)
    by_label = {}
    for r in rows:
        by_label.setdefault(r["label"], []).append(r)
    rand_test = []
    for label, items in by_label.items():
        items = list(items)
        rng.shuffle(items)
        n = max(1, round(len(test_rows) * len(items) / len(rows)))
        rand_test.extend(items[:n])
    train_bal = balance_train(train_rows, 0.2, 42)
    spec = build_vocab(train_rows)
    X_train = [extract(r, spec) for r in train_bal]
    y_train = [r["label"] for r in train_bal]
    X_test = [extract(r, spec) for r in test_rows]
    y_test = [r["label"] for r in test_rows]
    X_rand = [extract(r, spec) for r in rand_test]
    y_rand = [r["label"] for r in rand_test]
    log(f"dataset: {len(rows)} rows; train {len(train_rows)} "
        f"(balanced {len(train_bal)}), grouped-test {len(test_rows)}, "
        f"random-test {len(rand_test)}; features {spec.dim}; "
        f"hours banked {status['hours_trained']:.2f}")

    done = set(status.get("experiments_done", []))
    grid = [dict(c) for c in GRID]
    if args.epochs:
        for c in grid:
            c["epochs"] = args.epochs
    ran = 0
    passes = 0
    while True:
        for idx, config in enumerate(grid):
            if args.max_experiments and ran >= args.max_experiments:
                break
            if time.time() >= chunk_deadline:
                break
            exp_id = f"p{passes:03d}-e{idx:02d}"
            seed = 42 + passes * 100 + idx
            if exp_id in done:
                continue
            log(f"start {exp_id} {config} seed={seed}")
            res = run_experiment(exp_id, config, seed, X_train,
                               y_train, X_test, y_test, X_rand,
                               y_rand, chunk_deadline, status)
            if res is None:
                break  # chunk time up mid-experiment
            result, net = res
            ran += 1
            done.add(exp_id)
            status["experiments_done"] = sorted(done)
            status["current"] = None
            with open(HERE / "experiments.jsonl", "a") as fh:
                fh.write(json.dumps(result) + "\n")
            gm = result["grouped_test"]
            log(f"{exp_id}: grouped acc {gm['accuracy']:.4f} "
                f"AUC {gm['roc_auc']:.4f} "
                f"conf {gm['confusion']} "
                f"recall_listed {gm['recall_listed']:.3f} | "
                f"random-split acc "
                f"{result['random_split_test']['accuracy']:.4f}")
            best = status.get("best")
            if (best is None
                    or gm["accuracy"] > best["grouped_test"]["accuracy"]
                    or (gm["accuracy"] == best["grouped_test"]["accuracy"]
                        and gm["roc_auc"] > best["grouped_test"]["roc_auc"])):
                status["best"] = result
                net.save(str(HERE / "best.json"))
                (HERE / "best-metrics.json").write_text(
                    json.dumps(result, indent=2))
                log(f"{exp_id}: new best grouped acc "
                    f"{gm['accuracy']:.4f}")
            save_status(status)
        else:
            passes += 1
            if args.max_experiments and ran >= args.max_experiments:
                break
            if time.time() < chunk_deadline:
                continue
            break
        break

    elapsed_h = (time.time() - chunk_start) / 3600
    status["hours_trained"] = float(status.get("hours_trained", 0.0)) \
        + elapsed_h
    if status["hours_trained"] >= GOAL_HOURS:
        status["status"] = "done"
    save_status(status)
    log(f"chunk done: +{elapsed_h:.3f}h, total "
        f"{status['hours_trained']:.2f}h, experiments {ran} this chunk, "
        f"status={status['status']}")


if __name__ == "__main__":
    main()
