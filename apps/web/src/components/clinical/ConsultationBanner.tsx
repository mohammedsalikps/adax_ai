import type { Encounter, VitalKind } from '@adaxai/contracts'
import { VITALS } from '@adaxai/contracts'
import { IdCard, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { usePatient } from '../../lib/clinical.ts'
import { fmtTime } from '../../lib/format.ts'
import { usePatientHistory } from '../../lib/history.ts'
import { latestPerKind, vitalsStatus } from '../../lib/vitals.ts'
import { Badge } from '../ui/Feedback.tsx'
import { useAllergies } from './AllergyItems.tsx'
import { ageSex } from './PatientBanner.tsx'

/**
 * Classes for what the consultation bar leaves out while it is compact (scrolled, from 1024px: see ConsultationHeader), and what it shows
 * only then. The bar marks itself `data-compact`; what is left out stays in the page (hidden), so the banner still says all of it to anyone who
 * reads the page's text, and comes back as soon as the page is scrolled to the top.
 */
export const HIDE_WHEN_COMPACT = 'lg:group-data-[compact=true]/header:hidden'

/**
 * The allergies as chips (put them in a `ul`): each with its severity and a warning sign, read as "Allergy: Penicillin (Severe)"; "No known
 * allergies (recorded)" when that is what the record says; "Allergy status not recorded" when it says nothing (missing is not none); and a
 * warning when the list may be out of date. From the patient's record, falling back to the consultation's own list (see `useAllergies`).
 */
export function AllergyChips({ encounter }: { encounter: Pick<Encounter, 'patient'> }) {
  const a = useAllergies(encounter)
  return (
    <>
      {a.chips.map((c) => (
        <li key={c.key}>
          <Badge tone={c.tone} wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            <span className="sr-only">Allergy: </span>
            {c.text.replace(/^Allergy: /, '')}
          </Badge>
        </li>
      ))}
      {a.noKnown && (
        <li>
          <Badge wrap>No known allergies (recorded)</Badge>
        </li>
      )}
      {a.notRecorded && (
        <li>
          <Badge tone="warn" wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            Allergy status not recorded
          </Badge>
        </li>
      )}
      {a.stale && (
        <li>
          <Badge tone="warn" wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
            Allergy list may be out of date
          </Badge>
        </li>
      )}
    </>
  )
}

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
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span aria-hidden="true" className="text-xs text-ink-muted">
          Allergies
        </span>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies">
          <AllergyChips encounter={encounter} />
        </ul>
      </div>
    </div>
  )
}

/** A badge's words for the vital signs outside the adult range: the kinds by their short names (one or two), else how many. */
function outsideLabel(kinds: VitalKind[]): string {
  if (kinds.length && kinds.length <= 2) return `${kinds.map((k) => VITALS[k]?.short ?? k).join(', ')} outside the reference range`
  return `${kinds.length} vital signs outside the reference range`
}

/**
 * The patient under the consultation bar, on one line where it fits (it wraps where it does not; nothing that keeps the patient safe is ever
 * cut short): who they are (age, sex, MRN; SYNTHETIC for a synthetic record), what to be careful of (every allergy with its severity, or that
 * none is known, or that the status is not recorded), an urgent visit, the vital signs outside the adult reference range (the kinds in the
 * badge; when they were recorded and that the range is an adult one, a display aid, beside it on wide screens and in the badge's tooltip and
 * spoken text elsewhere), `status` (the devices and the local AI, in words), then in one line cut short with an ellipsis (its whole text is
 * its tooltip and is read out) why they came today, their known conditions, the token, the department and the blood group, and "View
 * profile". Nothing here is inferred: there is no alerts engine, only what was recorded.
 *
 * Inside the consultation bar while it is compact (scrolled, from 1024px) it keeps the age, sex and MRN, the allergies, an urgent visit, the
 * vital signs badge and `status`; the rest is left out (the conditions and the reason for the visit are in the History module, and View
 * profile is in the bar's menu).
 */
export function ConsultationBanner({ encounter, onOpenProfile, status }: { encounter: Encounter; onOpenProfile: () => void; status?: ReactNode }) {
  const p = encounter.patient
  const detail = usePatient(p.id)
  const history = usePatientHistory(p.id, { poll: true })
  const open = (history.data?.conditions ?? []).filter((c) => c.status !== 'resolved' && c.status !== 'entered_in_error')
  const vitals = vitalsStatus(encounter.vitals)
  const latest = latestPerKind(encounter.vitals)
  const newest = latest.map((v) => v.measuredAt).sort().at(-1)
  const outsideNames = vitals.outside.map((o) => VITALS[o.kind].label).join(', ')
  const notes = [`Recorded ${fmtTime(newest)}`, vitals.flagged ? 'adult range, a display aid' : 'no reference range applies to these readings (adult ranges only)', vitals.fromDevice ? `${vitals.fromDevice} from a device that is not validated` : null].filter(Boolean).join('; ')
  const vitalsNote = `${vitals.outside.length ? `${outsideNames}. ` : ''}${notes}.`
  const reason = encounter.visit.reasonForVisit?.trim()
  const conditions = open.length ? `Conditions: ${open.slice(0, 3).map((c) => c.name).join(', ')}${open.length > 3 ? ` +${open.length - 3} more` : ''}` : null
  const visit = [`Token ${encounter.visit.tokenNumber}`, encounter.visit.departmentName, detail.data?.bloodGroup ? `Blood group ${detail.data.bloodGroup}` : null].filter(Boolean).join(' · ')
  const tail = [reason ? `Reason for visit: “${reason}”` : null, conditions, visit].filter(Boolean).join(' · ')

  return (
    <section
      aria-label="Patient"
      className="min-w-0 border-t border-line pt-1.5 text-sm lg:max-h-[34dvh] lg:overflow-y-auto lg:group-data-[compact=true]/header:border-t-0 lg:group-data-[compact=true]/header:pt-0"
      data-testid="patient-banner"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-ink-muted lg:whitespace-nowrap lg:group-data-[compact=true]/header:text-xs" data-testid="patient-identity">
          {ageSex(p)} · MRN <span className="font-mono font-medium text-ink">{p.mrn}</span>
        </p>
        {detail.data && detail.data.dataOrigin !== 'clinical' && (
          <span className={HIDE_WHEN_COMPACT}>
            <Badge>Synthetic</Badge>
          </span>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span aria-hidden="true" className="text-xs text-ink-muted">
            Allergies
          </span>
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies">
            <AllergyChips encounter={encounter} />
          </ul>
        </div>
        {encounter.visit.priority === 'urgent' && (
          <span data-testid="visit-urgent">
            <Badge tone="down" dot>
              Urgent<span className="sr-only"> visit</span>
            </Badge>
          </span>
        )}
        {vitals.total > 0 && (
          <span className="inline-flex min-w-0 items-center gap-x-2" title={vitalsNote} data-testid="vitals-alert">
            {vitals.flagged ? (
              <Badge tone={vitals.outside.length ? 'warn' : 'ok'} dot wrap>
                {vitals.outside.length ? outsideLabel(vitals.outside.map((o) => o.kind)) : 'Latest vitals within the reference range'}
              </Badge>
            ) : (
              <Badge wrap>Vital signs recorded</Badge>
            )}
            {/* Spoken with the badge everywhere; shown beside it where there is room (from 1536px, when the bar is not compact). */}
            <span className="sr-only text-xs text-ink-muted 2xl:not-sr-only lg:group-data-[compact=true]/header:sr-only">{vitalsNote}</span>
          </span>
        )}
        {/* Cut short, never pushed to a line of its own from 1024px (below, where the bar scrolls away with the page, it has a line of its own):
            the reason for the visit, the conditions, the token, the department, the blood group. Where less than 8rem is left for it, it is not
            drawn at all (a word and an ellipsis say nothing) but is still read out. "Reason for visit" is said in full, drawn as "Reason". */}
        <div className={`@container min-w-0 flex-1 basis-0 max-lg:basis-full ${HIDE_WHEN_COMPACT}`}>
          <p className="truncate text-ink-muted @max-[8rem]:sr-only" title={tail} data-testid="patient-visit-line">
            {reason && (
              <span data-testid="visit-reason">
                <span>
                  Reason<span className="sr-only"> for visit</span>:
                </span>{' '}
                <span className="text-ink">“{reason}”</span>
              </span>
            )}
            {conditions && <span>{reason ? ' · ' : ''}{conditions}</span>}
            <span>{reason || conditions ? ' · ' : ''}{visit}</span>
          </p>
        </div>
        {status}
        <button
          type="button"
          onClick={onOpenProfile}
          title="View profile"
          className={`inline-flex min-h-control-sm min-w-control-sm items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 text-sm font-medium shadow-card hover:bg-canvas ${HIDE_WHEN_COMPACT}`}
        >
          <IdCard aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only 2xl:not-sr-only">View profile</span>
        </button>
      </div>
    </section>
  )
}
