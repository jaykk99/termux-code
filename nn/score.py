"""Score a registry model under an env scenario with the trained net.

    python3 -m nn.score --scenario no-keys --all
    python3 -m nn.score --scenario only-HF_TOKEN --model hf/DavidAU/GLM-4.7-Flash-Uncensored-Heretic-NEO-CODE-Imatrix-MAX-GGUF
    python3 -m nn.score --env-keys HF_TOKEN --model groq/openai/gpt-oss-120b

Pre-check only: the score predicts whether directModels() lists the
model under that env. directModels() itself stays the authority; a
high score never enables anything.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_model(weights_path=None):
    path = Path(weights_path) if weights_path else HERE / "weights.json"
    if not path.exists():
        return None
    sys.path.insert(0, str(HERE.parent))
    from nn.features import FeatureSpec
    from nn.mlp import MLP
    data = json.loads(path.read_text(encoding="utf-8"))
    net = MLP.from_dict(data["mlp"])
    spec = FeatureSpec.from_dict(data.get("features", {}))
    return net, spec


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Score model availability with the NN.")
    ap.add_argument("--scenario", default=None,
                    help="one of the 18 scenarios in nn/dataset.json")
    ap.add_argument("--env-keys", default=None,
                    help="comma-separated env keys set (custom scenario; "
                         "no rule label available for these)")
    ap.add_argument("--model", default=None,
                    help="provider/id, e.g. hf/<id> or horde/any")
    ap.add_argument("--all", action="store_true",
                    help="rank every registry model under the scenario")
    ap.add_argument("--weights", default=None)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    sys.path.insert(0, str(HERE.parent))
    from nn.data import load_dataset
    from nn.features import extract, top_features

    loaded = load_model(args.weights)
    if loaded is None:
        print("no trained weights found. Train first:\n"
              "  python3 -m nn.train", file=sys.stderr)
        return 2
    net, spec = loaded
    dataset = load_dataset()
    rows = dataset["rows"]
    if args.scenario:
        if args.scenario not in dataset["stats"]["scenario_names"]:
            print(f"unknown scenario {args.scenario!r}; known: "
                  + ", ".join(dataset["stats"]["scenario_names"]),
                  file=sys.stderr)
            return 2
        rows = [r for r in rows if r["scenario"] == args.scenario]
        keys_set = rows[0]["env_keys_set"] if rows else []
        rule_available = True
    elif args.env_keys is not None:
        keys_set = [k.strip() for k in args.env_keys.split(",") if k.strip()]
        # One row per registry model, with this custom env.
        seen = {}
        for r in rows:
            seen.setdefault(f"{r['provider']}/{r['model_id']}", r)
        rows = []
        for r in seen.values():
            r2 = dict(r)
            r2["scenario"] = "custom"
            r2["env_keys_set"] = list(keys_set)
            r2["label"] = None
            rows.append(r2)
        rule_available = False
    else:
        ap.error("give --scenario or --env-keys")
        return 2
    if not args.all and not args.model:
        ap.error("give --model or --all")
        return 2
    if args.model:
        rows = [r for r in rows
                if f"{r['provider']}/{r['model_id']}" == args.model]
        if not rows:
            print(f"no registry model {args.model!r}", file=sys.stderr)
            return 2
    scored = []
    for r in rows:
        p = net.predict_proba(extract(r, spec))
        rec = {
            "model": f"{r['provider']}/{r['model_id']}",
            "scenario": r["scenario"],
            "nn_score": round(p, 4),
            "nn_label": "listed" if p >= args.threshold else "not-listed",
            "nn_top_features": top_features(r, spec, net),
        }
        if rule_available:
            rec["rule_label"] = "listed" if r["label"] == 1 else "not-listed"
        scored.append(rec)
    scored.sort(key=lambda d: d["nn_score"], reverse=True)
    if args.json:
        print(json.dumps({"scenario": args.scenario or "custom",
                          "env_keys_set": keys_set,
                          "models": scored}, indent=2))
    else:
        print(f"scenario: {args.scenario or 'custom'} "
              f"(keys: {', '.join(keys_set) or 'none'})  "
              "pre-check only; directModels() stays the authority")
        for s in scored:
            rule = f"  (rule: {s['rule_label']})" if "rule_label" in s else ""
            agree = ""
            if "rule_label" in s and s["nn_label"] != s["rule_label"]:
                agree = "  [NN disagrees with rule]"
            print(f"{s['nn_score']:.3f}  {s['nn_label']:<10}  {s['model']}"
                  f"{rule}{agree}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
