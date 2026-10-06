import { DATA_ORIGIN_LABELS, type ThermalCapture, type ThermalReviewRequest, type ThermalRoiInput } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Circle, Download, Pentagon, Plus, Save, Square, Trash2, Undo2, X } from 'lucide-react'
import { type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { useMe } from '../../lib/auth.tsx'
import { fmtDateTime } from '../../lib/format.ts'
import { boxPolygon, cacheThermalCapture, countNonFinite, fmtC, fmtReading, noReadingCss, noReadingShade, type PaletteName, paletteCss, paletteLut, polygonBounds, type RoiGeom, type RoiPoint, roiPreviewStats, useMatrix } from '../../lib/thermal.ts'
import { captureFacts, captureStatusSpec, fmtDiff, roiStatsParts, wholeImageStats } from '../../lib/thermalStudy.ts'
import { PanelGroup } from '../hero/Panel.tsx'
import { SimulatedBadge } from '../clinical/DeviceReadingsCard.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, Spinner } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../ui/Form.tsx'
import { Card, DescriptionList } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'
import { ThermalFlagsCard, useThermalFlags } from './ThermalFlags.tsx'
import { ThermalLabelsCard } from './ThermalLabels.tsx'
import { ThermalModelStatus } from './ThermalModelStatus.tsx'
import { ThermalSourceBadge } from './ThermalSourceBadge.tsx'

interface EditableRoi extends RoiGeom {
  key: string
  label: string
  pairWith: string
  note: string
}

type Tool = 'none' | 'rect' | 'ellipse' | 'polygon'

const round = (v: number) => Math.round(v * 10) / 10
/** The most corners a polygon may have (the API's limit). */
const MAX_POINTS = 64
/** How close (in screen pixels) a tap must be to the first corner to close the polygon: half of a 44-pixel target. */
const CLOSE_RADIUS_PX = 22
const NO_HOTSPOTS: { x: number; y: number; width: number; height: number }[] = []
const NO_POINTS: RoiPoint[] = []
const fromCapture = (c: ThermalCapture): EditableRoi[] =>
  c.rois.map((r) => ({ key: r.id, label: r.label, shape: r.shape, x: r.x, y: r.y, width: r.width, height: r.height, points: r.points ?? null, pairWith: r.pairWith ?? '', note: r.note ?? '' }))
const roundBox = (b: { x: number; y: number; width: number; height: number }) => ({ x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) })
const isSimulated = (c: ThermalCapture) => !!c.simulated || c.captureSource === 'simulator'

function ThermalCanvas({
  matrix,
  c,
  low,
  high,
  palette,
  rois,
  tool,
  onDrawn,
  hotspots = NO_HOTSPOTS,
  polygon = NO_POINTS,
  onPolygonPoint,
  onPolygonClose,
  missing,
}: {
  matrix: Float32Array
  c: ThermalCapture
  low: number
  high: number
  palette: PaletteName
  rois: EditableRoi[]
  tool: Tool
  onDrawn: (g: RoiGeom) => void
  /** Experimental warm areas, outlined dashed in amber. */
  hotspots?: { x: number; y: number; width: number; height: number }[] | undefined
  /** The corners of the polygon being drawn. */
  polygon?: RoiPoint[]
  onPolygonPoint?: (p: RoiPoint) => void
  onPolygonClose?: () => void
  /** Pixels without a reading. */
  missing: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; t: number; fx: number; fy: number } | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  // The ref is the source of truth while dragging: pointer events can arrive
  // before React re-renders, so handlers must not rely on the `drag` state.
  const dragRef = useRef<{ x0: number; y0: number } | null>(null)
  const { width: w, height: h } = c
  const simulated = isSimulated(c)

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx) return
    const lut = paletteLut(palette)
    const img = ctx.createImageData(w, h)
    const span = Math.max(high - low, 0.01)
    for (let i = 0; i < w * h; i++) {
      const v = matrix[i]!
      // A pixel without a reading is never given a colour of the scale: it gets the grey stripes of the legend.
      const rgb = Number.isFinite(v) ? null : noReadingShade(i % w, Math.floor(i / w))
      const idx = rgb ? 0 : Math.max(0, Math.min(255, Math.round(((v - low) / span) * 255)))
      img.data[i * 4] = rgb ? rgb[0] : lut[idx * 3]!
      img.data[i * 4 + 1] = rgb ? rgb[1] : lut[idx * 3 + 1]!
      img.data[i * 4 + 2] = rgb ? rgb[2] : lut[idx * 3 + 2]!
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [matrix, w, h, low, high, palette])

  // Overlay drawn at a higher resolution so outlines and labels stay crisp.
  const SCALE = Math.max(1, Math.ceil(640 / w))
  const drawing = tool === 'polygon' && polygon.length > 0
  const rubberX = drawing && hover ? hover.fx : null
  const rubberY = drawing && hover ? hover.fy : null
  useEffect(() => {
    const ctx = overlay.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w * SCALE, h * SCALE)
    const outline = (pending: boolean) => {
      ctx.lineWidth = 2
      ctx.setLineDash(pending ? [6, 4] : [])
      ctx.strokeStyle = '#ffffff'
      ctx.shadowColor = 'rgba(0,0,0,0.9)'
      ctx.shadowBlur = 3
    }
    const draw = (g: RoiGeom, label: string, pending = false) => {
      ctx.save()
      outline(pending)
      ctx.beginPath()
      if (g.shape === 'polygon') {
        const pts = g.points ?? NO_POINTS
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * SCALE, y * SCALE) : ctx.moveTo(x * SCALE, y * SCALE)))
        ctx.closePath()
      } else if (g.shape === 'rect') ctx.rect(g.x * SCALE, g.y * SCALE, g.width * SCALE, g.height * SCALE)
      else ctx.ellipse((g.x + g.width / 2) * SCALE, (g.y + g.height / 2) * SCALE, (g.width / 2) * SCALE, (g.height / 2) * SCALE, 0, 0, Math.PI * 2)
      ctx.stroke()
      if (label) {
        ctx.font = `${Math.max(12, SCALE * 4)}px system-ui, sans-serif`
        ctx.fillStyle = '#ffffff'
        ctx.fillText(label, g.x * SCALE + 4, g.y * SCALE + Math.max(14, SCALE * 5))
      }
      ctx.restore()
    }
    hotspots.forEach((hs, i) => {
      ctx.save()
      ctx.lineWidth = 2
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#fbbf24'
      ctx.shadowColor = 'rgba(0,0,0,0.9)'
      ctx.shadowBlur = 3
      ctx.strokeRect(hs.x * SCALE, hs.y * SCALE, hs.width * SCALE, hs.height * SCALE)
      ctx.font = `${Math.max(12, SCALE * 4)}px system-ui, sans-serif`
      ctx.fillStyle = '#fbbf24'
      ctx.fillText(`H${i + 1}`, hs.x * SCALE + 2, Math.max(12, hs.y * SCALE - 4))
      ctx.restore()
    })
    rois.forEach((r) => draw(r, r.label))
    if (drag && (tool === 'rect' || tool === 'ellipse')) draw({ shape: tool, x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }, '', true)
    if (tool === 'polygon' && polygon.length) {
      // The polygon being drawn: its edges so far, a line to the pointer, and its corners (the first one larger: tapping it closes the polygon).
      ctx.save()
      outline(true)
      ctx.beginPath()
      polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x * SCALE, y * SCALE) : ctx.moveTo(x * SCALE, y * SCALE)))
      if (rubberX !== null && rubberY !== null) ctx.lineTo(rubberX * SCALE, rubberY * SCALE)
      ctx.stroke()
      ctx.setLineDash([])
      polygon.forEach(([x, y], i) => {
        ctx.beginPath()
        ctx.arc(x * SCALE, y * SCALE, i === 0 ? Math.max(8, SCALE * 2.5) : Math.max(4, SCALE), 0, Math.PI * 2)
        ctx.fillStyle = i === 0 ? 'rgba(255,255,255,0.35)' : '#ffffff'
        ctx.fill()
        ctx.stroke()
      })
      ctx.restore()
    }
  }, [rois, drag, tool, w, h, SCALE, hotspots, polygon, rubberX, rubberY])

  const toPixel = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(w, ((e.clientX - r.left) / r.width) * w)), y: Math.max(0, Math.min(h, ((e.clientY - r.top) / r.height) * h)) }
  }

  return (
    <div className="space-y-2">
      {/* Width is capped so that the height never exceeds 70vh while keeping the image's aspect ratio. */}
      <div className="relative mx-auto overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${w} / ${h}`, width: `min(100%, calc(70vh * ${w / h}))` }}>
        <canvas
          ref={canvas}
          width={w}
          height={h}
          className="absolute inset-0 size-full"
          style={{ imageRendering: 'pixelated' }}
          role="img"
          aria-label={`${simulated ? 'Simulated thermal image (not a measurement)' : 'Thermal image'} ${w} by ${h} pixels, ${fmtC(c.minC)} to ${fmtC(c.maxC)}${missing ? `, ${missing} pixels without a reading` : ''}`}
        />
        <canvas
          ref={overlay}
          width={w * SCALE}
          height={h * SCALE}
          data-testid="thermal-overlay"
          className={`absolute inset-0 size-full touch-none ${tool !== 'none' ? 'cursor-crosshair' : 'cursor-default'}`}
          aria-hidden="true"
          onPointerMove={(e) => {
            const p = toPixel(e)
            const xi = Math.min(w - 1, Math.floor(p.x))
            const yi = Math.min(h - 1, Math.floor(p.y))
            setHover({ x: xi, y: yi, t: matrix[yi * w + xi]!, fx: p.x, fy: p.y })
            const start = dragRef.current
            if (start) setDrag({ ...start, x1: p.x, y1: p.y })
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => {
            if (tool === 'none') return
            const p = toPixel(e)
            if (tool === 'polygon') {
              const r = e.currentTarget.getBoundingClientRect()
              const px = r.width / w
              const near = (q: RoiPoint | undefined, radius: number) => !!q && Math.hypot((q[0] - p.x) * px, (q[1] - p.y) * px) <= radius
              if (polygon.length >= 3 && near(polygon[0], CLOSE_RADIUS_PX)) onPolygonClose?.()
              // The second press of a double click lands on the corner the first one added: it is not a new corner.
              else if (!near(polygon[polygon.length - 1], 6) && polygon.length < MAX_POINTS) onPolygonPoint?.([round(p.x), round(p.y)])
              return
            }
            e.currentTarget.setPointerCapture(e.pointerId)
            dragRef.current = { x0: p.x, y0: p.y }
            setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
          }}
          onDoubleClick={() => {
            if (tool === 'polygon' && polygon.length >= 3) onPolygonClose?.()
          }}
          onPointerUp={(e) => {
            const start = dragRef.current
            dragRef.current = null
            setDrag(null)
            if (!start || (tool !== 'rect' && tool !== 'ellipse')) return
            // The end point comes from this event, not from possibly stale state.
            const end = toPixel(e)
            const g = { shape: tool, x: round(Math.min(start.x0, end.x)), y: round(Math.min(start.y0, end.y)), width: round(Math.abs(end.x - start.x0)), height: round(Math.abs(end.y - start.y0)) }
            if (g.width >= 1 && g.height >= 1) onDrawn(g)
          }}
          onPointerCancel={() => {
            dragRef.current = null
            setDrag(null)
          }}
        />
      </div>
      <p className="min-h-5 text-sm tabular-nums" aria-live="polite" data-testid="hover-readout">
        {hover ? `x ${hover.x}, y ${hover.y}: ${fmtReading(hover.t)}${simulated && Number.isFinite(hover.t) ? ' (SIMULATED)' : ''}` : 'Point at the image to read a temperature.'}
      </p>
    </div>
  )
}

function ReviewPanel({ c, onDone, clinical = false }: { c: ThermalCapture; onDone: (c: ThermalCapture) => void; clinical?: boolean }) {
  const toast = useToast()
  const [note, setNote] = useState('')
  const review = useMutation({
    mutationFn: (body: ThermalReviewRequest) => api<ThermalCapture>(`/thermal/${c.id}/review`, { method: 'POST', body }),
    onSuccess: (d) => (onDone(d), toast('success', d.status === 'approved' ? 'Measurements approved' : 'Image rejected')),
  })
  const body = (
    <div className="space-y-3 text-sm">
      <p className={clinical ? 'text-ink-muted' : undefined}>Approving records that the image and regions are fit to keep with the patient’s record. It is not a diagnosis, and the image cannot be changed afterwards.</p>
      {review.isError && <Alert tone="error">{errorMessage(review.error)}</Alert>}
      <TextAreaField label="Note" hint="Required when rejecting." rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button loading={review.isPending && review.variables?.decision === 'approved'} onClick={() => review.mutate({ decision: 'approved', note })}>
          Approve measurements
        </Button>
        <Button variant="secondary" disabled={!note.trim()} loading={review.isPending && review.variables?.decision === 'rejected'} onClick={() => review.mutate({ decision: 'rejected', note })}>
          Reject
        </Button>
      </div>
    </div>
  )
  return clinical ? <PanelGroup label="Doctor review">{body}</PanelGroup> : <Card title="Doctor review">{body}</Card>
}

/** The colour scale under the image, and the legend of pixels without a reading. */
function ColourScale({ palette, low, high, missing }: { palette: PaletteName; low: number; high: number; missing: number }) {
  return (
    <div className="space-y-1">
      <div className="h-3 rounded" style={{ background: paletteCss(palette) }} aria-hidden="true" />
      <div className="flex justify-between text-xs tabular-nums text-ink-muted">
        <span>{fmtC(low)}</span>
        <span>{fmtC((low + high) / 2)}</span>
        <span>{fmtC(high)}</span>
      </div>
      {missing > 0 && (
        <p className="flex items-center gap-2 pt-1 text-xs" data-testid="no-reading-legend">
          <span aria-hidden="true" className="inline-block h-3 w-6 shrink-0 rounded-sm border border-line" style={{ background: noReadingCss }} />
          No reading: {missing} pixel{missing === 1 ? '' : 's'}, drawn in grey stripes and left out of every statistic.
        </p>
      )}
    </div>
  )
}

const SOURCE_DETAIL: Record<ThermalCapture['captureSource'], string> = {
  live_capture: 'Captured in the consultation from a camera connected to the tablet.',
  gallery_import: 'An earlier file chosen from the device.',
  file_upload: 'A file uploaded on the thermal pages.',
  simulator: 'Generated by the simulator: not a measurement of anyone.',
}
const CHIP = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap'

/** Where the image came from and how it was processed, as stored. What the device bridge reported is shown as reported: ADAXAI does not verify it. */
function ProvenanceCard({ c }: { c: ThermalCapture }) {
  const simulated = isSimulated(c)
  const r = c.deviceReported
  return (
    <Card title="Provenance">
      <div className="space-y-4" data-testid="thermal-provenance">
        <DescriptionList
          items={[
            [
              'Source',
              <span className="flex flex-wrap items-center gap-2">
                <ThermalSourceBadge capture={c} />
                <span className="text-xs text-ink-muted">{SOURCE_DETAIL[c.captureSource] ?? ''}</span>
              </span>,
            ],
            [
              'Device',
              c.device ? (
                <span className="flex flex-col">
                  <span>{c.device.label}</span>
                  <span className="text-xs text-ink-muted" data-testid="thermal-device-link">
                    Matched by the serial number the device reported (not verified)
                  </span>
                </span>
              ) : (
                'Not registered'
              ),
            ],
            ['Captured at', c.capturedAt ? fmtDateTime(c.capturedAt) : 'Not stated'],
            ['Received at', fmtDateTime(c.createdAt)],
            ['Radiometric', simulated ? 'Not applicable: generated numbers, no camera file' : <span className={`${CHIP} border-ink/60 bg-surface text-ink`}>RADIOMETRIC</span>],
            ['Processing', `${c.extractor.name} ${c.extractor.version}`],
          ]}
        />
        <div className="text-sm">
          <p className="text-xs font-medium text-ink-muted uppercase">Original file SHA-256</p>
          <p className="mt-0.5 font-mono text-xs break-all" data-testid="thermal-raw-sha256">
            {c.rawSha256 || '—'}
          </p>
          <a href={`/api/files/${c.rawFileId}`} download className="mt-1 inline-flex min-h-control items-center gap-2 font-medium text-brand-strong underline underline-offset-2">
            <Download aria-hidden="true" className="size-4" />
            Download original
          </a>
          {simulated && <p className="text-xs text-ink-muted">For a simulated image this is what the simulator was given (its case and seed, as JSON), so that it can be generated again.</p>}
        </div>
        <div className="text-sm">
          <p className="text-xs font-medium text-ink-muted uppercase">Reported by the device, not verified</p>
          {r ? (
            <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-testid="thermal-device-reported">
              <dt className="font-medium text-ink-muted">Model</dt>
              <dd className="break-words">{r.model ?? '—'}</dd>
              <dt className="font-medium text-ink-muted">Serial number</dt>
              <dd className="break-all">{r.serialNumber ?? '—'}</dd>
              <dt className="font-medium text-ink-muted">Firmware</dt>
              <dd className="break-words">{r.programVersion ?? '—'}</dd>
              <dt className="font-medium text-ink-muted">SDK version</dt>
              <dd className="break-words">{r.sdk ? `${r.sdk.name} ${r.sdk.version ?? ''}`.trim() : '—'}</dd>
              {r.bridge && (
                <>
                  <dt className="font-medium text-ink-muted">Bridge</dt>
                  <dd className="break-words">{`${r.bridge.name} ${r.bridge.version}`}</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="mt-0.5 text-ink-muted">Nothing was reported{c.captureSource === 'live_capture' ? '.' : ': not a live capture.'}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

/** A polygon's corners as numbers, with its bounding box kept in step. */
function PointsEditor({ roi, w, h, disabled, embedded, onChange }: { roi: EditableRoi; w: number; h: number; disabled: boolean; embedded: boolean; onChange: (points: RoiPoint[]) => void }) {
  const points = roi.points ?? []
  const set = (i: number, axis: 0 | 1, v: number) => onChange(points.map((p, j) => (j === i ? (axis === 0 ? [v, p[1]] : [p[0], v]) : p)))
  return (
    <fieldset className="mt-3">
      <legend className="text-sm font-medium">Corners ({points.length})</legend>
      <ol className={`mt-1 grid grid-cols-1 gap-2 ${embedded ? '@sm:grid-cols-2 @3xl:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
        {points.map(([x, y], i) => (
          <li key={i} className="flex items-end gap-2">
            <span aria-hidden="true" className="w-5 shrink-0 pb-3 text-right text-xs text-ink-muted tabular-nums">
              {i + 1}
            </span>
            <TextField
              label={
                <>
                  <span className="sr-only">Corner {i + 1} </span>X
                </>
              }
              type="number"
              step="0.1"
              min={0}
              max={w}
              value={x}
              disabled={disabled}
              className="min-w-0 flex-1"
              onChange={(e) => set(i, 0, Number(e.target.value))}
            />
            <TextField
              label={
                <>
                  <span className="sr-only">Corner {i + 1} </span>Y
                </>
              }
              type="number"
              step="0.1"
              min={0}
              max={h}
              value={y}
              disabled={disabled}
              className="min-w-0 flex-1"
              onChange={(e) => set(i, 1, Number(e.target.value))}
            />
            {!disabled && (
              <Button variant="ghost" aria-label={`Remove corner ${i + 1} of ${roi.label}`} disabled={points.length <= 3} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => onChange(points.filter((_, j) => j !== i))} />
            )}
          </li>
        ))}
      </ol>
      {!disabled && (
        <Button
          variant="secondary"
          className="mt-2"
          icon={<Plus aria-hidden="true" className="size-4" />}
          disabled={points.length >= MAX_POINTS}
          onClick={() => {
            // A new corner halfway along the closing edge, to be moved where it belongs.
            const first = points[0]
            const last = points[points.length - 1]
            if (first && last) onChange([...points, [round((first[0] + last[0]) / 2), round((first[1] + last[1]) / 2)]])
          }}
        >
          Add corner
        </Button>
      )}
    </fieldset>
  )
}

/**
 * Thermal measurement workspace for one capture. Everything beyond the measuring the thermal pages have always had is opt-in, so those pages
 * look as before (apart from the source label, which is shown everywhere): `embedded` fits it to its container (container queries instead of
 * the window's width); `allowPolygon` adds the polygon tool, its corner editor and a note per region; `showProvenance` shows where the image
 * came from (source, device, what the device bridge reported, times, the original file's hash and a link to it, processing); `showModelStatus`
 * shows whether a thermal model is installed (there is none); `onDirtyChange` hears whether drawn regions are unsaved (false again when they are
 * saved, and when the viewer goes away), so that the screen around it can ask before it discards them. Pixels without a reading are always drawn
 * apart and never given a temperature.
 *
 * `variant="clinical"` (the doctor's thermal study, DESIGN §5.7) lays the same viewer out for the doctor: the large image with its colour scale
 * and the temperature under the pointer, the drawing tools, the whole image's min / max / mean / SD, the regions with their numbers and pairs,
 * and the review; then `summary` (the study's summary card); then one collapsed "Details" holding everything else (display palette and span,
 * the regions' numeric geometry and comments, the capture's conditions and camera parameters, provenance with the file's SHA-256, the
 * visible-light image, the experimental flags, the model status, the clinician labels, and `details`). It always fits its container. The
 * default `full` variant is the viewer as it was (the nurse's pages keep it).
 */
export function ThermalViewer({
  capture,
  embedded = false,
  allowPolygon = false,
  showProvenance = false,
  showModelStatus = false,
  onDirtyChange,
  variant = 'full',
  summary,
  details,
}: {
  capture: ThermalCapture
  embedded?: boolean
  allowPolygon?: boolean
  showProvenance?: boolean
  showModelStatus?: boolean
  onDirtyChange?: ((dirty: boolean) => void) | undefined
  variant?: 'full' | 'clinical'
  /** Clinical only: shown after the measurements and before Details (the study's summary card). */
  summary?: ReactNode
  /** Clinical only: added at the end of Details (the research entry). */
  details?: ReactNode
}) {
  const { data: me } = useMe()
  const qc = useQueryClient()
  const toast = useToast()
  const matrix = useMatrix(capture)
  const [palette, setPalette] = useState<PaletteName>('iron')
  const [low, setLow] = useState(capture.minC)
  const [high, setHigh] = useState(capture.maxC)
  const [tool, setTool] = useState<Tool>('none')
  const [poly, setPoly] = useState<RoiPoint[]>([])
  const [rois, setRois] = useState<EditableRoi[]>(() => fromCapture(capture))
  const [dirty, setDirty] = useState(false)
  const editable = capture.status === 'draft'
  const simulated = isSimulated(capture)
  const [showFlags, setShowFlags] = useState(false)
  const flags = useThermalFlags(capture, showFlags)
  const missing = useMemo(() => (matrix.data ? countNonFinite(matrix.data) : 0), [matrix.data])
  const setAll = (next: EditableRoi[]) => (setRois(next), setDirty(true))
  const pick = (t: Tool) => (setTool(tool === t ? 'none' : t), setPoly([]))
  const toolSize = embedded || allowPolygon ? 'md' : 'sm'

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // Escape abandons the polygon being drawn, and only that: the key is taken before a dialog around the viewer would close on it.
  useEffect(() => {
    if (tool !== 'polygon') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setPoly([])
      setTool('none')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tool])

  const save = useMutation({
    mutationFn: () =>
      api<ThermalCapture>(`/thermal/${capture.id}/rois`, {
        method: 'PUT',
        body: {
          rois: rois.map(({ label, shape, x, y, width, height, points, pairWith, note }) => ({ label, shape, x, y, width, height, points: shape === 'polygon' ? (points ?? null) : null, pairWith: pairWith || null, note: note || null })) satisfies ThermalRoiInput[],
        },
      }),
    onSuccess: (d) => {
      // The patient's list of images is read again too: the consultation's thermal module, its research view and what Analyze reads show its regions.
      cacheThermalCapture(qc, d)
      setRois(fromCapture(d))
      setDirty(false)
      toast('success', 'Regions saved; statistics computed')
    },
  })

  const serverStats = useMemo(() => new Map(capture.rois.map((r) => [r.label.toLowerCase(), r.stats])), [capture.rois])
  const addRoi = (g: RoiGeom) => {
    let n = rois.length + 1
    while (rois.some((r) => r.label === `Region ${n}`)) n++
    setAll([...rois, { ...g, key: crypto.randomUUID(), label: `Region ${n}`, pairWith: '', note: '' }])
    setTool('none')
  }
  const closePolygon = () => {
    if (poly.length < 3) return
    const b = polygonBounds(poly)
    if (b.width < 1 || b.height < 1) {
      toast('warning', 'This polygon has no area to measure. Place the corners further apart.')
      return
    }
    addRoi({ shape: 'polygon', points: poly, ...roundBox(b) })
    setPoly([])
  }

  const reviewDone = (d: ThermalCapture) => (cacheThermalCapture(qc, d), setRois(fromCapture(d)))

  const drawingTools = editable && (
    <div role="group" aria-label="Drawing tool" className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">Draw a region:</span>
      <Button size={toolSize} variant={tool === 'rect' ? 'primary' : 'secondary'} aria-pressed={tool === 'rect'} icon={<Square aria-hidden="true" className="size-4" />} onClick={() => pick('rect')}>
        Rectangle
      </Button>
      <Button size={toolSize} variant={tool === 'ellipse' ? 'primary' : 'secondary'} aria-pressed={tool === 'ellipse'} icon={<Circle aria-hidden="true" className="size-4" />} onClick={() => pick('ellipse')}>
        Ellipse
      </Button>
      {allowPolygon && (
        <Button size={toolSize} variant={tool === 'polygon' ? 'primary' : 'secondary'} aria-pressed={tool === 'polygon'} icon={<Pentagon aria-hidden="true" className="size-4" />} onClick={() => pick('polygon')}>
          Polygon
        </Button>
      )}
      {(tool === 'rect' || tool === 'ellipse') && <span className="text-sm text-ink-muted">Drag on the image.</span>}
    </div>
  )
  const polygonTool = editable && tool === 'polygon' && (
    <div role="group" aria-label="Polygon being drawn" className="flex flex-wrap items-center gap-2" data-testid="polygon-tool">
      <p className="w-full text-sm text-ink-muted" aria-live="polite">
        {poly.length ? `${poly.length} corner${poly.length === 1 ? '' : 's'}. ` : ''}Tap or click the image to add corners; tap the first corner, double-click or use “Close polygon” to finish. Escape cancels.
        {poly.length >= MAX_POINTS ? ` A polygon has at most ${MAX_POINTS} corners.` : ''}
      </p>
      <Button icon={<Check aria-hidden="true" className="size-4" />} disabled={poly.length < 3} onClick={closePolygon}>
        Close polygon
      </Button>
      <Button variant="secondary" icon={<Undo2 aria-hidden="true" className="size-4" />} disabled={!poly.length} onClick={() => setPoly(poly.slice(0, -1))}>
        Undo last corner
      </Button>
      <Button variant="ghost" icon={<X aria-hidden="true" className="size-4" />} onClick={() => (setPoly([]), setTool('none'))}>
        Cancel
      </Button>
    </div>
  )
  const canvas = matrix.data && (
    <ThermalCanvas
      matrix={matrix.data}
      c={capture}
      low={low}
      high={high}
      palette={palette}
      rois={rois}
      tool={editable ? tool : 'none'}
      onDrawn={addRoi}
      hotspots={showFlags ? flags.data?.hotspots : undefined}
      polygon={poly}
      onPolygonPoint={(p) => setPoly((cur) => (cur.length < MAX_POINTS ? [...cur, p] : cur))}
      onPolygonClose={closePolygon}
      missing={missing}
    />
  )
  const addDefaultRoi = () => addRoi({ shape: 'rect', x: round(capture.width / 4), y: round(capture.height / 4), width: round(capture.width / 4), height: round(capture.height / 4) })

  if (variant === 'clinical') {
    const facts = captureFacts(capture)
    const status = captureStatusSpec(capture.status)
    // The extractor and the file's SHA-256 are shown by the provenance group, once.
    const detailFacts = facts.details.filter((f) => f.key !== 'extractor' && f.key !== 'sha256')
    return (
      <div className="@container space-y-4">
        {simulated && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted" data-testid="thermal-simulated-notice">
            <SimulatedBadge />
            Generated by the simulator: not a measurement of this patient or of anyone. It never reaches the note, the patient portal, a model, Mana or a dataset.
          </p>
        )}
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 @4xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-3">
            {matrix.isPending && <Spinner label="Loading temperature data…" />}
            {matrix.isError && <Alert tone="error">{errorMessage(matrix.error)}</Alert>}
            {matrix.data && (
              <>
                {canvas}
                <ColourScale palette={palette} low={low} high={high} missing={missing} />
                {drawingTools}
                {polygonTool}
              </>
            )}
          </div>
          <div className="min-w-0">
            <PanelGroup
              label="Whole image"
              testId="thermal-dashboard"
              actions={
                <>
                  <ThermalSourceBadge capture={capture} />
                  <Badge tone={status.tone} dot>
                    {status.label}
                  </Badge>
                </>
              }
            >
              <p className="text-sm">
                {facts.clinical.map((f, i) => (
                  <span key={f.key} className={i ? 'text-ink-muted' : 'font-medium'}>
                    {i ? ` · ${f.label} ${f.value}` : f.value}
                  </span>
                ))}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 @md:grid-cols-4 @4xl:grid-cols-2">
                {wholeImageStats(capture).map((s) => (
                  <div key={s.key} className="min-w-0" data-stat={s.key}>
                    <dt className="text-xs text-ink-muted">{s.label}</dt>
                    <dd className={s.missing ? 'text-sm text-ink-muted' : 'tabular-nums'}>
                      {s.missing ? (
                        s.value
                      ) : (
                        <>
                          <span className="text-2xl font-semibold">{s.value}</span> <span className="text-sm text-ink-muted">{s.unit}</span>
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-xs text-ink-muted" data-testid="thermal-dashboard-basis">
                {simulated ? 'SIMULATED: generated numbers, not a measurement.' : 'Measured from the radiometric data of this image (skin-surface temperature). Measurements only, not a diagnosis.'}
              </p>
            </PanelGroup>
            <PanelGroup
              label="Regions"
              actions={
                editable && (
                  <>
                    <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={addDefaultRoi}>
                      Add region
                    </Button>
                    <Button size="sm" icon={<Save aria-hidden="true" className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                      Save regions
                    </Button>
                  </>
                )
              }
            >
              {save.isError && <Alert tone="error" className="mb-3">{errorMessage(save.error)}</Alert>}
              {!rois.length && <p className="text-sm text-ink-muted">No regions yet.{editable ? ' Draw one on the image, or use “Add region”.' : ''}</p>}
              <ul className="divide-y divide-line">
                {rois.map((r, i) => {
                  const saved = !dirty ? serverStats.get(r.label.toLowerCase()) : undefined
                  const s = roiStatsParts(saved ?? (matrix.data ? roiPreviewStats(matrix.data, capture.width, capture.height, r) : null))
                  const set = (patch: Partial<EditableRoi>) => setAll(rois.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                  return (
                    <li key={r.key} className="py-3 first:pt-1 last:pb-0" data-testid={`roi-${r.label}`}>
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
                        <TextField label="Label" value={r.label} disabled={!editable} onChange={(e) => set({ label: e.target.value })} />
                        <SelectField label="Compare with" value={r.pairWith} disabled={!editable} onChange={(e) => set({ pairWith: e.target.value })}>
                          <option value="">—</option>
                          {rois.filter((o) => o.key !== r.key).map((o) => (
                            <option key={o.key} value={o.label}>
                              {o.label}
                            </option>
                          ))}
                        </SelectField>
                        {editable ? <Button variant="ghost" aria-label={`Remove ${r.label}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => setAll(rois.filter((_, j) => j !== i))} /> : <span />}
                      </div>
                      <p className="mt-2 text-sm tabular-nums" data-testid={`roi-stats-${r.label}`}>
                        {s ? (
                          <>
                            Mean <strong>{s.mean}</strong> · min {s.min} · max {s.max} · SD {s.sd} · {s.pixels}
                            {!saved && <span className="ml-2 text-xs text-ink-muted">(preview — save to record)</span>}
                          </>
                        ) : (
                          <span className="text-ink-muted">No pixels with a reading inside this region.</span>
                        )}
                      </p>
                    </li>
                  )
                })}
              </ul>
              {!dirty && capture.pairs.length > 0 && (
                <div className="mt-3 border-t border-line pt-3">
                  <p className="text-sm font-medium">Paired differences</p>
                  <ul className="mt-1 space-y-1 text-sm tabular-nums" data-testid="pair-diffs">
                    {capture.pairs.map((p) => (
                      <li key={`${p.a}-${p.b}`}>
                        {p.a} − {p.b}: mean <strong>{fmtDiff(p.meanDiff)}</strong> · max {fmtDiff(p.maxDiff)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs text-ink-muted">Differences are measurements. Interpretation depends on the capture protocol and clinical context.</p>
                </div>
              )}
            </PanelGroup>
            {editable && me?.role === 'doctor' && !dirty && <ReviewPanel clinical c={capture} onDone={reviewDone} />}
            {editable && me?.role === 'doctor' && dirty && (
              <PanelGroup>
                <p className="text-sm text-ink-muted">Save the regions before reviewing.</p>
              </PanelGroup>
            )}
          </div>
        </div>
        {summary}
        <details className="group rounded-lg border border-line" data-testid="thermal-details">
          <summary className="flex min-h-control cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Details
            <span className="min-w-0 truncate text-xs font-normal text-ink-muted">Display, region geometry, capture conditions, provenance, experimental flags, model status, labels, research</span>
          </summary>
          <div className="pb-1">
            <Card title="Display">
              <div className="grid grid-cols-1 gap-3 @lg:grid-cols-4">
                <SelectField label="Palette" value={palette} onChange={(e) => setPalette(e.target.value as PaletteName)}>
                  <option value="iron">Iron</option>
                  <option value="rainbow">Rainbow</option>
                  <option value="grayscale">Greyscale</option>
                </SelectField>
                <TextField label="Span low (°C)" type="number" step="0.1" value={low} onChange={(e) => setLow(Number(e.target.value))} />
                <TextField label="Span high (°C)" type="number" step="0.1" value={high} onChange={(e) => setHigh(Number(e.target.value))} />
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => (setLow(capture.minC), setHigh(capture.maxC))}>
                    Auto span
                  </Button>
                </div>
              </div>
            </Card>
            {rois.length > 0 && (
              <Card title="Region geometry">
                <p className="mb-3 text-xs text-ink-muted">Each region in image pixels, as drawn. Change a number to move a region exactly.</p>
                <ul className="divide-y divide-line">
                  {rois.map((r, i) => {
                    const set = (patch: Partial<EditableRoi>) => setAll(rois.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                    const isPolygon = r.shape === 'polygon'
                    return (
                      <li key={r.key} className="py-3 first:pt-0" data-testid={`roi-geometry-${r.label}`}>
                        <fieldset>
                          <legend className="text-sm font-medium">{r.label}</legend>
                          <div className={`mt-2 ${isPolygon ? 'grid grid-cols-1 gap-3 @md:grid-cols-[minmax(0,12rem)]' : 'grid grid-cols-2 gap-3 @lg:grid-cols-[minmax(0,10rem)_repeat(4,minmax(0,6rem))]'}`}>
                            <SelectField
                              label="Shape"
                              value={r.shape}
                              disabled={!editable}
                              className={isPolygon ? undefined : 'col-span-2 @lg:col-span-1'}
                              onChange={(e) => {
                                const shape = e.target.value as RoiGeom['shape']
                                set(shape === 'polygon' ? { shape, points: boxPolygon(r) } : { shape, points: null })
                              }}
                            >
                              <option value="rect">Rectangle</option>
                              <option value="ellipse">Ellipse</option>
                              <option value="polygon">Polygon</option>
                            </SelectField>
                            {!isPolygon &&
                              (['x', 'y', 'width', 'height'] as const).map((k) => (
                                <TextField key={k} label={k === 'width' ? 'Width' : k === 'height' ? 'Height' : k.toUpperCase()} type="number" step="1" min={0} value={r[k]} disabled={!editable} onChange={(e) => set({ [k]: Number(e.target.value) })} />
                              ))}
                          </div>
                          {isPolygon && <PointsEditor roi={r} w={capture.width} h={capture.height} disabled={!editable} embedded onChange={(points) => set({ points, ...roundBox(polygonBounds(points)) })} />}
                          <TextAreaField label="Comment on this region" className="mt-3" rows={2} maxLength={300} value={r.note} disabled={!editable} onChange={(e) => set({ note: e.target.value })} />
                        </fieldset>
                      </li>
                    )
                  })}
                </ul>
              </Card>
            )}
            <Card title="Capture details">
              <DescriptionList
                items={detailFacts.map((f) => [f.label, f.key === 'dataOrigin' ? <Badge tone={capture.dataOrigin === 'clinical' ? 'neutral' : 'notice'}>{f.value}</Badge> : f.value])}
              />
              <p className="mt-3 text-xs text-ink-muted">
                {simulated
                  ? 'Generated numbers: there is no camera, no radiometric file and no capture conditions.'
                  : 'Temperatures come from the camera’s radiometric data and depend on emissivity, distance and room conditions. They are not a diagnosis and this tool is not clinically validated. It has been tested with public FLIR sample files only.'}
              </p>
            </Card>
            <ProvenanceCard c={capture} />
            {capture.visibleFileId && (
              <Card title="Visible-light image">
                <img src={`/api/files/${capture.visibleFileId}`} alt={`Visible-light photo taken with the thermal image of ${capture.protocol.bodyRegion}`} className="w-full max-w-md rounded-lg" loading="lazy" />
              </Card>
            )}
            <ThermalFlagsCard shown={showFlags} onToggle={setShowFlags} flags={flags} unsaved={dirty} />
            <ThermalModelStatus />
            {capture.status === 'approved' && <ThermalLabelsCard capture={capture} />}
            {details}
          </div>
        </details>
      </div>
    )
  }

  const grid = {
    main: embedded ? 'grid grid-cols-1 gap-6 @5xl:grid-cols-[minmax(0,1fr)_24rem]' : 'grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]',
    controls: embedded ? 'grid grid-cols-1 gap-3 @lg:grid-cols-4' : 'grid grid-cols-1 gap-3 sm:grid-cols-4',
    box: embedded ? 'grid grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-[1fr_7rem_repeat(4,5.5rem)_10rem_auto] @4xl:items-end' : 'grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem_repeat(4,5.5rem)_10rem_auto] sm:items-end',
    polygon: embedded ? 'grid grid-cols-1 gap-3 @md:grid-cols-2 @2xl:grid-cols-[1fr_9rem_10rem_auto] @2xl:items-end' : 'grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem_10rem_auto] sm:items-end',
  }

  return (
    <div className={embedded ? '@container space-y-6' : 'space-y-6'}>
      {simulated ? (
        <Alert tone="warning" title="SIMULATED: not a measurement">
          These temperatures were generated by the simulator to test the system. They are not a measurement of this patient or of anyone, and they are never sent to the patient portal, a model, Mana, a dataset export or a consultation note.
        </Alert>
      ) : (
        <Alert tone="warning" title="Measurements only">
          Temperatures come from the camera’s radiometric data and depend on emissivity, distance and room conditions. They are not a diagnosis and this tool is not clinically validated. It has been tested with public FLIR sample files only.
        </Alert>
      )}
      <div className={grid.main}>
        <Card title="Thermal image" actions={<ThermalSourceBadge capture={capture} />}>
          {matrix.isPending && <Spinner label="Loading temperature data…" />}
          {matrix.isError && <Alert tone="error">{errorMessage(matrix.error)}</Alert>}
          {matrix.data && (
            <div className={embedded ? '@container space-y-4' : 'space-y-4'}>
              {canvas}
              <ColourScale palette={palette} low={low} high={high} missing={missing} />
              <div className={grid.controls}>
                <SelectField label="Palette" value={palette} onChange={(e) => setPalette(e.target.value as PaletteName)}>
                  <option value="iron">Iron</option>
                  <option value="rainbow">Rainbow</option>
                  <option value="grayscale">Greyscale</option>
                </SelectField>
                <TextField label="Span low (°C)" type="number" step="0.1" value={low} onChange={(e) => setLow(Number(e.target.value))} />
                <TextField label="Span high (°C)" type="number" step="0.1" value={high} onChange={(e) => setHigh(Number(e.target.value))} />
                <div className="flex items-end">
                  <Button variant="secondary" onClick={() => (setLow(capture.minC), setHigh(capture.maxC))}>
                    Auto span
                  </Button>
                </div>
              </div>
              {drawingTools}
              {polygonTool}
            </div>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Capture">
            <DescriptionList
              items={[
                ['Status', capture.status === 'draft' ? <Badge tone="warn">Draft — awaiting review</Badge> : capture.status === 'approved' ? <Badge tone="ok">Approved</Badge> : <Badge>Rejected</Badge>],
                ['Body region', `${capture.protocol.bodyRegion} · ${capture.protocol.view.replace('_', ' ')}`],
                ['Image range', `${fmtC(capture.minC)} – ${fmtC(capture.maxC)} (mean ${fmtC(capture.meanC)}${typeof capture.stdC === 'number' ? `, SD ${capture.stdC.toFixed(2)} °C` : ''})`],
                ['Resolution', `${capture.width} × ${capture.height}`],
                ['Room / acclimatisation', `${capture.protocol.roomTempC ?? '—'} °C · ${capture.protocol.acclimatisationMin ?? '—'} min`],
                ['Distance', capture.protocol.distanceM ? `${capture.protocol.distanceM} m` : '—'],
                ['Emissivity (camera)', capture.parameters.emissivity?.toFixed(2) ?? '—'],
                ['Reflected temp (camera)', fmtC(capture.parameters.reflectedTempC)],
                ['Camera', [capture.camera.make, capture.camera.model].filter(Boolean).join(' ') || '—'],
                // With the provenance card, the extractor is shown there as "Processing".
                ...(showProvenance ? [] : ([['Extractor', `${capture.extractor.name} ${capture.extractor.version}`]] as [string, string][])),
                ['Data origin', <Badge tone={capture.dataOrigin === 'clinical' ? 'neutral' : 'notice'}>{DATA_ORIGIN_LABELS[capture.dataOrigin]}</Badge>],
                ['Uploaded', `${fmtDateTime(capture.createdAt)} · ${capture.createdByName ?? ''}`],
                ...(capture.review ? ([['Reviewed', `${fmtDateTime(capture.review.at)} · ${capture.review.byName ?? ''}${capture.review.note ? ` · ${capture.review.note}` : ''}`]] as [string, string][]) : []),
              ]}
            />
            {capture.protocol.notes && <p className="mt-3 text-sm">Notes: {capture.protocol.notes}</p>}
          </Card>
          {showProvenance && <ProvenanceCard c={capture} />}
          {capture.visibleFileId && (
            <Card title="Visible-light image">
              <img src={`/api/files/${capture.visibleFileId}`} alt={`Visible-light photo taken with the thermal image of ${capture.protocol.bodyRegion}`} className="w-full rounded-lg" />
            </Card>
          )}
        </div>
      </div>

      <Card
        title="Regions of interest"
        actions={
          editable && (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={addDefaultRoi}>
                Add region
              </Button>
              <Button size="sm" icon={<Save aria-hidden="true" className="size-4" />} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                Save regions
              </Button>
            </div>
          )
        }
      >
        {save.isError && <Alert tone="error" className="mb-3">{errorMessage(save.error)}</Alert>}
        {!rois.length && <p className="text-sm text-ink-muted">No regions yet. {editable ? 'Draw on the image or use “Add region”.' : ''}</p>}
        <ul className={embedded ? '@container space-y-3' : 'space-y-3'}>
          {rois.map((r, i) => {
            const saved = !dirty ? serverStats.get(r.label.toLowerCase()) : undefined
            const preview = matrix.data ? roiPreviewStats(matrix.data, capture.width, capture.height, r) : null
            const s = saved ?? preview
            const set = (patch: Partial<EditableRoi>) => setAll(rois.map((x, j) => (j === i ? { ...x, ...patch } : x)))
            const isPolygon = r.shape === 'polygon'
            const compare = (
              <SelectField label="Compare with" value={r.pairWith} disabled={!editable} onChange={(e) => set({ pairWith: e.target.value })}>
                <option value="">—</option>
                {rois.filter((o) => o.key !== r.key).map((o) => (
                  <option key={o.key} value={o.label}>
                    {o.label}
                  </option>
                ))}
              </SelectField>
            )
            return (
              <li key={r.key} className="rounded-lg border border-line p-3" data-testid={`roi-${r.label}`}>
                <div className={isPolygon ? grid.polygon : grid.box}>
                  <TextField label="Label" value={r.label} disabled={!editable} onChange={(e) => set({ label: e.target.value })} />
                  <SelectField
                    label="Shape"
                    value={r.shape}
                    disabled={!editable}
                    onChange={(e) => {
                      const shape = e.target.value as RoiGeom['shape']
                      // A box becomes a four-corner polygon; a polygon becomes a box over its bounding box.
                      set(shape === 'polygon' ? { shape, points: boxPolygon(r) } : { shape, points: null })
                    }}
                  >
                    <option value="rect">Rectangle</option>
                    <option value="ellipse">Ellipse</option>
                    {(allowPolygon || isPolygon) && <option value="polygon">Polygon</option>}
                  </SelectField>
                  {!isPolygon &&
                    (['x', 'y', 'width', 'height'] as const).map((k) => (
                      <TextField key={k} label={k === 'width' ? 'Width' : k === 'height' ? 'Height' : k.toUpperCase()} type="number" step="1" min={0} value={r[k]} disabled={!editable} onChange={(e) => set({ [k]: Number(e.target.value) })} />
                    ))}
                  {compare}
                  {editable && <Button variant="ghost" aria-label={`Remove ${r.label}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => setAll(rois.filter((_, j) => j !== i))} />}
                </div>
                {isPolygon && <PointsEditor roi={r} w={capture.width} h={capture.height} disabled={!editable} embedded={embedded} onChange={(points) => set({ points, ...roundBox(polygonBounds(points)) })} />}
                {/* The region's note. Labelled "Comment" so that it is never taken for the review's "Note". */}
                {allowPolygon ? (
                  <TextAreaField label="Comment on this region" className="mt-3" rows={2} maxLength={300} value={r.note} disabled={!editable} onChange={(e) => set({ note: e.target.value })} />
                ) : (
                  r.note && <p className="mt-2 text-sm break-words">Comment: {r.note}</p>
                )}
                <p className="mt-2 text-sm tabular-nums" data-testid={`roi-stats-${r.label}`}>
                  {s ? (
                    <>
                      Mean <strong>{fmtC(s.mean, 2)}</strong> · min {fmtC(s.min, 2)} · max {fmtC(s.max, 2)} · SD {typeof s.std === 'number' ? s.std.toFixed(2) : '—'} · {s.pixelCount} px
                      {!saved && <span className="ml-2 text-xs text-ink-muted">(preview — save to record)</span>}
                    </>
                  ) : (
                    <span className="text-ink-muted">No pixels with a reading inside this region.</span>
                  )}
                </p>
              </li>
            )
          })}
        </ul>
        {!dirty && capture.pairs.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium">Paired differences</p>
            <ul className="mt-1 space-y-1 text-sm tabular-nums" data-testid="pair-diffs">
              {capture.pairs.map((p) => (
                <li key={`${p.a}-${p.b}`}>
                  {p.a} − {p.b}: mean <strong>{p.meanDiff === null ? '—' : `${p.meanDiff > 0 ? '+' : ''}${p.meanDiff.toFixed(2)} °C`}</strong> · max {p.maxDiff === null ? '—' : `${p.maxDiff > 0 ? '+' : ''}${p.maxDiff.toFixed(2)} °C`}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-ink-muted">Differences are measurements. Interpretation depends on the capture protocol and clinical context.</p>
          </div>
        )}
      </Card>

      <ThermalFlagsCard shown={showFlags} onToggle={setShowFlags} flags={flags} unsaved={dirty} />
      {showModelStatus && <ThermalModelStatus />}
      {capture.status === 'approved' && <ThermalLabelsCard capture={capture} />}

      {editable && me?.role === 'doctor' && !dirty && <ReviewPanel c={capture} onDone={reviewDone} />}
      {editable && me?.role === 'doctor' && dirty && <Alert tone="info">Save the regions before reviewing.</Alert>}
    </div>
  )
}
