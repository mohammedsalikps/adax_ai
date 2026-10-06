import type { Encounter, PatientDetail, ThermalCapture } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Thermometer } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api.ts'
import { patientKey } from '../../../lib/clinical.ts'
import { fmtC, noReadingShade, paletteLut, patientThermalKey, useMatrix, useThermalModelStatus } from '../../../lib/thermal.ts'
import { colourize, findNativeBridge } from '../../../lib/thermalCamera.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { ThermalSourceBadge } from '../../thermal/ThermalSourceBadge.tsx'
import { Badge } from '../../ui/Feedback.tsx'
import { CLOSED_ONLY, OPEN_ONLY } from '../ModuleShell.tsx'
import { consentOf, NOT_UPDATED, safely, type SummaryState, thermalCameraLine, thermalCore, type ThermalNewest, thermalState, type ThermalView, thermalView } from './state.ts'

/*
 * Module 5, thermal imaging: this consultation's images as the thermal panel already read them (the patient's thermal list) and the patient's
 * consents, both observed with their owners' keys and functions and never enabled. Two reads are this summary's own, both what the thermal
 * pages already do: whether a thermal model is installed (GET /api/thermal/model-status, at most once a minute, shared with the workspace),
 * and the newest image's temperature matrix, coloured into a small picture exactly as the viewer colours it (the same query as the viewer:
 * read once, then kept; the file read is audited by the server as any image shown is). Nothing here measures, flags or concludes anything.
 */

const capturesQuery = (patientId: string) => ({ queryKey: patientThermalKey(patientId), queryFn: () => api<{ captures: ThermalCapture[] }>(`/patients/${patientId}/thermal`), enabled: false }) as const
const patientQuery = (patientId: string) => ({ queryKey: patientKey(patientId), queryFn: () => api<PatientDetail>(`/patients/${patientId}`), enabled: false }) as const

const thermalConsent = (p: PatientDetail) => consentOf(p, 'thermal_imaging')
/** Whether the tablet app's camera bridge is on this page (it never is in a browser). */
const hasBridge = () => safely(() => findNativeBridge() !== null, false)

/**
 * For the page: the thermal module's chip, what the workflow strip counts (this consultation's images, and the simulated ones; null until read),
 * and what the analysis' list of inputs needs (the patient's approved images that are not simulated, the simulated ones, a withdrawn consent).
 * It asks the server nothing.
 */
export function useThermalModule(encounter: Pick<Encounter, 'id' | 'patient'>): {
  state: SummaryState
  facts: InputModuleFacts['thermal']
  analysis: { approvedThermal: number; simulatedThermal: number; thermalConsentWithdrawn: boolean }
} {
  const id = encounter.id
  const captures = useQuery({ ...capturesQuery(encounter.patient.id), select: (d: { captures: ThermalCapture[] } | null) => thermalCore(d?.captures, id) })
  const consent = useQuery({ ...patientQuery(encounter.patient.id), select: thermalConsent })
  const core = captures.data
  return {
    state: thermalState(core, consent.data ?? null, captures.isError),
    facts: core ? { images: core.images, simulated: core.simulated } : null,
    analysis: { approvedThermal: core?.approvedReal ?? 0, simulatedThermal: core?.simulatedAll ?? 0, thermalConsentWithdrawn: consent.data === 'withdrawn' },
  }
}

function useThermalView(encounter: Pick<Encounter, 'id' | 'patient'>, { withModel }: { withModel: boolean }): ThermalView {
  const captures = useQuery(capturesQuery(encounter.patient.id))
  const patient = useQuery(patientQuery(encounter.patient.id))
  const model = useThermalModelStatus(withModel)
  const bridge = useMemo(hasBridge, [])
  return safely(
    () =>
      thermalView({
        captures: captures.data === undefined ? undefined : (captures.data?.captures ?? null),
        failed: captures.isError,
        patient: patient.data,
        encounterId: encounter.id,
        model: model.data,
        modelFailed: model.isError,
        bridge,
      }),
    {
      state: NOT_UPDATED,
      facts: null,
      analysis: { approvedThermal: 0, simulatedThermal: 0, thermalConsentWithdrawn: false },
      newest: null,
      images: 'The thermal images could not be read just now.',
      consentLine: null,
      camera: thermalCameraLine(bridge),
      model: { chip: null, available: null, text: null },
      research: 'Research mode available',
      meta: null,
    },
  )
}

const CHIP = 'inline-flex items-center rounded-md border border-ink/60 bg-surface px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide whitespace-nowrap text-ink'

/**
 * The range the small picture is coloured over: from the 2nd to the 98th percentile of the image's own temperatures, for display only (the
 * image's measured range is said in words beside it). Over the full range, one hot spot (a lamp, a hand in the frame) leaves the rest of a
 * 56px picture nearly black. Null when there are too few readings to tell, and the full range is used instead.
 */
export function displayRange(data: ArrayLike<number>): { lo: number; hi: number } | null {
  const step = Math.max(1, Math.floor(data.length / 20_000))
  const xs: number[] = []
  for (let i = 0; i < data.length; i += step) {
    const v = data[i]!
    if (Number.isFinite(v)) xs.push(v)
  }
  if (xs.length < 16) return null
  xs.sort((p, q) => p - q)
  const lo = xs[Math.floor(0.02 * (xs.length - 1))]!
  const hi = xs[Math.ceil(0.98 * (xs.length - 1))]!
  return hi > lo ? { lo, hi } : null
}

/**
 * The newest image as a small picture (56px high), coloured from its own temperatures with the viewer's iron palette, stretched over the 2nd to
 * 98th percentile of the image for display (displayRange; the picture's name says so); a pixel without a reading in grey stripes.
 *
 * The canvas is always in the page and is drawn whenever it, the temperatures or the range change (a layout effect on the canvas element
 * itself, so a canvas put in the page after the temperatures arrived, or resized for another image, is drawn too: setting a canvas's size
 * clears it). Until the temperatures arrive the frame shows a quiet thermometer, and "Image not loaded" if they cannot be read (the read gives
 * up after a few seconds and tries again: lib/thermal.ts useMatrix). The parent keys it by the image, so another image starts from a new canvas.
 */
function Thumbnail({ n }: { n: ThermalNewest }) {
  const c = n.capture
  const matrix = useMatrix(c)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const lut = useMemo(() => paletteLut('iron'), [])
  const data = matrix.data
  const fits = !!data && data.length === c.width * c.height
  const range = useMemo(() => (data && fits ? displayRange(data) : null), [data, fits])
  useLayoutEffect(() => {
    const ctx = canvas?.getContext('2d')
    if (!ctx || !data || data.length !== c.width * c.height) return
    ctx.putImageData(new ImageData(colourize(data, c.width, c.height, lut, range?.lo ?? c.minC, range?.hi ?? c.maxC, noReadingShade), c.width, c.height), 0, 0)
  }, [canvas, data, c.width, c.height, c.minC, c.maxC, lut, range])
  const failed = matrix.isError || (!!data && !fits)
  const what = n.simulated ? 'Simulated thermal image (not a measurement)' : 'Thermal image'
  const shade = range ? `, coloured over ${fmtC(range.lo)} to ${fmtC(range.hi)} (2nd to 98th percentile, for display only)` : ''
  return (
    <div
      className="relative h-14 max-w-20 min-w-10 shrink-0 self-start overflow-hidden rounded-md border border-line bg-canvas"
      style={{ aspectRatio: `${c.width} / ${c.height}` }}
      data-testid="summary-thermal-image"
      data-loaded={fits}
    >
      <canvas
        ref={setCanvas}
        width={c.width}
        height={c.height}
        role={fits ? 'img' : undefined}
        aria-hidden={fits ? undefined : true}
        aria-label={fits ? `${what}, the newest of this consultation: ${n.body}, ${fmtC(c.minC)} to ${fmtC(c.maxC)}${shade}` : undefined}
        title={fits && range ? `Display range ${fmtC(range.lo)} to ${fmtC(range.hi)} (2nd to 98th percentile)` : undefined}
        className={`absolute inset-0 size-full ${fits ? '' : 'invisible'}`}
      />
      {!fits && (
        <span className="absolute inset-0 flex items-center justify-center p-0.5 text-center text-[0.625rem] leading-tight text-ink-muted">
          {failed ? (
            'Image not loaded'
          ) : (
            <>
              <Thermometer aria-hidden="true" className="size-4 opacity-60" />
              <span className="sr-only">Loading the image…</span>
            </>
          )}
        </span>
      )}
    </div>
  )
}

/**
 * The newest image of this consultation, beside its picture: where on the body (cut short with an ellipsis where it is long), its source
 * (SIMULATED when generated) and approval on the first line; its range and how many images there are on the second; then, while the module is
 * closed, its two actions (`actions`). Open, also its min, max and mean, whether it is radiometric and its regions.
 */
function Newest({ n, images, actions }: { n: ThermalNewest; images: string; actions?: ReactNode }) {
  const c = n.capture
  return (
    <div className="flex min-w-0 gap-2.5" data-testid="summary-thermal-newest" data-status={c.status} data-simulated={n.simulated}>
      {c.width > 0 && c.height > 0 && <Thumbnail key={c.id} n={n} />}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 items-center gap-1.5 group-data-[open=true]/module:flex-wrap">
          <span className="min-w-0 truncate font-medium group-data-[open=true]/module:whitespace-normal" title={n.body}>
            {n.body}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <ThermalSourceBadge capture={c} compact />
            <Badge tone={n.status.tone}>
              <span className="sr-only">Status: </span>
              {n.status.word}
            </Badge>
          </span>
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="whitespace-nowrap">{n.range}</span>
          <span className="text-xs text-ink-muted" data-testid="summary-thermal-images">
            {images}
          </span>
        </p>
        {actions}
        <div className={OPEN_ONLY}>
          <p>{n.stats}</p>
          <p className="text-xs text-ink-muted">
            {n.radiometric} · {n.regions}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * The summary of module 5. Closed: the newest image of this consultation (a small picture; where on the body; its source, SIMULATED when
 * generated; its approval; its range), how many images there are and how many are approved, and the module's two actions (`actions`: the
 * thermal imaging viewer and the research view; the full panel has its own once the module is open). Open, also the newest image's
 * measurements, the thermal model (MODEL UNAVAILABLE: none is installed) and that the research view is there; the camera ("FLIR ONE not
 * connected" in a browser) is said by the panel under it, and here only for whoever reads the summary alone.
 */
export function ThermalSummary({ encounter, actions }: { encounter: Pick<Encounter, 'id' | 'patient'>; actions?: ReactNode }) {
  const v = useThermalView(encounter, { withModel: true })
  const quick = actions ? <div className={`flex flex-wrap gap-1.5 ${CLOSED_ONLY}`}>{actions}</div> : null
  return (
    <div className="space-y-1.5" data-testid="summary-thermal" data-state={v.state.kind}>
      {v.newest ? (
        <Newest n={v.newest} images={v.images} actions={quick} />
      ) : (
        <>
          <p data-testid="summary-thermal-images">{v.images}</p>
          {quick}
        </>
      )}
      {v.consentLine && <p className="text-pending">{v.consentLine}</p>}
      <div className={`space-y-1 text-xs text-ink-muted ${OPEN_ONLY}`}>
        <p className="sr-only" data-testid="summary-thermal-camera">
          {v.camera}
        </p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="summary-thermal-model" data-available={v.model.available === null ? 'unknown' : String(v.model.available)}>
          {v.model.chip && (
            <span className={CHIP}>
              <span className="sr-only">Thermal model: </span>
              {v.model.chip}
            </span>
          )}
          {v.model.text && <span>{v.model.text}</span>}
          <span data-testid="summary-thermal-research">{v.research}</span>
        </p>
      </div>
    </div>
  )
}

/** Where the newest image came from (live capture, imported, uploaded, simulated) and when it was taken. */
export function ThermalMeta({ encounter }: { encounter: Pick<Encounter, 'id' | 'patient'> }) {
  const v = useThermalView(encounter, { withModel: false })
  return v.meta ? <span data-testid="summary-thermal-meta">{v.meta}</span> : null
}
