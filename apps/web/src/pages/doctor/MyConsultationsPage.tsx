import { type MyConsultation, OPEN_VISIT_STATUSES } from '@adaxai/contracts'
import { FileSignature, NotebookPen, Stethoscope, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { DiscardDraftDialog } from '../../components/clinical/RecordLifecycle.tsx'
import { VisitStatusBadge } from '../../components/clinical/VisitStatusBadge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Alert, Badge, EmptyState, Spinner } from '../../components/ui/Feedback.tsx'
import { PageHeader } from '../../components/ui/Layout.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { ApiError, errorMessage } from '../../lib/api.ts'
import { useMyConsultations, useStartConsultation } from '../../lib/encounters.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

type Tab = 'in_progress' | 'signed'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One unsigned draft: where it is in the visit's life, how far it got, and what can be done with it. */
function DraftItem({ d, today, onDiscard }: { d: MyConsultation; today: string; onDiscard: () => void }) {
  const start = useStartConsultation()
  const toast = useToast()
  const navigate = useNavigate()
  const earlier = d.visit.visitDate < today
  const withDoctor = d.visit.status === 'in_consultation'
  const paused = !withDoctor && OPEN_VISIT_STATUSES.includes(d.visit.status)
  const closed = !OPEN_VISIT_STATUSES.includes(d.visit.status)
  return (
    <li className="rounded-xl border border-line bg-surface p-4" data-testid={`draft-${d.encounterId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <Link to={`/doctor/patients/${d.patient.id}`} className="font-semibold text-brand-strong hover:underline">
              {d.patient.fullName}
            </Link>
            <span className="text-sm text-ink-muted">{d.patient.mrn}</span>
            <Badge tone="warn">Draft, not signed</Badge>
            {earlier && <Badge tone="down">From {fmtDate(d.visit.visitDate)}</Badge>}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              Visit {fmtDate(d.visit.visitDate)} · token {d.visit.tokenNumber} · {d.visit.departmentName}
            </span>
            <VisitStatusBadge status={d.visit.status} />
          </p>
          <p className="text-xs text-ink-muted">
            {d.progress.sectionsWithText} of 7 note sections written · {plural(d.progress.diagnoses, 'diagnosis', 'diagnoses')} · {plural(d.progress.medicines, 'medicine')} · last saved {fmtDateTime(d.updatedAt)}
          </p>
          {paused && <p className="text-xs font-medium text-pending">Paused: the visit is back in the queue. Continuing brings it back to you.</p>}
          {closed && <p className="text-xs font-medium text-down">The visit was closed while this draft was open. It cannot be signed; discard it to close it.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {!closed && (
            <Button
              size="sm"
              icon={<Stethoscope aria-hidden="true" className="size-4" />}
              loading={start.isPending}
              onClick={() =>
                withDoctor ? navigate(`/doctor/encounters/${d.encounterId}`) : start.mutate(d.visit.id, { onError: (e) => toast('error', errorMessage(e)) })
              }
            >
              Continue
            </Button>
          )}
          {closed && (
            <Link to={`/doctor/encounters/${d.encounterId}`} className="inline-flex min-h-9 items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas">
              Open
            </Link>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={onDiscard}>
            Discard…
          </Button>
        </div>
      </div>
    </li>
  )
}

function SignedItem({ d }: { d: MyConsultation }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <Link to={`/doctor/patients/${d.patient.id}`} className="font-semibold text-brand-strong hover:underline">
            {d.patient.fullName}
          </Link>
          <span className="text-sm text-ink-muted">{d.patient.mrn}</span>
          {d.amendmentCount > 0 && <Badge tone="notice">{plural(d.amendmentCount, 'amendment')}</Badge>}
        </p>
        <p className="text-sm">
          Visit {fmtDate(d.visit.visitDate)} · token {d.visit.tokenNumber} · {d.visit.departmentName}
        </p>
        <p className="text-xs text-ink-muted">Signed at {fmtDateTime(d.signedAt)}</p>
      </div>
      <Link to={`/doctor/encounters/${d.encounterId}`} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas">
        <FileSignature aria-hidden="true" className="size-4" />
        Open record
      </Link>
    </li>
  )
}

/**
 * The doctor's own consultations: unsigned drafts from any day (the queue
 * shows today only, so earlier drafts would otherwise be forgotten) and
 * records signed in the last 30 days.
 */
export function MyConsultationsPage() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('show') === 'signed' ? 'signed' : 'in_progress'
  useDocumentTitle(tab === 'signed' ? 'Signed consultations' : 'Unsigned drafts')
  const q = useMyConsultations(tab)
  // The dialog keeps the item it was opened for; a refreshed version from the list is used after a refusal,
  // and if the draft left the list meanwhile (signed or discarded elsewhere) the dialog stays open with the refusal.
  const [discardingItem, setDiscardingItem] = useState<MyConsultation | null>(null)
  const items = q.data?.items ?? []
  const current = discardingItem ? items.find((d) => d.encounterId === discardingItem.encounterId) : undefined
  const discarding = discardingItem ? { ...discardingItem, version: current?.version ?? discardingItem.version } : null
  const earlier = q.data ? items.filter((d) => d.visit.visitDate < q.data.today).length : 0
  return (
    <>
      {/* HERO final: "My consultations" is now today's queue (/doctor/queue); this page keeps the drafts and the recently signed records. */}
      <PageHeader title="Drafts and signed records" description="Your unsigned drafts from any day, and the records you signed recently." />
      <div role="group" aria-label="Which consultations" className="mb-4 inline-flex rounded-md border border-line bg-surface p-0.5">
        {(['in_progress', 'signed'] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setParams(t === 'signed' ? { show: 'signed' } : {}, { replace: true, preventScrollReset: true })}
            className={`rounded px-3 py-1.5 text-sm font-medium ${tab === t ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:text-ink'}`}
          >
            {t === 'in_progress' ? 'Unsigned drafts' : 'Signed recently'}
          </button>
        ))}
      </div>
      {q.isPending && <Spinner />}
      {q.isError && (
        <Alert tone="error" title={q.error instanceof ApiError && q.error.status === 403 ? 'Only doctors have consultations' : 'Cannot load your consultations'}>
          {errorMessage(q.error)}
        </Alert>
      )}
      {q.data && tab === 'in_progress' && earlier > 0 && (
        <Alert tone="warning" className="mb-4" title={`${plural(earlier, 'draft')} from an earlier day`}>
          The queue shows today only. Finish and sign these, or discard them with a reason.
        </Alert>
      )}
      {q.data && !items.length && (
        <EmptyState title={tab === 'in_progress' ? 'No unsigned drafts' : `Nothing signed in the last ${q.data.signedWindowDays} days`}>
          {tab === 'in_progress' ? 'Consultations you start appear here until you sign or discard them.' : 'Records you sign appear here for 30 days. Older ones are on each patient’s record.'}
        </EmptyState>
      )}
      {q.data && items.length > 0 && (
        <ul className="space-y-3" aria-label={tab === 'in_progress' ? 'Unsigned drafts' : 'Signed consultations'}>
          {tab === 'in_progress' ? items.map((d) => <DraftItem key={d.encounterId} d={d} today={q.data.today} onDiscard={() => setDiscardingItem(d)} />) : items.map((d) => <SignedItem key={d.encounterId} d={d} />)}
        </ul>
      )}
      {discarding && <DiscardDraftDialog draft={{ id: discarding.encounterId, version: discarding.version, patientName: discarding.patient.fullName, visitStatus: discarding.visit.status }} onClose={() => setDiscardingItem(null)} />}
    </>
  )
}

/** Queue notice: unsigned drafts from earlier days are not in today's queue (no patient names here). */
export function EarlierDraftsNotice() {
  const q = useMyConsultations('in_progress')
  if (!q.data) return null
  const earlier = q.data.items.filter((d) => d.visit.visitDate < q.data.today).length
  if (!earlier) return null
  return (
    <Alert tone="warning" className="mb-4" title={`You have ${plural(earlier, 'unsigned draft')} from an earlier day`}>
      They are not in today’s queue.{' '}
      <Link to="/doctor/consultations" className="font-semibold underline">
        Review unsigned drafts
      </Link>
      <NotebookPen aria-hidden="true" className="ml-1 inline size-4" />
    </Alert>
  )
}
