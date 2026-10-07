import { type PatientDetail, type PriorConsultation, SEX_LABELS, VISIT_STATUS_LABELS, type VisitStatus } from '@adaxai/contracts'
import { CalendarClock, ChevronDown, ClipboardList, ExternalLink, FileHeart, IdCard, Images, Printer, ShieldCheck, Stethoscope } from 'lucide-react'
import { Link } from 'react-router'
import { useTimeline } from '../../lib/encounters.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import { usePatientHistory } from '../../lib/history.ts'
import { localToday, recordLines } from '../../lib/patientRecord.ts'
import { PatientThermalCard } from '../../pages/clinical/ThermalPages.tsx'
import { AuscultationCard } from '../clinical/AuscultationCard.tsx'
import { ClinicalImagesCard } from '../clinical/ClinicalImagesCard.tsx'
import { ConsentsCard } from '../clinical/ConsentsCard.tsx'
import { PastHistoryPanel } from '../clinical/PastHistory.tsx'
import { HeroEmpty, KeyValue, KeyValueList, Panel, SECTION_LABEL, SourceTag } from '../hero/index.ts'
import { Badge, ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { CardFrameContext } from '../ui/Layout.tsx'
import { PatientDocumentsPanel } from './DocumentsList.tsx'
import { RecordLines } from './RecordLines.tsx'

/*
 * The three tabs of the doctor's patient page (DESIGN §5.3): Summary (the record in compact lines and the last consultations with their
 * prescriptions), Details (the full history, the consultation timeline, the patient's details, consents collapsed) and Documents (documents,
 * thermal images, photographs, stethoscope recordings). The page mounts only the open tab, so each list is read (and audited) when it is seen.
 */

/** A person's name without the marker the synthetic dataset adds to it. */
const person = (name: string | null) => name?.replace(/\s*\(synthetic\)$/i, '') ?? null

const medLine = (r: PriorConsultation['prescription'][number]) => [[r.drugName, r.strength].filter(Boolean).join(' '), r.dose, r.frequency, r.duration, r.instructions].filter(Boolean).join(' · ')

/** How many earlier consultations the Summary shows. */
const SUMMARY_CONSULTATIONS = 3

const linkClass = 'inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas'

export function ConsultationSummary({ c }: { c: PriorConsultation }) {
  return (
    <li className="py-3 first:pt-0" data-testid="summary-consultation">
      <div className="flex flex-wrap items-start justify-between gap-x-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {fmtDate(c.date)}
            <span className="ml-2 font-normal text-ink-muted">{[person(c.doctorName), c.departmentName].filter(Boolean).join(' · ')}</span>
          </p>
          <p className="text-sm [overflow-wrap:anywhere]">{c.chiefComplaint || 'No reason recorded'}</p>
        </div>
        <div className="-mr-2 flex shrink-0 items-center">
          <Link to={`/doctor/encounters/${c.encounterId}`} className={linkClass}>
            <ExternalLink aria-hidden="true" className="size-4" />
            Open<span className="sr-only"> the consultation of {fmtDate(c.date)}</span>
          </Link>
          <a href={`/print/encounters/${c.encounterId}`} target="_blank" rel="noreferrer" className={linkClass}>
            <Printer aria-hidden="true" className="size-4" />
            Print<span className="sr-only"> the prescription of {fmtDate(c.date)} (opens a new tab)</span>
          </a>
        </div>
      </div>
      {c.diagnoses.length > 0 && <p className="mt-1 text-sm"><span className="text-ink-muted">Diagnosis: </span>{c.diagnoses.map((d) => d.description).join('; ')}</p>}
      {c.prescription.length ? (
        <ul className="mt-1.5 space-y-0.5 text-sm" aria-label={`Prescribed on ${fmtDate(c.date)}`}>
          {c.prescription.map((r, i) => (
            <li key={`${r.drugName}-${i}`} className="[overflow-wrap:anywhere]">
              {medLine(r)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-ink-muted">Nothing was prescribed.</p>
      )}
      {c.amendmentCount > 0 && <p className="mt-1 text-xs text-ink-muted">{c.amendmentCount} amendment{c.amendmentCount === 1 ? '' : 's'}</p>}
    </li>
  )
}

/** Summary (the default tab): the record in compact lines "From the record" (with the last vitals), and the last consultations with what was prescribed. */
export function PatientSummaryTab({ patientId, onShowDetails }: { patientId: string; onShowDetails: () => void }) {
  const q = usePatientHistory(patientId)
  const h = q.data
  if (q.isPending) return <LoadingState rows={4} label="Loading the record…" />
  if (!h) return <ErrorState title="The record could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
  const shown = h.consultations.slice(0, SUMMARY_CONSULTATIONS)
  const more = h.consultations.length - shown.length + h.more.consultations
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
      <Panel label="Record summary" icon={ClipboardList} className="xl:col-span-5" testId="patient-record-summary" actions={<SourceTag kind="record" />}>
        {q.isError && <p className="mb-2 text-xs text-pending">The latest update failed, so this may be out of date.</p>}
        <RecordLines lines={recordLines(h, localToday(), { vitals: true })} />
        <p className="mt-3 text-xs text-ink-muted">Composed by fixed rules from entries typed in by staff and signed consultations, as of {fmtDateTime(h.generatedAt)}. Not AI-generated.</p>
      </Panel>
      <Panel label="Recent consultations" icon={Stethoscope} className="xl:col-span-7" testId="patient-recent-consultations">
        {shown.length ? (
          <ul className="divide-y divide-line">
            {shown.map((c) => (
              <ConsultationSummary key={c.encounterId} c={c} />
            ))}
          </ul>
        ) : (
          <HeroEmpty>No signed consultation yet.</HeroEmpty>
        )}
        {more > 0 && (
          <p className="mt-2 text-sm">
            <button type="button" onClick={onShowDetails} className="min-h-11 font-medium text-brand-strong hover:underline">
              {more} earlier consultation{more === 1 ? '' : 's'} in Details
            </button>
          </p>
        )}
        <p className="mt-2 text-xs text-ink-muted">What was prescribed, not a record of what the patient takes.</p>
      </Panel>
    </div>
  )
}

/** The consultation timeline: every visit, newest first, with its signed consultation's diagnoses and medicines and a link to open it. */
export function ConsultationTimeline({ patientId }: { patientId: string }) {
  const q = useTimeline(patientId)
  return (
    <Panel label="Consultation timeline" icon={CalendarClock} testId="patient-timeline">
      {q.isPending && <LoadingState rows={2} label="Loading the timeline…" />}
      {q.isError && !q.data && <ErrorState title="The timeline could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.data && !q.data.length && <HeroEmpty>No visits yet.</HeroEmpty>}
      {q.data && q.data.length > 0 && (
        <ol className="divide-y divide-line">
          {q.data.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2.5 first:pt-0">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>
                    {fmtDate(t.date)} · {t.title}
                  </span>
                  {t.kind === 'encounter' ? t.status === 'signed' ? <Badge tone="ok">Signed</Badge> : <Badge tone="warn">Draft</Badge> : <Badge>{VISIT_STATUS_LABELS[t.status as VisitStatus] ?? t.status}</Badge>}
                  {t.amendmentCount > 0 && <Badge tone="notice">{t.amendmentCount} amendment{t.amendmentCount > 1 ? 's' : ''}</Badge>}
                </p>
                <p className="text-xs text-ink-muted">{[t.departmentName, person(t.doctorName)].filter(Boolean).join(' · ')}</p>
                {t.diagnoses.length > 0 && <p className="text-sm"><span className="text-ink-muted">Diagnosis: </span>{t.diagnoses.join('; ')}</p>}
                {t.medications.length > 0 && <p className="text-sm"><span className="text-ink-muted">Medicines: </span>{t.medications.join(', ')}</p>}
              </div>
              {t.encounterId && (
                <Link to={`/doctor/encounters/${t.encounterId}`} className={`${linkClass} -mr-2`}>
                  Open<span className="sr-only"> the consultation of {fmtDate(t.date)}</span>
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

/** Details: the full history (with surgeries), the consultation timeline, who the patient is, and the consents (collapsed). */
export function PatientDetailsTab({ p }: { p: PatientDetail }) {
  const granted = p.consentStates.filter((c) => c.state === 'granted' || c.state === 'outdated').length
  return (
    <div className="space-y-4">
      <Panel label="Medical history" icon={FileHeart} testId="patient-medical-history">
        <PastHistoryPanel idScope="page" patientId={p.id} bare />
      </Panel>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <ConsultationTimeline patientId={p.id} />
        </div>
        <Panel label="Patient details" icon={IdCard} className="xl:col-span-5" testId="patient-details">
          <KeyValueList>
            <KeyValue label="Date of birth" value={`${fmtDate(p.dateOfBirth)}${p.dateOfBirthEstimated ? ' (estimated)' : ''}`} />
            <KeyValue label="Sex" value={SEX_LABELS[p.sex]} />
            <KeyValue label="Phone" value={p.phone} />
            <KeyValue label="Email" value={p.email} />
            <KeyValue label="Address" value={[p.addressLine, p.city, p.state, p.postalCode].filter(Boolean).join(', ')} />
            <KeyValue label="ABHA number" value={p.abhaNumber ? `${p.abhaNumber} (not verified)` : null} />
            <KeyValue label="Blood group" value={p.bloodGroup} />
            <KeyValue label="Preferred language" value={p.preferredLanguage} />
            <KeyValue label="Emergency contact" value={[p.emergencyContactName, p.emergencyContactPhone].filter(Boolean).join(' · ')} />
            <KeyValue label="Registered" value={fmtDateTime(p.createdAt)} />
          </KeyValueList>
        </Panel>
      </div>
      <details className="group rounded-xl border border-line bg-surface" data-testid="patient-consents">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 xl:px-5">
          <span className={`flex items-center gap-2 ${SECTION_LABEL}`}>
            <ShieldCheck aria-hidden="true" className="size-4 text-ink-muted" />
            Consents
          </span>
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            {granted} of {p.consentStates.length} granted
            <ChevronDown aria-hidden="true" className="size-4 transition-transform motion-safe:duration-150 group-open:rotate-180" />
          </span>
        </summary>
        {/* Drawn flat: a line under the summary, never a card inside this box. */}
        <CardFrameContext.Provider value="flat">
          <ConsentsCard p={p} />
        </CardFrameContext.Provider>
      </details>
    </div>
  )
}

/** Documents: the patient's documents (grouped, with upload), then thermal images, clinical photographs and stethoscope recordings. */
export function PatientDocumentsTab({ p }: { p: PatientDetail }) {
  return (
    <div className="space-y-4">
      <PatientDocumentsPanel patientId={p.id} />
      <Panel label="Images and recordings" icon={Images} bodyClassName="pb-1" testId="patient-images-recordings">
        <PatientThermalCard patient={p} />
        <ClinicalImagesCard patientId={p.id} />
        <AuscultationCard patientId={p.id} />
      </Panel>
    </div>
  )
}
