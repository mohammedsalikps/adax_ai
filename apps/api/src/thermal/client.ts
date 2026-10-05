import { type ThermalFlags, ThermalModelStatus } from '@adaxai/contracts'
import { HttpError } from '../http/errors.ts'

export interface ExtractResult {
  width: number
  height: number
  minC: number
  maxC: number
  meanC: number
  /** Population standard deviation over the pixels with a reading (V6; absent from a service older than V6). */
  stdC?: number | null
  /** float32 little-endian, row-major. */
  matrix: Buffer
  camera: { make: string | null; model: string | null; dateTime: string | null }
  parameters: Record<string, number | null>
  visibleJpeg: Buffer | null
  extractor: { name: string; version: string }
}

export interface RoiStatsResult {
  rois: { id: string; stats: { pixelCount: number; min: number | null; max: number | null; mean: number | null; std: number | null } }[]
  pairs: { a: string; b: string; meanDiff: number | null; maxDiff: number | null }[]
}

/** A region as the thermal service takes it: a box (rect, or the ellipse inscribed in it), or a polygon by its corners (even-odd rule). */
export interface RoiGeometry {
  id: string
  shape: 'rect' | 'ellipse' | 'polygon'
  x: number
  y: number
  width: number
  height: number
  /** Polygon only: its corners in image pixels. */
  points?: [number, number][] | null
}

export interface RoiStatsInput {
  width: number
  height: number
  matrix: Buffer
  rois: RoiGeometry[]
  pairs: { a: string; b: string }[]
}

export type FlagsInput = RoiStatsInput

export interface EvaluationResult {
  report: Record<string, unknown>
  markdown: string
}

/** The Python thermal service (stateless; never touches the database). */
export interface ThermalService {
  extract(file: Buffer, filename: string): Promise<ExtractResult>
  roiStats(input: RoiStatsInput): Promise<RoiStatsResult>
  /** Experimental rule-based flags: not validated, not diagnostic. */
  flags(input: FlagsInput): Promise<ThermalFlags>
  /** Evaluates a dataset ZIP against its clinician labels. */
  evaluate(datasetZip: Buffer): Promise<EvaluationResult>
  /** Validates a clinical photograph and returns a metadata-free JPEG preview. */
  inspectImage(data: Buffer, opts: { allowed: string[]; maxPixels: number; previewMaxSide: number }): Promise<InspectedImage>
  /**
   * Whether a thermal model is installed (V6). Never throws: when the service cannot be reached, or answers with something that is not a model
   * status, the answer is "unavailable" with that reason. There is no model in this build, so the service always says unavailable.
   */
  modelStatus(): Promise<ThermalModelStatus>
}

export interface InspectedImage {
  format: string
  mimeType: string
  width: number
  height: number
  hadExif: boolean
  hadGps: boolean
  preview: Buffer
  previewWidth: number
  previewHeight: number
}

/**
 * WHERE A REAL THERMAL MODEL WOULD PLUG IN. Nothing implements this in this build: no trained thermal model exists, the thermal service says so
 * (`GET /model/status`), and the evaluation pipeline's logistic-regression baseline is a measurement of a dataset, not a model that is installed.
 * A model would be added behind this interface only with its weights, its evaluation for the stated use, and a decision record; every output it
 * gives carries everything below, so that what it said can be traced to exactly which model, which weights and which input. Until then the product
 * shows MODEL UNAVAILABLE and no model output of any kind.
 */
export interface ThermalModel {
  /** Stable identifier and version of the model. */
  readonly id: string
  readonly version: string
  /** SHA-256 of the weights file as installed. */
  readonly artifactSha256: string
  /** Version of the preprocessing applied to the matrix before inference (normalisation, resizing, masking). */
  readonly preprocessingVersion: string
  /** `real`: trained and evaluated for its stated task; `research`; `simulation`. */
  readonly kind: 'real' | 'research' | 'simulation'
  readonly intendedUse: string
  /** The evaluation run that supports the stated use. */
  readonly evaluation: { runId: string; summary: string }
  infer(input: ThermalModelInput): Promise<ThermalModelOutput>
}

export interface ThermalModelInput {
  captureId: string
  width: number
  height: number
  /** float32 little-endian, row-major; NaN where there is no reading. */
  matrix: Buffer
  /** SHA-256 of `matrix`, recorded with the output. */
  matrixSha256: string
  /** Never a simulated capture: a simulator's numbers are not given to a model. */
  simulated: false
  rois: RoiGeometry[]
}

export interface ThermalModelOutput {
  modelId: string
  version: string
  artifactSha256: string
  preprocessingVersion: string
  /** When inference ran (ISO). */
  inferredAt: string
  /** What it was given, by reference: never the image itself. */
  input: { captureId: string; width: number; height: number; matrixSha256: string }
  /** What it said, in its own documented shape. */
  output: Record<string, unknown>
  /** Its own confidence, where it has one; null where it does not. */
  confidence: number | null
  evaluation: { runId: string; summary: string }
}

const unavailable = () => new HttpError(503, 'thermal_unavailable', 'The thermal processing service is not reachable. Try again shortly.')

/** The model status when the thermal service gave none (it is down, or answered with something else). Never says a model is available. */
export function modelUnavailable(reason: string): ThermalModelStatus {
  return { available: false, kind: null, modelId: null, version: null, artifactSha256: null, intendedUse: null, evaluation: null, reason }
}

export function httpThermalService(baseUrl: string, fetchImpl: typeof fetch = fetch): ThermalService {
  async function call(path: string, init: RequestInit, timeoutMs = 60_000) {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      throw unavailable()
    }
    const body = (await res.json().catch(() => null)) as { detail?: { error?: string; message?: string } } | null
    if (res.status === 422 || res.status === 413) {
      // Rejections (not radiometric, unsupported variant, too large) are user-facing.
      throw new HttpError(422, body?.detail?.error ?? 'thermal_rejected', body?.detail?.message ?? 'The thermal image could not be processed.')
    }
    if (!res.ok || !body) throw unavailable()
    return body as unknown
  }

  return {
    async extract(file, filename) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), filename)
      const b = (await call('/extract', { method: 'POST', body: form })) as Omit<ExtractResult, 'matrix' | 'visibleJpeg'> & { matrix: string; visibleJpeg: string | null }
      return { ...b, matrix: Buffer.from(b.matrix, 'base64'), visibleJpeg: b.visibleJpeg ? Buffer.from(b.visibleJpeg, 'base64') : null }
    },
    async roiStats(input) {
      return (await call('/roi-stats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, matrix: input.matrix.toString('base64') }),
      })) as RoiStatsResult
    },
    async flags(input) {
      return (await call('/flags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, matrix: input.matrix.toString('base64') }),
      })) as ThermalFlags
    },
    async evaluate(datasetZip) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(datasetZip)], { type: 'application/zip' }), 'dataset.zip')
      return (await call('/evaluate', { method: 'POST', body: form })) as EvaluationResult
    },
    async inspectImage(data, opts) {
      const form = new FormData()
      form.append('allowed', opts.allowed.join(','))
      form.append('max_pixels', String(opts.maxPixels))
      form.append('preview_max_side', String(opts.previewMaxSide))
      form.append('file', new Blob([new Uint8Array(data)]), 'image')
      const b = (await call('/image/inspect', { method: 'POST', body: form })) as Omit<InspectedImage, 'preview'> & { preview: string }
      return { ...b, preview: Buffer.from(b.preview, 'base64') }
    },
    async modelStatus() {
      let body: unknown
      try {
        // A status, not a computation: a service that does not answer within seconds is taken as unreachable.
        body = await call('/model/status', { method: 'GET' }, 5_000)
      } catch {
        return modelUnavailable('The thermal service could not be reached, so no thermal model can be used.')
      }
      const parsed = ThermalModelStatus.safeParse(body)
      return parsed.success ? parsed.data : modelUnavailable('The thermal service did not give a model status, so no thermal model can be used.')
    },
  }
}
