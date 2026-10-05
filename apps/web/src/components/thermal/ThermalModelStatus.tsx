import type { ThermalModelStatus as ModelStatus } from '@adaxai/contracts'
import { errorMessage } from '../../lib/api.ts'
import { useThermalModelStatus } from '../../lib/thermal.ts'
import { Spinner } from '../ui/Feedback.tsx'
import { Card } from '../ui/Layout.tsx'

const CHIP = 'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap'
const KIND: Record<NonNullable<ModelStatus['kind']>, { label: string; cls: string; meaning: string }> = {
  real: { label: 'REAL', cls: 'border-ink/60 bg-surface text-ink', meaning: 'Trained and evaluated for its stated use.' },
  research: { label: 'RESEARCH', cls: 'border-pending/30 bg-pending-soft text-pending', meaning: 'A research model: not for clinical decisions.' },
  simulation: { label: 'SIMULATION', cls: 'border-dashed border-ink/60 bg-canvas text-ink', meaning: 'A stand-in that produces made-up outputs for testing: never a finding.' },
}

/**
 * What the server says about the thermal model, as it says it. There is none today: MODEL UNAVAILABLE with the server's reason. If one is ever
 * installed, it is described by what it is (REAL, RESEARCH or SIMULATION), its id, version, the hash of its weights and its evaluation. This shows
 * no model output, ever: an output is shown only by a screen that names the model this status describes.
 */
export function ThermalModelStatusView({ status }: { status: ModelStatus }) {
  if (!status.available) {
    return (
      <div className="space-y-1 text-sm" data-testid="thermal-model-status" data-available="false">
        <p>
          <span className={`${CHIP} border-ink/60 bg-surface text-ink`}>MODEL UNAVAILABLE</span>
        </p>
        <p>{status.reason ?? 'No thermal model is installed.'}</p>
        <p className="text-xs text-ink-muted">Nothing about a thermal image comes from a model: measurements and experimental rules only.</p>
      </div>
    )
  }
  const kind = status.kind ? KIND[status.kind] : null
  return (
    <div className="space-y-2 text-sm" data-testid="thermal-model-status" data-available="true" data-kind={status.kind ?? ''}>
      <p className="flex flex-wrap items-center gap-2">
        <span className={`${CHIP} ${kind?.cls ?? 'border-ink/60 bg-surface text-ink'}`}>{kind?.label ?? 'KIND NOT STATED'}</span>
        <span className="text-xs text-ink-muted">{kind?.meaning ?? 'The server did not say what kind of model this is.'}</span>
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium text-ink-muted">Model</dt>
        <dd className="break-words">{status.modelId ?? '—'}</dd>
        <dt className="font-medium text-ink-muted">Version</dt>
        <dd className="break-words">{status.version ?? '—'}</dd>
        <dt className="font-medium text-ink-muted">Artifact SHA-256</dt>
        <dd className="font-mono break-all">{status.artifactSha256 ?? '—'}</dd>
        <dt className="font-medium text-ink-muted">Intended use</dt>
        <dd className="break-words">{status.intendedUse ?? '—'}</dd>
        <dt className="font-medium text-ink-muted">Evaluation</dt>
        <dd className="break-words">{status.evaluation ? `${status.evaluation.summary}${status.evaluation.runId ? ` (run ${status.evaluation.runId})` : ''}` : 'No evaluation recorded'}</dd>
      </dl>
      <p className="text-xs text-ink-muted">This describes the installed model. It shows none of its outputs.</p>
    </div>
  )
}

/** The thermal model's status, read from the server. `inline`: without the card, for a narrow panel that has its own heading. */
export function ThermalModelStatus({ variant = 'card' }: { variant?: 'card' | 'inline' }) {
  const q = useThermalModelStatus()
  const body = (
    <>
      {q.isPending && <Spinner label="Reading the model status…" />}
      {q.isError && (
        <p className="text-sm" data-testid="thermal-model-status" data-available="unknown">
          The model status could not be read: {errorMessage(q.error)} No model output is shown.
        </p>
      )}
      {q.data && <ThermalModelStatusView status={q.data} />}
    </>
  )
  return variant === 'inline' ? <div>{body}</div> : <Card title="Thermal model">{body}</Card>
}
