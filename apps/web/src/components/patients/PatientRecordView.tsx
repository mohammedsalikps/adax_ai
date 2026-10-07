import { type Observation, type PatientDetail, type PatientHistory, SEX_LABELS } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { Activity, ClipboardList, Droplet, FileText, FlaskConical, HeartPulse, IdCard, Images, Pill, Printer, Scissors, Stethoscope, Thermometer, TriangleAlert, Wind } from 'lucide-react'
import { type ComponentType, useState } from 'react'
import { Link } from 'react-router'
import { useMe } from '../../lib/auth.tsx'
import { usePatient } from '../../lib/clinical.ts'
import { api } from '../../lib/api.ts'
import { plainName } from '../../lib/displayName.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import { usePatientHistory } from '../../lib/history.ts'
import { localToday, recordLines } from '../../lib/patientRecord.ts'
import { PatientThermalCard } from '../../pages/clinical/ThermalPages.tsx'
import { conditionBadge } from '../clinical/ConsultationHeader.tsx'
import { ageSex } from '../clinical/PatientBanner.tsx'
import { PastHistoryPanel } from '../clinical/PastHistory.tsx'
import { HeroEmpty, KeyValue, KeyValueList, Panel, SourceTag } from '../hero/index.ts'
import { ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { PatientAvatar } from '../ui/PatientAvatar.tsx'
import { TabPanel, Tabs } from '../ui/Tabs.tsx'
import { prescriptionPdfUrl } from '../rx/PdfPreview.tsx'
import { ConsultationSummary, ConsultationTimeline, PatientDocumentsTab } from './PatientRecordSections.tsx'
import { RecordLines } from './RecordLines.tsx'
import { SurgeriesSection } from './SurgeriesSection.tsx'

/** The tabs of the patient record (jury design, screen 2). */
export type PatientRecordTab = 'overview' | 'consultations' | 'prescriptions' | 'labs' | 'imaging' | 'documents' | 'surgeries' | 'allergies_medications'
const TABS: { id: PatientRecordTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'consultations', label: 'Consultations' },
  { id: 'prescriptions', label: 'Prescriptions' },
  { id: 'labs', label: 'Lab Reports' },
  { id: 'imaging', label: 'Imaging' },
  { id: 'documents', label: 'Documents' },
  { id: 'surgeries', label: 'Surgeries' },
  { id: 'allergies_medications', label: 'Allergies & Medications' },
]
export const isRecordTab = (v: string | null): v is PatientRecordTab => TABS.some((t) => t.id === v)

const SEVERITY = { severe: 'Severe', moderate: 'Moderate', mild: 'Mild', unknown: 'severity not recorded' } as const

/** The windows the average vitals can be taken over. */
const WINDOWS = [
  { id: '6m', label: 'Last 6 months', days: 183 },
  { id: '12m', label: 'Last 12 months', days: 366 },
  { id: 'all', label: 'All recorded', days: null },
] as const
type WindowId = (typeof WINDOWS)[number]['id']

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>
interface AvgTile {
  key: string
  label: string
  icon: Icon
  value: string | null
  unit: string
  n: number
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * The averages of the vital signs STAFF recorded over a window (device and simulated values are left out: they are not measurements staff made).
 * Blood pressure pairs a visit's systolic and diastolic; the others average every value of their kind. A kind with no value says so ("—").
 */
export function averageVitals(obs: Observation[], since: string | null): AvgTile[] {
  const staff = obs.filter((o) => o.validationStatus === 'manual_entry' && (!since || o.measuredAt >= since))
  const of = (k: Observation['kind']) => staff.filter((o) => o.kind === k).map((o) => o.value)
  const fmt = (v: number | null, digits: number) => (v === null ? null : v.toFixed(digits))
  const sys = of('systolic_bp')
  const dia = of('diastolic_bp')
  const bp = sys.length && dia.length ? `${Math.round(mean(sys)!)}/${Math.round(mean(dia)!)}` : null
  return [
    { key: 'bp', label: 'Avg BP', icon: Activity, value: bp, unit: 'mmHg', n: Math.min(sys.length, dia.length) },
    { key: 'glucose', label: 'Avg Blood Sugar', icon: Droplet, value: fmt(mean(of('blood_glucose')), 0), unit: 'mg/dL', n: of('blood_glucose').length },
    { key: 'hr', label: 'Avg Heart Rate', icon: HeartPulse, value: fmt(mean(of('heart_rate')), 0), unit: 'bpm', n: of('heart_rate').length },
    { key: 'spo2', label: 'Avg SpO₂', icon: Wind, value: fmt(mean(of('spo2')), 0), unit: '%', n: of('spo2').length },
    { key: 'temp', label: 'Avg Temperature', icon: Thermometer, value: fmt(mean(of('temperature')), 1), unit: '°C', n: of('temperature').length },
  ]
}

function AverageVitals({ patientId }: { patientId: string }) {
  const [win, setWin] = useState<WindowId>('6m')
  const q = useQuery({ queryKey: ['patient', patientId, 'observations', 'all'], queryFn: () => api<{ observations: Observation[] }>(`/patients/${patientId}/observations?limit=500`), staleTime: 30_000 })
  const days = WINDOWS.find((w) => w.id === win)!.days
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString()
  const tiles = q.data ? averageVitals(q.data.observations, since) : null
  const n = tiles ? Math.max(...tiles.map((t) => t.n)) : 0
  return (
    <Panel
      label="Average / Recent Vitals"
      icon={HeartPulse}
      testId="record-average-vitals"
      actions={
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="sr-only">Window</span>
          <select value={win} onChange={(e) => setWin(e.target.value as WindowId)} className="min-h-9 rounded-lg border border-line bg-surface px-2 text-sm text-ink">
            {WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {q.isPending && <LoadingState rows={1} label="Loading the vitals…" />}
      {q.isError && !q.data && <ErrorState title="The vitals could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {tiles && (
        <>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {tiles.map((t) => {
              const I = t.icon
              return (
                <li key={t.key} className="rounded-xl border border-line bg-canvas/60 px-3 py-2.5" data-testid={`avg-${t.key}`}>
                  <p className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
                    <I aria-hidden="true" className="size-3.5 text-brand" />
                    {t.label}
                  </p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {t.value ?? '—'}
                    {t.value && <span className="ml-1 text-xs font-normal text-ink-muted">{t.unit}</span>}
                  </p>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">{n ? `Averages of vitals recorded by staff at ${n === 1 ? 'one visit' : 'visits'} in this window. Device and simulated readings are not included.` : 'No vitals were recorded by staff in this window.'}</p>
        </>
      )}
    </Panel>
  )
}

function ActiveMedications({ h }: { h: PatientHistory }) {
  const current = h.medications.filter((m) => m.status === 'current')
  return (
    <Panel label="Active Medications" icon={Pill} testId="record-active-medications">
      {current.length ? (
        <ul className="divide-y divide-line">
          {current.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{[m.drugName, m.strength].filter(Boolean).join(' ')}</p>
                <p className="text-xs text-ink-muted">{[m.dose, m.frequency, m.reason].filter(Boolean).join(' · ')}</p>
              </div>
              <span className="shrink-0 text-xs text-ink-muted">{m.startedOn ? `since ${fmtDate(m.startedOn)}` : `updated ${fmtDate(m.enteredAt.slice(0, 10))}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <HeroEmpty>No current medicines on the list.</HeroEmpty>
      )}
    </Panel>
  )
}

function PatientInformation({ p, h }: { p: PatientDetail; h: PatientHistory }) {
  const last = h.consultations[0]
  return (
    <Panel label="Patient Information" icon={IdCard} testId="record-patient-information">
      <KeyValueList>
        <KeyValue label="Date of birth" value={`${fmtDate(p.dateOfBirth)}${p.dateOfBirthEstimated ? ' (estimated)' : ''}`} />
        <KeyValue label="Sex" value={SEX_LABELS[p.sex]} />
        <KeyValue label="Blood group" value={p.bloodGroup} missing="—" />
        <KeyValue label="Phone" value={p.phone} missing="—" />
        {(p.emergencyContactName || p.emergencyContactPhone) && <KeyValue label="Emergency contact" value={[p.emergencyContactName, p.emergencyContactPhone].filter(Boolean).join(' · ')} />}
        <KeyValue label="Registered" value={fmtDate(p.createdAt.slice(0, 10))} />
        <KeyValue label="Last consultation" value={last ? fmtDate(last.date) : null} missing="—" />
      </KeyValueList>
    </Panel>
  )
}

function RecentConsultationsTable({ h, onAll }: { h: PatientHistory; onAll: () => void }) {
  const rows = h.consultations.slice(0, 5)
  return (
    <Panel
      label="Recent Consultations"
      icon={Stethoscope}
      testId="record-recent-consultations"
      actions={
        h.consultations.length > 0 && (
          <button type="button" onClick={onAll} className="text-sm font-medium text-brand-strong hover:underline">
            View all
          </button>
        )
      }
    >
      {rows.length ? (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs text-ink-muted">
                <th scope="col" className="px-1 py-2 font-medium">Date</th>
                <th scope="col" className="px-1 py-2 font-medium">Reason</th>
                <th scope="col" className="px-1 py-2 font-medium">Diagnosis</th>
                <th scope="col" className="px-1 py-2 font-medium">Doctor</th>
                <th scope="col" className="px-1 py-2 font-medium"><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {rows.map((c) => (
                <tr key={c.encounterId} className="align-top">
                  <td className="px-1 py-2 whitespace-nowrap tabular-nums">{fmtDate(c.date)}</td>
                  <td className="px-1 py-2">{c.chiefComplaint || '—'}</td>
                  <td className="px-1 py-2">{c.diagnoses.map((d) => d.description).join('; ') || '—'}</td>
                  <td className="px-1 py-2 whitespace-nowrap">{plainName(c.doctorName) || '—'}</td>
                  <td className="px-1 py-2 text-right">
                    <Link to={`/doctor/encounters/${c.encounterId}`} className="font-medium text-brand-strong hover:underline">
                      View<span className="sr-only"> the consultation of {fmtDate(c.date)}</span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <HeroEmpty>No signed consultation yet.</HeroEmpty>
      )}
    </Panel>
  )
}

function Overview({ p, h, onTab }: { p: PatientDetail; h: PatientHistory; onTab: (t: PatientRecordTab) => void }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <div className="min-w-0 space-y-4 xl:col-span-8">
        <AverageVitals patientId={p.id} />
        <Panel label="Record summary" icon={ClipboardList} testId="record-summary-panel" actions={<SourceTag kind="record">From recorded consultations</SourceTag>}>
          <RecordLines lines={recordLines(h, localToday())} />
          <p className="mt-3 text-xs text-ink-muted">Composed by fixed rules from the record as of {fmtDateTime(h.generatedAt)}. Not AI-generated.</p>
        </Panel>
        <RecentConsultationsTable h={h} onAll={() => onTab('consultations')} />
      </div>
      <div className="min-w-0 space-y-4 xl:col-span-4">
        <PatientInformation p={p} h={h} />
        <ActiveMedications h={h} />
      </div>
    </div>
  )
}

function Prescriptions({ h }: { h: PatientHistory }) {
  const withRx = h.consultations.filter((c) => c.prescription.length)
  return (
    <Panel label="Prescriptions" icon={Pill} testId="record-prescriptions">
      {withRx.length ? (
        <ul className="divide-y divide-line">
          {withRx.map((c) => (
            <li key={c.encounterId} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {fmtDate(c.date)} <span className="font-normal text-ink-muted">· {[plainName(c.doctorName), c.diagnoses[0]?.description].filter(Boolean).join(' · ')}</span>
                </p>
                <a href={prescriptionPdfUrl(c.encounterId)} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas">
                  <Printer aria-hidden="true" className="size-4" />
                  PDF<span className="sr-only"> of the prescription of {fmtDate(c.date)} (opens a new tab)</span>
                </a>
              </div>
              <ul className="mt-1 space-y-0.5 text-sm">
                {c.prescription.map((r, i) => (
                  <li key={`${r.drugName}-${i}`}>
                    <span className="font-medium">{[r.drugName, r.strength].filter(Boolean).join(' ')}</span> <span className="text-ink-muted">· {[r.dose, r.frequency, r.duration].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <HeroEmpty>No prescriptions in the signed consultations.</HeroEmpty>
      )}
      <p className="mt-2 text-xs text-ink-muted">What was prescribed, not a record of what the patient takes.</p>
    </Panel>
  )
}

function LabReports({ h, onDocuments }: { h: PatientHistory; onDocuments: () => void }) {
  const docs = (h.documents?.latest ?? []).filter((d) => d.category === 'lab_report')
  return (
    <div className="space-y-4">
      <Panel label="Results" icon={FlaskConical} testId="record-lab-results">
        {h.investigations.length ? (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs text-ink-muted">
                  <th scope="col" className="px-1 py-2 font-medium">Test</th>
                  <th scope="col" className="px-1 py-2 font-medium">Result</th>
                  <th scope="col" className="px-1 py-2 font-medium">Reference</th>
                  <th scope="col" className="px-1 py-2 font-medium">Collected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {h.investigations.map((r) => (
                  <tr key={r.id}>
                    <td className="px-1 py-2 font-medium">{r.testName}</td>
                    <td className={`px-1 py-2 tabular-nums ${r.flag === 'high' || r.flag === 'low' || r.flag === 'abnormal' ? 'font-semibold text-pending' : ''}`}>
                      {r.valueText}
                      {r.unit ? ` ${r.unit}` : ''}
                      {r.flag === 'high' ? ' (high)' : r.flag === 'low' ? ' (low)' : ''}
                    </td>
                    <td className="px-1 py-2 text-ink-muted">{r.refText ?? (r.refLow !== null && r.refHigh !== null ? `${r.refLow}–${r.refHigh}` : '—')}</td>
                    <td className="px-1 py-2 whitespace-nowrap tabular-nums">{fmtDate(r.collectedOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <HeroEmpty>No results recorded.</HeroEmpty>
        )}
      </Panel>
      <Panel label="Lab report documents" icon={FileText} testId="record-lab-documents">
        {docs.length ? (
          <ul className="divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                <span className="text-sm font-medium">{d.title}</span>
                <span className="text-xs text-ink-muted">{d.studyDate ? fmtDate(d.studyDate) : fmtDate(d.createdAt.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <HeroEmpty>No lab report documents.</HeroEmpty>
        )}
        <button type="button" onClick={onDocuments} className="mt-2 text-sm font-medium text-brand-strong hover:underline">
          Open in Documents
        </button>
      </Panel>
    </div>
  )
}

function Imaging({ p, h, onDocuments }: { p: PatientDetail; h: PatientHistory; onDocuments: () => void }) {
  const docs = (h.documents?.latest ?? []).filter((d) => d.category === 'imaging_report' || d.category === 'imaging_image')
  return (
    <div className="space-y-4">
      <Panel label="Imaging studies" icon={Images} testId="record-imaging">
        {docs.length ? (
          <ul className="divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                <span className="text-sm">
                  <span className="font-medium">{d.title}</span>
                  {d.modality && <span className="ml-2 text-xs text-ink-muted uppercase">{d.modality}</span>}
                  {d.hasReportText && <span className="ml-2 text-xs text-ink-muted">· report on file</span>}
                </span>
                <span className="text-xs text-ink-muted">{d.studyDate ? fmtDate(d.studyDate) : fmtDate(d.createdAt.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <HeroEmpty>No imaging studies.</HeroEmpty>
        )}
        <button type="button" onClick={onDocuments} className="mt-2 text-sm font-medium text-brand-strong hover:underline">
          Open in Documents
        </button>
      </Panel>
      <Panel label="Thermal images" icon={Thermometer} bodyClassName="pb-1">
        <PatientThermalCard patient={p} />
      </Panel>
    </div>
  )
}

function Header({ p, h, embedded }: { p: PatientDetail; h: PatientHistory | undefined; embedded: boolean }) {
  const active = p.allergies.filter((a) => a.status === 'active')
  const conditions = [...new Set((h?.conditions ?? []).filter((c) => c.status === 'active' || c.status === 'controlled').map((c) => conditionBadge(c.name)))].slice(0, 3)
  const Title = embedded ? 'h2' : 'h1'
  return (
    <header className="mb-4 flex items-start gap-4 rounded-2xl border border-line/80 bg-surface p-4 shadow-card xl:p-5" data-testid="patient-header">
      <PatientAvatar name={p.fullName} size="lg" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Title className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{p.fullName}</Title>
          <ul aria-label="Allergies" className="flex flex-wrap gap-1.5">
            {active.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1 rounded-full border border-down/25 bg-down-soft px-2 py-0.5 text-xs font-semibold text-down">
                <TriangleAlert aria-hidden="true" className="size-3" />
                Allergy: {a.substance} ({SEVERITY[a.severity]})
              </li>
            ))}
            {!active.length && <li className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-muted">{p.noKnownAllergies ? 'No known allergies' : 'Allergy status not recorded'}</li>}
          </ul>
          {conditions.length > 0 && (
            <ul aria-label="Conditions" className="flex flex-wrap gap-1.5" data-testid="record-condition-badges">
              {conditions.map((n) => (
                <li key={n} className="rounded-full border border-pending/25 bg-pending-soft px-2 py-0.5 text-xs font-medium text-pending">
                  {n}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-sm text-ink-muted">
          {ageSex(p)} · MRN <span className="font-mono text-ink">{p.mrn}</span>
          {p.phone && <> · {p.phone}</>}
        </p>
      </div>
    </header>
  )
}

/**
 * The patient record (jury design, screen 2): the header (avatar, name, allergy and condition badges, age · sex · MRN · phone), then the tabs
 * Overview (average staff vitals, the record summary by fixed rules, recent consultations, patient information, active medications) ·
 * Consultations · Prescriptions · Lab Reports · Imaging · Documents · Surgeries · Allergies & Medications. Only the open tab is mounted, so
 * each part of the record is read (and audited) when it is looked at. Nothing here is AI-generated. `tab`/`onTabChange` let the page keep the
 * tab in its address; without them the view keeps it itself (starting on `initialTab`).
 */
export function PatientRecordView({ patientId, initialTab = 'overview', embedded = false, tab: controlled, onTabChange }: { patientId: string; initialTab?: PatientRecordTab; encounterId?: string; embedded?: boolean; tab?: PatientRecordTab; onTabChange?: (t: PatientRecordTab) => void }) {
  const [own, setOwn] = useState<PatientRecordTab>(initialTab)
  const tab = controlled ?? own
  const setTab = (t: PatientRecordTab) => (onTabChange ? onTabChange(t) : setOwn(t))
  const pq = usePatient(patientId)
  const hq = usePatientHistory(patientId)
  const { data: me } = useMe()
  if (pq.isPending) return <LoadingState rows={4} label="Loading the patient…" />
  if (!pq.data) return <ErrorState title="The patient could not be loaded" error={pq.error} onRetry={() => void pq.refetch()} retrying={pq.isFetching} />
  const p = pq.data
  const h = hq.data
  const prefix = `record-${p.id}`
  const needsHistory = tab !== 'documents' && tab !== 'allergies_medications'
  const content = () => (
    <>
          {needsHistory && hq.isPending && <LoadingState rows={4} label="Loading the record…" />}
          {needsHistory && !h && hq.isError && <ErrorState title="The record could not be loaded" error={hq.error} onRetry={() => void hq.refetch()} retrying={hq.isFetching} />}
          {tab === 'overview' && h && <Overview p={p} h={h} onTab={setTab} />}
          {tab === 'consultations' && h && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
              <Panel label="Signed consultations" icon={Stethoscope} className="xl:col-span-7" testId="record-consultations">
                {h.consultations.length ? (
                  <ul className="divide-y divide-line">
                    {h.consultations.map((c) => (
                      <ConsultationSummary key={c.encounterId} c={c} />
                    ))}
                  </ul>
                ) : (
                  <HeroEmpty>No signed consultation yet.</HeroEmpty>
                )}
              </Panel>
              <div className="xl:col-span-5">
                <ConsultationTimeline patientId={p.id} />
              </div>
            </div>
          )}
          {tab === 'prescriptions' && h && <Prescriptions h={h} />}
          {tab === 'labs' && h && <LabReports h={h} onDocuments={() => setTab('documents')} />}
          {tab === 'imaging' && h && <Imaging p={p} h={h} onDocuments={() => setTab('documents')} />}
          {tab === 'documents' && <PatientDocumentsTab p={p} />}
          {tab === 'surgeries' && h && (
            <Panel label="Surgeries and procedures" icon={Scissors} testId="record-surgeries">
              <SurgeriesSection h={h} patientId={p.id} canWrite={me?.role === 'doctor'} />
            </Panel>
          )}
          {tab === 'allergies_medications' && (
            <Panel label="Allergies, conditions and medicines" icon={Pill} testId="record-allergies-medications">
              <PastHistoryPanel idScope="record" patientId={p.id} bare />
            </Panel>
          )}
    </>
  )
  return (
    <div data-testid="patient-record-view">
      <Header p={p} h={h} embedded={embedded} />
      <Tabs label="Patient record" prefix={prefix} tabs={TABS} value={tab} onChange={setTab} className="mb-4 overflow-x-auto" />
      {TABS.map((t) => (
        <TabPanel key={t.id} prefix={prefix} id={t.id} active={tab === t.id} focusable={false}>
          {tab === t.id && content()}
        </TabPanel>
      ))}
    </div>
  )
}
