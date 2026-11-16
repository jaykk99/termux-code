"""Feature extraction: (registry model, env scenario) -> numeric vector.

Every feature is a real registry field or a real property of the env
scenario: the model's auth style, whether its provider needs a key,
whether the scenario sets that key, whether it is free / tool-capable,
whether its id/label carries an uncensored-lineage marker (the same
marker text lib/uncensored.mjs looks for), and the provider.

The label rule itself (directModels' gating + the uncensored filter)
is NOT a feature. The network has to learn the interaction — a model
is listed only when its provider is on under the env AND it passes
the uncensored filter — from these raw inputs.
"""
from __future__ import annotations

import re
from typing import Dict, List, Sequence

# Same marker text as lib/uncensored.mjs UNCENSORED_MARK, applied to
# the model's id + label. A text feature, not the policy verdict.
UNCENSORED_MARK = re.compile(
    r"uncensored|heretic|abliterat|dolphin|stheno|rocinante|magnum|"
    r"mythomax|euryale|hermes|miqu", re.IGNORECASE)

AUTHS = ("none", "horde", "bearer", "gemini", "cohere", "anthropic", "hf")
# Auth styles that work with no key at all (lib/models.mjs KEYLESS).
KEYLESS_AUTHS = ("none", "horde")
TOP_K_PROVIDERS = 24


def _one_hot(value: str, choices: Sequence[str]) -> List[float]:
    out = [0.0] * len(choices)
    v = (value or "").strip()
    if v in choices:
        out[choices.index(v)] = 1.0
    else:
        out[-1] = 1.0  # "other" bucket is always the last choice
    return out


class FeatureSpec:
    """Provider vocabulary + layout, learned from the training rows."""

    def __init__(self, providers: Sequence[str] = ()) -> None:
        self.providers = list(providers)

    @property
    def dim(self) -> int:
        return len(self.feature_names())

    def feature_names(self) -> List[str]:
        names: List[str] = []
        names += ["auth:" + a for a in AUTHS] + ["auth:OTHER"]
        names += ["key_required", "key_set", "free", "tools",
                  "has_uncensored_marker"]
        names += ["provider:" + p for p in self.providers] + ["provider:OTHER"]
        return names

    def groups(self) -> Dict[str, tuple]:
        names = self.feature_names()
        idx = {n: i for i, n in enumerate(names)}

        def span(prefix: str):
            hits = [i for n, i in idx.items() if n.startswith(prefix)]
            return (min(hits), max(hits) + 1)

        return {
            "auth": span("auth:"),
            "key_required": (idx["key_required"], idx["key_required"] + 1),
            "key_set": (idx["key_set"], idx["key_set"] + 1),
            "free": (idx["free"], idx["free"] + 1),
            "tools": (idx["tools"], idx["tools"] + 1),
            "has_uncensored_marker": (idx["has_uncensored_marker"],
                                      idx["has_uncensored_marker"] + 1),
            "provider": span("provider:"),
        }

    def to_dict(self) -> Dict:
        return {"providers": self.providers}

    @classmethod
    def from_dict(cls, data: Dict) -> "FeatureSpec":
        return cls(data.get("providers", []))


def build_vocab(rows: Sequence[Dict], top_k: int = TOP_K_PROVIDERS) -> FeatureSpec:
    from collections import Counter
    providers = Counter()
    for row in rows:
        if row.get("provider"):
            providers[str(row["provider"])] += 1
    return FeatureSpec([p for p, _ in providers.most_common(top_k)])


def extract(row: Dict, spec: FeatureSpec) -> List[float]:
    """One dataset row -> feature vector in spec order."""
    vec: List[float] = []
    auth = str(row.get("auth") or "")
    vec += _one_hot(auth, list(AUTHS) + ["OTHER"])
    vec.append(0.0 if auth in KEYLESS_AUTHS else 1.0)
    env_key = row.get("env_key")
    keys_set = row.get("env_keys_set") or []
    vec.append(1.0 if env_key and env_key in keys_set else 0.0)
    vec.append(1.0 if row.get("free") else 0.0)
    vec.append(1.0 if row.get("tools") else 0.0)
    text = f"{row.get('model_id') or ''} {row.get('label_text') or ''}"
    vec.append(1.0 if UNCENSORED_MARK.search(text) else 0.0)
    vec += _one_hot(str(row.get("provider") or ""),
                    list(spec.providers) + ["OTHER"])
    return vec


def top_features(row: Dict, spec: FeatureSpec, net, k: int = 3) -> List[Dict]:
    """Top contributing features for one scored row (leave-one-out)."""
    x = extract(row, spec)
    base = net.predict_proba(x)
    names = spec.feature_names()
    deltas = []
    for i, name in enumerate(names):
        if x[i] == 0.0:
            continue
        x2 = list(x)
        x2[i] = 0.0
        d = base - net.predict_proba(x2)
        deltas.append((abs(d), d, name))
    deltas.sort(reverse=True)
    return [{"feature": name,
             "direction": "up" if d > 0 else "down",
             "delta": round(d, 4)}
            for _abs, d, name in deltas[:k]]
