import { type Encounter, type NoteFields, SEX_LABELS } from '@adaxai/contracts'
import { Check, Lightbulb, Pencil } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import type { Draft } from '../../lib/draftSaver.ts'
import { plainName } from '../../lib/displayName.ts'
import { ageFrom, fmtDate } from '../../lib/format.ts'
import { AllergyItems } from '../clinical/AllergyItems.tsx'
import { OrderServiceButton } from '../orders/OrderServiceButton.tsx'
import { ServiceOrdersList } from '../orders/ServiceOrdersList.tsx'
import { type AllergyNameCheck, BeforeYouPrescribe } from './BeforeYouPrescribe.tsx'
import { DiagnosesEditor, MedicinesEditor, MedicinesList } from './MedicinesEditor.tsx'
import { noteAreaMode } from './rxModel.ts'

/** "34 y · Female" from the date of birth (estimated dates say so). */
export const ageSex = (p: Pick<Encounter['patient'], 'dateOfBirth' | 'dateOfBirthEstimated' | 'sex'>) => `${ageFrom(p.dateOfBirth)} y${p.dateOfBirthEstimated ? ' (estimated)' : ''} · ${SEX_LABELS[p.sex]}`

/** A sign issue in words, for the section it belongs to (from contracts' signIssues). */
export interface SignIssue {
  path: string
  message: string
}

/**
 * A diagnosis to offer when there is none (premium design): the first line of the doctor's own Assessment, which the doctor accepts or not
 * ("Use as diagnosis"). Never added by itself and never signed empty: the doctor's act puts it in the draft, editable like any row.
 */
export function diagnosisSuggestion(assessment: string): string | null {
  const first = assessment
    .split(/\n|(?<=[.;])\s+/)
    .map((x) => x.trim())
    .find(Boolean)
  if (!first) return null
  const text = first.replace(/[.;:]+$/, '').trim()
  return text.length >= 3 && text.length <= 160 ? text : null
}

/** One part of the prescription document: a title, an optional action (Edit / Done), what the signing rules still need here, the content. */
function DocSection({ title, action, issues = [], children, testId }: { title: string; action?: ReactNode; issues?: SignIssue[]; children: ReactNode; testId?: string }) {
  return (
    <section className="border-t border-line/70 py-4 first:border-t-0 first:pt-0" aria-label={title} data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {issues.length > 0 && (
        <ul className="mb-2 space-y-0.5 rounded-lg bg-pending-soft/70 px-3 py-2 text-xs font-medium text-pending" data-testid="rx-section-issues">
          {issues.map((i) => (
            <li key={i.path}>{i.message}</li>
          ))}
        </ul>
      )}
      {children}
    </section>
  )
}

const editButton = (editing: boolean, onClick: () => void, what: string, disabled = false) => (
  <button type="button" onClick={onClick} disabled={disabled} className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-brand-strong hover:bg-brand-soft disabled:text-ink-muted" data-testid={`rx-edit-${what}`}>
    {editing ? <Check aria-hidden="true" className="size-3.5" /> : <Pencil aria-hidden="true" className="size-3.5" />}
    {editing ? 'Done' : 'Edit'}
    <span className="sr-only"> {what}</span>
  </button>
)

/**
 * The prescription as a document (premium design: the visual hero of the page): the letterhead (clinic, doctor, registration number, date), the
 * patient and the allergies beside the body: diagnosis, medications, "Before you prescribe" (the fixed rules' allergy check), advice and diet (the
 * note's Plan), follow-up, and this consultation's orders. While it is the doctor's draft every part is editable: a part with content reads as the
 * finished document with [Edit]; an empty part opens as its editor. With no diagnosis, the first line of the doctor's own Assessment is offered as
 * one (the doctor's act adds it). What the signing rules still need is said in the part it concerns (`issues`). Read as a document once signed.
 * While reviewed AI text is being inserted into the note (`inserting`), advice and follow-up are read-only, as the clinical note is.
 */
export function PrescriptionDocument({
  encounter,
  draft,
  onChange,
  locked = false,
  inserting = false,
  allergy,
  issues = [],
}: {
  encounter: Encounter
  draft: Draft
  onChange?: (fn: (d: Draft) => Draft) => void
  locked?: boolean
  inserting?: boolean
  allergy?: AllergyNameCheck
  issues?: SignIssue[]
}) {
  const e = encounter
  const editable = !!onChange
  const mode = noteAreaMode({ editable, locked, inserting })
  const readOnly = mode === 'document'
  const frozen = mode === 'frozen'
  const setNote = (key: keyof NoteFields, value: string) => onChange?.((d) => ({ ...d, note: { ...d.note, [key]: value } }))
  // A part with content reads as the document; an empty one opens as its editor (and stays open while the doctor works in it).
  // A diagnosis row without words (never signed: the rules refuse it) opens the editor too, never reads as finished text.
  const [editDx, setEditDx] = useState(() => !draft.diagnoses.length || draft.diagnoses.some((d) => !(d.description ?? '').trim()))
  const [editRx, setEditRx] = useState(() => draft.prescription.length === 0)
  const dxIssues = issues.filter((i) => i.path.startsWith('diagnoses'))
  const rxIssues = issues.filter((i) => i.path.startsWith('prescription'))
  const otherIssues = issues.filter((i) => !i.path.startsWith('diagnoses') && !i.path.startsWith('prescription'))
  const hasDiagnosis = draft.diagnoses.some((d) => (d.description ?? '').trim())
  const suggestion = editable && !locked && !hasDiagnosis ? diagnosisSuggestion(draft.note.assessment) : null
  const useSuggestion = () => {
    if (!suggestion) return
    onChange?.((d) => ({ ...d, diagnoses: [...d.diagnoses.filter((x) => (x.description ?? '').trim()), { description: suggestion, code: null, kind: 'primary' }] }))
    setEditDx(true)
  }
  return (
    <article className="overflow-hidden rounded-2xl border border-line/80 bg-surface shadow-card" data-testid="prescription-document" aria-label="Prescription">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line/70 bg-gradient-to-br from-brand-soft/60 to-surface px-6 py-5" data-testid="prescription-header-block">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-indigo-600 text-lg font-bold text-white">
            A
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-sm font-bold tracking-wide uppercase">{plainName(e.facilityName)}</p>
            <p className="mt-0.5 text-sm font-medium">{plainName(e.doctor.fullName)}</p>
            <p className="text-xs text-ink-muted">
              {e.visit.departmentName} · {e.doctor.registrationNumber ? `Reg. no. ${e.doctor.registrationNumber}` : 'Registration no. not recorded'}
            </p>
          </div>
        </div>
        <p className="text-right text-xs text-ink-muted tabular-nums">
          Date
          <span className="block text-sm font-medium text-ink">{fmtDate(e.visit.visitDate)}</span>
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-4 border-b border-line/70 px-6 py-5 md:border-r md:border-b-0" aria-label="Patient">
          <div>
            <p className="font-semibold">{e.patient.fullName}</p>
            <p className="text-sm text-ink-muted">{ageSex(e.patient)}</p>
            <p className="text-sm text-ink-muted">
              MRN <span className="font-mono text-ink">{e.patient.mrn}</span>
            </p>
          </div>
          <div data-testid="prescription-allergies">
            <p className="mb-1.5 text-xs font-semibold text-ink-muted">Allergies</p>
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies on record">
              <AllergyItems encounter={e} />
            </ul>
          </div>
          {otherIssues.length > 0 && (
            <ul className="space-y-0.5 rounded-lg bg-pending-soft/70 px-3 py-2 text-xs font-medium text-pending" data-testid="rx-other-issues">
              {otherIssues.map((i) => (
                <li key={i.path}>{i.message}</li>
              ))}
            </ul>
          )}
        </aside>
        <div className="min-w-0 px-6 py-5">
          <DocSection title="Diagnosis" issues={dxIssues} action={editable && hasDiagnosis && !locked ? editButton(editDx, () => setEditDx((v) => !v), 'diagnosis') : undefined}>
            {suggestion && (
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed border-brand/40 bg-brand-soft/50 px-3 py-2.5" data-testid="rx-diagnosis-suggestion">
                <Lightbulb aria-hidden="true" className="size-4 shrink-0 text-brand" />
                <p className="min-w-0 flex-1 text-sm">
                  <span className="block text-xs font-medium text-ink-muted">Suggested from your assessment · draft</span>
                  <span className="font-medium">{suggestion}</span>
                </p>
                <button type="button" onClick={useSuggestion} className="inline-flex min-h-8 items-center rounded-lg bg-brand px-3 text-xs font-semibold text-white hover:bg-brand-strong" data-testid="rx-use-diagnosis">
                  Use as diagnosis
                </button>
              </div>
            )}
            {!editable || !editDx ? (
              draft.diagnoses.length ? (
                <ul className="space-y-1 text-sm" data-testid="rx-diagnoses-signed">
                  {draft.diagnoses.map((d, i) => (
                    <li key={i}>
                      <span className="font-medium">{d.description}</span> {d.code && <span className="font-mono text-ink-muted">({d.code})</span>} <span className="text-ink-muted">· {d.kind}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">No diagnosis recorded.</p>
              )
            ) : (
              <DiagnosesEditor items={draft.diagnoses} readOnly={locked} onChange={(diagnoses) => onChange?.((d) => ({ ...d, diagnoses }))} />
            )}
          </DocSection>
          <DocSection title="Medications" issues={rxIssues} action={editable && draft.prescription.length > 0 && !locked ? editButton(editRx, () => setEditRx((v) => !v), 'medications') : undefined}>
            {!editable || !editRx ? (
              <MedicinesList items={draft.prescription} visitDate={e.visit.visitDate} />
            ) : (
              <MedicinesEditor items={draft.prescription} readOnly={locked} patientId={e.patient.id} visitDate={e.visit.visitDate} onChange={(prescription) => onChange?.((d) => ({ ...d, prescription }))} />
            )}
          </DocSection>
          {editable && allergy && (
            <DocSection title="Before you prescribe">
              <BeforeYouPrescribe encounterId={e.id} allergy={allergy} locked={locked} />
            </DocSection>
          )}
          <NoteArea label="Advice / diet" value={draft.note.plan} readOnly={readOnly} frozen={frozen} onChange={(v) => setNote('plan', v)} testId="rx-advice" rows={3} placeholder="Diet, rest, fluids, what to watch for" />
          <NoteArea label="Follow-up" value={draft.note.followUp} readOnly={readOnly} frozen={frozen} onChange={(v) => setNote('followUp', v)} testId="rx-follow-up" rows={2} placeholder="Review in 5 days, or sooner if…" />
          <DocSection title="Orders" action={e.status === 'in_progress' && e.canEdit ? <OrderServiceButton encounterId={e.id} patientId={e.patient.id} /> : undefined}>
            <ServiceOrdersList encounterId={e.id} patientId={e.patient.id} />
          </DocSection>
          <div className="mt-2 flex items-end justify-end border-t border-line/70 pt-6">
            <div className="w-52 border-t border-ink/60 pt-1.5 text-right text-xs">
              <p className="font-semibold text-ink">{plainName(e.doctor.fullName)}</p>
              <p className="text-ink-muted">{e.signedAt ? `Signed electronically · ${fmtDate(e.signedAt.slice(0, 10))}` : 'Doctor’s signature'}</p>
            </div>
          </div>
        </div>
      </div>
    </article>
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
    <div className="border-t border-line/70 py-4" data-testid={testId}>
      {readOnly ? (
        <>
          <p className="mb-2 text-sm font-semibold text-ink">{label === 'Advice / diet' ? 'Advice' : label}</p>
          <p className="text-sm whitespace-pre-wrap">{value || <span className="text-ink-muted">Not recorded</span>}</p>
        </>
      ) : (
        <>
          <label htmlFor={id} className="mb-2 block text-sm font-semibold text-ink">
            {label}
          </label>
          <textarea
            id={id}
            rows={rows}
            value={value}
            readOnly={frozen}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="block w-full resize-y rounded-lg border border-transparent bg-canvas/70 px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-muted/70 hover:border-line focus:border-brand/50 focus:bg-surface focus:outline-none"
          />
        </>
      )}
    </div>
  )
}
