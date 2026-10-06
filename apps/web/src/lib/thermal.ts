import { type CaptureProtocol, type Encounter, THERMAL_SUMMARY_DECISIONS, type ThermalCapture, type ThermalCaptureSource, type ThermalDeviceReported, type ThermalModelStatus, type ThermalSimulateRequest, type ThermalSummary, type ThermalSummaryReviewRequest, type ThermalWorkspaceEventRequest } from '@adaxai/contracts'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from './api.ts'
import { fmtDateTime } from './format.ts'

export const thermalKey = (id: string) => ['thermal', id] as const
export const patientThermalKey = (patientId: string) => ['patient', patientId, 'thermal'] as const
/** The summaries of one capture (V6), under the capture's key so that refreshing the capture refreshes them. */
export const thermalSummariesKey = (captureId: string) => ['thermal', captureId, 'summaries'] as const
export const thermalModelStatusKey = ['thermal', 'model-status'] as const

export function useThermal(id: string | undefined) {
  return useQuery({ queryKey: thermalKey(id ?? ''), queryFn: () => api<ThermalCapture>(`/thermal/${id}`), enabled: !!id })
}

export function usePatientThermal(patientId: string) {
  return useQuery({ queryKey: patientThermalKey(patientId), queryFn: () => api<{ captures: ThermalCapture[] }>(`/patients/${patientId}/thermal`), select: (d) => d.captures })
}

/** After a capture is stored (upload, import, live capture or simulator): cache it and refresh the lists it appears in. */
export function cacheThermalCapture(qc: QueryClient, c: ThermalCapture) {
  qc.setQueryData(thermalKey(c.id), c)
  void qc.invalidateQueries({ queryKey: patientThermalKey(c.patientId) })
  void qc.invalidateQueries({ queryKey: ['thermal', 'list'] })
}

/** How a file reaches POST /patients/:id/thermal. `captureSource` is what the sending screen says; the server checks the file is radiometric either way. */
export interface ThermalUploadInput {
  file: Blob
  /** Sent as the file name (a `File` keeps its own when this is not given). */
  fileName?: string | undefined
  protocol: CaptureProtocol
  encounterId?: string | null | undefined
  captureSource?: Exclude<ThermalCaptureSource, 'simulator'> | undefined
  /** When the camera says it took the image (ISO 8601), from the device bridge. */
  capturedAt?: string | null | undefined
  /** What the device bridge reported about the camera, as reported. */
  deviceReported?: ThermalDeviceReported | null | undefined
}

/** Uploads a radiometric file. The text fields go before the file: the server reads only the fields that come first. */
export function uploadThermal(patientId: string, input: ThermalUploadInput): Promise<ThermalCapture> {
  const fd = new FormData()
  fd.append('captureSource', input.captureSource ?? 'file_upload')
  if (input.encounterId) fd.append('encounterId', input.encounterId)
  fd.append('protocol', JSON.stringify(input.protocol))
  if (input.capturedAt) fd.append('capturedAt', input.capturedAt)
  if (input.deviceReported) fd.append('deviceReported', JSON.stringify(input.deviceReported))
  const name = input.fileName ?? (input.file instanceof File ? input.file.name : 'thermal.jpg')
  fd.append('file', input.file, name)
  return api<ThermalCapture>(`/patients/${patientId}/thermal`, { method: 'POST', body: fd })
}

/** Asks the server's simulator for a capture (stored and shown as SIMULATED; `invalid_capture` and `processing_failure` are refused). */
export function simulateThermalCapture(patientId: string, body: ThermalSimulateRequest): Promise<ThermalCapture> {
  return api<ThermalCapture>(`/patients/${patientId}/thermal/simulate`, { method: 'POST', body })
}

/** Reports a workspace event for the audit log. Fire and forget: a failure here never interrupts the doctor, so it is swallowed. */
export async function sendThermalEvent(encounterId: string, body: ThermalWorkspaceEventRequest): Promise<void> {
  try {
    await api(`/encounters/${encounterId}/thermal-events`, { method: 'POST', body })
  } catch {
    // Nothing to do: the audit trail of the capture itself is written by the server when a capture is stored.
  }
}

/** Whether a thermal model is installed (there is none: `available` is false with the reason). */
export function useThermalModelStatus(enabled = true) {
  return useQuery({ queryKey: thermalModelStatusKey, queryFn: () => api<ThermalModelStatus>('/thermal/model-status'), staleTime: 60_000, enabled })
}

export function useThermalSummaries(captureId: string | undefined) {
  return useQuery({
    queryKey: thermalSummariesKey(captureId ?? ''),
    queryFn: () => api<{ summaries: ThermalSummary[] }>(`/thermal/${captureId}/summaries`),
    select: (d) => [...d.summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    enabled: !!captureId,
  })
}

function putSummary(qc: QueryClient, s: ThermalSummary) {
  qc.setQueryData<{ summaries: ThermalSummary[] }>(thermalSummariesKey(s.captureId), (old) => (old ? { summaries: [s, ...old.summaries.filter((x) => x.id !== s.id)] } : old))
  void qc.invalidateQueries({ queryKey: thermalSummariesKey(s.captureId) })
}

/** Composes a new summary of the capture (by fixed rules on the server, from what was measured); earlier ones are kept. */
export function useGenerateThermalSummary(captureId: string) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api<ThermalSummary>(`/thermal/${captureId}/summaries`, { method: 'POST', body: {} }), onSuccess: (s) => putSummary(qc, s) })
}

/** The doctor's decision on a summary: accept, edit (and accept) or reject. */
export function useReviewThermalSummary() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ThermalSummaryReviewRequest }) => api<ThermalSummary>(`/thermal-summaries/${id}/review`, { method: 'POST', body }),
    onSuccess: (s) => putSummary(qc, s),
  })
}

/**
 * Whether a summary may be offered for the note: the doctor accepted it (as it is or edited), it is not simulated, its image is approved (an
 * approved image and its regions can no longer change, so the summary's numbers are still the image's), and the consultation is an unsigned
 * draft the doctor may edit now. The server checks the same again when the text is inserted.
 */
export function canAddThermalSummary(
  s: Pick<ThermalSummary, 'status' | 'simulated' | 'encounterId'>,
  encounter: Pick<Encounter, 'status' | 'id'> | null | undefined,
  canEdit: boolean,
  captureStatus: ThermalCapture['status'] | null | undefined,
): boolean {
  // A summary goes only into the note of the consultation its image was taken in (the server checks the same).
  return (s.status === 'accepted' || s.status === 'edited') && !s.simulated && captureStatus === 'approved' && !!encounter && s.encounterId === encounter.id && encounter.status === 'in_progress' && canEdit
}

/** A summary is composed only from an approved image: its measurements and regions are then fixed, and a rejected image never gets one. */
export const canComposeThermalSummary = (captureStatus: ThermalCapture['status'] | null | undefined) => captureStatus === 'approved'

/** The doctor's decision in words ("Accepted by Dr X at 5 Oct 2026, 10:00"), or null while it waits for review. */
export function thermalSummaryDecision(s: Pick<ThermalSummary, 'status' | 'decidedByName' | 'decidedAt'>): string | null {
  if (s.status === 'pending') return null
  return `${THERMAL_SUMMARY_DECISIONS[s.status]}${s.decidedByName ? ` by ${s.decidedByName}` : ''}${s.decidedAt ? ` at ${fmtDateTime(s.decidedAt)}` : ''}`
}

/** The words of the source label. A simulator capture is SIMULATED whatever else is said about it; an unknown source has no label. */
export const THERMAL_SOURCE_LABELS: Record<ThermalCaptureSource, string> = { live_capture: 'LIVE CAPTURE', gallery_import: 'IMPORTED', file_upload: 'UPLOADED', simulator: 'SIMULATED' }
export function thermalSourceLabel(c: { captureSource?: ThermalCaptureSource | null | undefined; simulated?: boolean | null | undefined }): string | null {
  if (c.simulated || c.captureSource === 'simulator') return THERMAL_SOURCE_LABELS.simulator
  return c.captureSource ? (THERMAL_SOURCE_LABELS[c.captureSource] ?? null) : null
}

/**
 * Fetches the float32 temperature matrix (°C, row-major). A read that hangs is given up after 2.5 seconds and tried again almost at once (up
 * to four times), instead of leaving the image "loading" for as long as the page is open: through the development server's proxy about one
 * read in four of this file was seen to stall with no answer for 20 s and more, while the same file read straight from the API answered in 20
 * to 60 ms. A healthy answer takes well under a second, so 2.5 seconds gives up only on a read that will not come, and a stalled read costs
 * the small picture in the thermal module about 3 s instead of 4 to 5.
 */
export function useMatrix(c: ThermalCapture | undefined) {
  return useQuery({
    queryKey: ['thermal-matrix', c?.matrixFileId],
    enabled: !!c,
    staleTime: Infinity,
    retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 4,
    retryDelay: (n) => 150 * (n + 1),
    queryFn: async () => {
      const res = await fetch(`/api/files/${c!.matrixFileId}`, { credentials: 'same-origin', signal: AbortSignal.timeout(2_500) })
      if (!res.ok) throw new ApiError(res.status, 'matrix_unavailable', 'The temperature data could not be loaded.')
      const buf = await res.arrayBuffer()
      if (buf.byteLength !== c!.width * c!.height * 4) throw new ApiError(500, 'matrix_size', 'The temperature data has an unexpected size.')
      return new Float32Array(buf)
    },
  })
}

export type PaletteName = 'iron' | 'grayscale' | 'rainbow'

const STOPS: Record<PaletteName, [number, [number, number, number]][]> = {
  grayscale: [
    [0, [0, 0, 0]],
    [1, [255, 255, 255]],
  ],
  iron: [
    [0, [0, 0, 20]],
    [0.25, [80, 20, 130]],
    [0.5, [200, 40, 80]],
    [0.75, [250, 150, 20]],
    [1, [255, 250, 220]],
  ],
  rainbow: [
    [0, [20, 20, 140]],
    [0.25, [0, 160, 230]],
    [0.5, [40, 200, 60]],
    [0.75, [250, 220, 0]],
    [1, [220, 30, 30]],
  ],
}

/** 256-entry RGB lookup table, linear interpolation between palette stops. */
export function paletteLut(name: PaletteName): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3)
  const stops = STOPS[name]
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let j = 0
    while (j < stops.length - 2 && t > stops[j + 1]![0]) j++
    const [t0, c0] = stops[j]!
    const [t1, c1] = stops[j + 1]!
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k]! + (c1[k]! - c0[k]!) * f
  }
  return lut
}

export const paletteCss = (name: PaletteName) => `linear-gradient(to right, ${STOPS[name].map(([t, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${t * 100}%`).join(', ')})`

/**
 * Pixels without a reading are painted in diagonal stripes of two greys, in every palette, so that they are never read as a temperature (the
 * greyscale palette has greys, but no stripes). The same two greys make the legend's swatch.
 */
export const NO_READING_RGB: readonly [readonly [number, number, number], readonly [number, number, number]] = [
  [156, 163, 175],
  [75, 85, 99],
]
export const noReadingCss = `repeating-linear-gradient(135deg, rgb(${NO_READING_RGB[0].join(' ')}) 0 3px, rgb(${NO_READING_RGB[1].join(' ')}) 3px 6px)`
/** Which grey a pixel without a reading gets: bands two pixels wide, on the diagonal. */
export const noReadingShade = (x: number, y: number) => NO_READING_RGB[((x + y) >> 1) & 1]!

/** Pixels without a reading (NaN or infinite). */
export function countNonFinite(m: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i]!)) n++
  return n
}

export type RoiPoint = [number, number]

export interface RoiGeom {
  shape: 'rect' | 'ellipse' | 'polygon'
  x: number
  y: number
  width: number
  height: number
  /** Polygon only: its corners, in image pixels. */
  points?: RoiPoint[] | null | undefined
}

/**
 * Whether (px, py) is inside the polygon by the even-odd rule: a ray to the right crosses its edges an odd number of times (the PNPOLY crossing
 * test). Where a polygon crosses itself, the overlap is outside, as in the thermal service.
 */
export function pointInPolygon(px: number, py: number, pts: readonly RoiPoint[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!
    const [xj, yj] = pts[j]!
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The bounding box of a polygon's corners (what the API stores beside the points). */
export function polygonBounds(pts: readonly RoiPoint[]): { x: number; y: number; width: number; height: number } {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** A box as a four-corner polygon, clockwise from the top left (when a rectangle or ellipse is turned into a polygon). */
export const boxPolygon = (r: { x: number; y: number; width: number; height: number }): RoiPoint[] => [
  [r.x, r.y],
  [r.x + r.width, r.y],
  [r.x + r.width, r.y + r.height],
  [r.x, r.y + r.height],
]

/** Same rule as the thermal service: pixels whose centres fall inside the region (for a polygon, by the even-odd rule); pixels without a reading are left out. */
export function roiPreviewStats(m: ArrayLike<number>, w: number, h: number, r: RoiGeom) {
  const poly = r.shape === 'polygon' ? r.points : null
  if (r.shape === 'polygon' && (!poly || poly.length < 3)) return null
  const box = poly ? polygonBounds(poly) : r
  let n = 0
  let sum = 0
  let sq = 0
  let min = Infinity
  let max = -Infinity
  const x0 = Math.max(0, Math.floor(box.x))
  const y0 = Math.max(0, Math.floor(box.y))
  const x1 = Math.min(w - 1, Math.ceil(box.x + box.width))
  const y1 = Math.min(h - 1, Math.ceil(box.y + box.height))
  const rx = r.width / 2
  const ry = r.height / 2
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5
      const cy = y + 0.5
      const inside = poly ? pointInPolygon(cx, cy, poly) : r.shape === 'rect' ? cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height : ((cx - (r.x + rx)) / rx) ** 2 + ((cy - (r.y + ry)) / ry) ** 2 <= 1
      if (!inside) continue
      const v = m[y * w + x]!
      if (!Number.isFinite(v)) continue
      n++
      sum += v
      sq += v * v
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!n) return null
  const mean = sum / n
  return { pixelCount: n, min, max, mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) }
}

/** A temperature, or a dash when there is none (null, or a pixel without a reading). */
export const fmtC = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)} °C`)

/** The pointer readout of one pixel: its temperature to 0.01 °C, or that it has none. */
export const fmtReading = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? 'No reading at this pixel' : fmtC(v, 2))
