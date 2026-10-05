from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_no_thermal_model_is_installed_and_the_status_says_so():
    res = client.get("/model/status")
    assert res.status_code == 200
    assert res.json() == {
        "available": False,
        "kind": None,
        "modelId": None,
        "version": None,
        "artifactSha256": None,
        "intendedUse": None,
        "evaluation": None,
        "reason": "No trained thermal model is installed.",
    }
