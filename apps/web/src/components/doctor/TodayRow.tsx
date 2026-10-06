import type { DoctorDayTimelineRow } from '@adaxai/contracts'
import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { fmtClock } from '../../lib/appointments.ts'
import { rowDetail, rowPill, stageNote } from '../../lib/doctorDay.ts'
import { StatusPill } from '../hero/StatusPill.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'

export interface TodayRowProps {
  /** One of today's patients, as GET /api/doctor/day returns it. */
  row: DoctorDayTimelineRow
  /** The facility's calendar day (the age is on it). */
  today: string
  /** The row's one action (TodayAction); none for a patient who has not arrived. */
  action?: ReactNode
  /** Draw the row as just changed (the consultation completed on the way back to My consultations). */
  highlighted?: boolean
}

/**
 * One of today's patients, shared by Home and My consultations (DESIGN §5.1-5.2): time · avatar, name and "age · sex · MRN" · short reason ·
 * allergy chip when there is one · status pill (with where the patient is: ready for the doctor, with the nurse, overdue; urgent as a pill,
 * never re-ordered) · one action. A `listitem` holding the patient's name and the action button (many e2e helpers find a row this way).
 *
 * The patient's name is a link to the patient page and stretches over the whole row, so a click anywhere on the row opens the patient; the
 * action sits above it and keeps its own click and focus.
 */
export function TodayRow({ row, today, action, highlighted = false }: TodayRowProps) {
  const p = row.patient
  const note = stageNote(row)
  return (
    <li
      data-row-key={row.key}
      className={`relative grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3 motion-safe:transition-colors motion-safe:duration-150 hover:bg-canvas/70 md:grid-cols-[4.5rem_minmax(0,1fr)_11.5rem] md:items-center md:gap-x-4 xl:grid-cols-[4.5rem_minmax(0,1.25fr)_minmax(0,1fr)_10rem_11.5rem] xl:px-5 ${highlighted ? 'bg-ok-soft/50' : ''}`}
    >
      <div className="pt-0.5 md:pt-0">
        <p className="text-sm font-semibold tabular-nums">{row.time ? fmtClock(row.time) : <span className="text-ink-muted">No time</span>}</p>
        <p className="text-[0.6875rem] text-ink-muted">{row.scheduledAt ? 'Appointment' : 'Walk-in'}</p>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span className="hidden shrink-0 sm:block">
          <PatientAvatar name={p.fullName} size="md" />
        </span>
        <div className="min-w-0">
          <Link
            to={`/doctor/patients/${p.id}`}
            className="block font-semibold [overflow-wrap:anywhere] text-ink after:absolute after:inset-0 after:content-[''] hover:text-brand-strong hover:underline"
          >
            {p.fullName}
          </Link>
          <p className="text-xs text-ink-muted">{rowDetail(p, today)}</p>
        </div>
      </div>
      {/* Every row lines up with the others. Below 768px one column under the name; up to 1280px the status above the action on the right and the reason under the name; from 1280px five columns. */}
      {(row.reason || p.activeAllergies.length > 0) && (
        <div className="col-start-2 min-w-0 space-y-1 sm:pl-13 md:row-start-2 xl:col-start-3 xl:row-start-1 xl:pl-0">
          {row.reason && <p className="line-clamp-2 text-sm [overflow-wrap:anywhere] text-ink-muted">{row.reason}</p>}
          {p.activeAllergies.length > 0 && (
            <span className="inline-flex max-w-full items-start gap-1 rounded-full border border-down/25 bg-down-soft px-2 py-0.5 text-xs font-medium text-down">
              <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span className="[overflow-wrap:anywhere]">Allergy: {p.activeAllergies.join(', ')}</span>
            </span>
          )}
        </div>
      )}
      <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 sm:pl-13 md:col-start-3 md:row-start-1 md:justify-end md:pl-0 xl:col-start-4 xl:justify-start">
        <StatusPill status={rowPill(row)} />
        {row.priority === 'urgent' && <Badge tone="down">Urgent</Badge>}
        {note && <span className="text-xs text-ink-muted">{note}</span>}
      </div>
      {/* Above the stretched name link: the action keeps its own click and focus. */}
      {action && <div className="relative z-10 col-start-2 sm:pl-13 md:col-start-3 md:row-start-2 md:justify-self-end md:pl-0 xl:col-start-5 xl:row-start-1">{action}</div>}
    </li>
  )
}
