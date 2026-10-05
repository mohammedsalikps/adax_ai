import {
  AmendmentRequest,
  type DiagnosisInput,
  type Encounter,
  FREQUENCY_PRESETS,
  INSERTION_SUBJECTS,
  NOTE_SECTIONS,
  type NoteInsertion,
  type NoteFields,
  type PrescriptionItemInput,
  signIssues,
  VISIT_STATUS_LABELS,
} from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, CloudUpload, FilePlus2, LoaderCircle, Plus, Printer, Sparkles, Stethoscope, Trash2 } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { AllergyItems } from '../../components/clinical/AllergyItems.tsx'
import { ConsultationBanner, PatientStrip } from '../../components/clinical/ConsultationBanner.tsx'
import { ConsultationHeader, useOnScreen } from '../../components/clinical/ConsultationHeader.tsx'
import { ConsultationStatus, type ToolSection } from '../../components/clinical/ConsultationStatus.tsx'
import { PastHistoryPanel } from '../../components/clinical/PastHistory.tsx'
import { PatientBanner } from '../../components/clinical/PatientBanner.tsx'
import { PatientProfileDrawer } from '../../components/clinical/PatientProfileDrawer.tsx'
import { DiscardDraftDialog, RecordVerificationCard, StatusHistoryCard } from '../../components/clinical/RecordLifecycle.tsx'
import { Timeline } from '../../components/clinical/Timeline.tsx'
import { RecordVitalsDialog, VitalsInline, VitalsTiles } from '../../components/clinical/Vitals.tsx'
import { Menu } from '../../components/ui/Menu.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Dialog } from '../../components/ui/Dialog.tsx'
import { Alert, Badge, Spinner } from '../../components/ui/Feedback.tsx'
import { CheckboxField, SelectField, TextAreaField, TextField } from '../../components/ui/Form.tsx'
import { Card } from '../../components/ui/Layout.tsx'
import { PanelBoundary } from '../../components/ui/PanelBoundary.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { useMe, useStillSamePerson } from '../../lib/auth.tsx'
import { usePortalBase } from '../../lib/clinical.ts'
import { encounterKey, useEncounter, useStartConsultation } from '../../lib/encounters.ts'
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format.ts'
import { consultKey } from '../../lib/consult.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

export interface Draft {
  note: NoteFields
  diagnoses: DiagnosisInput[]
  prescription: PrescriptionItemInput[]
}

/** Lets other panels (Mana, the AI assistant, the photographs) insert reviewed AI text into the note, recorded on the server. */
export type SidePanel = (e: Encounter, inserter: NoteInserter) => ReactNode

/**
 * The tools beside the note, in the order a consultation uses them: the conversation (live transcription, important points), the AI draft,
 * Mana, the devices (readings, stethoscope recordings) and the rest (photographs, the older assistant). The doctor's route supplies them; the
 * visit and the patient's history are always there. Each is given the consultation and the one way into the note: `NoteInserter`, which
 * saves the doctor's edits first and records what was inserted, from which reviewed AI output, on the server.
 */
export interface ConsultationPanels {
  conversation?: SidePanel
  draft?: SidePanel
  mana?: SidePanel
  devices?: SidePanel
  /** V6: thermal imaging for this patient and this encounter. */
  thermal?: SidePanel
  more?: SidePanel
}

/** The parts of the tools column, for the bar at its top (and for the chips under the banner, which lead to the part that says more). */
const TOOL_PARTS: { id: 'history' | ToolSection | 'mana' | 'thermal' | 'more'; label: string; panel?: keyof ConsultationPanels }[] = [
  { id: 'history', label: 'History' },
  { id: 'conversation', label: 'Conversation', panel: 'conversation' },
  { id: 'draft', label: 'AI draft', panel: 'draft' },
  { id: 'mana', label: 'Mana', panel: 'mana' },
  { id: 'devices', label: 'Devices', panel: 'devices' },
  { id: 'thermal', label: 'Thermal', panel: 'thermal' },
  { id: 'more', label: 'More', panel: 'more' },
]
const PANEL_LABEL: Record<keyof ConsultationPanels, string> = { conversation: 'The conversation', draft: 'The AI draft', mana: 'Mana', devices: 'The devices', thermal: 'Thermal imaging', more: 'This panel' }

/**
 * Brings a part of the tools column (or the note) into view and moves focus there, so a keyboard or screen-reader user arrives with it. From
 * 1024px the tools column scrolls on its own: only it moves (under its bar), and the page, with the note beside it, stays where the doctor
 * left it. Below that, the page scrolls.
 */
function showPart(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  const column = el.closest<HTMLElement>('[data-tools-scroller]')
  if (column && getComputedStyle(column).overflowY !== 'visible') column.scrollTo({ top: el.getBoundingClientRect().top - column.getBoundingClientRect().top + column.scrollTop - 4, behavior })
  else el.scrollIntoView({ block: 'start', behavior })
  el.focus({ preventScroll: true })
}

/**
 * One tool beside the note. It is drawn again when the consultation's AI insertions change (a tool says what is already in the note), not on
 * every keystroke in the note; and a fault inside it stays inside it (see PanelBoundary).
 */
const ToolSlot = memo(function ToolSlot({ render, encounter, inserter, label }: { render: SidePanel; encounter: Encounter; inserter: NoteInserter; label: string; insertions: NoteInsertion[] }) {
  return <PanelBoundary label={label}>{render(encounter, inserter)}</PanelBoundary>
})

/** Where AI-produced text in the note came from (shown while editing, before signing and on the signed record). */
export function AiProvenance({ insertions, section }: { insertions: NoteInsertion[]; section?: keyof NoteFields }) {
  const list = section ? insertions.filter((i) => i.section === section) : insertions
  if (!list.length) return null
  return (
    <ul className="mt-1 space-y-0.5 text-xs" aria-label={section ? 'AI-assisted text in this section' : 'AI-assisted text in this note'}>
      {list.map((i) => (
        <li key={i.id} className="text-ai">
          <Sparkles aria-hidden="true" className="mr-1 inline size-3" />
          {section ? '' : `${NOTE_SECTIONS.find((s) => s.key === i.section)?.label}: `}AI-assisted text from {INSERTION_SUBJECTS[i.subjectType].toLowerCase()}
          {i.producedBy && ` (${i.producedBy})`}, inserted {fmtDateTime(i.insertedAt)}
          {i.insertedByName && ` by ${i.insertedByName}`} · {i.retained ? 'unchanged in the note' : 'edited or removed since'}
        </li>
      ))}
    </ul>
  )
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'blocked'

/** Refusals that retrying cannot fix: the draft was signed or discarded elsewhere, the visit left the doctor, or access ended. */
const isTerminal = (err: unknown) => err instanceof ApiError && (['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(err.code) || err.status === 403 || err.status === 404)

const emptyRx = (): PrescriptionItemInput => ({ drugName: '', strength: '', form: '', dose: '', route: 'Oral', frequency: '', duration: '', instructions: '' })

function SaveIndicator({ state, savedAt }: { state: SaveState; savedAt: Date | null }) {
  const map: Record<SaveState, { icon: ReactNode; text: string; cls: string }> = {
    saved: { icon: <CircleCheck aria-hidden="true" className="size-4" />, text: savedAt ? `Saved ${fmtTime(savedAt.toISOString())}` : 'No changes', cls: 'text-ok' },
    dirty: { icon: <CloudUpload aria-hidden="true" className="size-4" />, text: 'Unsaved changes', cls: 'text-ink-muted' },
    saving: { icon: <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />, text: 'Saving…', cls: 'text-ink-muted' },
    error: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Not saved — retrying', cls: 'text-down' },
    conflict: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Changed elsewhere', cls: 'text-down' },
    blocked: { icon: <CircleAlert aria-hidden="true" className="size-4" />, text: 'Not saved', cls: 'text-down' },
  }
  const m = map[state]
  return (
    <p role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 text-sm font-medium ${m.cls}`} data-testid="save-state">
      {m.icon}
      {m.text}
    </p>
  )
}

function DiagnosesEditor({ items, onChange }: { items: DiagnosisInput[]; onChange: (next: DiagnosisInput[]) => void }) {
  const set = (i: number, patch: Partial<DiagnosisInput>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  return (
    <Card title="Diagnosis" actions={<Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => onChange([...items, { description: '', code: '', kind: items.length ? 'secondary' : 'primary' }])}>Add diagnosis</Button>}>
      {!items.length && <p className="text-sm text-ink-muted">No diagnosis yet. At least one is needed to sign (provisional is fine).</p>}
      <ul className="space-y-3">
        {items.map((d, i) => (
          <li key={i} className="grid grid-cols-1 gap-3 rounded-lg border border-line p-3 @sm:grid-cols-2 @2xl:grid-cols-[minmax(10rem,1fr)_8rem_9rem_auto] @2xl:items-end">
            <TextField label={`Diagnosis ${i + 1}`} value={d.description ?? ''} onChange={(e) => set(i, { description: e.target.value })} className="@sm:col-span-2 @2xl:col-span-1" />
            <TextField label="ICD-10 (optional)" value={d.code ?? ''} onChange={(e) => set(i, { code: e.target.value })} spellCheck={false} />
            <SelectField label="Type" value={d.kind ?? 'primary'} onChange={(e) => set(i, { kind: e.target.value as DiagnosisInput['kind'] })}>
              <option value="provisional">Provisional</option>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </SelectField>
            <div className="flex justify-end @sm:col-span-2 @2xl:col-span-1">
              <Button variant="ghost" aria-label={`Remove diagnosis ${i + 1}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => onChange(items.filter((_, j) => j !== i))} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">ICD-10 codes are checked for format only; they are not looked up in a code set.</p>
    </Card>
  )
}

function PrescriptionEditor({ encounter, items, onChange }: { encounter: Encounter; items: PrescriptionItemInput[]; onChange: (next: PrescriptionItemInput[]) => void }) {
  const set = (i: number, patch: Partial<PrescriptionItemInput>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  return (
    <Card title="Prescription" actions={<Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => onChange([...items, emptyRx()])}>Add medicine</Button>}>
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid="prescription-allergies">
        <p className="text-sm font-medium">Allergies on record</p>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Allergies on record">
          <AllergyItems encounter={encounter} />
        </ul>
      </div>
      {!items.length && <p className="text-sm text-ink-muted">No medicines prescribed.</p>}
      <datalist id="frequency-presets">
        {FREQUENCY_PRESETS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <ol className="space-y-3">
        {items.map((p, i) => (
          <li key={i} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold">Medicine {i + 1}</p>
              <Button size="sm" variant="ghost" aria-label={`Remove medicine ${i + 1}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @2xl:grid-cols-4">
              <TextField label="Medicine" value={p.drugName ?? ''} onChange={(e) => set(i, { drugName: e.target.value })} className="@sm:col-span-2" />
              <TextField label="Strength" placeholder="500 mg" value={p.strength ?? ''} onChange={(e) => set(i, { strength: e.target.value })} />
              <TextField label="Form" placeholder="Tablet" value={p.form ?? ''} onChange={(e) => set(i, { form: e.target.value })} />
              <TextField label="Dose" placeholder="1 tablet" value={p.dose ?? ''} onChange={(e) => set(i, { dose: e.target.value })} />
              <TextField label="Route" value={p.route ?? ''} onChange={(e) => set(i, { route: e.target.value })} />
              <TextField label="Frequency" list="frequency-presets" value={p.frequency ?? ''} onChange={(e) => set(i, { frequency: e.target.value })} />
              <TextField label="Duration" placeholder="5 days" value={p.duration ?? ''} onChange={(e) => set(i, { duration: e.target.value })} />
              <TextField label="Instructions" placeholder="After food" value={p.instructions ?? ''} onChange={(e) => set(i, { instructions: e.target.value })} className="@sm:col-span-2 @2xl:col-span-4" />
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-ink-muted">No drug-interaction, allergy or dose checking is performed by this system. Check the medicines against the allergies listed here.</p>
    </Card>
  )
}

function ReviewAndSignDialog({ draft, encounter, insertions, onClose, onSign, signing, error }: { draft: Draft; encounter: Encounter; insertions: NoteInsertion[]; onClose: () => void; onSign: () => void; signing: boolean; error: unknown }) {
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
            Sign and complete
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
              {draft.prescription.map((p, i) => (
                <li key={i}>
                  {[p.drugName, p.strength, p.form].filter(Boolean).join(' ')} — {p.dose}, {p.route}, {p.frequency}, {p.duration}
                  {p.instructions && `; ${p.instructions}`}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-ink-muted">None</p>
          )}
        </div>
        {insertions.length > 0 && (
          <div className="rounded-md border border-ai/30 bg-ai-soft p-3">
            <p className="font-medium">AI-assisted text in this note</p>
            <p className="text-xs text-ink-muted">The signed record keeps these references.</p>
            <AiProvenance insertions={insertions} />
          </div>
        )}
        <Alert tone="warning">After signing, this record cannot be edited. Corrections are added as amendments, and the original stays visible.</Alert>
        <CheckboxField label="I have reviewed this record, including any AI-assisted text, and it is accurate." checked={attest} onChange={(e) => setAttest(e.target.checked)} />
      </div>
    </Dialog>
  )
}

function ConsultationEditor({ initial, panels }: { initial: Encounter; panels: ConsultationPanels }) {
  const qc = useQueryClient()
  const toast = useToast()
  const base = usePortalBase()
  const [profileOpen, setProfileOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)
  const bannerRef = useRef<HTMLDivElement>(null)
  const bannerOnScreen = useOnScreen(bannerRef)
  const [draft, setDraft] = useState<Draft>({ note: initial.note, diagnoses: initial.diagnoses, prescription: initial.prescription })
  const [state, setState] = useState<SaveState>('saved')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [vitalsOpen, setVitalsOpen] = useState(false)
  const [insertions, setInsertions] = useState<NoteInsertion[]>(initial.aiInsertions)
  const [inserting, setInserting] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)
  const blockedRef = useRef<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const pendingInsertsRef = useRef(0)
  const draftRef = useRef(draft)
  const versionRef = useRef(initial.version)
  const dirtyRef = useRef(false)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const stateRef = useRef<SaveState>('saved')
  const setSaveState = (s: SaveState) => {
    stateRef.current = s
    setState(s)
  }
  /** A refusal retrying cannot fix: stop saving and say why. */
  const block = (err: unknown) => {
    blockedRef.current = errorMessage(err)
    setBlocked(blockedRef.current)
    setSaveState('blocked')
  }

  const update = (fn: (d: Draft) => Draft) => {
    if (stateRef.current === 'conflict' || stateRef.current === 'blocked') return
    const next = fn(draftRef.current)
    draftRef.current = next
    dirtyRef.current = true
    setDraft(next)
    setSaveState('dirty')
  }

  const samePerson = useStillSamePerson()

  /** Saves serially; resolves once nothing is pending. */
  const flush = useCallback((): Promise<void> => {
    chainRef.current = chainRef.current.then(async () => {
      if (!dirtyRef.current || stateRef.current === 'conflict' || stateRef.current === 'blocked') return
      // Another person has taken over this browser (this page is being closed for them): the last edits are not theirs to send.
      if (!samePerson()) {
        dirtyRef.current = false
        return
      }
      dirtyRef.current = false
      setSaveState('saving')
      try {
        const e = await api<Encounter>(`/encounters/${initial.id}/draft`, { method: 'PUT', body: { version: versionRef.current, ...draftRef.current } })
        versionRef.current = e.version
        setInsertions(e.aiInsertions)
        setSavedAt(new Date())
        void qc.invalidateQueries({ queryKey: ['my-consultations'] })
        // The consultation intelligence panel compares its draft with the note: it looks again when the note has been saved.
        void qc.invalidateQueries({ queryKey: consultKey(initial.id) })
        setSaveState(dirtyRef.current ? 'dirty' : 'saved')
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') setSaveState('conflict')
        else if (isTerminal(err)) block(err)
        else {
          dirtyRef.current = true
          setSaveState('error')
        }
      }
    })
    return chainRef.current
  }, [initial.id, qc, samePerson])

  // Debounced autosave; retry after errors.
  useEffect(() => {
    if (state !== 'dirty' && state !== 'error') return
    const t = setTimeout(() => void flush(), state === 'error' ? 5000 : 1200)
    return () => clearTimeout(t)
  }, [draft, state, flush])

  // Leaving the page within the autosave delay (in-app navigation) still saves the last edits.
  useEffect(
    () => () => {
      if (dirtyRef.current) void flush()
    },
    [flush],
  )

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || stateRef.current === 'saving') e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  const sign = useMutation({
    mutationFn: async () => {
      await flush()
      if (stateRef.current !== 'saved') throw new ApiError(409, 'not_saved', 'The latest changes could not be saved. Try again.')
      return api<Encounter>(`/encounters/${initial.id}/sign`, { method: 'POST', body: { version: versionRef.current, attestation: true } })
    },
    onSuccess: (e) => {
      qc.setQueryData(encounterKey(e.id), e)
      void qc.invalidateQueries({ queryKey: ['visits'] })
      void qc.invalidateQueries({ queryKey: ['appointments'] })
      void qc.invalidateQueries({ queryKey: ['patient', e.patient.id] })
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      toast('success', 'Consultation signed and visit completed')
      setReviewing(false)
    },
  })

  /**
   * Saves pending edits, then asks the server to insert the reviewed AI text
   * (the server records which AI artifact it came from). The note is
   * read-only while this runs so no keystroke is lost.
   */
  const inserter: NoteInserter = {
    insert: async (section, text, subject) => {
      pendingInsertsRef.current += 1
      setInserting(true)
      try {
        await flush()
        // Runs on the same serial chain as autosave, so a save and an insertion never use the same version.
        const run = chainRef.current.then(async () => {
          if (stateRef.current === 'conflict') throw new ApiError(409, 'version_conflict', 'This consultation was changed in another window. Reload to continue.')
          if (stateRef.current === 'blocked') throw new ApiError(409, 'not_saved', blockedRef.current ?? 'Changes to this consultation cannot be saved. Reload it.')
          if (dirtyRef.current || stateRef.current === 'error') {
            // Diagnoses or prescription changed meanwhile: save them first (note fields are read-only now).
            dirtyRef.current = false
            setSaveState('saving')
            try {
              const saved = await api<Encounter>(`/encounters/${initial.id}/draft`, { method: 'PUT', body: { version: versionRef.current, ...draftRef.current } })
              versionRef.current = saved.version
            } catch (err) {
              if (err instanceof ApiError && err.code === 'version_conflict') setSaveState('conflict')
              else if (isTerminal(err)) block(err)
              else {
                dirtyRef.current = true
                setSaveState('error')
              }
              throw err
            }
          }
          setSaveState('saving')
          try {
            const e = await api<Encounter>(`/encounters/${initial.id}/insertions`, { method: 'POST', body: { version: versionRef.current, section, text, subjectType: subject.type, subjectId: subject.id } })
            versionRef.current = e.version
            const next = { ...draftRef.current, note: e.note }
            draftRef.current = next
            setDraft(next)
            setInsertions(e.aiInsertions)
            setSavedAt(new Date())
            setSaveState(dirtyRef.current ? 'dirty' : 'saved')
            void qc.invalidateQueries({ queryKey: ['my-consultations'] })
            void qc.invalidateQueries({ queryKey: consultKey(initial.id) })
          } catch (err) {
            if (err instanceof ApiError && err.code === 'version_conflict') setSaveState('conflict')
            else if (isTerminal(err)) block(err)
            else setSaveState(dirtyRef.current ? 'dirty' : 'saved')
            throw err
          }
        })
        chainRef.current = run.catch(() => undefined)
        await run
      } finally {
        pendingInsertsRef.current -= 1
        if (pendingInsertsRef.current === 0) setInserting(false)
      }
    },
    inserted: (type, id) => insertions.some((i) => i.subjectType === type && i.subjectId === id),
  }
  const inserterRef = useRef(inserter)
  inserterRef.current = inserter
  const toolInserter = useMemo<NoteInserter>(() => ({ insert: (...a) => inserterRef.current.insert(...a), inserted: (...a) => inserterRef.current.inserted(...a) }), [])

  const locked = state === 'conflict' || state === 'blocked'
  const parts = TOOL_PARTS.filter((p) => !p.panel || panels[p.panel])
  const tool = (key: keyof ConsultationPanels) => {
    const render = panels[key]
    return render ? <ToolSlot render={render} encounter={initial} inserter={toolInserter} insertions={insertions} label={PANEL_LABEL[key]} /> : null
  }
  // A part of the tools column: a named group the bar at its top leads to, focusable so that arriving there by the bar or a chip moves focus too.
  const part = (id: (typeof TOOL_PARTS)[number]['id'], children: ReactNode) => (
    <div
      id={`tools-${id}`}
      role="group"
      aria-label={TOOL_PARTS.find((p) => p.id === id)?.label}
      tabIndex={-1}
      className="scroll-mt-20 space-y-6 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0"
    >
      {children}
    </div>
  )
  return (
    <>
      <ConsultationHeader
        patientName={initial.patient.fullName}
        startedAt={initial.startedAt}
        backTo={`${base}/queue`}
        backLabel="Back to today’s patients"
        patient={bannerOnScreen ? null : <PatientStrip encounter={initial} />}
        banner={
          <div ref={bannerRef}>
            <ConsultationBanner encounter={initial} onOpenProfile={() => setProfileOpen(true)} status={<ConsultationStatus encounterId={initial.id} patientId={initial.patient.id} onSelect={(s) => showPart(`tools-${s}`)} />} />
          </div>
        }
        actions={
          <>
            <SaveIndicator state={state} savedAt={savedAt} />
            <Button variant="secondary" onClick={() => void flush()} disabled={state === 'saved' || locked}>
              Save
            </Button>
            <Button onClick={() => setReviewing(true)} disabled={locked}>
              Complete consultation
            </Button>
            {/* Closing a draft without signing is deliberate, so it is kept away from the save and complete buttons. */}
            <Menu label="More consultation actions" items={[{ label: 'Discard draft…', tone: 'danger', icon: <Trash2 aria-hidden="true" className="size-4" />, disabled: locked, onSelect: () => void flush().then(() => setDiscarding(true)) }]} />
          </>
        }
      />
      {state === 'blocked' && (
        <Alert tone="error" title="Your latest changes cannot be saved" className="mb-4">
          {blocked}{' '}
          <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
            Reload the consultation
          </button>
          .
        </Alert>
      )}
      {state === 'conflict' && (
        <Alert tone="error" title="This consultation was changed in another window" className="mb-4">
          Your latest edits were not saved. Copy anything you need, then{' '}
          <button type="button" className="font-semibold underline" onClick={() => void qc.invalidateQueries({ queryKey: encounterKey(initial.id) }).then(() => window.location.reload())}>
            reload the latest version
          </button>
          .
        </Alert>
      )}
      {/*
        One workspace, two panes from 1024px (a tablet held sideways): the tools on the left, in the order a consultation uses them, and the note
        on the right, so reviewed text moves left to right into it. The tools column keeps its place under the consultation bar and scrolls on
        its own, so the note stays in view while the doctor reads the transcript or the AI draft, and the reverse. Below 1024px one column.
        Every tool stays mounted and visible: a recording, the device readings and the AI draft keep running while the doctor works elsewhere.
      */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] 2xl:grid-cols-[30rem_minmax(0,1fr)]">
        <aside
          aria-label="Consultation tools"
          className="min-w-0 lg:sticky lg:top-[calc(var(--spacing-topbar)+var(--consult-header-h,0px)+1rem)] lg:-ml-1 lg:flex lg:max-h-[calc(100dvh-var(--spacing-topbar)-var(--consult-header-h,0px)-2rem)] lg:flex-col"
          data-testid="consultation-tools"
        >
          {/* The note is after the tools in the reading order; a keyboard user can go straight to it (visible when focused). */}
          <button type="button" onClick={() => showPart('consultation-note')} className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-pop focus:not-sr-only focus:inline-flex">
            Skip to the note
          </button>
          <nav aria-label="Go to" className="mb-4 flex flex-wrap gap-1 lg:shrink-0 lg:pl-1">
            {parts.map((p) => (
              <button key={p.id} type="button" onClick={() => showPart(`tools-${p.id}`)} className="inline-flex min-h-control-sm items-center rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink-muted hover:bg-canvas hover:text-ink">
                {p.label}
              </button>
            ))}
            <button type="button" onClick={() => showPart('consultation-note')} className="inline-flex min-h-control-sm items-center rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink-muted hover:bg-canvas hover:text-ink lg:hidden">
              Note
            </button>
          </nav>
          <div data-tools-scroller className="min-w-0 space-y-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-2 lg:pb-4 lg:pl-1">
            {part(
              'history',
              <>
                <Card title="This visit">
                  <VitalsTiles vitals={initial.vitals} />
                  <div className="mt-3">
                    <Button size="sm" variant="secondary" onClick={() => setVitalsOpen(true)}>
                      Record vitals
                    </Button>
                  </div>
                </Card>
                <Card
                  title="Past history"
                  bodyClassName="p-4"
                  actions={
                    <Button size="sm" variant="ghost" aria-expanded={historyOpen} aria-controls="past-history-body" onClick={() => setHistoryOpen((o) => !o)}>
                      {historyOpen ? 'Hide' : 'Show'}
                      <span className="sr-only"> past history</span>
                    </Button>
                  }
                >
                  {/* No scroller of its own: the tools column scrolls. */}
                  <div id="past-history-body" hidden={!historyOpen}>
                    <PastHistoryPanel patientId={initial.patient.id} bare />
                  </div>
                </Card>
              </>,
            )}
            {panels.conversation && part('conversation', tool('conversation'))}
            {panels.draft && part('draft', tool('draft'))}
            {panels.mana && part('mana', tool('mana'))}
            {panels.devices && part('devices', tool('devices'))}
            {panels.thermal && part('thermal', tool('thermal'))}
            {panels.more && part('more', tool('more'))}
          </div>
        </aside>
        {/* The editors inside lay themselves out by the width of this column (container queries). */}
        <div className="@container min-w-0 space-y-6">
          <div id="consultation-note" tabIndex={-1} className="scroll-mt-20 focus:outline-none">
            <Card title="Consultation note" actions={inserting ? <Badge tone="ai">Inserting AI text…</Badge> : undefined}>
              <div className="space-y-4">
                {NOTE_SECTIONS.map((s) => (
                  <div key={s.key}>
                    <TextAreaField
                      label={s.label}
                      hint={s.hint}
                      rows={s.rows}
                      value={draft.note[s.key]}
                      onChange={(e) => update((d) => ({ ...d, note: { ...d.note, [s.key]: e.target.value } }))}
                      readOnly={state === 'conflict' || state === 'blocked' || inserting}
                    />
                    <AiProvenance insertions={insertions} section={s.key} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <DiagnosesEditor items={draft.diagnoses} onChange={(diagnoses) => update((d) => ({ ...d, diagnoses }))} />
          <PrescriptionEditor encounter={initial} items={draft.prescription} onChange={(prescription) => update((d) => ({ ...d, prescription }))} />
        </div>
      </div>
      {/* Room for the actions that stay at the bottom of the screen below 1024px: as tall as that bar actually is. */}
      <div aria-hidden="true" className="lg:hidden" style={{ height: 'calc(var(--action-bar-h, 7rem) + 1rem)' }} />
      <PatientProfileDrawer patientId={initial.patient.id} open={profileOpen} onClose={() => setProfileOpen(false)} />
      {discarding && (
        <DiscardDraftDialog
          draft={{ id: initial.id, version: versionRef.current, patientName: initial.patient.fullName, visitStatus: initial.visit.status }}
          onClose={() => setDiscarding(false)}
          // Nothing more to save: the page now shows the discarded draft read-only.
          onDiscarded={() => (dirtyRef.current = false)}
        />
      )}
      {reviewing && <ReviewAndSignDialog draft={draft} encounter={initial} insertions={insertions} onClose={() => setReviewing(false)} onSign={() => sign.mutate()} signing={sign.isPending} error={sign.error} />}
      {vitalsOpen && (
        <RecordVitalsDialog
          visitId={initial.visit.id}
          patientName={initial.patient.fullName}
          onClose={() => {
            setVitalsOpen(false)
            void qc.invalidateQueries({ queryKey: encounterKey(initial.id) })
          }}
        />
      )}
    </>
  )
}

function AmendmentDialog({ encounterId, patientId, onClose }: { encounterId: string; patientId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [v, setV] = useState({ reason: '', content: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: (body: AmendmentRequest) => api<Encounter>(`/encounters/${encounterId}/amendments`, { method: 'POST', body }),
    onSuccess: (e) => {
      qc.setQueryData(encounterKey(encounterId), e)
      void qc.invalidateQueries({ queryKey: ['patient', patientId] })
      void qc.invalidateQueries({ queryKey: ['my-consultations'] })
      toast('success', 'Amendment added')
      onClose()
    },
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add amendment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              const r = AmendmentRequest.safeParse(v)
              if (!r.success) return setErrors(Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message])))
              save.mutate(r.data)
            }}
          >
            Add amendment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        <p className="text-sm">The signed record stays as it is. Your amendment is added below it with your name and the time.</p>
        <TextField label="Reason" required value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} error={errors.reason} />
        <TextAreaField label="Amendment" required rows={5} value={v.content} onChange={(e) => setV({ ...v, content: e.target.value })} error={errors.content} />
      </div>
    </Dialog>
  )
}

export function EncounterReadView({ e }: { e: Encounter }) {
  const { data: me } = useMe()
  const base = usePortalBase()
  const [amending, setAmending] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const start = useStartConsultation()
  const signed = e.status === 'signed'
  const own = me?.role === 'doctor' && me.id === e.doctor.id
  return (
    <>
      <PatientBanner patient={e.patient} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Consultation · {fmtDate(e.visit.visitDate)}</h1>
          <p className="text-sm text-ink-muted">
            {e.doctor.fullName} · {e.visit.departmentName} · token {e.visit.tokenNumber}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {signed ? <Badge tone="ok">Signed {fmtDateTime(e.signedAt)}</Badge> : e.status === 'discarded' ? <Badge>Discarded draft</Badge> : <Badge tone="warn">Draft — not signed</Badge>}
          {signed && (
            <Link to={`/print/encounters/${e.id}`} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-4 text-sm font-medium hover:bg-canvas">
              <Printer aria-hidden="true" className="size-4" />
              Print prescription
            </Link>
          )}
          {signed && me?.role === 'doctor' && me.id === e.doctor.id && (
            <Button variant="secondary" icon={<FilePlus2 aria-hidden="true" className="size-4" />} onClick={() => setAmending(true)}>
              Add amendment
            </Button>
          )}
        </div>
      </div>
      {e.discarded && (
        <Alert tone="info" title="This draft was discarded" className="mb-4">
          {e.discarded.byName} discarded it on {fmtDateTime(e.discarded.at)}. Reason: {e.discarded.reason}. It is kept read-only and is not part of the patient’s record.
        </Alert>
      )}
      {e.status === 'in_progress' && own && (
        <Alert tone="warning" title={e.canResume ? 'This draft is paused' : 'This draft cannot be signed'} className="mb-4">
          <p>
            {e.canResume
              ? `The visit is back in the queue (${VISIT_STATUS_LABELS[e.visit.status]}). Continue the consultation to edit and sign it.`
              : `The visit was closed (${VISIT_STATUS_LABELS[e.visit.status]}) while this draft was open. Discard it, with a reason, to close it.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {e.canResume && (
              <Button size="sm" icon={<Stethoscope aria-hidden="true" className="size-4" />} loading={start.isPending} onClick={() => start.mutate(e.visit.id)}>
                Continue consultation
              </Button>
            )}
            {e.canDiscard && (
              <Button size="sm" variant="secondary" icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => setDiscarding(true)}>
                Discard draft…
              </Button>
            )}
          </div>
          {start.isError && <p className="mt-2 font-medium">{errorMessage(start.error)}</p>}
        </Alert>
      )}
      {e.status === 'in_progress' && !own && <Alert tone="info" className="mb-4">This consultation is still a draft by {e.doctor.fullName}. Only they can edit and sign it.</Alert>}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Consultation note">
            <dl className="space-y-4 text-sm">
              {NOTE_SECTIONS.map((s) => (
                <div key={s.key}>
                  <dt className="font-medium">{s.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap">{e.note[s.key] || <span className="text-ink-muted">—</span>}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Diagnosis">
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {e.diagnoses.map((d, i) => (
                <li key={i}>
                  {d.description} {d.code && <span className="font-mono">({d.code})</span>} <span className="text-ink-muted">· {d.kind}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Prescription">
            {e.prescription.length ? (
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {e.prescription.map((p, i) => (
                  <li key={i}>
                    <strong>{[p.drugName, p.strength, p.form].filter(Boolean).join(' ')}</strong> — {p.dose}, {p.route}, {p.frequency}, {p.duration}
                    {p.instructions && `; ${p.instructions}`}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-muted">No medicines prescribed.</p>
            )}
          </Card>
          {e.aiInsertions.length > 0 && (
            <Card title="AI-assisted text">
              <p className="text-xs text-ink-muted">Text in this note that the doctor inserted from AI or rule-based output, with its source.</p>
              <AiProvenance insertions={e.aiInsertions} />
            </Card>
          )}
          {e.amendments.length > 0 && (
            <Card title="Amendments">
              <ol className="space-y-3 text-sm">
                {e.amendments.map((a) => (
                  <li key={a.id} className="rounded-lg border border-notice/30 bg-notice-soft p-3">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {a.seq !== null && <span>Amendment {a.seq} ·</span>}
                      {fmtDateTime(a.createdAt)} · {a.authorName}
                      {a.contentHash === null && <Badge>Added before fingerprinting</Badge>}
                    </p>
                    <p className="text-ink-muted">Reason: {a.reason}</p>
                    <p className="mt-1 whitespace-pre-wrap">{a.content}</p>
                  </li>
                ))}
              </ol>
            </Card>
          )}
          {signed && e.contentHash && <p className="text-xs text-ink-muted">Integrity hash (SHA-256 of the signed content): <span className="font-mono break-all">{e.contentHash}</span></p>}
          {/* A new amendment changes what is checked: start again from "Check now". */}
          {signed && <RecordVerificationCard key={`${e.id}:${e.amendments.length}`} encounterId={e.id} />}
          <StatusHistoryCard encounterId={e.id} />
        </div>
        <aside className="space-y-6" aria-label="Visit information">
          <Card title="Vitals at this visit">
            <VitalsInline vitals={e.vitals} />
          </Card>
          <Timeline patientId={e.patient.id} />
          <Link to={`${base}/patients/${e.patient.id}`} className="block text-sm font-medium text-brand-strong underline underline-offset-2">
            Open patient record
          </Link>
        </aside>
      </div>
      {amending && <AmendmentDialog encounterId={e.id} patientId={e.patient.id} onClose={() => setAmending(false)} />}
      {discarding && <DiscardDraftDialog draft={{ id: e.id, version: e.version, patientName: e.patient.fullName, visitStatus: e.visit.status }} onClose={() => setDiscarding(false)} />}
    </>
  )
}

/** A consultation: the editor (the doctor who is writing it, with `panels` beside the note), or the record read-only (everyone else, and after signing). */
export function ConsultationPage({ panels = {} }: { panels?: ConsultationPanels }) {
  const { encounterId } = useParams()
  const q = useEncounter(encounterId)
  const navigate = useNavigate()
  useDocumentTitle(q.data ? `Consultation · ${q.data.patient.fullName}` : 'Consultation')
  if (q.isPending) return <Spinner />
  if (q.isError)
    return (
      <Alert tone="error" title={q.error instanceof ApiError && q.error.status === 403 ? 'You do not have access to this consultation' : q.error instanceof ApiError && q.error.status === 404 ? 'Consultation not found' : 'Cannot open this consultation'}>
        {errorMessage(q.error)}{' '}
        <button type="button" className="underline" onClick={() => navigate(-1)}>
          Go back
        </button>
      </Alert>
    )
  // The editor starts from the server's current version, never from a cached copy (another tab or an earlier visit may have saved since).
  if (q.data.canEdit && !q.isFetchedAfterMount) return <Spinner label="Opening the latest version…" />
  return q.data.canEdit ? <ConsultationEditor key={q.data.id} initial={q.data} panels={panels} /> : <EncounterReadView key={q.data.id} e={q.data} />
}
