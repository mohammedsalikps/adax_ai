import { type Encounter, THERMAL_STATEMENT_BASES, THERMAL_SUMMARY_DECISIONS, type ThermalCapture, type ThermalSummary } from '@adaxai/contracts'
import { Check, FileText, Pencil, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import { useMe } from '../../lib/auth.tsx'
import { fmtDateTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { canAddThermalSummary, canComposeThermalSummary, thermalSummaryDecision, useGenerateThermalSummary, useReviewThermalSummary, useThermalSummaries } from '../../lib/thermal.ts'
import { InsertButton } from '../ai/InsertButton.tsx'
import { SECTION_LABEL } from '../hero/Panel.tsx'
import { SimulatedBadge } from '../clinical/DeviceReadingsCard.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge, type BadgeTone, Spinner } from '../ui/Feedback.tsx'
import { TextAreaField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { plainName } from '../../lib/displayName.ts'

type Basis = keyof typeof THERMAL_STATEMENT_BASES
const BASIS_TONE: Record<Basis, BadgeTone> = { measurement: 'brand', rule: 'warn', model: 'ai', limitation: 'neutral' }
const STATUS_TONE: Record<ThermalSummary['status'], BadgeTone> = { pending: 'warn', accepted: 'ok', edited: 'ok', rejected: 'neutral' }

/** Accept / edit / reject, with the look of the AI review controls (there is nothing to defer: a summary waits until it is decided). */
function SummaryReview({ s }: { s: ThermalSummary }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(s.finalText ?? s.text)
  const review = useReviewThermalSummary()
  const pending = (d: 'accepted' | 'edited' | 'rejected') => review.isPending && review.variables?.body.decision === d
  const act = (decision: 'accepted' | 'edited' | 'rejected') => review.mutate({ id: s.id, body: decision === 'edited' ? { decision, text: draft } : { decision } }, { onSuccess: () => setEditing(false) })
  return (
    <div className="mt-3 space-y-2">
      {editing && <TextAreaField label="Edit the summary before accepting" rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />}
      {review.isError && <p className="text-sm text-down">{errorMessage(review.error)}</p>}
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={pending('edited')} disabled={!draft.trim() || review.isPending} onClick={() => act('edited')}>
              Save edited text
            </Button>
            <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => (setEditing(false), setDraft(s.finalText ?? s.text))}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" icon={<Check aria-hidden="true" className="size-4" />} loading={pending('accepted')} disabled={review.isPending} onClick={() => act('accepted')}>
              Accept
            </Button>
            <Button size="sm" variant="secondary" icon={<Pencil aria-hidden="true" className="size-4" />} disabled={review.isPending} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon={<X aria-hidden="true" className="size-4" />} loading={pending('rejected')} disabled={review.isPending} onClick={() => act('rejected')}>
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function Statements({ s, testIds, sources = true }: { s: ThermalSummary; testIds: boolean; sources?: boolean }) {
  return (
    <ul className={`space-y-2 text-sm ${s.status === 'rejected' ? 'text-ink-muted' : ''}`}>
      {s.statements.map((st, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-testid={testIds ? 'thermal-summary-statement' : undefined} data-basis={st.basis}>
          <Badge tone={BASIS_TONE[st.basis]}>{THERMAL_STATEMENT_BASES[st.basis]}</Badge>
          <span className={`min-w-0 flex-1 basis-48 break-words ${s.status === 'rejected' ? 'line-through' : ''}`}>{st.text}</span>
          {sources && <span className="w-full text-xs text-ink-muted break-words">Source: {st.source}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * The summary's frame inside the doctor's thermal study: a group of the study's panel (a line above, the section label), still a region named
 * "Thermal summary", instead of a card of its own.
 */
function StudyGroup({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="min-w-0 border-t border-line pt-3">
      <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={id} className={SECTION_LABEL}>
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  )
}

/** The clinical study's summary keeps what each statement rests on, and the composer's versions, one tap away (as an AI draft's sources). */
function SourcesDisclosure({ s }: { s: ThermalSummary }) {
  return (
    <details className="mt-3 text-sm" data-testid="thermal-summary-sources">
      <summary className="min-h-control-sm cursor-pointer font-medium text-ink-muted">Sources</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-ink-muted">
        {s.statements.map((st, i) => (
          <li key={i} className="break-words">
            {st.source}
          </li>
        ))}
      </ol>
      <div className="mt-2">
        <Provenance s={s} versions />
      </div>
    </details>
  )
}

/** Composer, rules and model at the time, and who composed it. `versions: false` (the clinical study): only that it was composed by fixed rules, when and by whom. */
function Provenance({ s, versions = true }: { s: ThermalSummary; versions?: boolean }) {
  return (
    <p className="text-xs text-ink-muted">
      <span className="font-medium text-ink">Composed by fixed rules from the measurements, not by AI.</span>{' '}
      {versions && (
        <>
          Composer {s.composerVersion}
          {s.rulesVersion ? ` · rules ${s.rulesVersion}` : ''} · model: {s.model.available ? `${s.model.kind ?? 'kind not stated'} ${s.model.modelId ?? ''} ${s.model.version ?? ''}`.trim() : 'unavailable'} ·{' '}
        </>
      )}
      {fmtDateTime(s.createdAt)}
      {s.createdByName ? ` · ${plainName(s.createdByName)}` : ''}
    </p>
  )
}

/**
 * The summary of one thermal study (V6): statements composed by fixed rules from what was measured, each with what it rests on (Measured,
 * Experimental rule, Model, Limitation). A summary is composed only from an approved image (approval fixes the image's measurements and
 * regions, so the summary's numbers stay the image's; a rejected image never gets one). The doctor accepts, edits or rejects it; only then, and
 * only by a separate "Add to Examination" while the image is approved and the consultation is an unsigned draft they may edit, can its text
 * reach the note. A simulated summary never can. The newest summary is shown; earlier ones are kept, collapsed. `canEdit` defaults to the
 * consultation's own `canEdit`. `variant="clinical"` (the doctor's thermal study): what each statement rests on and the composer's versions
 * are under "Sources" (one tap away) instead of under every statement; everything else is the same.
 */
export function ThermalSummaryCard({
  captureId,
  captureStatus,
  encounter,
  inserter,
  canEdit,
  variant = 'full',
}: {
  captureId: string
  /** The image's review status: draft (awaiting review), approved or rejected. */
  captureStatus: ThermalCapture['status']
  encounter?: Encounter | undefined
  inserter?: NoteInserter | undefined
  canEdit?: boolean | undefined
  variant?: 'full' | 'clinical'
}) {
  const clinical = variant === 'clinical'
  const { data: me } = useMe()
  const isDoctor = me?.role === 'doctor'
  const q = useThermalSummaries(captureId)
  const compose = useGenerateThermalSummary(captureId)
  const editable = canEdit ?? !!encounter?.canEdit
  const composable = canComposeThermalSummary(captureStatus)
  const [latest, ...earlier] = q.data ?? []
  const decided = latest && (latest.status === 'accepted' || latest.status === 'edited')
  const insertable = !!latest && !!inserter && canAddThermalSummary(latest, encounter, editable, captureStatus)
  const Frame = clinical ? StudyGroup : Card
  return (
    <Frame
      title="Thermal summary"
      actions={
        isDoctor &&
        composable && (
          <Button size="sm" variant="secondary" icon={<FileText aria-hidden="true" className="size-4" />} loading={compose.isPending} onClick={() => compose.mutate()}>
            Compose summary
          </Button>
        )
      }
    >
      <p className="mb-3 text-xs text-ink-muted">What was measured in this image, in sentences composed by fixed rules (not by AI). It is not a diagnosis. The doctor reviews it; only an accepted summary can be added to the note, and only by the doctor.</p>
      {isDoctor && !composable && (
        <p className="mb-3 text-sm font-medium" data-testid="thermal-summary-unavailable" data-capture-status={captureStatus}>
          {captureStatus === 'rejected'
            ? 'This image was rejected as unfit for the record: no summary is composed from it.'
            : 'Approve the image first (Review, above): a summary is composed from an approved image, whose measurements and regions can no longer change.'}
        </p>
      )}
      {compose.isError && (
        <Alert tone="error" className="mb-3">
          {errorMessage(compose.error)}
        </Alert>
      )}
      {q.isPending && <Spinner label="Loading summaries…" />}
      {q.isError && <Alert tone="error">{errorMessage(q.error)}</Alert>}
      {q.data && !latest && <p className="text-sm text-ink-muted">No summary yet.{isDoctor && composable ? ' “Compose summary” writes one from the measurements; you review it before anything reaches the note.' : ''}</p>}
      {latest && (
        <article className={`rounded-lg border p-3 ${latest.simulated ? 'border-dashed border-ink/50' : 'border-line'}`} data-testid="thermal-summary" data-status={latest.status} data-simulated={latest.simulated}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span data-testid="thermal-summary-status" data-status={latest.status}>
              <Badge tone={STATUS_TONE[latest.status]}>{THERMAL_SUMMARY_DECISIONS[latest.status]}</Badge>
            </span>
            {latest.simulated && <SimulatedBadge />}
          </div>
          <Statements s={latest} testIds sources={!clinical} />
          {latest.status === 'edited' && latest.finalText && (
            <div className="mt-3 rounded-md bg-canvas p-2 text-sm">
              <p className="text-xs font-medium text-ink-muted">Text as edited by the doctor</p>
              <p className="whitespace-pre-line break-words">{latest.finalText}</p>
            </div>
          )}
          <div className="mt-3">
            <Provenance s={latest} versions={!clinical} />
          </div>
          {clinical && <SourcesDisclosure s={latest} />}
          {latest.status !== 'pending' && <p className="mt-2 text-sm font-medium">{thermalSummaryDecision(latest)}</p>}
          {latest.status === 'pending' && isDoctor && <SummaryReview key={latest.id} s={latest} />}
          {latest.status === 'pending' && !isDoctor && <p className="mt-2 text-sm text-ink-muted">Awaiting the doctor’s review.</p>}
          {latest.simulated && (
            <p className="mt-2 text-sm font-medium" data-testid="thermal-summary-simulated-note">
              A simulated summary cannot be added to a consultation note.
            </p>
          )}
          {insertable && inserter && (
            <div data-testid="thermal-summary-insert">
              <InsertButton inserter={inserter} section="examination" text={latest.finalText ?? latest.text} subject={{ type: 'thermal_summary', id: latest.id }} />
            </div>
          )}
          {decided && !latest.simulated && inserter && !insertable && (
            <p className="mt-2 text-xs text-ink-muted">{captureStatus === 'approved' ? 'It can be added to the note only while this consultation is an unsigned draft you are editing.' : 'It can be added to the note only from an approved image.'}</p>
          )}
        </article>
      )}
      {earlier.length > 0 && (
        <details className="mt-4 rounded-lg border border-line">
          <summary className="flex min-h-control cursor-pointer items-center px-3 text-sm font-medium">Earlier summaries ({earlier.length})</summary>
          <ul className="space-y-3 border-t border-line p-3">
            {earlier.map((s) => (
              <li key={s.id} className="space-y-2" data-testid="thermal-summary-earlier" data-status={s.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[s.status]}>{THERMAL_SUMMARY_DECISIONS[s.status]}</Badge>
                  {s.simulated && <SimulatedBadge compact />}
                  {s.status !== 'pending' && <span className="text-xs text-ink-muted">{thermalSummaryDecision(s)}</span>}
                </div>
                <Statements s={s} testIds={false} />
                {s.status === 'edited' && s.finalText && <p className="text-sm whitespace-pre-line break-words">Edited: {s.finalText}</p>}
                <Provenance s={s} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </Frame>
  )
}
