import { SEX_LABELS } from '@adaxai/contracts'
import { Search, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { Alert, EmptyState, Spinner } from '../../components/ui/Feedback.tsx'
import { Card, PageHeader } from '../../components/ui/Layout.tsx'
import { Table } from '../../components/ui/Table.tsx'
import { errorMessage } from '../../lib/api.ts'
import { usePatientSearch, usePortalBase } from '../../lib/clinical.ts'
import { ageFrom, fmtDate } from '../../lib/format.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { useMe } from '../../lib/auth.tsx'
import { DoctorPatientsPage } from '../../components/patients/DoctorPatientsList.tsx'

/** The patients list: the doctor's own variant (DESIGN §5.3, no registration), the nurse's unchanged. */
export function PatientsPage() {
  const { data: me } = useMe()
  return me?.role === 'doctor' ? <DoctorPatientsPage /> : <StaffPatientsPage />
}

function StaffPatientsPage() {
  useDocumentTitle('Patients')
  const base = usePortalBase()
  // A search started from the top bar arrives in the router state (never in the address). It is taken once and then cleared from the
  // history entry, so a reload or Back does not repeat the (audited) search; a new one from the top bar replaces the current term.
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
  return (
    <>
      <PageHeader
        title="Patients"
        description="Search by name, MRN or phone number. Every search and record you open is audited."
        actions={
          <Link to={`${base}/register`} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-4 text-sm font-medium hover:bg-canvas">
            <UserPlus aria-hidden="true" className="size-4" />
            Register new patient
          </Link>
        }
      />
      <div className="relative mb-4 max-w-xl">
        <label htmlFor="patient-search" className="sr-only">
          Search patients
        </label>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-ink-muted" />
        <input
          id="patient-search"
          type="search"
          autoFocus
          autoComplete="off"
          placeholder="Name, MRN or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="block min-h-12 w-full rounded-lg border border-line bg-surface pr-3 pl-10 text-base"
        />
      </div>
      <Card bodyClassName="">
        {results.isPending && <div className="px-5"><Spinner label="Searching…" /></div>}
        {results.isError && <Alert tone="error" className="m-5">{errorMessage(results.error)}</Alert>}
        {results.data && (
          <Table
            caption={q.trim() ? 'Search results' : 'Recently updated patients'}
            rows={results.data}
            rowKey={(p) => p.id}
            empty={
              <div className="p-5">
                <EmptyState title="No patients found">
                  Check the spelling, or <Link to={`${base}/register`} className="font-medium text-brand-strong underline">register a new patient</Link>.
                </EmptyState>
              </div>
            }
            columns={[
              {
                key: 'name',
                header: 'Patient',
                cell: (p) => (
                  <Link to={`${base}/patients/${p.id}`} className="font-medium text-brand-strong hover:underline">
                    {p.fullName}
                  </Link>
                ),
              },
              { key: 'mrn', header: 'MRN', cell: (p) => <span className="font-mono text-sm">{p.mrn}</span> },
              { key: 'age', header: 'Age · sex', cell: (p) => `${p.dateOfBirthEstimated ? '~' : ''}${ageFrom(p.dateOfBirth)} y · ${SEX_LABELS[p.sex]}` },
              { key: 'phone', header: 'Phone', cell: (p) => <span className="whitespace-nowrap">{p.phone}</span> },
              { key: 'last', header: 'Last visit', cell: (p) => (p.lastVisitDate ? fmtDate(p.lastVisitDate) : '—') },
            ]}
          />
        )}
      </Card>
    </>
  )
}
