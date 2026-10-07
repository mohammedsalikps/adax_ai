import { type Encounter, type NoteFields, signIssues } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleCheck, FlaskConical, PenLine } from 'lucide-react'
import { type MouseEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { BottomBar } from '../../components/hero/BottomBar.tsx'
import { WorkflowStepper } from '../../components/hero/WorkflowStepper.tsx'
import { StatusPill } from '../../components/hero/StatusPill.tsx'
import { useAllergyNameCheck } from '../../components/rx/BeforeYouPrescribe.tsx'
import { ClinicalNote } from '../../components/rx/ClinicalNote.tsx'
import { ClinicalSummary } from '../../components/rx/ClinicalSummary.tsx'
import { printUrl, SignedActions } from '../../components/rx/CompleteConsultation.tsx'
import { ageSex, PrescriptionDocument } from '../../components/rx/PrescriptionDocument.tsx'
import { PdfPreview } from '../../components/rx/PdfPreview.tsx'
import { openInNewTab } from '../../components/rx/PrintPreviewLink.tsx'
import { SECONDARY_CONTROL } from '../../components/rx/RepeatMedicineMenu.tsx'
import { ReviewAndSignDialog } from '../../components/rx/ReviewAndSignDialog.tsx'
import { allergyReviewNote, medicinesKey, type RxPageState, rxPageState, rxStatusPill } from '../../components/rx/rxModel.ts'
import { SaveIndicator } from '../../components/rx/SaveIndicator.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Alert, Spinner } from '../../components/ui/Feedback.tsx'
import { PatientAvatar } from '../../components/ui/PatientAvatar.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { ApiError, errorMessage } from '../../lib/api.ts'
import { draftOf, isLocked } from '../../lib/draftSaver.ts'
import { DEMO_PRESCRIPTION_NOTICE, demoPrescriptionMark } from '../../lib/demoPrescription.ts'
import { useEncounterDraft, useFreshDraftGate, useSignEncounter } from '../../lib/encounterDraft.ts'
import { encounterKey, useEncounter } from '../../lib/encounters.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

/** The consultation workspace of this prescription. */
const consultationUrl = (encounterId: string) => `/doctor/encounters/${encounterId}`

/** A reviewed-AI insertion is the doctor's act on the draft; a signed or read-only prescription has none. */
const NO_INSERTER: NoteInserter = { insert: () => Promise.reject(new Error('This consultation cannot be edited.')), inserted: () => false }

/**
 * The prescription page of a consultation (`/doctor/encounters/:encounterId/prescription`, focus mode; DESIGN §5.6): the clinical summary (the
 * local model's draft, each statement AI DRAFT with [Add to note] [Edit] [Remove], then the typed note) on the left, the prescription as a
 * document on the right (diagnosis, medicines with their course, Before you prescribe, advice and diet, follow-up, orders), and the bottom bar:
 * save state · [Preview] · [Sign & print]. Once signed: "Prescription signed ✓" · [Print] · [Complete consultation]. AI never creates a
 * prescription row; an approved Mana action adds one through the draft (lib/draftBridge, registered by useEncounterDraft).
 */
export function PrescriptionPage() {
  const { encounterId } = useParams()
  const q = useEncounter(encounterId)
  const navigate = useNavigate()
  const ready = useFreshDraftGate(encounterId, q)
  useDocumentTitle(q.data ? `Prescription · ${q.data.patient.fullName}` : 'Prescription')
  if (q.isPending) return <Spinner />
  if (q.isError)
    return (
      <Alert tone="error" title={q.error instanceof ApiError && q.error.status === 403 ? 'You do not have access to this consultation' : q.error instanceof ApiError && q.error.status === 404 ? 'Consultation not found' : 'Cannot open this prescription'}>
        {errorMessage(q.error)}{' '}
        <button type="button" className="underline" onClick={() => navigate(-1)}>
          Go back
        </button>
      </Alert>
    )
  const e = q.data
  const state = rxPageState(e)
  // The editor starts from the server's current version, never from a cached copy (another tab, or the consultation a moment ago, may have saved since).
  if (state === 'draft') return ready ? <DraftPrescription key={e.id} initial={e} /> : <Spinner label="Opening the latest version…" />
  return <ReadPrescription e={e} state={state} />
}

/** The header (DESIGN §5.6): ← Back to consultation · avatar · name · age · sex · MRN · status. */
function Header({ e, state, onBack }: { e: Encounter; state: RxPageState; onBack?: (ev: MouseEvent<HTMLAnchorElement>) => void }) {
  const pill = rxStatusPill(state)
  return (
    <>
    <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="prescription-header">
      <Link to={consultationUrl(e.id)} onClick={onBack} className="-ml-2 inline-flex min-h-control w-full items-center gap-2 rounded-md px-2 text-sm font-medium text-ink-muted hover:bg-surface hover:text-ink sm:w-auto">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to consultation
      </Link>
      <span aria-hidden="true" className="hidden h-6 w-px bg-line sm:block" />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PatientAvatar name={e.patient.fullName} size="lg" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">
            <span className="font-semibold text-brand">Prescription</span> · AI-assisted draft · review and edit before signing
          </p>
          <h1 className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">
            <span className="sr-only">Prescription · </span>
            {e.patient.fullName}
          </h1>
          <p className="text-sm text-ink-muted">
            {ageSex(e.patient)} · MRN <span className="font-mono text-ink">{e.patient.mrn}</span>
          </p>
        </div>
      </div>
      <StatusPill status={pill.status} label={pill.label} />
    </header>
    {/* UI/UX redesign: where this consultation is (a picture of the page's state, not a control). */}
    <WorkflowStepper current={state === 'draft' ? 2 : 3} allDone={state === 'completed'} className="mb-5" />
    </>
  )
}

/**
 * Jury design, screen 4: the prescription document first (with the clinical summary and the note under it) and the PDF preview beside it from
 * 1024px (7 : 5, the preview held in view while the document scrolls); one column below, the preview after the document.
 */
function Columns({ doc, notes, preview }: { doc: ReactNode; notes: ReactNode; preview: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-start">
      <div className="min-w-0 space-y-4 lg:col-span-7">
        {doc}
        {notes}
      </div>
      <div className="min-w-0 lg:sticky lg:top-4 lg:col-span-5">{preview}</div>
    </div>
  )
}

/** The doctor's draft: everything editable, saved as it is written (the same draft and save chain as the consultation). */
function DraftPrescription({ initial }: { initial: Encounter }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const d = useEncounterDraft(initial)
  const [reviewing, setReviewing] = useState(false)
  // [Sign & print] opens the printout as the signature is answered; [Sign] only signs.
  const [printAfter, setPrintAfter] = useState(true)
  // The fixed rules' allergy name check of the medicines written here: after a saved change to them, on [Check now], and before Review and sign.
  const { saver, flushState } = d
  const savedKeyNow = useCallback(() => medicinesKey(saver.getSnapshot().savedPrescription), [saver])
  const allergy = useAllergyNameCheck(initial.id, { draftKey: medicinesKey(d.draft.prescription), savedKey: medicinesKey(d.savedPrescription), locked: d.locked, savedKeyNow, flushState })
  // Review and sign opens once what is pending is saved and the allergy name check has answered (or failed) for the medicines as saved.
  const [preparing, setPreparing] = useState(false)
  // What the signing rules still need, shown in the document where it belongs once the doctor has tried to sign (and kept current as they edit).
  const [triedToSign, setTriedToSign] = useState(false)
  const issues = triedToSign ? signIssues(d.draft) : []
  // DEMO / SEED: Analyze filled this draft by the fixed demo rules (lib/demoPrescription.ts): said plainly, above the document.
  const [demoFilled] = useState(() => demoPrescriptionMark(initial.id) !== null)
  const openReview = async (print: boolean) => {
    setPrintAfter(print)
    setPreparing(true)
    try {
      const state = await flushState()
      const key = savedKeyNow()
      if (key && !isLocked(state)) await allergy.ensure(key)
    } finally {
      setPreparing(false)
    }
    // Premium design: nothing is signed incomplete, and what is missing is said on the prescription itself, not in a blocking box.
    const missing = signIssues(d.saver.getSnapshot().draft)
    if (missing.length) {
      setTriedToSign(true)
      toast('warning', `${missing.length === 1 ? 'One thing' : `${missing.length} things`} to complete before signing: see the prescription.`)
      document.querySelector('[data-testid="prescription-document"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    setReviewing(true)
  }
  const sign = useSignEncounter(initial.id, d.saver, (signed) => {
    setReviewing(false)
    toast('success', 'Prescription signed. Complete the consultation when you are done.')
    // Opened as the doctor's Sign is answered; a browser that still blocks it is told so, and [Print] is on the page.
    if (printAfter) openInNewTab(printUrl(signed.id), 'The browser did not open the prescription to print. Use Print below, or allow pop-ups for this site.', toast)
  })
  const setNote = (key: keyof NoteFields, value: string) => d.update((x) => ({ ...x, note: { ...x.note, [key]: value } }))
  // Ctrl/⌘+S saves now (the autosave saves anyway).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        void d.flush()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [d.flush])
  // Back to the consultation: what is pending is saved first (and an insertion under way ends), so the consultation opens on it.
  const back = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    ev.preventDefault()
    void d.idle().then(() => navigate(consultationUrl(initial.id)))
  }
  return (
    <div data-testid="prescription-page" data-state="draft">
      <Header e={initial} state="draft" onBack={back} />
      {d.state === 'blocked' && (
        <Alert tone="error" title="Your latest changes cannot be saved" className="mb-4">
          {d.blocked}{' '}
          <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
            Reload the prescription
          </button>
          .
        </Alert>
      )}
      {d.state === 'conflict' && (
        <Alert tone="error" title="This consultation was changed in another window" className="mb-4">
          Your latest edits were not saved. Copy anything you need, then{' '}
          <button type="button" className="font-semibold underline" onClick={() => void qc.invalidateQueries({ queryKey: encounterKey(initial.id) }).then(() => window.location.reload())}>
            reload the latest version
          </button>
          .
        </Alert>
      )}
      {demoFilled && (
        <div role="note" className="mb-4 flex items-start gap-3 rounded-2xl border border-brand/20 bg-brand-soft px-4 py-3 text-sm" data-testid="rx-demo-draft">
          <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
          <div>
            <p className="font-semibold text-ink">Demo prescription draft — doctor review required</p>
            <p className="mt-0.5 text-ink-muted">{DEMO_PRESCRIPTION_NOTICE}</p>
          </div>
        </div>
      )}
      <Columns
        doc={<PrescriptionDocument encounter={initial} draft={d.draft} onChange={d.update} locked={d.locked} inserting={d.inserting} allergy={allergy} issues={issues} />}
        notes={
          <>
            <ClinicalSummary encounter={initial} inserter={d.inserter} editable={!d.locked} flushState={flushState} />
            <ClinicalNote note={d.draft.note} insertions={d.insertions} readOnly={false} inserting={d.inserting} locked={d.locked} onChange={setNote} />
          </>
        }
        preview={<PdfPreview encounterId={initial.id} revision={String(d.savedAt?.getTime() ?? 0)} signed={false} flush={d.flushState} />}
      />
      <BottomBar label="Prescription actions" testId="prescription-actions" start={<SaveIndicator state={d.state} savedAt={d.savedAt} />}>
        <Link to={consultationUrl(initial.id)} onClick={back} className={SECONDARY_CONTROL} data-testid="back-to-editing">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to editing
        </Link>
        <Button variant="secondary" disabled={d.locked || d.inserting} loading={preparing && !printAfter} onClick={() => void openReview(false)} data-testid="sign-only">
          Sign
        </Button>
        <Button variant="cta" icon={<PenLine aria-hidden="true" className="size-4" />} disabled={d.locked || d.inserting} loading={preparing && printAfter} onClick={() => void openReview(true)} data-testid="sign-and-print">
          Sign & print
        </Button>
        <Button variant="secondary" icon={<CircleCheck aria-hidden="true" className="size-4" />} disabled title="Sign the prescription first" data-testid="complete-locked">
          Complete consultation
        </Button>
      </BottomBar>
      {reviewing && (
        <ReviewAndSignDialog
          draft={d.draft}
          encounter={initial}
          insertions={d.insertions}
          allergyNote={allergyReviewNote(allergy.view)}
          onClose={() => setReviewing(false)}
          onSign={() => sign.mutate()}
          signing={sign.isPending}
          error={sign.error}
        />
      )}
    </div>
  )
}

/** Signed (to complete, or completed), discarded, or a draft this person cannot edit: the prescription as a document. */
function ReadPrescription({ e, state }: { e: Encounter; state: RxPageState }) {
  const draft = draftOf(e)
  return (
    <div data-testid="prescription-page" data-state={state}>
      <Header e={e} state={state} />
      {state === 'readonly_draft' && (
        <Alert tone="info" className="mb-4">
          {e.canResume ? 'This consultation is paused: continue it to write and sign the prescription.' : `This prescription is a draft by ${e.doctor.fullName}. Only they can edit and sign it.`}
        </Alert>
      )}
      {state === 'discarded' && (
        <Alert tone="info" title="This draft was discarded" className="mb-4">
          {e.discarded ? `${e.discarded.byName}: ${e.discarded.reason}. ` : ''}It is not part of the patient’s record.
        </Alert>
      )}
      <Columns
        doc={<PrescriptionDocument encounter={e} draft={draft} />}
        notes={
          <>
            <ClinicalSummary encounter={e} inserter={NO_INSERTER} editable={false} />
            <ClinicalNote note={e.note} insertions={e.aiInsertions} readOnly />
          </>
        }
        preview={state === 'discarded' ? null : <PdfPreview encounterId={e.id} revision={e.version + ':' + e.amendments.length} signed={e.status === 'signed'} />}
      />
      {(state === 'signed_to_complete' || state === 'signed' || state === 'completed') && (
        <BottomBar label="Prescription actions" testId="prescription-actions">
          <SignedActions encounter={e} completed={state === 'completed'} />
        </BottomBar>
      )}
    </div>
  )
}
