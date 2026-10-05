// Unit tests (node --test) of the pure logic behind the doctor's thermal views (V6): which pixels a polygon region measures (the even-odd rule
// the thermal service uses, pixel centres, pixels without a reading left out), how a pixel without a reading is worded and drawn, the source
// label every capture carries, when a summary may be composed (an approved image only), and when a reviewed summary may be offered for the
// note. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { simulateThermalMatrix, THERMAL_SIM_SIZE, thermalStats } from '@adaxai/contracts'
import { boxPolygon, canAddThermalSummary, canComposeThermalSummary, countNonFinite, fmtC, fmtReading, NO_READING_RGB, noReadingShade, pointInPolygon, polygonBounds, type RoiPoint, roiPreviewStats, thermalSourceLabel, thermalSummaryDecision } from '../src/lib/thermal.ts'

/** The thermal service's mask, written the way it is there (each edge from point i to i + 1, horizontal edges skipped), as a reference. */
function serviceMask(w: number, h: number, pts: RoiPoint[]): boolean[] {
  const out: boolean[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      let inside = false
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i]!
        const [x2, y2] = pts[(i + 1) % pts.length]!
        if (y1 === y2) continue
        const crosses = (y1 > cy) !== (y2 > cy)
        if (crosses && cx < x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside
      }
      out.push(inside)
    }
  }
  return out
}
const clientMask = (w: number, h: number, pts: RoiPoint[]) => Array.from({ length: w * h }, (_, i) => pointInPolygon((i % w) + 0.5, Math.floor(i / w) + 0.5, pts))

const STAR: RoiPoint[] = Array.from({ length: 5 }, (_, k) => {
  const a = ((-90 + k * 144) * Math.PI) / 180
  return [20 + 18 * Math.cos(a), 20 + 18 * Math.sin(a)]
})

test('a point is inside a polygon by the even-odd rule, so the overlap of a self-crossing outline is outside', () => {
  const square: RoiPoint[] = [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
  ]
  assert.equal(pointInPolygon(2, 2, square), true)
  assert.equal(pointInPolygon(0.5, 2, square), false)
  assert.equal(pointInPolygon(3.5, 2, square), false)
  // A U shape: the notch is outside, both arms are inside.
  const u: RoiPoint[] = [
    [0, 0],
    [6, 0],
    [6, 6],
    [4, 6],
    [4, 2],
    [2, 2],
    [2, 6],
    [0, 6],
  ]
  assert.equal(pointInPolygon(3, 4, u), false)
  assert.equal(pointInPolygon(1, 4, u), true)
  assert.equal(pointInPolygon(5, 4, u), true)
  assert.equal(pointInPolygon(3, 1, u), true)
  // A bow tie: the two triangles are inside; the open sides between them are not.
  const bowTie: RoiPoint[] = [
    [0, 0],
    [4, 4],
    [4, 0],
    [0, 4],
  ]
  assert.equal(pointInPolygon(1, 2, bowTie), true)
  assert.equal(pointInPolygon(3, 2, bowTie), true)
  assert.equal(pointInPolygon(2, 1, bowTie), false)
  assert.equal(pointInPolygon(2, 3, bowTie), false)
  // A five-pointed star drawn in one stroke: its tips are inside, its centre (crossed twice) is outside.
  assert.equal(pointInPolygon(20, 20, STAR), false)
  assert.equal(pointInPolygon(20, 4, STAR), true)
})

test('the screen selects exactly the pixels the thermal service measures, for simple, concave and self-crossing polygons', () => {
  const shapes: RoiPoint[][] = [
    [
      [2.3, 3.1],
      [30.7, 5.2],
      [25.4, 33.9],
      [4.1, 28.6],
    ],
    [
      [0, 0],
      [40, 0],
      [40, 40],
      [28, 40],
      [28, 12.5],
      [12.5, 12.5],
      [12.5, 40],
      [0, 40],
    ],
    STAR,
    [
      [0, 0],
      [40, 40],
      [40, 0],
      [0, 40],
    ],
  ]
  for (const pts of shapes) assert.deepEqual(clientMask(40, 40, pts), serviceMask(40, 40, pts))
})

test('a polygon region measures the pixel centres inside it and leaves out pixels without a reading', () => {
  // 4 × 4, each pixel's value is its index.
  const m = Float32Array.from({ length: 16 }, (_, i) => i)
  const square: RoiPoint[] = [
    [1, 1],
    [3, 1],
    [3, 3],
    [1, 3],
  ]
  const s = roiPreviewStats(m, 4, 4, { shape: 'polygon', ...polygonBounds(square), points: square })
  assert.deepEqual(s && { n: s.pixelCount, min: s.min, max: s.max, mean: s.mean }, { n: 4, min: 5, max: 10, mean: (5 + 6 + 9 + 10) / 4 })
  // The same box drawn as a rectangle measures the same pixels.
  const rect = roiPreviewStats(m, 4, 4, { shape: 'rect', x: 1, y: 1, width: 2, height: 2 })
  assert.equal(rect?.pixelCount, 4)
  assert.equal(rect?.mean, s?.mean)
  // A pixel without a reading inside the region is left out, not counted as zero.
  m[6] = Number.NaN
  const t = roiPreviewStats(m, 4, 4, { shape: 'polygon', ...polygonBounds(square), points: square })
  assert.equal(t?.pixelCount, 3)
  assert.equal(t?.mean, (5 + 9 + 10) / 3)
  // A region with no reading at all has no statistics.
  const empty = Float32Array.from({ length: 16 }, () => Number.NaN)
  assert.equal(roiPreviewStats(empty, 4, 4, { shape: 'polygon', ...polygonBounds(square), points: square }), null)
  // A polygon without its corners measures nothing.
  assert.equal(roiPreviewStats(m, 4, 4, { shape: 'polygon', x: 0, y: 0, width: 4, height: 4, points: null }), null)
})

test('a polygon over a whole simulated frame with missing data agrees with the whole-image statistics', () => {
  const { width: w, height: h } = THERMAL_SIM_SIZE
  const m = simulateThermalMatrix('missing_data', 7)
  const whole: RoiPoint[] = boxPolygon({ x: 0, y: 0, width: w, height: h })
  const s = roiPreviewStats(m, w, h, { shape: 'polygon', ...polygonBounds(whole), points: whole })
  const ref = thermalStats(m)
  assert.ok(s)
  assert.equal(countNonFinite(m), 25 * 30)
  assert.equal(s.pixelCount, ref.pixelCount)
  assert.equal(s.pixelCount, w * h - countNonFinite(m))
  assert.equal(Math.round(s.min * 100) / 100, ref.minC)
  assert.equal(Math.round(s.max * 100) / 100, ref.maxC)
  assert.ok(Math.abs(s.mean - ref.meanC!) < 0.006)
})

test('a polygon’s bounding box, and a box turned into a polygon', () => {
  assert.deepEqual(
    polygonBounds([
      [5, 9],
      [12.5, 2],
      [8, 14],
    ]),
    { x: 5, y: 2, width: 7.5, height: 12 },
  )
  const box = { x: 3, y: 4, width: 10, height: 6 }
  assert.deepEqual(boxPolygon(box), [
    [3, 4],
    [13, 4],
    [13, 10],
    [3, 10],
  ])
  assert.deepEqual(polygonBounds(boxPolygon(box)), box)
})

test('a pixel without a reading is said to have none, never given a temperature, and drawn in stripes', () => {
  assert.equal(fmtReading(33.4), '33.40 °C')
  assert.equal(fmtReading(Number.NaN), 'No reading at this pixel')
  assert.equal(fmtReading(Number.POSITIVE_INFINITY), 'No reading at this pixel')
  assert.equal(fmtReading(null), 'No reading at this pixel')
  assert.equal(fmtC(Number.NaN), '—')
  assert.equal(fmtC(null), '—')
  assert.equal(fmtC(undefined), '—')
  assert.equal(fmtC(21.04), '21.0 °C')
  assert.equal(fmtC(21.04, 2), '21.04 °C')
  assert.equal(countNonFinite([1, Number.NaN, 2, Number.NEGATIVE_INFINITY, Number.NaN]), 3)
  assert.equal(countNonFinite(simulateThermalMatrix('normal', 1)), 0)
  // Two greys in diagonal bands two pixels wide.
  assert.deepEqual([noReadingShade(0, 0), noReadingShade(1, 0), noReadingShade(2, 0), noReadingShade(1, 1), noReadingShade(3, 0)], [NO_READING_RGB[0], NO_READING_RGB[0], NO_READING_RGB[1], NO_READING_RGB[1], NO_READING_RGB[1]])
})

test('every capture says where it came from, and a simulator capture is SIMULATED whatever else is said about it', () => {
  assert.equal(thermalSourceLabel({ captureSource: 'live_capture', simulated: false }), 'LIVE CAPTURE')
  assert.equal(thermalSourceLabel({ captureSource: 'gallery_import', simulated: false }), 'IMPORTED')
  assert.equal(thermalSourceLabel({ captureSource: 'file_upload', simulated: false }), 'UPLOADED')
  assert.equal(thermalSourceLabel({ captureSource: 'simulator', simulated: true }), 'SIMULATED')
  // Defensive: either sign of the simulator is enough.
  assert.equal(thermalSourceLabel({ captureSource: 'file_upload', simulated: true }), 'SIMULATED')
  assert.equal(thermalSourceLabel({ captureSource: 'simulator' }), 'SIMULATED')
  // A row that does not say (an older list) gets no label rather than a guess.
  assert.equal(thermalSourceLabel({}), null)
  assert.equal(thermalSourceLabel({ captureSource: null, simulated: false }), null)
})

// The image's status is a new argument (V6 decision: a summary is composed only from an approved image, and goes into the note only while
// that image is still approved). The cases below are the earlier ones, each now with an approved image, plus the image's own status.
test('a summary is offered for the note only when accepted, not simulated, from an approved image, and the consultation is a draft the doctor may edit', () => {
  const draft = { status: 'in_progress' as const, id: 'e1' }
  const ok = { status: 'accepted' as const, simulated: false, encounterId: 'e1' }
  assert.equal(canAddThermalSummary(ok, draft, true, 'approved'), true)
  assert.equal(canAddThermalSummary({ ...ok, status: 'edited' }, draft, true, 'approved'), true)
  assert.equal(canAddThermalSummary({ ...ok, status: 'pending' }, draft, true, 'approved'), false)
  assert.equal(canAddThermalSummary({ ...ok, status: 'rejected' }, draft, true, 'approved'), false)
  assert.equal(canAddThermalSummary({ ...ok, simulated: true }, draft, true, 'approved'), false)
  assert.equal(canAddThermalSummary(ok, draft, false, 'approved'), false)
  assert.equal(canAddThermalSummary(ok, { status: 'signed', id: 'e1' }, true, 'approved'), false)
  assert.equal(canAddThermalSummary(ok, { status: 'discarded', id: 'e1' }, true, 'approved'), false)
  assert.equal(canAddThermalSummary({ ...ok, encounterId: 'another' }, draft, true, 'approved'), false, 'never into another consultation')
  assert.equal(canAddThermalSummary({ ...ok, encounterId: null }, draft, true, 'approved'), false)
  assert.equal(canAddThermalSummary(ok, undefined, true, 'approved'), false)
  assert.equal(canAddThermalSummary(ok, null, true, 'approved'), false)
  // The image: one awaiting review can still change, a rejected one is unfit for the record, and an unknown status is not taken as approved.
  assert.equal(canAddThermalSummary(ok, draft, true, 'draft'), false, 'not while the image awaits review')
  assert.equal(canAddThermalSummary(ok, draft, true, 'rejected'), false, 'never from a rejected image')
  assert.equal(canAddThermalSummary(ok, draft, true, undefined), false)
  assert.equal(canAddThermalSummary(ok, draft, true, null), false)
})

test('a summary is composed only from an approved image', () => {
  assert.equal(canComposeThermalSummary('approved'), true)
  assert.equal(canComposeThermalSummary('draft'), false)
  assert.equal(canComposeThermalSummary('rejected'), false)
  assert.equal(canComposeThermalSummary(undefined), false)
})

test('the doctor’s decision on a summary is said with who and when', () => {
  const at = '2026-10-05T10:00:00.000Z'
  assert.equal(thermalSummaryDecision({ status: 'pending', decidedByName: null, decidedAt: null }), null)
  assert.match(thermalSummaryDecision({ status: 'accepted', decidedByName: 'Dr Meera', decidedAt: at }) ?? '', /^Accepted by Dr Meera at \S/)
  assert.match(thermalSummaryDecision({ status: 'edited', decidedByName: 'Dr Meera', decidedAt: at }) ?? '', /^Edited and accepted by Dr Meera at \S/)
  assert.match(thermalSummaryDecision({ status: 'rejected', decidedByName: null, decidedAt: at }) ?? '', /^Rejected at \S/)
  assert.equal(thermalSummaryDecision({ status: 'rejected', decidedByName: null, decidedAt: null }), 'Rejected')
})
