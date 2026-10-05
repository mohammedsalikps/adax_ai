"""Thermal model status.

No trained thermal model is installed in this service, so the status says so: `available` is false and
every identifier is empty. The logistic-regression baseline in the evaluation pipeline (app/evaluate.py) is
a measurement of an exported dataset, trained and discarded within one evaluation run; it is not installed
and is not a model the product uses. A real model would be described here by its id, version, the SHA-256
of its weights, what it is (real, research or simulation), its intended use and its evaluation, and only
then could anything show its output.
"""

NO_MODEL_REASON = "No trained thermal model is installed."


def status() -> dict:
    return {
        "available": False,
        "kind": None,
        "modelId": None,
        "version": None,
        "artifactSha256": None,
        "intendedUse": None,
        "evaluation": None,
        "reason": NO_MODEL_REASON,
    }
