import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.roi import Roi, encode_matrix, roi_mask

client = TestClient(app)


def matrix() -> np.ndarray:
    # 10 x 10: left half 30.0 C, right half 34.0 C, one hot pixel 40.0 at (row 2, col 7).
    m = np.full((10, 10), 30.0, dtype=np.float32)
    m[:, 5:] = 34.0
    m[2, 7] = 40.0
    return m


def body(rois, pairs=()):
    m = matrix()
    return {"width": 10, "height": 10, "matrix": encode_matrix(m), "rois": rois, "pairs": list(pairs)}


def test_rectangle_stats_are_exact():
    res = client.post(
        "/roi-stats", json=body([{"id": "L", "shape": "rect", "x": 0, "y": 0, "width": 5, "height": 10}])
    )
    assert res.status_code == 200
    assert res.json()["rois"][0]["stats"] == {
        "pixelCount": 50,
        "min": 30.0,
        "max": 30.0,
        "mean": 30.0,
        "std": 0.0,
    }


def test_right_half_includes_the_hot_pixel():
    res = client.post(
        "/roi-stats", json=body([{"id": "R", "shape": "rect", "x": 5, "y": 0, "width": 5, "height": 10}])
    )
    s = res.json()["rois"][0]["stats"]
    assert s["pixelCount"] == 50
    assert s["max"] == 40.0
    assert s["mean"] == round((49 * 34 + 40) / 50, 2)


def test_paired_regions_report_differences():
    rois = [
        {"id": "L", "shape": "rect", "x": 0, "y": 0, "width": 5, "height": 10},
        {"id": "R", "shape": "rect", "x": 5, "y": 0, "width": 5, "height": 10},
    ]
    res = client.post("/roi-stats", json=body(rois, [{"a": "R", "b": "L"}]))
    pair = res.json()["pairs"][0]
    assert pair == {"a": "R", "b": "L", "meanDiff": round((49 * 34 + 40) / 50 - 30, 2), "maxDiff": 10.0}


def test_ellipse_uses_pixel_centres_inside_the_inscribed_ellipse():
    mask = roi_mask((10, 10), Roi(id="e", shape="ellipse", x=0, y=0, width=10, height=10))
    # A circle of radius 5 over a 10x10 grid covers 80 pixel centres.
    assert int(mask.sum()) == 80
    assert not mask[0, 0] and mask[5, 5]


def test_invalid_requests_are_rejected():
    bad_size = body([{"id": "a", "shape": "rect", "x": 0, "y": 0, "width": 1, "height": 1}])
    bad_size["width"] = 11
    assert client.post("/roi-stats", json=bad_size).status_code == 422
    dup = body([{"id": "a", "shape": "rect", "x": 0, "y": 0, "width": 1, "height": 1}] * 2)
    assert client.post("/roi-stats", json=dup).status_code == 422
    bad_pair = body(
        [{"id": "a", "shape": "rect", "x": 0, "y": 0, "width": 1, "height": 1}], [{"a": "a", "b": "zz"}]
    )
    assert client.post("/roi-stats", json=bad_pair).status_code == 422


# ---- V6: polygons and pixels without a reading -------------------------------------------------------------


def expected(shape, pixels):
    m = np.zeros(shape, dtype=bool)
    for x, y in pixels:
        m[y, x] = True
    return m


def test_polygon_mask_is_the_pixel_centres_inside_an_l_shape():
    # Corners on whole pixels, so no pixel centre (at .5) lies on an edge: the mask is exactly
    # columns 1-6 of rows 1-2 plus columns 1-2 of rows 3-7.
    points = [(1, 1), (7, 1), (7, 3), (3, 3), (3, 8), (1, 8)]
    mask = roi_mask((10, 10), Roi(id="L", shape="polygon", x=1, y=1, width=6, height=7, points=points))
    want = expected(
        (10, 10),
        [(x, y) for y in (1, 2) for x in range(1, 7)] + [(x, y) for y in range(3, 8) for x in (1, 2)],
    )
    assert int(mask.sum()) == 22
    assert np.array_equal(mask, want)
    # The order of the corners (clockwise or not) does not matter.
    reverse = Roi(id="R", shape="polygon", x=1, y=1, width=6, height=7, points=list(reversed(points)))
    assert np.array_equal(roi_mask((10, 10), reverse), want)


def test_polygon_mask_of_a_triangle_by_hand():
    # Right triangle with legs of 4.5 px: a centre (x + 0.5, y + 0.5) is inside when x + y + 1 < 4.5,
    # i.e. x + y <= 3 (no centre is on the long edge).
    tri = Roi(id="t", shape="polygon", x=0, y=0, width=4.5, height=4.5, points=[(0, 0), (4.5, 0), (0, 4.5)])
    mask = roi_mask((6, 6), tri)
    assert np.array_equal(mask, expected((6, 6), [(x, y) for y in range(6) for x in range(6) if x + y <= 3]))
    assert int(mask.sum()) == 10


def test_polygon_stats_through_the_endpoint():
    # L-shape over the left half (30 C) and into the right half (34 C) of the 10 x 10 test matrix.
    points = [[3, 0], [7, 0], [7, 2], [5, 2], [5, 4], [3, 4]]
    res = client.post(
        "/roi-stats",
        json=body(
            [{"id": "p", "shape": "polygon", "x": 3, "y": 0, "width": 4, "height": 4, "points": points}]
        ),
    )
    assert res.status_code == 200
    s = res.json()["rois"][0]["stats"]
    # Rows 0-1: columns 3-6 (3, 4 at 30 C; 5, 6 at 34 C); rows 2-3: columns 3-4 (30 C).
    values = [30, 30, 34, 34] * 2 + [30, 30] * 2
    assert s["pixelCount"] == 12
    assert s["min"] == 30.0 and s["max"] == 34.0
    assert s["mean"] == round(float(np.mean(values)), 2)
    assert s["std"] == round(float(np.std(values)), 2)


def test_pixels_without_a_reading_are_left_out_of_every_statistic():
    m = matrix()
    m[0:5, 0:2] = np.nan  # 10 pixels of the left half have no reading
    m[8:10, 8:10] = np.nan  # a whole small region without a reading
    rois = [
        {"id": "L", "shape": "rect", "x": 0, "y": 0, "width": 5, "height": 10},
        {"id": "E", "shape": "rect", "x": 8, "y": 8, "width": 2, "height": 2},
        {
            "id": "P",
            "shape": "polygon",
            "x": 0,
            "y": 0,
            "width": 4,
            "height": 4,
            "points": [[0, 0], [4, 0], [4, 4], [0, 4]],
        },
    ]
    req = {
        "width": 10,
        "height": 10,
        "matrix": encode_matrix(m),
        "rois": rois,
        "pairs": [{"a": "L", "b": "E"}],
    }
    res = client.post("/roi-stats", json=req)
    assert res.status_code == 200
    by_id = {r["id"]: r["stats"] for r in res.json()["rois"]}
    assert by_id["L"] == {"pixelCount": 40, "min": 30.0, "max": 30.0, "mean": 30.0, "std": 0.0}
    assert by_id["E"] == {"pixelCount": 0, "min": None, "max": None, "mean": None, "std": None}
    # 4 x 4 square: 16 pixels, of which columns 0-1 of rows 0-3 (8) have no reading.
    assert by_id["P"]["pixelCount"] == 8
    assert res.json()["pairs"] == [{"a": "L", "b": "E", "meanDiff": None, "maxDiff": None}]


def test_flags_accept_polygons_and_missing_readings():
    m = matrix()
    m[0:3, 0:3] = np.nan
    rois = [
        {
            "id": "a",
            "shape": "polygon",
            "x": 0,
            "y": 0,
            "width": 5,
            "height": 10,
            "points": [[0, 0], [5, 0], [5, 10], [0, 10]],
        },
        {"id": "b", "shape": "rect", "x": 5, "y": 0, "width": 5, "height": 10},
    ]
    req = {
        "width": 10,
        "height": 10,
        "matrix": encode_matrix(m),
        "rois": rois,
        "pairs": [{"a": "b", "b": "a"}],
    }
    res = client.post("/flags", json=req)
    assert res.status_code == 200
    assert res.json()["asymmetry"][0]["meanDiffC"] == round((49 * 34 + 40) / 50 - 30, 2)


def test_polygon_points_must_match_the_shape():
    poly = {"id": "a", "shape": "polygon", "x": 0, "y": 0, "width": 2, "height": 2}
    assert client.post("/roi-stats", json=body([poly])).status_code == 422
    assert client.post("/roi-stats", json=body([{**poly, "points": [[0, 0], [2, 2]]}])).status_code == 422
    rect = {
        "id": "r",
        "shape": "rect",
        "x": 0,
        "y": 0,
        "width": 2,
        "height": 2,
        "points": [[0, 0], [2, 0], [2, 2]],
    }
    assert client.post("/roi-stats", json=body([rect])).status_code == 422
