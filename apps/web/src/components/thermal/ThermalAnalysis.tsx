import { THERMAL_DEMO_IMAGE_LABEL, type ThermalCapture } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { FlaskConical, LoaderCircle, ScanHeart } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { api } from '../../lib/api.ts'
import { fmtDate } from '../../lib/format.ts'
import { isDemoImage, paletteCss, paletteLut, useMatrix, useThermal } from '../../lib/thermal.ts'
import { Sheet } from '../hero/Sheet.tsx'
import { ErrorState } from '../ui/Feedback.tsx'

/** The thermal analysis of one capture (GET /api/thermal/:id/analysis): demonstration indices by fixed formulas, never clinically validated. */
export interface ThermalAnalysisResult {
  engine: { name: string; version: string; validated: false; label: string }
  indices: { key: string; label: string; score: number; basis: string }[]
  summary: string[]
  scale: { minC: number; maxC: number }
  simulated: boolean
  /** An ordinary image without temperature data, analysed as a demo with values simulated from its colours. */
  demoImage?: boolean
}

export const thermalAnalysisKey = (captureId: string) => ['thermal', captureId, 'analysis'] as const

export function useThermalAnalysis(captureId: string | null | undefined) {
  return useQuery({ queryKey: thermalAnalysisKey(captureId ?? ''), enabled: !!captureId, queryFn: () => api<ThermalAnalysisResult>(`/thermal/${captureId}/analysis`), staleTime: Infinity })
}

/** Each index's colour (a ring), in the order the dashboard shows them. */
const RING: Record<string, string> = {
  pain_pattern: '#e11d48',
  thermal_asymmetry: '#f59e0b',
  perfusion_pattern: '#0284c7',
  temperature_pattern: '#059669',
  thermal_stress: '#7c3aed',
}

function Ring({ score, label, basis, color }: { score: number; label: string; basis: string; color: string }) {
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <li className="flex flex-col items-center text-center" data-testid="thermal-index" title={basis}>
      <svg viewBox="0 0 76 76" className="size-20" role="img" aria-label={`${label}: ${score} of 100 (demo index)`}>
        <circle cx="38" cy="38" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-line/70" />
        <circle
          cx="38"
          cy="38"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          transform="rotate(-90 38 38)"
          className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700"
        />
        <text x="38" y="43" textAnchor="middle" className="fill-ink text-[17px] font-semibold tabular-nums">
          {score}
        </text>
      </svg>
      <p className="mt-1 text-xs font-semibold text-ink">{label}</p>
      <p className="mt-0.5 max-w-36 text-[0.6875rem] leading-4 text-ink-muted">{basis}</p>
    </li>
  )
}

/** The image in the rainbow palette over the analysis' temperature scale, from the stored matrix (the same numbers the indices used). */
function ThermalImage({ capture, minC, maxC }: { capture: ThermalCapture; minC: number; maxC: number }) {
  const m = useMatrix(capture)
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const data = m.data
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = capture.width
    canvas.height = capture.height
    const img = ctx.createImageData(capture.width, capture.height)
    const lut = paletteLut('rainbow')
    const span = Math.max(0.1, maxC - minC)
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!
      const o = i * 4
      if (!Number.isFinite(v)) {
        img.data[o] = 60
        img.data[o + 1] = 60
        img.data[o + 2] = 70
        img.data[o + 3] = 255
        continue
      }
      // The palette is 256 RGB triplets.
      const k = Math.round(Math.min(1, Math.max(0, (v - minC) / span)) * 255) * 3
      img.data[o] = lut[k]!
      img.data[o + 1] = lut[k + 1]!
      img.data[o + 2] = lut[k + 2]!
      img.data[o + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }, [m.data, capture.width, capture.height, minC, maxC])
  return (
    <div className="flex items-stretch gap-3">
      <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-ink">
        <canvas ref={ref} role="img" aria-label={`${capture.simulated ? 'Simulated thermal image (not a measurement)' : 'Thermal image'}, ${minC.toFixed(1)} to ${maxC.toFixed(1)} °C`} className="block aspect-[4/3] w-full object-contain [image-rendering:auto]" data-testid="thermal-analysis-image" />
        {m.isPending && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Loading the image…
          </p>
        )}
      </div>
      <div className="flex w-10 shrink-0 flex-col items-center text-[0.6875rem] font-medium text-ink-muted tabular-nums">
        <span>{maxC.toFixed(1)}°C</span>
        <span aria-hidden="true" className="my-1 w-3 flex-1 rounded-full" style={{ background: paletteCss('rainbow').replace('to right', 'to top') }} />
        <span>{minC.toFixed(1)}°C</span>
      </div>
    </div>
  )
}

/** A DEMO image (an ordinary picture, no temperature data): the picture itself, as uploaded, without a temperature scale. */
function DemoImage({ capture }: { capture: ThermalCapture }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-ink">
      <img src={`/api/files/${capture.rawFileId}`} alt={`Uploaded image of ${capture.protocol.bodyRegion} (demo: no temperature data)`} className="block aspect-[4/3] w-full object-contain" data-testid="thermal-analysis-image" />
    </div>
  )
}

/**
 * The thermal analysis dashboard (premium design): the image prominently, five demonstration indices as rings (each with the measured number it
 * comes from), a short summary composed by rules, and — visible at the top — "Demo analysis — not clinically validated". What a future validated
 * thermal intelligence module will show; today nothing here detects, predicts or diagnoses anything.
 */
export function ThermalAnalysisDashboard({ captureId, patient }: { captureId: string; patient?: { name: string; mrn: string } | undefined }) {
  const capture = useThermal(captureId)
  const analysis = useThermalAnalysis(captureId)
  if (capture.isError || analysis.isError) return <ErrorState title="The thermal analysis could not be made" error={capture.error ?? analysis.error} onRetry={() => void analysis.refetch()} retrying={analysis.isFetching} />
  if (!capture.data || !analysis.data)
    return (
      <p role="status" className="flex items-center gap-2 py-10 text-sm text-ink-muted" data-testid="thermal-analysis-processing">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> Analysing the thermal image…
      </p>
    )
  const c = capture.data
  const a = analysis.data
  const demoImage = a.demoImage === true || isDemoImage(c)
  return (
    <div className="space-y-5" data-testid="thermal-analysis">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink-muted">Thermal analysis</p>
          {patient && <p className="mt-0.5 text-lg font-semibold tracking-tight">{patient.name}</p>}
          <p className="text-sm text-ink-muted">
            {patient && <>MRN {patient.mrn} · </>}
            {fmtDate((c.capturedAt ?? c.createdAt).slice(0, 10))}
            {c.protocol.bodyRegion ? ` · ${c.protocol.bodyRegion}` : ''}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-pending/25 bg-pending-soft px-3 py-1 text-xs font-semibold text-pending" data-testid="thermal-analysis-demo-label">
            <FlaskConical aria-hidden="true" className="size-3.5" />
            {a.engine.label}
          </span>
          {demoImage && (
            <span className="inline-flex items-center rounded-full border border-brand/20 bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-strong" data-testid="thermal-analysis-demo-image">
              {THERMAL_DEMO_IMAGE_LABEL}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        {demoImage ? <DemoImage capture={c} /> : <ThermalImage capture={c} minC={a.scale.minC} maxC={a.scale.maxC} />}
        <section aria-label="Analysis scores">
          <h3 className="text-sm font-semibold">Analysis scores</h3>
          <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3">
            {a.indices.map((i) => (
              <Ring key={i.key} score={i.score} label={i.label} basis={i.basis} color={RING[i.key] ?? '#2563eb'} />
            ))}
          </ul>
        </section>
      </div>
      <section aria-label="Summary" className="rounded-2xl bg-canvas px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ScanHeart aria-hidden="true" className="size-4 text-brand" />
          Summary
        </h3>
        <p className="mt-2 text-sm leading-6 text-ink" data-testid="thermal-analysis-summary">
          {a.summary.join(' ')}
        </p>
        <p className="mt-3 text-xs text-ink-muted">
          {demoImage
            ? `Indices computed by fixed demonstration formulas from values simulated from the image’s colours (${a.engine.name} v${a.engine.version}): the image has no temperature data. They measure, detect and diagnose nothing.`
            : `Indices computed by fixed demonstration formulas from the recorded temperatures (${a.engine.name} v${a.engine.version}); they detect, predict and diagnose nothing. A validated thermal model would replace them.`}
        </p>
      </section>
    </div>
  )
}

/** The dashboard in a wide sheet (from the Thermal page after a capture, and from the consultation's thermal tile). */
export function ThermalAnalysisSheet({ captureId, patient, onClose }: { captureId: string | null; patient?: { name: string; mrn: string } | undefined; onClose: () => void }) {
  return (
    <Sheet open={!!captureId} onClose={onClose} title="Thermal analysis" subtitle="Demo analysis — not clinically validated" width="xl" testId="thermal-analysis-sheet">
      {captureId && <ThermalAnalysisDashboard captureId={captureId} patient={patient} />}
    </Sheet>
  )
}
