import { type Encounter, NOTE_SECTIONS, type NoteInsertion, signIssues } from '@adaxai/contracts'
import { useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import type { Draft } from '../../lib/draftSaver.ts'
import { fmtDate } from '../../lib/format.ts'
import { durationLines } from '../../lib/prescriptionCourse.ts'
import { AllergyItems } from '../clinical/AllergyItems.tsx'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { CheckboxField } from '../ui/Form.tsx'
import { AiProvenance } from './AiProvenance.tsx'
import { courseStart } from './rxModel.ts'

/**
 * "Review and sign" (the consultation and the prescription page): what will be signed (the note, the diagnosis, the prescription with each
 * medicine's course, the AI-assisted text and its sources), what is still missing, and the doctor's attestation. Its button is "Sign": signing
 * freezes the record; it does NOT complete the consultation (that is a separate, explicit act afterwards: Complete consultation). `allergyNote`:
 * what the fixed rules' allergy name check found, or that it could not check the medicines (rxModel allergyReviewNote); nothing when clear.
 */
export function ReviewAndSignDialog({
  draft,
  encounter,
  insertions,
  allergyNote = null,
  onClose,
  onSign,
  signing,
  error,
}: {
  draft: Draft
  encounter: Encounter
  insertions: NoteInsertion[]
  allergyNote?: { tone: 'error' | 'warning'; text: string } | null
  onClose: () => void
  onSign: () => void
  signing: boolean
  error: unknown
}) {
  const [attest, setAttest] = useState(false)
  const issues = signIssues(draft)
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      dismissible={!signing}
      title="Review and sign"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={signing}>
            Back to editing
          </Button>
          <Button onClick={onSign} disabled={!attest || issues.length > 0} loading={signing}>
            Sign
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {issues.length > 0 && (
          <Alert tone="error" title="Complete these before signing">
            <ul className="list-disc pl-5">
              {issues.map((i) => (
                <li key={i.path}>{i.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        {error != null && <Alert tone="error">{errorMessage(error)}</Alert>}
        <p>
          <strong>{encounter.patient.fullName}</strong> ({encounter.patient.mrn}) · {fmtDate(encounter.visit.visitDate)} · token {encounter.visit.tokenNumber}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="review-allergies">
          <p className="font-medium">Allergies on record</p>
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies on record">
            <AllergyItems encounter={encounter} />
          </ul>
        </div>
        {allergyNote && (
          <Alert tone={allergyNote.tone} title="Allergy name check (fixed rules)">
            <span data-testid="review-allergy-check">{allergyNote.text}</span>
          </Alert>
        )}
        <dl className="space-y-2">
          {NOTE_SECTIONS.filter((s) => draft.note[s.key].trim()).map((s) => (
            <div key={s.key}>
              <dt className="font-medium">{s.label}</dt>
              <dd className="whitespace-pre-wrap text-ink-muted">{draft.note[s.key]}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="font-medium">Diagnosis</p>
          <ul className="list-disc pl-5">
            {draft.diagnoses.map((d, i) => (
              <li key={i}>
                {d.description} {d.code && `(${d.code})`} <span className="text-ink-muted">· {d.kind}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">Prescription</p>
          {draft.prescription.length ? (
            <ol className="list-decimal pl-5">
              {draft.prescription.map((p, i) => {
                const d = durationLines({ duration: p.duration ?? '', durationDays: p.durationDays ?? null, startDate: courseStart(p, encounter.visit.visitDate) })
                return (
                  <li key={i}>
                    {[p.drugName, p.strength, p.form].filter(Boolean).join(' ')} — {p.dose}, {p.route}, {p.frequency}, {d.main}
                    {d.written && ` (${d.written})`}
                    {p.instructions && `; ${p.instructions}`}
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="text-ink-muted">No medicines prescribed.</p>
          )}
        </div>
        {insertions.length > 0 && (
          <div className="rounded-md border border-ai/30 bg-ai-soft p-3">
            <p className="font-medium">AI-assisted text in this note</p>
            <p className="text-xs text-ink-muted">The signed record keeps these references.</p>
            <AiProvenance insertions={insertions} />
          </div>
        )}
        <Alert tone="warning">After signing, this record cannot be edited. Corrections are added as amendments, and the original stays visible. Signing does not complete the consultation: you complete it afterwards.</Alert>
        <CheckboxField label="I have reviewed this record, including any AI-assisted text, and it is accurate." checked={attest} onChange={(e) => setAttest(e.target.checked)} />
      </div>
    </Dialog>
  )
}
