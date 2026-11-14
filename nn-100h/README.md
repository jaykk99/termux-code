# termux-code NN, 100h training

Predicts whether a registry model is listed by `directModels(env)`
under an env configuration. Pre-check / ranker only: `directModels()`
stays the authority, this never enables a model.

## Run
```bash
cd nn-100h
python3 train.py --resume --max-run-hours 5.5
```
Pure Python stdlib, no new dependencies. Checkpoints every 20
epochs to `checkpoints/`, cumulative hours in `status.json`,
per-experiment honest metrics in `experiments.jsonl`, best weights
in `best.json`.

## Honest split
Grouped leave-models-out (see DATASET.md): 9 models held out, 37
train. The label is a deterministic rule, so the random-split
1.000 from the Nov 14 PR #25 build is rule reproduction, not a win.
The grouped-test accuracy is the number that matters.

## GitHub Actions
`.github/workflows/nn-100h.yml` runs 5.5h chunks (under the 6h job
cap), commits checkpoints back to this branch, and self-chains the
next run until `status.json` reaches 100h. Public repo, so Actions
minutes are free. No manual restarts.
