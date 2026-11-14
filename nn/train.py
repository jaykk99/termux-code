"""Train the availability network on the real registry/env rows.

    node nn/build_dataset.mjs   # rebuild dataset.json from lib/models.mjs
    python3 -m nn.train [--out DIR] [--epochs N] [--hidden 8]

Trains an MLP to predict whether a registry model is listed by
directModels() under a given env configuration. Writes weights.json +
viewer-data.json into the out dir (default: this package dir) and
refreshes the embedded metrics block in viewer.html.

Honest limits, printed with the metrics and baked into the viewer:
- the positive class is 3.6% (30 of 828 rows): only 7 of 46 registry
  models are ever listed, because the uncensored-only filter drops
  the rest. The majority baseline is 96.4%, so accuracy alone means
  nothing: judge by listed-class recall and ROC AUC.
- the training set is oversampled (positives duplicated to 20%) so
  the network sees the minority class at all; the test set is never
  oversampled and stays at natural prevalence.
- labels are rule-derived: each row is labeled by directModels() on
  the real registry. A high score means the network reproduced that
  gating + filter, not a discovery.
- the model never enables anything: directModels() stays the
  authority; this is a pre-check / ranker only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import sys
from pathlib import Path

from .data import balance_train, load_dataset, stratified_split
from .features import FeatureSpec, build_vocab, extract
from .mlp import MLP, metrics_for, roc_auc

LIMITS = [
    "Pre-check only. The model predicts whether a registry model is "
    "listed by directModels() under an env configuration; it never "
    "enables a model and never overrides directModels(), which stays "
    "the authority.",
    "Labels are rule-derived: each row is labeled by directModels() "
    "on the real PROVIDERS registry. A high score means the network "
    "reproduced that gating + the uncensored filter, not a discovery.",
    # Index 2 is replaced at train time with the real skew.
    "Label skew: see the dataset stats.",
    "Training positives are duplicated (train set only) so the "
    "network sees the minority class; the test set stays at natural "
    "prevalence and is never oversampled.",
    "Registry models or env keys unseen in training fall into the "
    "OTHER bucket; the model has no opinion about them beyond the "
    "generic features.",
]

VIEWER_START = "<!-- NN-DATA-START -->"
VIEWER_END = "<!-- NN-DATA-END -->"


def permutation_importance(net: MLP, spec: FeatureSpec,
                           X_test, y_test, seed: int = 42):
    """Grouped permutation importance: AUC drop when a feature group
    is shuffled in the test set. Positive drop = the group matters."""
    base_scores = [net.predict_proba(x) for x in X_test]
    base_auc = roc_auc(base_scores, y_test)
    rng = random.Random(seed)
    out = []
    for group, (a, b) in sorted(spec.groups().items()):
        Xp = [list(x) for x in X_test]
        col_vals = [x[a:b] for x in Xp]
        rng.shuffle(col_vals)
        for row, vals in zip(Xp, col_vals):
            row[a:b] = vals
        auc = roc_auc([net.predict_proba(x) for x in Xp], y_test)
        out.append({"group": group, "auc_drop": round(base_auc - auc, 4)})
    out.sort(key=lambda d: d["auc_drop"], reverse=True)
    return out


def train(out_dir: str, epochs: int = 60, hidden: str = "8",
          lr: float = 0.05, seed: int = 42,
          test_frac: float = 0.2) -> dict:
    dataset = load_dataset()
    rows = dataset["rows"]
    stats = dataset["stats"]
    if len(rows) < 20:
        raise ValueError(f"only {len(rows)} training rows; refusing")
    train_rows, test_rows = stratified_split(rows, test_frac, seed)
    train_rows_bal, bal_info = balance_train(train_rows, 0.2, seed)
    spec = build_vocab([r for r in train_rows])
    X_train = [extract(r, spec) for r in train_rows_bal]
    y_train = [r["label"] for r in train_rows_bal]
    X_test = [extract(r, spec) for r in test_rows]
    y_test = [r["label"] for r in test_rows]

    limits = list(LIMITS)
    limits[2] = (
        f"Label skew: {stats['n_positive']} listed / "
        f"{stats['n_negative']} not-listed of {len(rows)} rows "
        f"({100.0 * stats['n_positive'] / max(1, len(rows)):.1f}% "
        "positive). Only "
        f"{stats['distinct_listed_models']} of "
        f"{stats['registry_models']} registry models are ever listed: "
        "horde/any under every env, and the 6 hf models only when "
        "HF_TOKEN is set. The majority baseline is "
        f"{max(stats['n_positive'], stats['n_negative']) / max(1, len(rows)):.3f}; "
        "judge by listed-class recall and ROC AUC, not accuracy.")

    layers = [spec.dim] + [int(h) for h in hidden.split(",") if h] + [1]
    net = MLP(layers, seed=seed, lr=lr)
    history = net.fit(X_train, y_train, epochs=epochs, batch_size=32,
                      X_val=X_test, y_val=y_test, seed=seed)
    train_scores = [net.predict_proba(x) for x in X_train]
    test_scores = [net.predict_proba(x) for x in X_test]
    train_metrics = metrics_for(y_train, train_scores)
    test_metrics = metrics_for(y_test, test_scores)
    importance = permutation_importance(net, spec, X_test, y_test, seed)

    result = {
        "trained_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "layers": layers,
        "n_features": spec.dim,
        "feature_names": spec.feature_names(),
        "dataset": stats,
        "train_rows": len(train_rows),
        "train_rows_balanced": len(train_rows_bal),
        "balance": bal_info,
        "test_rows": len(test_rows),
        "train_metrics": train_metrics,
        "test_metrics": test_metrics,
        "history": history,
        "feature_importance": importance,
        "limits": limits,
        "seed": seed,
        "epochs": epochs,
        "lr": lr,
    }

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    weights = {
        "format": "termux-code-nn-weights/1",
        "trained_at": result["trained_at"],
        "mlp": net.to_dict(),
        "features": spec.to_dict(),
        "metrics": {"train": train_metrics, "test": test_metrics},
        "dataset": stats,
        "limits": limits,
    }
    (out / "weights.json").write_text(json.dumps(weights, indent=2),
                                      encoding="utf-8")
    (out / "viewer-data.json").write_text(
        json.dumps(result, indent=2), encoding="utf-8")
    _refresh_viewer(out / "viewer.html", result)
    return result


def _refresh_viewer(viewer_path: Path, result: dict) -> None:
    if not viewer_path.exists():
        return
    text = viewer_path.read_text(encoding="utf-8")
    if VIEWER_START not in text or VIEWER_END not in text:
        return
    block = (VIEWER_START + "\n<script type=\"application/json\" "
             "id=\"nn-data\">\n" + json.dumps(result, indent=2) +
             "\n</script>\n" + VIEWER_END)
    before, _sep, rest = text.partition(VIEWER_START)
    _mid, _sep2, after = rest.partition(VIEWER_END)
    viewer_path.write_text(before + block + after, encoding="utf-8")


def _print_report(result: dict) -> None:
    tm = result["test_metrics"]
    tr = result["train_metrics"]
    print(f"rows: train={result['train_rows']} "
          f"(balanced {result['train_rows_balanced']}) "
          f"test={result['test_rows']} "
          f"(listed {result['dataset']['n_positive']} / "
          f"not-listed {result['dataset']['n_negative']})")
    print(f"features: {result['n_features']}  layers: {result['layers']}")
    print(f"train acc {tr['accuracy']:.3f}  test acc {tm['accuracy']:.3f}  "
          f"majority baseline {tm['majority_baseline_accuracy']:.3f}")
    print(f"test ROC AUC {tm['roc_auc']:.3f}")
    print(f"listed: precision {tm['precision_listed']:.3f} "
          f"recall {tm['recall_listed']:.3f}")
    print(f"not-listed: precision {tm['precision_not_listed']:.3f} "
          f"recall {tm['recall_not_listed']:.3f}")
    cm = tm["confusion"]
    print(f"confusion (test): tp={cm['tp']} fp={cm['fp']} "
          f"fn={cm['fn']} tn={cm['tn']}")
    print("feature importance (AUC drop): " + ", ".join(
        f"{d['group']}={d['auc_drop']:.3f}"
        for d in result["feature_importance"][:6]))
    if tm["accuracy"] >= 1.0:
        print("FLAG: test accuracy is 100% — the network reproduced "
              "directModels() rule on the test rows. That is the "
              "expected rule-reproduction outcome, not a win; see limits.")
    print("LIMITS: pre-check only; labels are directModels() rule; "
          "directModels() stays the authority.")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Train the termux-code availability network.")
    ap.add_argument("--out",
                    default=str(Path(__file__).resolve().parent))
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--hidden", default="8")
    ap.add_argument("--lr", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--test-frac", type=float, default=0.2)
    args = ap.parse_args(argv)
    result = train(args.out, epochs=args.epochs, hidden=args.hidden,
                   lr=args.lr, seed=args.seed, test_frac=args.test_frac)
    _print_report(result)
    print(f"weights: {Path(args.out) / 'weights.json'}")
    print(f"viewer data: {Path(args.out) / 'viewer-data.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
