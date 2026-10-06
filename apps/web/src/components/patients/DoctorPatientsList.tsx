import { type PatientSummary, SEX_LABELS } from '@adaxai/contracts'
import { ChevronRight, Search, TriangleAlert, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { usePatientSearch } from '../../lib/clinical.ts'
import { ageFrom, fmtDate } from '../../lib/format.ts'
import { allergyChip } from '../../lib/patientRecord.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { HeroEmpty, PageTitle, Panel } from '../hero/index.ts'
import { ErrorState, Spinner } from '../ui/Feedback.tsx'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'

/** One patient: avatar · name (the link; the whole row opens the patient) · age · sex · MRN · last visit · allergy chip · chevron. */
function PatientRow({ p }: { p: PatientSummary }) {
  const chip = allergyChip(p.activeAllergies)
  return (
    <li className="relative flex items-center gap-3 px-4 py-3 focus-within:bg-canvas hover:bg-canvas xl:px-5" data-testid="patient-row">
      <PatientAvatar name={p.fullName} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* The name is the link; its box covers the row, so the whole row opens the patient (one tab stop, one name for it). */}
          <Link to={`/doctor/patients/${p.id}`} className="font-medium text-ink [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-brand">
            {p.fullName}
          </Link>
          {chip && (
            <span className="inline-flex items-center gap-1 rounded-md border border-down/30 bg-down-soft px-1.5 py-px text-xs font-medium text-down" title={(p.activeAllergies ?? []).join(', ')}>
              <TriangleAlert aria-hidden="true" className="size-3" />
              <span className="sr-only">Allergy: </span>
              {chip}
            </span>
          )}
        </p>
        <p className="text-sm text-ink-muted">
          <span className="tabular-nums">
            {p.dateOfBirthEstimated ? '~' : ''}
            {ageFrom(p.dateOfBirth)} y
          </span>{' '}
          · {SEX_LABELS[p.sex]} · MRN <span className="font-mono text-ink">{p.mrn}</span> · {p.lastVisitDate ? `Last visit ${fmtDate(p.lastVisitDate)}` : 'No visit yet'}
        </p>
      </div>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
    </li>
  )
}

/**
 * The doctor's patient database (`/doctor/patients`; DESIGN §5.3): one large search (name, MRN, phone or ABHA number; every search is
 * audited without its text), and the matching patients, or the recently updated ones when nothing is typed. No registration for doctors.
 * A search started from the top bar arrives in the router state (never in the address), is taken once and cleared from the history entry.
 */
export function DoctorPatientsPage() {
  useDocumentTitle('Patients')
  const location = useLocation()
  const navigate = useNavigate()
  const started = (location.state as { q?: string } | null)?.q
  const [q, setQ] = useState(started ?? '')
  useEffect(() => {
    if (!started) return
    setQ(started)
    void navigate(location.pathname, { replace: true, state: null, preventScrollReset: true })
  }, [started, location.key, location.pathname, navigate])
  const results = usePatientSearch(q)
  const searching = q.trim().length > 0
  return (
    <>
      <PageTitle title="Patients" />
      <div className="relative mb-4 max-w-2xl">
        <label htmlFor="patient-search" className="sr-only">
          Search patients
        </label>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-ink-muted" />
        <input
          id="patient-search"
          type="search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="Name, MRN, phone or ABHA"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="block min-h-14 w-full rounded-xl border border-line bg-surface pr-4 pl-12 text-base"
        />
      </div>
      <Panel label={searching ? 'Search results' : 'Recently updated patients'} icon={Users} bodyClassName="pb-1" testId="patients-list">
        {results.isPending && (
          <div className="px-4 pb-3 xl:px-5">
            <Spinner label="Searching…" />
          </div>
        )}
        {results.isError && !results.data && (
          <div className="px-4 pb-3 xl:px-5">
            <ErrorState title="The search did not work" error={results.error} onRetry={() => void results.refetch()} retrying={results.isFetching} />
          </div>
        )}
        {results.data &&
          (results.data.length ? (
            <ul aria-label="Patients" className="divide-y divide-line border-t border-line" aria-busy={results.isFetching || undefined}>
              {results.data.map((p) => (
                <PatientRow key={p.id} p={p} />
              ))}
            </ul>
          ) : (
            <HeroEmpty className="px-4 pb-3 xl:px-5">{searching ? 'No patient matches. Check the spelling, or search by MRN, phone or ABHA number.' : 'No patients yet.'}</HeroEmpty>
          ))}
      </Panel>
    </>
  )
}
