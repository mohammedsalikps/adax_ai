import { type Encounter, type NoteFields, SEX_LABELS } from '@adaxai/contracts'
import { FileText } from 'lucide-react'
import { useId } from 'react'
import type { Draft } from '../../lib/draftSaver.ts'
import { ageFrom, fmtDate } from '../../lib/format.ts'
import { AllergyItems } from '../clinical/AllergyItems.tsx'
import { Panel, PanelGroup, SECTION_LABEL } from '../hero/Panel.tsx'
import { OrderServiceButton } from '../orders/OrderServiceButton.tsx'
import { ServiceOrdersList } from '../orders/ServiceOrdersList.tsx'
import { type AllergyNameCheck, BeforeYouPrescribe } from './BeforeYouPrescribe.tsx'
import { DiagnosesEditor, MedicinesEditor, MedicinesList } from './MedicinesEditor.tsx'
import { noteAreaMode } from './rxModel.ts'

/** "34 y · Female" from the date of birth (estimated dates say so). */
export const ageSex = (p: Pick<Encounter['patient'], 'dateOfBirth' | 'dateOfBirthEstimated' | 'sex'>) => `${ageFrom(p.dateOfBirth)} y${p.dateOfBirthEstimated ? ' (estimated)' : ''} · ${SEX_LABELS[p.sex]}`

/**
 * The prescription as a document (DESIGN §5.6, right column): who writes it and for whom (clinic, doctor and registration number, date;
 * patient, age, sex, MRN; allergies), the diagnosis, the medicines, "Before you prescribe", advice and diet (the note's Plan), follow-up, and
 * this consultation's orders. Editable while it is the doctor's draft (`onChange`, with the fixed rules' allergy name check of the page:
 * `allergy`); read as a document once signed. While reviewed AI text is being inserted into the note (`inserting`), the note's parts here
 * (advice and diet, follow-up) are read-only, as the clinical note is, so nothing typed meanwhile is replaced by the server's note.
 */
export function PrescriptionDocument({
  encounter,
  draft,
  onChange,
  locked = false,
  inserting = false,
  allergy,
}: {
  encounter: Encounter
  draft: Draft
  onChange?: (fn: (d: Draft) => Draft) => void
  locked?: boolean
  inserting?: boolean
  allergy?: AllergyNameCheck
}) {
  const e = encounter
  const editable = !!onChange
  const mode = noteAreaMode({ editable, locked, inserting })
  const readOnly = mode === 'document'
  const frozen = mode === 'frozen'
  const setNote = (key: keyof NoteFields, value: string) => onChange?.((d) => ({ ...d, note: { ...d.note, [key]: value } }))
  return (
    <Panel label="Prescription" icon={FileText} testId="prescription-document">
      <div className="space-y-3 text-sm" data-testid="prescription-header-block">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <p className="text-base font-semibold">{e.facilityName}</p>
            <p>{e.doctor.fullName}</p>
            <p className="text-ink-muted">{e.doctor.registrationNumber ? `Registration no. ${e.doctor.registrationNumber}` : 'Registration no. not recorded'}</p>
          </div>
          <p className="tabular-nums">
            <span className="text-ink-muted">Date </span>
            {fmtDate(e.visit.visitDate)}
          </p>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t border-line pt-3">
          <p className="font-semibold">{e.patient.fullName}</p>
          <p className="text-ink-muted">
            {ageSex(e.patient)} · MRN <span className="font-mono text-ink">{e.patient.mrn}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="prescription-allergies">
          <p className="font-medium">Allergies on record</p>
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies on record">
            <AllergyItems encounter={e} />
          </ul>
        </div>
      </div>
      <PanelGroup label="Diagnosis">
        {!editable ? (
          <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="rx-diagnoses-signed">
            {draft.diagnoses.map((d, i) => (
              <li key={i}>
                {d.description} {d.code && <span className="font-mono">({d.code})</span>} <span className="text-ink-muted">· {d.kind}</span>
              </li>
            ))}
          </ul>
        ) : (
          <DiagnosesEditor items={draft.diagnoses} readOnly={locked} onChange={(diagnoses) => onChange?.((d) => ({ ...d, diagnoses }))} />
        )}
      </PanelGroup>
      <PanelGroup label="Medicines">
        {!editable ? (
          <MedicinesList items={draft.prescription} visitDate={e.visit.visitDate} />
        ) : (
          <MedicinesEditor items={draft.prescription} readOnly={locked} patientId={e.patient.id} visitDate={e.visit.visitDate} onChange={(prescription) => onChange?.((d) => ({ ...d, prescription }))} />
        )}
      </PanelGroup>
      {editable && allergy && (
        <PanelGroup label="Before you prescribe">
          <BeforeYouPrescribe encounterId={e.id} allergy={allergy} locked={locked} />
        </PanelGroup>
      )}
      <NoteArea label="Advice / diet" value={draft.note.plan} readOnly={readOnly} frozen={frozen} onChange={(v) => setNote('plan', v)} testId="rx-advice" rows={4} placeholder="Diet, rest, fluids, what to watch for" />
      <NoteArea label="Follow-up" value={draft.note.followUp} readOnly={readOnly} frozen={frozen} onChange={(v) => setNote('followUp', v)} testId="rx-follow-up" rows={2} placeholder="Review in 5 days, or sooner if…" />
      <PanelGroup label="Orders" actions={e.status === 'in_progress' && e.canEdit ? <OrderServiceButton encounterId={e.id} patientId={e.patient.id} /> : undefined}>
        <ServiceOrdersList encounterId={e.id} patientId={e.patient.id} />
      </PanelGroup>
    </Panel>
  )
}

/**
 * A part of the document that is one of the note's sections, labelled like a section of the panel (its label names the field). `readOnly`:
 * read as a document; `frozen`: the field stays where it is but takes no typing for now (an insertion into the note is running).
 */
function NoteArea({
  label,
  value,
  readOnly,
  frozen,
  onChange,
  testId,
  rows,
  placeholder,
}: {
  label: string
  value: string
  readOnly: boolean
  frozen: boolean
  onChange: (v: string) => void
  testId: string
  rows: number
  placeholder: string
}) {
  const id = useId()
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid={testId}>
      {readOnly ? (
        <>
          <p className={`mb-2 ${SECTION_LABEL}`}>{label}</p>
          <p className="text-sm whitespace-pre-wrap">{value || <span className="text-ink-muted">Not recorded</span>}</p>
        </>
      ) : (
        <>
          <label htmlFor={id} className={`mb-2 block ${SECTION_LABEL}`}>
            {label}
          </label>
          <textarea
            id={id}
            rows={rows}
            value={value}
            readOnly={frozen}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="block w-full rounded-md border border-control bg-surface px-3 py-2 text-sm leading-relaxed text-ink shadow-card placeholder:text-ink-muted/70"
          />
        </>
      )}
    </div>
  )
}
