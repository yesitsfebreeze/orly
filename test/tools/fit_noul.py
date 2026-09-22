#!/usr/bin/env python3
"""Fit the threshold for one JEV `noul` question against labelled examples.

A noul ranks well and scales badly: on a 16-case run the ranking was perfect
and a 0.5 cut scored 4/16. The cut is a property of the question's wording,
not of the model, so it has to be fitted per question and refitted whenever
the wording changes.

Usage:
    fit_noul.py cases.jsonl "Rate: <the instruction, exactly as the hook sends it>"

cases.jsonl, one per line:
    {"text": "clean this up", "label": 1}          # 1 = the noul should fire
    {"text": "fix the typo on line 12", "label": 0}

The key comes from JEV_API_KEY, else the macOS keychain (svce=kern), else the
pass store named by PASSWORD_STORE_DIR. `state` is {"text": ...}; pass
--state-key to name the field your own question reads instead.
"""

import json
import subprocess
import sys
import urllib.request

URL = "https://api.typesafe.ai/v1/systemone"


def key() -> str:
    import os

    if os.environ.get("JEV_API_KEY"):
        return os.environ["JEV_API_KEY"]
    for cmd in (
        ["security", "find-generic-password", "-a", "typesafe/api-key", "-s", "kern", "-w"],
        ["pass", "show", "typesafe/api-key"],
    ):
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.split("\n")[0].strip()
    sys.exit("no key: set JEV_API_KEY, or store typesafe/api-key in the keychain or a pass store")


def noul(text: str, instructions: str, bearer: str, state_key: str) -> float:
    body = {
        "model": "jev-latest",
        "state": {state_key: text},
        # No `escalate` here: it is a kern-side flag (src/memory/decide/mod.rs `weak()`)
        # that forces a question past the local head. JEV ignores it — a paired run
        # over 8 cases moved scores by mean 0.010, inside this model's own drift.
        "questions": {"q": {"type": "noul", "instructions": instructions}},
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["answers"]["q"]["noul"]


def auc(pos: list[float], neg: list[float]) -> float:
    """P(a positive outranks a negative), ties counting half. 1.0 is separation."""
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def cut(pos: list[float], neg: list[float]) -> tuple[float, str]:
    """Separated: the midpoint of the gap. Overlapping: the best Youden J."""
    if min(pos) > max(neg):
        return (min(pos) + max(neg)) / 2, f"midpoint of a clean gap ({max(neg):.2f} .. {min(pos):.2f})"
    best, score = 0.5, -1.0
    for t in sorted({round(v, 2) for v in pos + neg}):
        j = sum(p >= t for p in pos) / len(pos) - sum(n >= t for n in neg) / len(neg)
        if j > score:
            best, score = t, j
    return best, f"best Youden J = {score:.2f}; the classes overlap, so this cut costs errors"


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cases = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
    instructions = sys.argv[2]
    state_key = sys.argv[3] if len(sys.argv) > 3 else "text"
    bearer = key()

    scored = []
    for c in cases:
        n = noul(c["text"], instructions, bearer, state_key)
        scored.append((n, int(c["label"]), c["text"]))
        print(f'{("FIRE" if c["label"] else "quiet"):>5}  {n:.2f}  {c["text"][:60]}')

    pos = [n for n, lab, _ in scored if lab]
    neg = [n for n, lab, _ in scored if not lab]
    if not pos or not neg:
        sys.exit("\nboth labels are needed to fit a threshold")

    t, why = cut(pos, neg)
    print(f"\nfire  n={len(pos)}  min={min(pos):.2f}  max={max(pos):.2f}")
    print(f"quiet n={len(neg)}  min={min(neg):.2f}  max={max(neg):.2f}")
    print(f"AUC {auc(pos, neg):.3f}   (1.000 = the ranking is perfect; the cut is then only a scaling choice)")
    print(f"threshold {t:.2f} — {why}")
    at_half = sum(n >= 0.5 for n in pos) + sum(n < 0.5 for n in neg)
    at_fit = sum(n >= t for n in pos) + sum(n < t for n in neg)
    print(f"accuracy at 0.5: {at_half}/{len(scored)}   at {t:.2f}: {at_fit}/{len(scored)}")
    if min(pos) - max(neg) < 0.05 and min(pos) > max(neg):
        print("gap is under 0.05 — separated, but too thin to trust from this many cases; add more")


if __name__ == "__main__":
    main()
