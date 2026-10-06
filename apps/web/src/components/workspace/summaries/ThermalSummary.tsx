import type { Encounter, PatientDetail, ThermalCapture } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Camera, FlaskConical, RotateCw, ScanLine } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api.ts'
import { patientKey } from '../../../lib/clinical.ts'
import { fmtC, noReadingShade, paletteCss, paletteLut, patientThermalKey, useMatrix, useThermalModelStatus } from '../../../lib/thermal.ts'
import { colourize, findNativeBridge } from '../../../lib/thermalCamera.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { ThermalSourceBadge } from '../../thermal/ThermalSourceBadge.tsx'
import { CLOSED_ONLY, OPEN_ONLY, QuickAction, runModuleAction } from '../ModuleShell.tsx'
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
      canCapture: false,
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
 * small picture nearly black. Null when there are too few readings to tell, and the full range is used instead.
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

/** The thumbnail's height, and its width from the image's own proportions (kept between 32 and 80px). */
const THUMB_H = 44
const thumbWidth = (c: Pick<ThermalCapture, 'width' | 'height'>) => Math.round(Math.min(80, Math.max(32, (THUMB_H * c.width) / c.height)))

/**
 * The newest image as a small picture (44px high), coloured from its own temperatures with the viewer's iron palette, stretched over the 2nd
 * to 98th percentile of the image for display (displayRange), with that stretch under it as a small temperature scale (its two ends in °C); a
 * pixel without a reading in grey stripes.
 *
 * The canvas is always in the page and is drawn whenever it, the temperatures or the range change (a layout effect on the canvas element
 * itself, so a canvas put in the page after the temperatures arrived, or resized for another image, is drawn too: setting a canvas's size
 * clears it). Until the temperatures arrive the frame is a quiet placeholder that pulses (still where motion is reduced); a read that hangs is
 * given up and tried again quickly (lib/thermal.ts useMatrix), and when it has failed the frame says "Not loaded" and is a button that reads it
 * again. The parent keys it by the image, so another image starts from a new canvas.
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
  const failed = !matrix.isFetching && (matrix.isError || (!!data && !fits))
  const what = n.simulated ? 'Simulated thermal image (not a measurement)' : 'Thermal image'
  const lo = range?.lo ?? c.minC
  const hi = range?.hi ?? c.maxC
  const shade = range ? `, coloured over ${fmtC(range.lo)} to ${fmtC(range.hi)} (2nd to 98th percentile, for display only)` : ''
  return (
    <div className="float-left mr-2.5 mb-1" style={{ width: thumbWidth(c) }} data-testid="summary-thermal-thumb">
      <div className="relative overflow-hidden rounded-md border border-line bg-canvas" style={{ height: THUMB_H }} data-testid="summary-thermal-image" data-loaded={fits}>
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
        {!fits &&
          (failed ? (
            <button
              type="button"
              onClick={() => void matrix.refetch()}
              className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-[0.625rem] leading-tight text-ink-muted hover:bg-surface hover:text-ink"
              data-testid="summary-thermal-retry"
            >
              <RotateCw aria-hidden="true" className="size-3.5" />
              <span>Not loaded</span>
              <span className="sr-only">: read the thermal image again</span>
            </button>
          ) : (
            <span className="absolute inset-0 animate-pulse bg-line/70" role="status">
              <span className="sr-only">Loading the image…</span>
            </span>
          ))}
      </div>
      {fits && (
        <div className="mt-1" role="img" aria-label={`Colour scale of the picture: ${fmtC(lo)} to ${fmtC(hi)}${range ? ' (2nd to 98th percentile of this image, for display only)' : ''}`} data-testid="summary-thermal-scale">
          <div className="h-1 rounded-full" style={{ background: paletteCss('iron') }} />
          <p className="mt-px flex justify-between text-[0.625rem] leading-3 text-ink-muted tabular-nums">
            <span>{lo.toFixed(1)}</span>
            <span>{hi.toFixed(1)}°</span>
          </p>
        </div>
      )}
    </div>
  )
}

const STATUS_TONE = { warn: 'bg-pending-soft text-pending border-pending/20', ok: 'bg-ok-soft text-ok border-ok/20', neutral: 'bg-canvas text-ink-muted border-line' } as const

/**
 * The newest image of this consultation, beside its picture and its scale: where on the body (cut short with an ellipsis where it is long),
 * then its source (SIMULATED when generated), its approval and its range on one line ("Left knee · IMPORTED · Approved · 25.9–62.3 °C"); then,
 * while the module is closed, its actions (`actions`). Open, also how many images there are, its min, max and mean, whether it is radiometric
 * and its regions.
 */
function Newest({ n, images, actions }: { n: ThermalNewest; images: string; actions?: ReactNode }) {
  const c = n.capture
  return (
    // A plain block, not a box of its own (which the module's corner button would narrow from top to bottom): the picture floats beside the
    // lines, and the last element clears it.
    <div data-testid="summary-thermal-newest" data-status={c.status} data-simulated={n.simulated}>
      {c.width > 0 && c.height > 0 && <Thumbnail key={c.id} n={n} />}
      <p className="truncate font-medium group-data-[open=true]/module:whitespace-normal" title={n.body}>
        {n.body}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
        <ThermalSourceBadge capture={c} compact />
        <span className={`inline-flex items-center rounded-md border px-1.5 py-px text-[0.6875rem] leading-4 font-medium ${STATUS_TONE[n.status.tone]}`}>
          <span className="sr-only">Status: </span>
          {n.status.word}
        </span>
        <span className="whitespace-nowrap tabular-nums">{n.range}</span>
      </p>
      {actions}
      <div className={`mt-1 ${OPEN_ONLY}`}>
        <p className="text-xs text-ink-muted" data-testid="summary-thermal-images">
          {images}
        </p>
        <p>{n.stats}</p>
        <p className="text-xs text-ink-muted">
          {n.radiometric} · {n.regions}
        </p>
      </div>
      <div aria-hidden="true" className="clear-both" />
    </div>
  )
}

/** Open thermal (the thermal imaging workspace), by default: the module opens and the thermal panel's own button is used, so there is one workspace on the page. */
export const openThermal = () => void runModuleAction('tools-thermal', { testId: 'thermal-open' })
/** The research view (Pediatric shock research), by default the thermal panel's own button. */
export const openThermalResearch = () => void runModuleAction('tools-thermal', { testId: 'thermal-research-open' })

/**
 * The summary of module 5. Closed: with no image, "Thermal image not captured" and Capture thermal (`onCaptureThermal`; by default the thermal
 * panel's own workspace, where a camera, a file or the simulator is chosen), or why none can be captured (the consent); with images, the newest
 * one of this consultation (a small picture with its temperature scale; where on the body; its source, SIMULATED when generated; its approval;
 * its range) and Open thermal (`onOpenThermal`). Both with Research (`onResearch`: Pediatric shock research, a research view that detects,
 * predicts and scores nothing). Open, also the newest image's measurements, the thermal model (MODEL UNAVAILABLE: none is installed) and that
 * the research view is there; the camera ("FLIR ONE not connected" in a browser) is said by the panel under it, and here only for whoever reads
 * the summary alone.
 */
export function ThermalSummary({
  encounter,
  onCaptureThermal = openThermal,
  onOpenThermal = openThermal,
  onResearch = openThermalResearch,
}: {
  encounter: Pick<Encounter, 'id' | 'patient'> & { canEdit?: boolean }
  /** No longer used: the summary has its own quick actions (Capture thermal or Open thermal, and Research). Kept so an older page still builds. */
  actions?: ReactNode
  onCaptureThermal?: () => void
  onOpenThermal?: () => void
  onResearch?: () => void
}) {
  const v = useThermalView(encounter, { withModel: true })
  const canEdit = encounter.canEdit !== false
  const research = (
    <QuickAction icon={FlaskConical} onClick={onResearch} testId="module-thermal-research" title="Pediatric shock research (research only)">
      <span className="sr-only">Pediatric shock </span>
      <span className="first-letter:uppercase">research</span>
    </QuickAction>
  )
  const quick = (
    <div className={`flex flex-wrap gap-x-2 gap-y-3 pt-2 pb-0.5 ${CLOSED_ONLY}`}>
      {v.newest ? (
        <QuickAction icon={ScanLine} onClick={onOpenThermal} disabled={!canEdit} testId="module-thermal-open">
          Open thermal
        </QuickAction>
      ) : (
        v.canCapture && (
          <QuickAction icon={Camera} onClick={onCaptureThermal} disabled={!canEdit} testId="module-thermal-capture">
            Capture thermal
          </QuickAction>
        )
      )}
      {research}
    </div>
  )
  return (
    <div data-testid="summary-thermal" data-state={v.state.kind}>
      {v.newest ? (
        <Newest n={v.newest} images={v.images} actions={quick} />
      ) : (
        <>
          <p className={v.facts ? 'text-ink-muted' : ''} data-testid="summary-thermal-images">
            {v.images}
          </p>
          {v.consentLine && <p className="text-xs text-pending">{v.consentLine}</p>}
          {v.facts && quick}
        </>
      )}
      {v.newest && v.consentLine && <p className="text-xs text-pending">{v.consentLine}</p>}
      <div className={`mt-1 space-y-1 text-xs text-ink-muted ${OPEN_ONLY}`}>
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
