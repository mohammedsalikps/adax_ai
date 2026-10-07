import { ChevronLeft } from 'lucide-react'
import { Link, useParams, useSearchParams } from 'react-router'
import { isRecordTab, PatientRecordView, type PatientRecordTab } from '../../components/patients/PatientRecordView.tsx'
import { usePatient } from '../../lib/clinical.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

/**
 * The doctor's patient page (`/doctor/patients/:patientId`; jury design, screen 2): the patient record (PatientRecordView) with its tabs
 * Overview · Consultations · Prescriptions · Lab Reports · Imaging · Documents · Surgeries · Allergies & Medications. The tab is kept in the
 * address (`?tab=labs`), so Back returns to it. No check-in, portal or appointments for doctors; Mana for this patient is the global Mana
 * (scoped by the route).
 */
export function DoctorPatientPage() {
  const { patientId } = useParams()
  const [params, setParams] = useSearchParams()
  const q = usePatient(patientId)
  const requested = params.get('tab')
  const tab: PatientRecordTab = isRecordTab(requested) ? requested : 'overview'
  const setTab = (t: PatientRecordTab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true, preventScrollReset: true })
  useDocumentTitle(q.data ? q.data.fullName : 'Patient')
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 text-sm">
        <Link to="/doctor/patients" className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 font-medium text-brand-strong hover:bg-surface">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Patients
        </Link>
      </nav>
      {patientId && <PatientRecordView patientId={patientId} tab={tab} onTabChange={setTab} />}
    </>
  )
}
