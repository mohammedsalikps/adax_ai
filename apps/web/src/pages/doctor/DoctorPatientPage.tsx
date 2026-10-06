import type { PatientDetail } from '@adaxai/contracts'
import { ChevronLeft, TriangleAlert } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ageSex } from '../../components/clinical/PatientBanner.tsx'
import { PatientDetailsTab, PatientDocumentsTab, PatientSummaryTab } from '../../components/patients/PatientRecordSections.tsx'
import { Badge, ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { PatientAvatar } from '../../components/ui/PatientAvatar.tsx'
import { TabPanel, Tabs } from '../../components/ui/Tabs.tsx'
import { usePatient } from '../../lib/clinical.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

type PageTab = 'summary' | 'details' | 'documents'
const TABS: { id: PageTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'details', label: 'Details' },
  { id: 'documents', label: 'Documents' },
]
const isTab = (v: string | null): v is PageTab => v === 'summary' || v === 'details' || v === 'documents'

const SEVERITY = { severe: 'Severe', moderate: 'Moderate', mild: 'Mild', unknown: 'severity not recorded' } as const

/** Who the patient is, always on screen: avatar, name (the page's h1), age · sex, MRN, the allergies (or that their status is not recorded). */
function PatientHeader({ p }: { p: PatientDetail }) {
  const active = p.allergies.filter((a) => a.status === 'active')
  return (
    <header className="mb-4 flex items-start gap-4" data-testid="patient-header">
      <PatientAvatar name={p.fullName} size="lg" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{p.fullName}</h1>
          {p.dataOrigin === 'synthetic' && <Badge>Synthetic data</Badge>}
        </div>
        <p className="text-sm text-ink-muted">
          {ageSex(p)} · MRN <span className="font-mono text-ink">{p.mrn}</span>
        </p>
        <ul aria-label="Allergies" className="flex flex-wrap gap-1.5">
          {active.map((a) => (
            <li key={a.id}>
              <Badge tone={a.severity === 'severe' ? 'down' : a.severity === 'mild' ? 'neutral' : 'warn'} wrap icon={<TriangleAlert aria-hidden="true" className="size-3 shrink-0" />}>
                Allergy: {a.substance} ({SEVERITY[a.severity]})
              </Badge>
            </li>
          ))}
          {!active.length && (
            <li>
              {p.noKnownAllergies ? (
                <Badge wrap>No known allergies</Badge>
              ) : (
                <Badge tone="warn" wrap>
                  Allergy status not recorded
                </Badge>
              )}
            </li>
          )}
        </ul>
      </div>
    </header>
  )
}

/**
 * The doctor's patient page (`/doctor/patients/:patientId`; DESIGN §5.3): the header (avatar, name, age · sex, MRN, allergies, Synthetic
 * badge) and the tabs Summary (default) · Details · Documents. Only the open tab is mounted, so each part of the record is read (and
 * audited) when the doctor looks at it. The tab is kept in the address (`?tab=details`), so Back returns to it. No check-in, portal or
 * appointments for doctors; Mana for this patient is the global Mana (scoped by the route).
 */
export function DoctorPatientPage() {
  const { patientId } = useParams()
  const [params, setParams] = useSearchParams()
  const q = usePatient(patientId)
  const requested = params.get('tab')
  const tab: PageTab = isTab(requested) ? requested : 'summary'
  const setTab = (t: PageTab) => setParams(t === 'summary' ? {} : { tab: t }, { replace: true, preventScrollReset: true })
  useDocumentTitle(q.data ? q.data.fullName : 'Patient')
  if (q.isPending) return <LoadingState rows={4} label="Loading the patient…" />
  if (!q.data) return <ErrorState title="The patient could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
  const p = q.data
  const prefix = `patient-${p.id}`
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm">
        <Link to="/doctor/patients" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 font-medium text-brand-strong hover:bg-surface">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Patients
        </Link>
      </nav>
      <PatientHeader p={p} />
      <Tabs label="Patient record" prefix={prefix} tabs={TABS} value={tab} onChange={setTab} className="mb-4" />
      <TabPanel prefix={prefix} id="summary" active={tab === 'summary'} focusable={false}>
        {tab === 'summary' && <PatientSummaryTab patientId={p.id} onShowDetails={() => setTab('details')} />}
      </TabPanel>
      <TabPanel prefix={prefix} id="details" active={tab === 'details'} focusable={false}>
        {tab === 'details' && <PatientDetailsTab p={p} />}
      </TabPanel>
      <TabPanel prefix={prefix} id="documents" active={tab === 'documents'} focusable={false}>
        {tab === 'documents' && <PatientDocumentsTab p={p} />}
      </TabPanel>
    </>
  )
}
