import type { Encounter } from '@adaxai/contracts'
import { VITALS } from '@adaxai/contracts'
import type { ReactNode } from 'react'
import { usePatient } from '../../lib/clinical.ts'
import { fmtTime } from '../../lib/format.ts'
import { usePatientHistory } from '../../lib/history.ts'
import { latestPerKind, vitalsStatus } from '../../lib/vitals.ts'
import { Button } from '../ui/Button.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { AllergyItems } from './AllergyItems.tsx'
import { ageSex } from './PatientBanner.tsx'

/** Name, MRN and allergies on one line: what stays in view, with the consultation bar, once the banner has scrolled away (below 1024px). */
export function PatientStrip({ encounter }: { encounter: Encounter }) {
  const p = encounter.patient
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="patient-strip">
      <p className="font-semibold break-words">
        {p.fullName}
        <span className="font-normal text-ink-muted">
          {' '}
          · MRN <span className="font-mono text-ink">{p.mrn}</span>
        </span>
      </p>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies">
        <AllergyItems encounter={encounter} />
      </ul>
    </div>
  )
}

/**
 * The patient under the consultation bar: who they are (age, sex, MRN), what to
 * be careful of (allergies with their severity, known conditions), why they came
 * today, the alerts the record holds for this visit (an urgent visit; vital
 * signs outside the adult reference range), and `status` (the devices and the
 * local AI, in words). The allergy chips come from the patient's record and fall
 * back to the consultation's own list if the record cannot be read (see
 * `AllergyItems`). Nothing here is inferred: there is no alerts engine, only
 * what was recorded.
 */
export function ConsultationBanner({ encounter, onOpenProfile, status }: { encounter: Encounter; onOpenProfile: () => void; status?: ReactNode }) {
  const p = encounter.patient
  const detail = usePatient(p.id)
  const history = usePatientHistory(p.id, { poll: true })
  const open = (history.data?.conditions ?? []).filter((c) => c.status !== 'resolved')
  const vitals = vitalsStatus(encounter.vitals)
  const latest = latestPerKind(encounter.vitals)
  const newest = latest.map((v) => v.measuredAt).sort().at(-1)
  const outsideNames = vitals.outside.map((o) => VITALS[o.kind].label).join(', ')
  const notes = [`Recorded ${fmtTime(newest)}`, vitals.flagged ? 'adult range, a display aid' : 'no reference range applies to these readings (adult ranges only)', vitals.fromDevice ? `${vitals.fromDevice} from a device that is not validated` : null].filter(Boolean).join('; ')
  const reason = encounter.visit.reasonForVisit

  return (
    <section aria-label="Patient" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-2 text-sm lg:max-h-[34dvh] lg:overflow-y-auto" data-testid="patient-banner">
      <p className="text-ink-muted">
        {ageSex(p)} · MRN <span className="font-mono font-medium text-ink">{p.mrn}</span>
        {detail.data?.bloodGroup ? ` · ${detail.data.bloodGroup}` : ''} · Token {encounter.visit.tokenNumber} · {encounter.visit.departmentName}
      </p>
      {detail.data && detail.data.dataOrigin !== 'clinical' && <Badge>Synthetic</Badge>}
      <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies and conditions">
        <AllergyItems encounter={encounter} />
        {open.slice(0, 3).map((c) => (
          <li key={c.id}>
            <Badge tone="notice" wrap>
              {c.name}
            </Badge>
          </li>
        ))}
        {open.length > 3 && (
          <li>
            <Badge wrap>+{open.length - 3} more conditions</Badge>
          </li>
        )}
      </ul>
      {reason && (
        <p className="min-w-0 break-words" data-testid="visit-reason">
          <span className="text-ink-muted">Reason for visit:</span> “{reason}”
        </p>
      )}
      {encounter.visit.priority === 'urgent' && (
        <Badge tone="down" dot>
          Urgent visit
        </Badge>
      )}
      {vitals.total > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {vitals.flagged ? (
            <Badge tone={vitals.outside.length ? 'warn' : 'ok'} dot wrap>
              {vitals.outside.length ? `${vitals.outside.length} vital sign${vitals.outside.length === 1 ? '' : 's'} outside the reference range` : 'Latest vitals within the reference range'}
            </Badge>
          ) : (
            <Badge wrap>Vital signs recorded</Badge>
          )}
          <span className="text-xs text-ink-muted">
            {vitals.outside.length ? `${outsideNames}. ` : ''}
            {notes}.
          </span>
        </p>
      )}
      {status}
      <Button variant="secondary" size="sm" onClick={onOpenProfile} className="ml-auto">
        View profile
      </Button>
    </section>
  )
}
