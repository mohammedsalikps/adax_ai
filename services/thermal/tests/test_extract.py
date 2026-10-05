"""Extraction tests against public FLIR sample files.

The samples (samples/thermal, fetched by scripts/fetch-thermal-samples.mjs) come
from the MIT-licensed FlirImageExtractor repository. They show that the
pipeline works on these files; compatibility with the clinic's own camera is a
separate, still-open check.
"""

import base64
import io
import pathlib
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.radiometric import extract, raw_to_celsius

SAMPLES = pathlib.Path(__file__).resolve().parents[3] / "samples" / "thermal"
client = TestClient(app)

needs_samples = pytest.mark.skipif(
    not (SAMPLES / "flir_example.jpg").exists(), reason="sample images not fetched (run npm run setup)"
)


def post(name: str, data: bytes, content_type: str = "image/jpeg"):
    return client.post("/extract", files={"file": (name, data, content_type)})


@needs_samples
@pytest.mark.parametrize(("name", "shape"), [("ax8.jpg", (60, 80)), ("flir_example.jpg", (320, 240))])
def test_extracts_temperature_matrix_and_settings(name, shape):
    res = post(name, (SAMPLES / name).read_bytes())
    assert res.status_code == 200
    body = res.json()
    assert (body["height"], body["width"]) == shape
    m = np.frombuffer(base64.b64decode(body["matrix"]), dtype="<f4").reshape(shape)
    assert body["minC"] == pytest.approx(float(m.min()), abs=0.01)
    assert body["maxC"] == pytest.approx(float(m.max()), abs=0.01)
    assert 0 < body["parameters"]["emissivity"] <= 1
    assert body["extractor"]["name"] == "flyr"
    assert body["camera"]["make"]


@needs_samples
def test_no_location_data_is_returned():
    body = post("flir_example.jpg", (SAMPLES / "flir_example.jpg").read_bytes()).json()
    assert "gps" not in str(body["camera"]).lower()
    visible = Image.open(io.BytesIO(base64.b64decode(body["visibleJpeg"])))
    assert visible.format == "JPEG"
    assert 0x8825 not in visible.getexif()  # GPSInfo tag stripped by re-encoding


@needs_samples
@pytest.mark.parametrize("name", ["ax8.jpg", "flir_example.jpg"])
def test_flyr_agrees_with_independent_formula(name):
    ex = extract((SAMPLES / name).read_bytes())
    independent = raw_to_celsius(ex.raw, ex.metadata)
    assert np.nanmax(np.abs(independent - ex.celsius.astype(np.float64))) < 0.01


@needs_samples
def test_unsupported_flir_variant_is_rejected_quickly():
    # Little-endian FFF (DJI Zenmuse XT-R): flyr would spin for tens of seconds; the pre-check rejects it.
    start = time.perf_counter()
    res = post("zenmuse_xtr.jpg", (SAMPLES / "zenmuse_xtr.jpg").read_bytes())
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "unsupported_format"
    assert time.perf_counter() - start < 1.0


def test_plain_photo_is_not_radiometric():
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (200, 30, 30)).save(buf, format="JPEG")
    res = post("photo.jpg", buf.getvalue())
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "not_radiometric"


def test_non_jpeg_is_rejected():
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, format="PNG")
    res = post("x.png", buf.getvalue(), "image/png")
    assert res.status_code == 422
    assert res.json()["detail"]["error"] == "invalid_image"


@needs_samples
def test_extract_reports_the_whole_image_standard_deviation():
    body = post("flir_example.jpg", (SAMPLES / "flir_example.jpg").read_bytes()).json()
    m = np.frombuffer(base64.b64decode(body["matrix"]), dtype="<f4").astype(np.float64)
    assert body["stdC"] == pytest.approx(float(m[np.isfinite(m)].std()), abs=0.01)
    assert body["stdC"] > 0


def test_std_is_the_population_std_over_pixels_with_a_reading(monkeypatch):
    from app import main
    from app.radiometric import Extracted

    c = np.array([[30.0, 32.0, np.nan], [34.0, 36.0, np.nan]], dtype=np.float32)
    camera = {"make": None, "model": None, "dateTime": None}
    monkeypatch.setattr(main, "extract", lambda data: Extracted(c, None, {}, camera, None))
    res = post("x.jpg", b"\xff\xd8\xff")
    assert res.status_code == 200
    body = res.json()
    assert (body["minC"], body["maxC"], body["meanC"]) == (30.0, 36.0, 33.0)
    assert body["stdC"] == round(float(np.std([30.0, 32.0, 34.0, 36.0])), 2)
    m = np.frombuffer(base64.b64decode(body["matrix"]), dtype="<f4").reshape(2, 3)
    assert np.isnan(m[0, 2]) and np.isnan(m[1, 2])
