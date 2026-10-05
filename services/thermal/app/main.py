"""ADAXAI thermal service.

Stateless by design: it never connects to the database. The API sends it a
file or a matrix over localhost HTTP and stores the results itself.

Measurements only. Nothing here is a diagnosis or a validated clinical tool.
"""

import base64
import platform
from typing import Annotated

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from app import __version__
from app.evaluate import DatasetError, evaluate_dataset, to_markdown
from app.flags import FlagsRequest, evaluate
from app.images import ImageRejected
from app.images import inspect as inspect_image
from app.model import status as model_status
from app.radiometric import ExtractionError, extract, extractor_info, parameters
from app.roi import RoiStatsRequest, compute, encode_matrix

MAX_FILE_BYTES = 30 * 1024 * 1024
MAX_DATASET_BYTES = 500 * 1024 * 1024

app = FastAPI(
    title="ADAXAI Thermal Service",
    version=__version__,
    docs_url="/docs",
    redoc_url=None,
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "thermal",
        "version": __version__,
        "python": platform.python_version(),
        "capabilities": [
            "flir_radiometric_jpeg",
            "roi_stats",
            "experimental_flags",
            "dataset_evaluation",
            "image_inspect",
        ],
    }


@app.post("/extract")
async def extract_endpoint(file: Annotated[UploadFile, File()]) -> dict:
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413, detail={"error": "too_large", "message": "File is larger than 30 MB."}
        )
    try:
        ex = extract(data)
    except ExtractionError as e:
        raise HTTPException(status_code=422, detail={"error": e.code, "message": e.message}) from e
    c = ex.celsius
    finite = c[np.isfinite(c)]
    return {
        "radiometric": True,
        "width": int(c.shape[1]),
        "height": int(c.shape[0]),
        "minC": round(float(finite.min()), 2),
        "maxC": round(float(finite.max()), 2),
        "meanC": round(float(finite.mean()), 2),
        # Population standard deviation over the pixels with a reading.
        "stdC": round(float(finite.astype(np.float64).std()), 2),
        "matrixEncoding": "float32-le-base64",
        "matrix": encode_matrix(c),
        "camera": ex.camera,
        "parameters": parameters(ex.metadata),
        "visibleJpeg": base64.b64encode(ex.visible_jpeg).decode("ascii") if ex.visible_jpeg else None,
        "extractor": extractor_info(),
    }


@app.get("/model/status")
def model_status_endpoint() -> dict:
    """Whether a thermal model is installed. None is, and the answer says so."""
    return model_status()


@app.post("/roi-stats")
def roi_stats(req: RoiStatsRequest) -> dict:
    try:
        return compute(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"error": "invalid_matrix", "message": str(e)}) from e


@app.post("/flags")
def flags(req: FlagsRequest) -> dict:
    """Experimental rule-based flags (not validated, not diagnostic)."""
    try:
        return evaluate(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"error": "invalid_matrix", "message": str(e)}) from e


@app.post("/evaluate")
async def evaluate_endpoint(file: Annotated[UploadFile, File()]) -> dict:
    """Evaluate an exported dataset ZIP. Never a clinical validation; the report says so."""
    data = await file.read(MAX_DATASET_BYTES + 1)
    if len(data) > MAX_DATASET_BYTES:
        raise HTTPException(
            status_code=413, detail={"error": "too_large", "message": "Dataset is larger than 500 MB."}
        )
    try:
        report = evaluate_dataset(data)
    except (DatasetError, KeyError, ValueError, TypeError) as e:
        msg = str(e) if isinstance(e, DatasetError) else f"The dataset is malformed ({type(e).__name__})."
        raise HTTPException(status_code=422, detail={"error": "invalid_dataset", "message": msg}) from e
    return {"report": report, "markdown": to_markdown(report)}


@app.post("/image/inspect")
async def image_inspect(
    file: Annotated[UploadFile, File()],
    allowed: Annotated[str, Form()] = "image/jpeg,image/png,image/webp",
    max_pixels: Annotated[int, Form(gt=0, le=200_000_000)] = 40_000_000,
    preview_max_side: Annotated[int, Form(ge=64, le=8192)] = 2048,
) -> dict:
    """Validates a clinical photograph and returns a metadata-free preview."""
    data = await file.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413, detail={"error": "too_large", "message": "File is larger than 30 MB."}
        )
    try:
        r = inspect_image(data, set(allowed.split(",")), max_pixels, preview_max_side)
    except ImageRejected as e:
        raise HTTPException(status_code=422, detail={"error": e.code, "message": e.message}) from e
    return {
        "format": r.format,
        "mimeType": r.mime_type,
        "width": r.width,
        "height": r.height,
        "hadExif": r.had_exif,
        "hadGps": r.had_gps,
        "preview": base64.b64encode(r.preview_jpeg).decode("ascii"),
        "previewWidth": r.preview_width,
        "previewHeight": r.preview_height,
    }
