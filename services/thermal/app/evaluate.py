"""Evaluation of an exported ADAXAI thermal dataset.

Reads a dataset ZIP (manifest.json + float32 matrices), forms a reference
label per capture from clinician labels, and reports:

* how the experimental asymmetry rule agrees with those labels, and
* a small logistic-regression baseline with subject-grouped cross-validation,
  trained ONLY when there is enough labelled data; otherwise it says why not.

Nothing here validates anything clinically. The report always says so, and
says prominently when the data is synthetic or otherwise non-clinical.

Usage: python -m app.evaluate dataset.zip [--json report.json] [--md report.md]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import zipfile
from collections import Counter
from dataclasses import dataclass

import numpy as np

from app.flags import RULES_VERSION, FlagParams, FlagsRequest, evaluate
from app.roi import Pair, Roi, encode_matrix

PIPELINE_VERSION = "thermal-eval-v1"
SCHEMA = "adaxai-thermal-dataset/1"
TAXONOMY = "thermal-labels-v1"

# Capture-level finding codes mapped to the binary target used here.
NEGATIVE = {"no_significant_finding"}
POSITIVE = {
    "inflammatory_pattern",
    "infective_pattern",
    "vascular_pattern",
    "musculoskeletal_pattern",
    "other_finding",
}
EXCLUDED = {"uninterpretable"}

# Minimum data before a model is trained at all.
MIN_PER_CLASS = 20
MIN_SUBJECTS = 10
# Below this many cases per class, rule metrics are reported with a warning.
MIN_FOR_ESTIMATES = 10

MAX_MANIFEST_BYTES = 50 * 1024 * 1024
FEATURES = ["maxAbsPairMeanDiffC", "maxAbsPairMaxDiffC", "imageStdC", "maxRoiStdC"]


class DatasetError(Exception):
    pass


@dataclass
class Case:
    id: str
    subject: str
    origin: str
    target: int | None  # 1 positive, 0 negative, None excluded / unlabelled
    rule: int | None  # 1 flagged, 0 not flagged, None no paired regions
    features: list[float]


def wilson(k: int, n: int) -> dict | None:
    """Proportion with a Wilson 95% interval, or None when n == 0."""
    if n == 0:
        return None
    z = 1.959964
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return {
        "value": round(p, 4),
        "k": k,
        "n": n,
        "ci95": [round(max(0.0, centre - half), 4), round(min(1.0, centre + half), 4)],
    }


def auc(y: np.ndarray, score: np.ndarray) -> float | None:
    pos, neg = score[y == 1], score[y == 0]
    if not len(pos) or not len(neg):
        return None
    # Mann-Whitney U with ties counted as half.
    greater = (pos[:, None] > neg[None, :]).sum() + 0.5 * (pos[:, None] == neg[None, :]).sum()
    return round(float(greater / (len(pos) * len(neg))), 4)


def fit_logistic(x: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 3000, lr: float = 0.1):
    """Deterministic L2-regularised logistic regression by gradient descent."""
    mu, sd = x.mean(axis=0), x.std(axis=0)
    sd[sd == 0] = 1.0
    xs = (x - mu) / sd
    w, b, n = np.zeros(x.shape[1]), 0.0, len(y)
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(xs @ w + b)))
        g = p - y
        w -= lr * (xs.T @ g / n + l2 * w / n)
        b -= lr * g.mean()
    return lambda z: 1 / (1 + np.exp(-(((z - mu) / sd) @ w + b)))


def read_dataset(data: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise DatasetError("Not a ZIP file.") from e
    with zf:
        try:
            info = zf.getinfo("manifest.json")
        except KeyError as e:
            raise DatasetError("manifest.json is missing.") from e
        if info.file_size > MAX_MANIFEST_BYTES:
            raise DatasetError("manifest.json is too large.")
        manifest = json.loads(zf.read(info))
        if manifest.get("schema") != SCHEMA:
            raise DatasetError(f"Unsupported dataset schema {manifest.get('schema')!r}; expected {SCHEMA}.")
        matrices = {}
        for c in manifest.get("captures", []):
            w, h = int(c["width"]), int(c["height"])
            try:
                mi = zf.getinfo(c["matrix"])
            except KeyError as e:
                raise DatasetError(f"{c['matrix']} is missing.") from e
            # Check the declared size before decompressing anything.
            if mi.file_size != w * h * 4:
                raise DatasetError(f"{c['matrix']} does not match {w} x {h}.")
            raw = zf.read(mi)
            if hashlib.sha256(raw).hexdigest() != c["matrixSha256"]:
                raise DatasetError(f"{c['matrix']} failed its checksum.")
            matrices[c["id"]] = np.frombuffer(raw, dtype="<f4").reshape(h, w)
    return manifest, matrices


def consensus(labels: list[dict]) -> tuple[str | None, bool]:
    """Binary reference from capture-level labels: ('positive'|'negative'|None, disagreement)."""
    classes = set()
    for lb in labels:
        code = lb["code"]
        classes.add("positive" if code in POSITIVE else "negative" if code in NEGATIVE else "excluded")
    if not classes:
        return None, False
    if len(classes) > 1:
        return None, True
    only = classes.pop()
    return (None if only == "excluded" else only), False


def build_case(c: dict, m: np.ndarray, params: FlagParams) -> tuple[Case, dict]:
    keyed = {r["label"].strip().lower(): r for r in c.get("rois", [])}
    rois = [
        Roi(
            id=k,
            shape=r["shape"],
            x=r["x"],
            y=r["y"],
            width=r["width"],
            height=r["height"],
            points=r.get("points"),
        )
        for k, r in keyed.items()
    ]
    pairs, seen = [], set()
    for k, r in keyed.items():
        other = (r.get("pairWith") or "").strip().lower()
        if other and other in keyed and frozenset((k, other)) not in seen:
            seen.add(frozenset((k, other)))
            pairs.append(Pair(a=k, b=other))
    h, w = m.shape
    flags = evaluate(
        FlagsRequest(width=w, height=h, matrix=encode_matrix(m), rois=rois, pairs=pairs, params=params)
    )
    asym = flags["asymmetry"]
    rule = None if not asym else int(any(a["flagged"] for a in asym))
    pair_stats = c.get("pairs", [])
    mean_diffs = [abs(p["meanDiff"]) for p in pair_stats if p.get("meanDiff") is not None]
    max_diffs = [abs(p["maxDiff"]) for p in pair_stats if p.get("maxDiff") is not None]
    roi_std = [r["stats"]["std"] for r in c.get("rois", []) if r.get("stats", {}).get("std") is not None]
    finite = m[np.isfinite(m)]
    features = [
        max(mean_diffs, default=0.0),
        max(max_diffs, default=0.0),
        float(finite.std()) if finite.size else 0.0,
        max(roi_std, default=0.0),
    ]
    capture_labels = [lb for lb in c.get("labels", []) if lb.get("scope") == "capture"]
    ref, disagree = consensus(capture_labels)
    target = None if ref is None else int(ref == "positive")
    case = Case(c["id"], c["subject"], c.get("dataOrigin", "unknown"), target, rule, features)
    return case, {"labels": capture_labels, "disagreement": disagree}


def rule_metrics(cases: list[Case], params: FlagParams) -> dict:
    usable = [c for c in cases if c.target is not None]
    applicable = [c for c in usable if c.rule is not None]
    tp = sum(1 for c in applicable if c.rule == 1 and c.target == 1)
    fp = sum(1 for c in applicable if c.rule == 1 and c.target == 0)
    tn = sum(1 for c in applicable if c.rule == 0 and c.target == 0)
    fn = sum(1 for c in applicable if c.rule == 0 and c.target == 1)
    warnings = []
    if tp + fn < MIN_FOR_ESTIMATES or tn + fp < MIN_FOR_ESTIMATES:
        warnings.append(
            f"Fewer than {MIN_FOR_ESTIMATES} positive or negative reference cases: the estimates below are "
            "not meaningful (see the width of the intervals)."
        )
    if len(usable) > len(applicable):
        warnings.append(
            f"{len(usable) - len(applicable)} labelled capture(s) had no paired regions; "
            "the rule cannot apply."
        )
    return {
        "rule": f"Mean temperature difference ≥ {params.asymmetry_threshold_c} °C between any paired regions",
        "rulesVersion": RULES_VERSION,
        "applicable": len(applicable),
        "notApplicable": len(usable) - len(applicable),
        "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "sensitivity": wilson(tp, tp + fn),
        "specificity": wilson(tn, tn + fp),
        "ppv": wilson(tp, tp + fp),
        "npv": wilson(tn, tn + fn),
        "warnings": warnings,
    }


def model_metrics(cases: list[Case]) -> dict:
    usable = [c for c in cases if c.target is not None]
    pos = sum(c.target for c in usable)
    neg = len(usable) - pos
    subjects = sorted({c.subject for c in usable})
    base = {
        "type": "logistic_regression",
        "features": FEATURES,
        "positives": pos,
        "negatives": neg,
        "subjects": len(subjects),
    }
    if pos < MIN_PER_CLASS or neg < MIN_PER_CLASS or len(subjects) < MIN_SUBJECTS:
        return {
            **base,
            "status": "skipped",
            "reason": (
                f"Insufficient labelled data: {pos} positive and {neg} negative captures "
                f"from {len(subjects)} subjects; at least {MIN_PER_CLASS} of each class from {MIN_SUBJECTS} "
                "subjects are required before any model is trained."
            ),
        }
    x = np.array([c.features for c in usable], dtype=np.float64)
    y = np.array([c.target for c in usable], dtype=np.float64)
    k = min(5, len(subjects))
    fold_of = {s: i % k for i, s in enumerate(subjects)}
    scores = np.zeros(len(usable))
    for f in range(k):
        test = np.array([fold_of[c.subject] == f for c in usable])
        train = ~test
        if len(set(y[train])) < 2:
            return {**base, "status": "skipped", "reason": "A training fold contained a single class."}
        scores[test] = fit_logistic(x[train], y[train])(x[test])
    pred = (scores >= 0.5).astype(int)
    tp = int(((pred == 1) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    return {
        **base,
        "status": "trained",
        "validation": (
            f"{k}-fold cross-validation grouped by subject (no subject in both training and test folds)"
        ),
        "auc": auc(y, scores),
        "sensitivity": wilson(tp, int(y.sum())),
        "specificity": wilson(tn, int((1 - y).sum())),
        "threshold": 0.5,
    }


def evaluate_dataset(data: bytes, params: FlagParams | None = None) -> dict:
    params = params or FlagParams()
    manifest, matrices = read_dataset(data)
    if manifest.get("taxonomyVersion") != TAXONOMY:
        raise DatasetError(
            f"Unsupported label taxonomy {manifest.get('taxonomyVersion')!r}; expected {TAXONOMY}."
        )
    cases, disagreements, multi, multi_agree = [], 0, 0, 0
    label_counts: Counter[str] = Counter()
    for c in manifest["captures"]:
        case, info = build_case(c, matrices[c["id"]], params)
        cases.append(case)
        label_counts.update(lb["code"] for lb in info["labels"])
        raters = {lb["rater"] for lb in info["labels"]}
        if len(raters) > 1:
            multi += 1
            multi_agree += 0 if info["disagreement"] else 1
        disagreements += int(info["disagreement"])
    origins = Counter(c.origin for c in cases)
    non_clinical = any(o != "clinical" for o in origins) or not cases
    labelled = [c for c in cases if c.target is not None]
    statements = [
        "Not clinically validated. These figures describe agreement with clinician labels in this "
        "dataset only; they are not evidence of diagnostic accuracy.",
    ]
    if non_clinical:
        statements.insert(
            0,
            "This dataset contains synthetic, demonstration or public sample data (non-clinical). "
            "The metrics show that the pipeline runs; they say nothing about clinical performance.",
        )
    return {
        "pipelineVersion": PIPELINE_VERSION,
        "validated": False,
        "nonClinical": non_clinical,
        "statements": statements,
        "dataset": {
            "exportId": manifest.get("exportId"),
            "schema": manifest.get("schema"),
            "taxonomyVersion": manifest.get("taxonomyVersion"),
            "captures": len(cases),
            "subjects": len({c.subject for c in cases}),
            "dataOrigins": dict(origins),
            "labelCounts": dict(label_counts),
            "reference": {
                "positive": sum(1 for c in labelled if c.target == 1),
                "negative": sum(1 for c in labelled if c.target == 0),
                "unusable": len(cases) - len(labelled),
                "raterDisagreements": disagreements,
            },
            "raterAgreement": {"capturesWithMultipleRaters": multi, "agreed": multi_agree},
        },
        "ruleEvaluation": rule_metrics(cases, params),
        "model": model_metrics(cases),
    }


def _pct(m: dict | None) -> str:
    if not m:
        return "n/a"
    lo, hi = m["ci95"]
    return f"{m['value'] * 100:.1f}% ({m['k']}/{m['n']}; 95% CI {lo * 100:.1f}–{hi * 100:.1f}%)"


def to_markdown(r: dict) -> str:
    d, rule, model = r["dataset"], r["ruleEvaluation"], r["model"]
    lines = ["# Thermal dataset evaluation", ""]
    lines += [f"> **{s}**" for s in r["statements"]]
    lines += [
        "",
        f"Pipeline {r['pipelineVersion']}, rules {rule['rulesVersion']}, export {d['exportId']}.",
        "",
        "## Dataset",
        f"- Captures: {d['captures']} from {d['subjects']} subjects",
        f"- Data origin: {', '.join(f'{k} {v}' for k, v in d['dataOrigins'].items()) or 'none'}",
        f"- Reference labels: {d['reference']['positive']} positive, {d['reference']['negative']} negative, "
        f"{d['reference']['unusable']} unlabelled/excluded "
        f"({d['reference']['raterDisagreements']} rater disagreements)",
        "",
        "## Experimental asymmetry rule",
        f"Rule: {rule['rule']}. Applicable to {rule['applicable']} labelled captures.",
        f"- Confusion: TP {rule['confusion']['tp']}, FP {rule['confusion']['fp']}, "
        f"TN {rule['confusion']['tn']}, FN {rule['confusion']['fn']}",
        f"- Sensitivity: {_pct(rule['sensitivity'])}",
        f"- Specificity: {_pct(rule['specificity'])}",
    ]
    lines += [f"- Warning: {w}" for w in rule["warnings"]]
    lines += ["", "## Baseline model"]
    if model["status"] == "trained":
        lines += [
            f"Logistic regression on {', '.join(model['features'])}; {model['validation']}.",
            f"- AUC: {model['auc']}",
            f"- Sensitivity: {_pct(model['sensitivity'])}",
            f"- Specificity: {_pct(model['specificity'])}",
        ]
    else:
        lines.append(f"Not trained. {model['reason']}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dataset")
    ap.add_argument("--json", dest="json_out")
    ap.add_argument("--md", dest="md_out")
    a = ap.parse_args()
    with open(a.dataset, "rb") as f:
        report = evaluate_dataset(f.read())
    if a.json_out:
        with open(a.json_out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
    md = to_markdown(report)
    if a.md_out:
        with open(a.md_out, "w", encoding="utf-8") as f:
            f.write(md)
    print(md)


if __name__ == "__main__":
    main()
