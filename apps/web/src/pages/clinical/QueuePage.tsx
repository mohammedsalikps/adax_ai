import { OPEN_VISIT_STATUSES, UpdateVisitRequest, VISIT_STATUS_LABELS, VISIT_TRANSITIONS, type Visit, type VisitStatus } from '@adaxai/contracts'
import { Activity, ClipboardCheck, Pencil, Route, Stethoscope, UserPlus, UserX, XCircle } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { useDoctors } from '../../components/clinical/CheckInDialog.tsx'
import { RoutingDialog } from '../../components/clinical/RoutingDialog.tsx'
import { ageSex, AllergySummary } from '../../components/clinical/PatientBanner.tsx'
import { RecordVitalsDialog, VitalsInline } from '../../components/clinical/Vitals.tsx'
import { VisitStatusBadge } from '../../components/clinical/VisitStatusBadge.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Dialog } from '../../components/ui/Dialog.tsx'
import { Alert, Badge, EmptyState, Spinner } from '../../components/ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../../components/ui/Form.tsx'
import { PageHeader } from '../../components/ui/Layout.tsx'
import { SegmentedControl } from '../../components/ui/SegmentedControl.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { errorMessage } from '../../lib/api.ts'
import { useMe } from '../../lib/auth.tsx'
import { usePortalBase, useVisitMutation, useVisits } from '../../lib/clinical.ts'
import { fmtClock } from '../../lib/appointments.ts'
import { fmtDate, fmtTime } from '../../lib/format.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { useDepartments } from '../admin/AdminUsersPage.tsx'

function StatusChangeButton({ visit, to, label, icon, variant = 'secondary' }: { visit: Visit; to: VisitStatus; label: string; icon: ReactNode; variant?: 'secondary' | 'ghost' | 'primary' }) {
  const toast = useToast()
  const change = useVisitMutation<{ status: VisitStatus; from: VisitStatus }>(visit.id, '/status')
  return (
    <Button
      size="sm"
      variant={variant}
      icon={icon}
      loading={change.isPending}
      onClick={() =>
        change.mutate(
          { status: to, from: visit.status },
          { onSuccess: () => toast('success', `Token ${visit.tokenNumber}: ${VISIT_STATUS_LABELS[to]}`), onError: (e) => toast('error', errorMessage(e)) },
        )
      }
    >
      {label}
    </Button>
  )
}

export function CancelDialog({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const change = useVisitMutation<{ status: VisitStatus; from: VisitStatus; reason: string }>(visit.id, '/status')
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Cancel token ${visit.tokenNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep visit
          </Button>
          <Button
            variant="danger"
            loading={change.isPending}
            disabled={reason.trim().length < 2}
            onClick={() => change.mutate({ status: 'cancelled', from: visit.status, reason }, { onSuccess: () => (toast('success', 'Visit cancelled'), onClose()) })}
          >
            Cancel visit
          </Button>
        </>
      }
    >
      {change.isError && <Alert tone="error">{errorMessage(change.error)}</Alert>}
      <p className="mb-3 text-sm">
        {visit.patient.fullName} ({visit.patient.mrn}) will be removed from today’s queue. The visit stays on record as cancelled.
      </p>
      <TextField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
    </Dialog>
  )
}

export function EditVisitDialog({ visit, onClose }: { visit: Visit; onClose: () => void }) {
  const toast = useToast()
  const depts = useDepartments()
  const doctors = useDoctors()
  const [v, setV] = useState({ departmentId: visit.departmentId, assignedDoctorId: visit.assignedDoctorId, priority: visit.priority, chiefComplaint: visit.chiefComplaint ?? '' })
  const save = useVisitMutation<UpdateVisitRequest>(visit.id, '', 'PATCH')
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit token ${visit.tokenNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(v, { onSuccess: () => (toast('success', 'Visit updated'), onClose()) })}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <SelectField label="Department" value={v.departmentId} onChange={(e) => setV({ ...v, departmentId: e.target.value })}>
          {depts.data?.filter((d) => d.isActive).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Doctor" value={v.assignedDoctorId ?? ''} onChange={(e) => setV({ ...v, assignedDoctorId: e.target.value || null })}>
          <option value="">Any doctor in the department</option>
          {doctors.data?.filter((d) => d.departmentId === v.departmentId).map((d) => (
            <option key={d.id} value={d.id}>
              {d.fullName}
            </option>
          ))}
        </SelectField>
        <SelectField label="Priority" value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value as Visit['priority'] })}>
          <option value="normal">Normal</option>
          <option value="urgent">Urgent (seen first)</option>
        </SelectField>
        <TextAreaField label="Reason for visit" rows={2} value={v.chiefComplaint} onChange={(e) => setV({ ...v, chiefComplaint: e.target.value })} />
      </div>
    </Dialog>
  )
}

type Dialogs = { kind: 'vitals' | 'cancel' | 'edit' | 'routing'; visit: Visit } | null

function QueueRow({ visit, role, onOpen, consultationAction }: { visit: Visit; role: 'doctor' | 'nurse'; onOpen: (d: NonNullable<Dialogs>) => void; consultationAction?: (v: Visit) => ReactNode }) {
  const base = role === 'doctor' ? '/doctor' : '/nurse'
  const open = OPEN_VISIT_STATUSES.includes(visit.status)
  const can = (to: VisitStatus) => VISIT_TRANSITIONS[visit.status].includes(to)
  return (
    <li className={`rounded-xl border bg-surface p-4 shadow-card ${visit.priority === 'urgent' && open ? 'border-down/40' : 'border-line'}`} data-testid={`queue-row-${visit.tokenNumber}`}>
      <div className="flex flex-wrap gap-4">
        <div className="flex size-14 shrink-0 flex-col items-center justify-center rounded-lg bg-canvas" aria-label={`Token ${visit.tokenNumber}`}>
          <span className="text-[10px] font-medium text-ink-muted uppercase">Token</span>
          <span className="text-xl font-semibold tabular-nums">{visit.tokenNumber}</span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`${base}/patients/${visit.patient.id}`} className="font-semibold text-brand-strong hover:underline">
              {visit.patient.fullName}
            </Link>
            <span className="text-sm text-ink-muted">
              {visit.patient.mrn} · {ageSex(visit.patient)}
            </span>
            {visit.priority === 'urgent' && <Badge tone="down">Urgent</Badge>}
            <VisitStatusBadge status={visit.status} />
          </div>
          <AllergySummary noKnownAllergies={visit.patient.noKnownAllergies} activeAllergies={visit.patient.activeAllergies} />
          {visit.chiefComplaint && <p className="text-sm">“{visit.chiefComplaint}”</p>}
          {visit.triageNote && (
            <p className="line-clamp-2 text-sm [overflow-wrap:anywhere] text-ink-muted">
              <span className="font-medium text-ink">Triage note:</span> {visit.triageNote}
            </p>
          )}
          <VitalsInline vitals={visit.latestVitals} />
          <p className="text-xs text-ink-muted">
            {visit.departmentName} · {visit.assignedDoctorName ?? 'Any doctor'} · checked in {fmtTime(visit.checkedInAt)}
            {visit.appointment && ` · appointment ${fmtClock(visit.appointment.localTime)}`}
          </p>
        </div>
        {open && (
          <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:max-w-xs sm:justify-end">
            {consultationAction?.(visit)}
            {visit.status !== 'in_consultation' && (
              <Button size="sm" variant="secondary" icon={<Activity aria-hidden="true" className="size-4" />} onClick={() => onOpen({ kind: 'vitals', visit })}>
                Vitals
              </Button>
            )}
            {role === 'nurse' && can('ready') && <StatusChangeButton visit={visit} to="ready" label="Ready for doctor" icon={<ClipboardCheck aria-hidden="true" className="size-4" />} variant="primary" />}
            {role === 'nurse' && can('no_show') && <StatusChangeButton visit={visit} to="no_show" label="No-show" icon={<UserX aria-hidden="true" className="size-4" />} variant="ghost" />}
            {visit.status !== 'in_consultation' && (
              <Button size="sm" variant="ghost" icon={<Route aria-hidden="true" className="size-4" />} onClick={() => onOpen({ kind: 'routing', visit })}>
                Routing
              </Button>
            )}
            {visit.status !== 'in_consultation' && (
              <Button size="sm" variant="ghost" icon={<Pencil aria-hidden="true" className="size-4" />} onClick={() => onOpen({ kind: 'edit', visit })}>
                Edit
              </Button>
            )}
            {can('cancelled') && (
              <Button size="sm" variant="ghost" icon={<XCircle aria-hidden="true" className="size-4" />} onClick={() => onOpen({ kind: 'cancel', visit })}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

const SUMMARY: VisitStatus[] = ['waiting', 'in_triage', 'ready', 'in_consultation', 'completed']

export function QueuePage({ consultationAction, notice }: { consultationAction?: (v: Visit) => ReactNode; notice?: ReactNode }) {
  const { data: me } = useMe()
  const role = me?.role === 'doctor' ? 'doctor' : 'nurse'
  useDocumentTitle('OPD queue')
  const base = usePortalBase()
  const [scope, setScope] = useState<'mine' | 'all'>(role === 'doctor' ? 'mine' : 'all')
  const [showClosed, setShowClosed] = useState(false)
  const q = useVisits({ mine: scope === 'mine' })
  const [dialog, setDialog] = useState<Dialogs>(null)

  const visits = q.data?.visits ?? []
  const shown = showClosed ? visits : visits.filter((v) => OPEN_VISIT_STATUSES.includes(v.status))
  // Doctors see patients ready for them first.
  const ordered = role === 'doctor' ? [...shown].sort((a, b) => Number(b.status === 'in_consultation') - Number(a.status === 'in_consultation') || Number(b.status === 'ready') - Number(a.status === 'ready')) : shown

  return (
    <>
      <PageHeader
        title="OPD queue"
        description={q.data ? `${fmtDate(q.data.date)} · updates automatically` : undefined}
        actions={
          role === 'nurse' ? (
            <Link to={`${base}/patients`} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-strong">
              <UserPlus aria-hidden="true" className="size-4" />
              Check in a patient
            </Link>
          ) : undefined
        }
      />
      {notice}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {role === 'doctor' && (
          <SegmentedControl
            label="Whose patients"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'mine', label: 'My patients' },
              { value: 'all', label: 'Whole clinic' },
            ]}
          />
        )}
        <label className="ml-auto inline-flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show completed and cancelled
        </label>
      </div>
      {q.data && (
        <ul className="mb-4 flex flex-wrap gap-2" aria-label="Queue summary">
          {SUMMARY.map((s) => (
            <li key={s} className="rounded-full border border-line bg-surface px-3 py-1 text-sm">
              {VISIT_STATUS_LABELS[s]} <span className="font-semibold tabular-nums">{visits.filter((v) => v.status === s).length}</span>
            </li>
          ))}
        </ul>
      )}
      {q.isPending && <Spinner />}
      {q.isError && <Alert tone="error">{errorMessage(q.error)}</Alert>}
      {q.data && !ordered.length && (
        <EmptyState title={visits.length ? 'No open visits' : 'No patients in the queue yet'}>
          {role === 'nurse' ? 'Check a patient in to add them to today’s queue.' : 'Patients appear here when they are checked in.'}
        </EmptyState>
      )}
      <ul className="space-y-3" aria-label="Visits">
        {ordered.map((v) => (
          <QueueRow key={v.id} visit={v} role={role} onOpen={setDialog} consultationAction={consultationAction} />
        ))}
      </ul>
      {dialog?.kind === 'vitals' && <RecordVitalsDialog visitId={dialog.visit.id} patientName={dialog.visit.patient.fullName} triageNote={dialog.visit.triageNote ?? null} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelDialog visit={dialog.visit} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditVisitDialog visit={dialog.visit} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'routing' && <RoutingDialog visit={dialog.visit} onClose={() => setDialog(null)} />}
    </>
  )
}

export const StartConsultIcon = Stethoscope
