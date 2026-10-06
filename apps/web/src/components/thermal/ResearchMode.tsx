import type { Encounter, PatientDetail, ThermalCapture } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Circle, CircleCheck, CircleDashed, FlaskConical, type LucideIcon } from 'lucide-react'
import { useId, useMemo } from 'react'
import { api } from '../../lib/api.ts'
import { patientKey } from '../../lib/clinical.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { patientThermalKey, useThermalModelStatus } from '../../lib/thermal.ts'
import { findNativeBridge } from '../../lib/thermalCamera.ts'
import {
  captureTitle,
  consultationCaptures,
  exactAge,
  type ImageFeatures,
  PAEDIATRIC_RANGES,
  PART_STATUS_LABEL,
  RESEARCH_DISCLAIMER,
  RESEARCH_HEADER,
  RESEARCH_TITLE,
  researchConsent,
  researchFeatures,
  researchPipeline,
  type ResearchStage,
  STAGE_STATUS_LABEL,
  type StageStatus,
  takenAt,
} from '../../lib/thermalResearch.ts'
import { Dialog } from '../ui/Dialog.tsx'
import { Badge, type BadgeTone, Spinner } from '../ui/Feedback.tsx'
import { PublishedResearch } from './PublishedResearch.tsx'
import { ThermalModelStatus } from './ThermalModelStatus.tsx'
import { ThermalSourceBadge } from './ThermalSourceBadge.tsx'

const STATUS_MARK: Record<StageStatus, { Icon: LucideIcon; tone: BadgeTone; icon: string }> = {
  built: { Icon: CircleCheck, tone: 'ok', icon: 'text-ok' },
  depends: { Icon: CircleDashed, tone: 'warn', icon: 'text-pending' },
  not_built: { Icon: Circle, tone: 'neutral', icon: 'text-ink-muted' },
}

/** One stage of the pipeline: its number and name, its status in words (the mark repeats it), what is true now, and what it has or lacks. */
function StageItem({ s }: { s: ResearchStage }) {
  const mark = STATUS_MARK[s.status]
  return (
    <li data-stage={s.id} data-status={s.status} className={`rounded-lg border bg-surface px-3 py-2.5 ${s.id === 'model' ? 'border-dashed border-line-strong' : 'border-line'}`}>
      {s.id === 'model' && <p className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">The pipeline stops at the feature set</p>}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
        <mark.Icon aria-hidden="true" className={`mt-0.5 size-5 ${mark.icon}`} />
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">
              <span className="tabular-nums">{s.n}.</span> {s.label}
            </span>
            <Badge tone={mark.tone}>{STAGE_STATUS_LABEL[s.status]}</Badge>
          </p>
          {s.detail.map((line, i) => (
            <p key={line} className={`text-sm break-words ${s.id === 'model' && i === 0 ? 'font-semibold' : ''}`}>
              {line}
            </p>
          ))}
          {s.id === 'model' && (
            <div className="rounded-md border border-line bg-canvas p-2" data-testid="research-model">
              <ThermalModelStatus variant="inline" />
            </div>
          )}
          {s.parts.length > 0 && (
            <ul className="space-y-0.5 text-xs text-ink-muted">
              {s.parts.map((part) => (
                <li key={part.text} className="break-words">
                  <span className="font-medium text-ink">{PART_STATUS_LABEL[part.status]}:</span> {part.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

/** One image of the feature set: its stored values, its regions, its pairs as "A minus B", and the evaluation's four numbers. */
function ImageBlock({ capture, f }: { capture: ThermalCapture; f: ImageFeatures }) {
  return (
    <li className="space-y-3 rounded-lg border border-line bg-surface p-3" data-testid="research-image" data-capture-id={f.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="font-semibold break-words">{f.title}</h4>
        <ThermalSourceBadge capture={capture} />
        <Badge tone={f.clinical ? 'neutral' : 'notice'}>{f.origin}</Badge>
        <span className="text-xs text-ink-muted tabular-nums">{fmtDateTime(f.at)}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4" data-testid="research-image-whole">
        {f.whole.map((m) => (
          <div key={m.label} className="min-w-0">
            <dt className="text-xs text-ink-muted">{m.label}</dt>
            <dd className="font-medium tabular-nums">{m.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs break-words text-ink-muted tabular-nums">{[f.size, f.camera, f.conditions, `Extractor ${f.extractor}`].filter(Boolean).join(' · ')}</p>
      <div className="space-y-1 text-xs">
        <p className="font-medium">Regions drawn by the doctor</p>
        {f.regions.length ? (
          <ul className="space-y-1 tabular-nums" data-testid="research-regions">
            {f.regions.map((r) => (
              <li key={r.id} className="break-words">
                <span className="font-medium">{r.label}</span> · {r.shape} · {r.pixels} · {r.values.map((v) => `${v.label} ${v.value}`).join(' · ')}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No region drawn</p>
        )}
      </div>
      <div className="space-y-1 text-xs">
        <p className="font-medium">Pairs (the doctor’s, as A minus B)</p>
        {f.pairs.length ? (
          <ul className="space-y-1 tabular-nums" data-testid="research-pairs">
            {f.pairs.map((p) => (
              <li key={p.name} className="break-words">
                <span className="font-medium">{p.name}</span>: mean {p.meanDiff} · max {p.maxDiff}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted" data-testid="research-pairs">
            No pair
          </p>
        )}
      </div>
      <div className="space-y-1 text-xs" data-testid="research-evaluation-inputs">
        <p>
          <span className="font-medium">The dataset evaluation’s four numbers (thermal-eval-v1)</span>
          <span className="text-ink-muted"> · descriptive; no model uses them here, and that evaluation compares any clinician finding with none, not shock.</span>
        </p>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {f.evaluation.map((m) => (
            <div key={m.label} className="flex min-w-0 flex-wrap justify-between gap-x-2">
              <dt className="text-ink-muted">{m.label}</dt>
              <dd className="font-medium tabular-nums">{m.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </li>
  )
}

/**
 * PEDIATRIC SHOCK — RESEARCH MODE: the content of the research sheet for one consultation. Research only, never a clinical result: nothing here
 * detects, predicts or scores shock, and nothing here writes. It shows the patient's exact age (no paediatric range exists to compare with),
 * the research consent, the research pipeline stage by stage with each status computed from this consultation's images and what the code has
 * (lib/thermalResearch.ts), the feature set of approved, non-simulated images with every other image listed and why it is out, the thermal
 * model status as the server gives it (MODEL UNAVAILABLE today), and the published research, labelled as not ADAXAI's.
 *
 * The images and the patient record are read as observers of the thermal panel's own queries (enabled: false): opening this makes no request
 * for them, and so no audit entry. The model status is the existing ThermalModelStatus view, which asks GET /api/thermal/model-status once
 * (not audited, kept for a minute).
 */
export function ResearchMode({ encounter }: { encounter: Encounter }) {
  const p = encounter.patient
  const thermal = useQuery({ queryKey: patientThermalKey(p.id), queryFn: () => api<{ captures: ThermalCapture[] }>(`/patients/${p.id}/thermal`), enabled: false, select: (d) => d.captures })
  const patient = useQuery({ queryKey: patientKey(p.id), queryFn: () => api<PatientDetail>(`/patients/${p.id}`), enabled: false })
  const model = useThermalModelStatus()
  const bridge = useMemo(() => findNativeBridge() !== null, [])
  const pipelineId = useId()
  const featuresId = useId()

  const loading = !thermal.data && !thermal.isError && thermal.fetchStatus === 'fetching'
  const mine = thermal.data ? consultationCaptures(thermal.data, encounter.id) : null
  const stages = researchPipeline({ captures: mine, bridge, model: model.data ?? null })
  const features = mine ? researchFeatures(mine) : null
  const age = exactAge(p.dateOfBirth)

  return (
    <div className="space-y-5" data-testid="thermal-research">
      <div className="space-y-1 rounded-xl border border-pending/30 bg-pending-soft px-4 py-3" data-testid="research-header">
        <p className="flex items-center gap-2 text-sm font-semibold tracking-wide text-pending">
          <FlaskConical aria-hidden="true" className="size-4 shrink-0" />
          {RESEARCH_HEADER}
        </p>
        <p className="text-sm font-medium text-ink">{RESEARCH_DISCLAIMER}</p>
      </div>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" data-testid="research-patient">
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Age, from the date of birth on the record</dt>
          <dd className="font-medium tabular-nums">
            {age ?? 'Not known'}
            {age && p.dateOfBirthEstimated ? ' (date of birth estimated)' : ''}
          </dd>
          <dd className="text-xs text-ink-muted">{PAEDIATRIC_RANGES}.</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">De-identified research use consent</dt>
          <dd className="font-medium" data-testid="research-consent">
            {researchConsent(patient.data?.consentStates)}
          </dd>
          <dd className="text-xs text-ink-muted">A research dataset takes an image only with this consent.</dd>
        </div>
      </dl>

      <section aria-labelledby={pipelineId} className="space-y-2">
        <h3 id={pipelineId} className="text-base font-semibold">
          Research pipeline
        </h3>
        {loading ? (
          <Spinner label="Reading the thermal images…" />
        ) : (
          <ol className="space-y-2" data-testid="research-pipeline">
            {stages.map((s) => (
              <StageItem key={s.id} s={s} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby={featuresId} className="space-y-3" data-testid="research-features">
        <h3 id={featuresId} className="text-base font-semibold">
          Feature set
        </h3>
        <p className="text-xs text-ink-muted">Approved, non-simulated images of this consultation, with the values stored for them. Nothing here turns them into a finding.</p>
        {features === null ? (
          loading ? null : <p className="text-sm">The thermal images of this consultation could not be read just now.</p>
        ) : (
          <>
            {features.included.length ? (
              <ul className="space-y-3">
                {features.included.map(({ capture, features: f }) => (
                  <ImageBlock key={f.id} capture={capture} f={f} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted" data-testid="research-features-empty">
                No approved, non-simulated image in this consultation.
              </p>
            )}
            {features.excluded.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-sm font-semibold">Not in the feature set</h4>
                <ul className="space-y-1">
                  {features.excluded.map(({ capture: c, reason, text }) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="research-excluded" data-reason={reason} data-capture-id={c.id}>
                      <span className="font-medium break-words">{captureTitle(c)}</span>
                      <ThermalSourceBadge capture={c} compact />
                      <span className="text-xs text-ink-muted tabular-nums">{fmtDateTime(takenAt(c))}</span>
                      <span>· {text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <PublishedResearch />
    </div>
  )
}

/**
 * The research view as a side sheet (48rem from the right, the page still visible behind it), titled "Pediatric shock research". Its content
 * is mounted only while it is open. Exported so that the thermal module can offer it as well as the thermal panel.
 */
export function ResearchModeSheet({ encounter, open, onClose }: { encounter: Encounter; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={RESEARCH_TITLE} placement="right" wide testId="thermal-research-sheet">
      <ResearchMode encounter={encounter} />
    </Dialog>
  )
}
