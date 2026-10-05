"""Tests of the dataset evaluator on SYNTHETIC datasets generated here."""

import hashlib
import io
import json
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.evaluate import DatasetError, consensus, evaluate_dataset, to_markdown, wilson
from app.main import app

client = TestClient(app)
W, H = 20, 10


def capture(
    i: int, subject: str, diff: float, codes: list[str], origin: str = "synthetic", paired: bool = True
):
    m = np.full((H, W), 30.0, dtype=np.float32)
    m[:, : W // 2] += diff  # left half warmer by `diff`
    rois = [
        {
            "label": "Left",
            "shape": "rect",
            "x": 0,
            "y": 0,
            "width": W / 2,
            "height": H,
            "pairWith": "Right" if paired else None,
            "stats": {"std": 0.0},
        },
        {
            "label": "Right",
            "shape": "rect",
            "x": W / 2,
            "y": 0,
            "width": W / 2,
            "height": H,
            "pairWith": None,
            "stats": {"std": 0.0},
        },
    ]
    entry = {
        "id": f"C{i:04d}",
        "subject": subject,
        "dataOrigin": origin,
        "width": W,
        "height": H,
        "matrix": f"matrices/C{i:04d}.f32",
        "rois": rois,
        "pairs": [{"a": "Left", "b": "Right", "meanDiff": diff, "maxDiff": diff}] if paired else [],
        "labels": [
            {
                "rater": f"R{j + 1}",
                "scope": "capture",
                "roi": None,
                "code": c,
                "referenceStandard": "clinical_impression",
            }
            for j, c in enumerate(codes)
        ],
    }
    return entry, m


def dataset(entries, schema="adaxai-thermal-dataset/1", corrupt=False) -> bytes:
    buf = io.BytesIO()
    caps = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for entry, m in entries:
            raw = m.astype("<f4").tobytes()
            z.writestr(entry["matrix"], raw)
            caps.append({**entry, "matrixSha256": hashlib.sha256(b"x" if corrupt else raw).hexdigest()})
        z.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": schema,
                    "exportId": "test",
                    "taxonomyVersion": "thermal-labels-v1",
                    "captures": caps,
                }
            ),
        )
    return buf.getvalue()


def small():
    return [
        capture(1, "S001", 2.0, ["inflammatory_pattern"]),
        capture(2, "S002", 0.2, ["no_significant_finding"]),
        capture(3, "S003", 1.5, ["no_significant_finding"]),  # rule false positive
        capture(4, "S004", 0.1, ["infective_pattern", "no_significant_finding"]),  # raters disagree
        capture(5, "S005", 3.0, []),  # unlabelled
        capture(6, "S006", 0.0, ["uninterpretable"]),
        capture(7, "S007", 0.0, ["no_significant_finding"], paired=False),
    ]


def test_wilson_interval():
    assert wilson(0, 0) is None
    w = wilson(8, 10)
    assert w["value"] == 0.8
    assert w["ci95"] == [0.4902, 0.9433]


def test_consensus_rules():
    assert consensus([]) == (None, False)
    assert consensus([{"code": "inflammatory_pattern"}, {"code": "other_finding"}]) == ("positive", False)
    assert consensus([{"code": "inflammatory_pattern"}, {"code": "no_significant_finding"}]) == (None, True)
    assert consensus([{"code": "uninterpretable"}]) == (None, False)


def test_small_synthetic_dataset_reports_rule_agreement_and_refuses_to_train():
    r = evaluate_dataset(dataset(small()))
    assert r["validated"] is False
    assert r["nonClinical"] is True
    assert "synthetic" in r["statements"][0]
    d = r["dataset"]
    assert d["captures"] == 7 and d["subjects"] == 7
    assert d["reference"] == {"positive": 1, "negative": 3, "unusable": 3, "raterDisagreements": 1}
    assert d["raterAgreement"] == {"capturesWithMultipleRaters": 1, "agreed": 0}
    rule = r["ruleEvaluation"]
    assert rule["confusion"] == {"tp": 1, "fp": 1, "tn": 1, "fn": 0}
    assert rule["applicable"] == 3 and rule["notApplicable"] == 1
    assert rule["sensitivity"]["value"] == 1.0
    assert rule["specificity"]["value"] == 0.5
    assert any("not meaningful" in w for w in rule["warnings"])
    assert r["model"]["status"] == "skipped"
    assert "Insufficient labelled data" in r["model"]["reason"]
    md = to_markdown(r)
    assert "non-clinical" in md and "Not trained" in md


def test_trains_a_baseline_only_with_enough_data_and_groups_folds_by_subject():
    rng = np.random.default_rng(7)
    entries = []
    for i in range(60):
        positive = i % 2 == 0
        diff = float(rng.normal(2.0 if positive else 0.3, 0.4))
        # Two captures per subject so grouping matters.
        entries.append(
            capture(i, f"S{i // 2:03d}", diff, ["vascular_pattern" if positive else "no_significant_finding"])
        )
    r = evaluate_dataset(dataset(entries))
    m = r["model"]
    assert m["status"] == "trained"
    assert m["subjects"] == 30
    assert "grouped by subject" in m["validation"]
    assert m["auc"] > 0.8
    # Still synthetic, still not validated.
    assert r["nonClinical"] and not r["validated"]


def test_clinical_origin_drops_the_synthetic_statement_but_never_claims_validation():
    r = evaluate_dataset(dataset([capture(1, "S1", 2.0, ["inflammatory_pattern"], origin="clinical")]))
    assert r["nonClinical"] is False
    assert len(r["statements"]) == 1 and "Not clinically validated" in r["statements"][0]


def test_rejects_malformed_datasets():
    with pytest.raises(DatasetError, match="ZIP"):
        evaluate_dataset(b"not a zip")
    with pytest.raises(DatasetError, match="schema"):
        evaluate_dataset(dataset(small(), schema="other/9"))
    with pytest.raises(DatasetError, match="checksum"):
        evaluate_dataset(dataset(small(), corrupt=True))


def test_evaluate_endpoint():
    res = client.post("/evaluate", files={"file": ("d.zip", dataset(small()), "application/zip")})
    assert res.status_code == 200
    assert res.json()["report"]["model"]["status"] == "skipped"
    assert res.json()["markdown"].startswith("# Thermal dataset evaluation")
    bad = client.post("/evaluate", files={"file": ("d.zip", b"nope", "application/zip")})
    assert bad.status_code == 422
    assert bad.json()["detail"]["error"] == "invalid_dataset"


def test_a_polygon_region_in_an_export_keeps_its_corners_and_builds_a_case():
    # V6: a region drawn as a polygon is exported with its corners, and the evaluator builds it
    # (before, it refused the whole dataset).
    from app.evaluate import build_case
    from app.flags import FlagParams

    m = np.full((H, W), 30.0, dtype=np.float32)
    c = {
        "id": "case-1",
        "subject": "S1",
        "rois": [
            {
                "label": "Knee",
                "shape": "polygon",
                "x": 1,
                "y": 1,
                "width": 8,
                "height": 6,
                "points": [[1, 1], [9, 1], [5, 7]],
                "pairWith": None,
                "stats": {},
            },
        ],
    }
    case, _ = build_case(c, m, FlagParams())
    assert case.id == "case-1"
