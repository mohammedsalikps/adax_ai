/**
 * The thermal simulator (V6): generated temperature matrices for tests, development and demonstrations without a camera. One implementation,
 * used by the browser for the simulated live preview and by the API for a simulated capture, so what is previewed is what is stored.
 *
 * Nothing here is a measurement, a model of a body, or a model of a camera. The numbers are made up to exercise the pipeline (an even
 * distribution, a localized difference, a noisy image, pixels without a reading), deterministically for a seed. Every capture made from them is
 * stored and shown as SIMULATED, and none is ever given to a patient, a model, Mana, a dataset export or a consultation note.
 */

export const THERMAL_SIM_VERSION = 'thermal-sim-v1'
/** The size of a simulated frame (the radiometric resolution of a FLIR ONE Pro is 160 × 120; nothing depends on that match). */
export const THERMAL_SIM_SIZE = { width: 160, height: 120 } as const

/** The cases that produce a matrix. */
export type ThermalSimMatrixCase = 'normal' | 'localized_difference' | 'high_variance' | 'missing_data'
export const THERMAL_SIM_MATRIX_CASES: readonly ThermalSimMatrixCase[] = ['normal', 'localized_difference', 'high_variance', 'missing_data']

/** A small, fast, seedable generator (mulberry32): the same seed gives the same numbers on every machine. */
function generator(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A normally distributed number (Box-Muller), from the generator. */
function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
}

/**
 * The matrix for a case and seed: °C, row-major, `height` rows of `width` values, rounded to 0.01 °C; `NaN` where there is no reading.
 * `frame` changes only the noise, for a live preview that moves a little from frame to frame; a capture uses frame 0.
 */
export function simulateThermalMatrix(c: ThermalSimMatrixCase, seed: number, frame = 0): Float32Array {
  const { width: w, height: h } = THERMAL_SIM_SIZE
  const next = generator((seed ^ Math.imul(frame + 1, 0x9e3779b1)) >>> 0)
  const noise = c === 'high_variance' ? 1.8 : 0.15
  const out = new Float32Array(w * h)
  // A warm oval on a cooler background: generated shapes, not anatomy.
  const cx = w / 2
  const cy = h / 2
  const rx = w * 0.32
  const ry = h * 0.42
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
      let v = d <= 1 ? 33.4 - 1.6 * d : 22 + 3 * Math.exp(-(d - 1) * 3)
      if (c === 'localized_difference') v += 2.4 * Math.exp(-(((x - w * 0.62) ** 2 + (y - h * 0.45) ** 2) / (2 * 6 ** 2)))
      v += normal(next) * noise
      out[y * w + x] = Math.round(v * 100) / 100
    }
  }
  if (c === 'missing_data') for (let y = 15; y < 40; y++) for (let x = 20; x < 50; x++) out[y * w + x] = Number.NaN
  return out
}

export interface ThermalStats {
  /** Pixels with a reading (finite values). */
  pixelCount: number
  minC: number | null
  maxC: number | null
  meanC: number | null
  /** Population standard deviation, as the thermal service computes it. */
  stdC: number | null
}

/** Whole-matrix statistics over the pixels that have a reading, rounded to 0.01 °C. */
export function thermalStats(m: ArrayLike<number>): ThermalStats {
  let n = 0
  let sum = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < m.length; i++) {
    const v = m[i]!
    if (!Number.isFinite(v)) continue
    n++
    sum += v
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!n) return { pixelCount: 0, minC: null, maxC: null, meanC: null, stdC: null }
  const mean = sum / n
  let sq = 0
  for (let i = 0; i < m.length; i++) {
    const v = m[i]!
    if (Number.isFinite(v)) sq += (v - mean) ** 2
  }
  const r = (v: number) => Math.round(v * 100) / 100
  return { pixelCount: n, minC: r(min), maxC: r(max), meanC: r(mean), stdC: r(Math.sqrt(sq / n)) }
}

/**
 * DEMO thermal image (final demo polish): an ordinary PNG or JPEG — a photo, a screenshot of a thermal image — has no temperature data. Where the
 * simulator is allowed it can still be analysed as a DEMO: the browser reduces it to a grid of at most DEMO_IMAGE_GRID_MAX × DEMO_IMAGE_GRID_MAX
 * colour "heat" values (0–255, `demoImageHeat`), and the API turns each into a simulated value on a skin-like scale (`demoImageHeatToC`). The
 * capture is stored as simulated and labelled "Demo thermal analysis — temperature data not available": nothing in it was measured.
 */
export const THERMAL_DEMO_IMAGE_EXTRACTOR = 'demo-image'
export const THERMAL_DEMO_IMAGE_LABEL = 'Demo thermal analysis — temperature data not available'
export const DEMO_IMAGE_GRID_MAX = 320

/** A pixel's colour as a "heat" value 0–255 by a fixed formula: warm colours (red, yellow, white) high, blue and black low. Not a temperature. */
export function demoImageHeat(r: number, g: number, b: number): number {
  const h = 0.2 + (0.55 * r + 0.25 * g - 0.2 * b) / 255
  return Math.round(Math.min(1, Math.max(0, h)) * 255)
}

/** A heat value (0–255) as a simulated value on a skin-like scale, 26–37 (rounded to 0.01). Simulated, never measured. */
export const demoImageHeatToC = (heat: number): number => Math.round((26 + (Math.min(255, Math.max(0, heat)) / 255) * 11) * 100) / 100
