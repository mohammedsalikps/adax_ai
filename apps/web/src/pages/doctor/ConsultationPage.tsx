import {
  AmendmentRequest,
  type DiagnosisInput,
  type Encounter,
  FREQUENCY_PRESETS,
  INSERTION_SUBJECTS,
  type Medication,
  NOTE_SECTIONS,
  type NoteInsertion,
  type NoteFields,
  type PatientHistory,
  type PrescriptionItemInput,
  signIssues,
  VISIT_STATUS_LABELS,
} from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  ClipboardList,
  CloudUpload,
  FilePlus2,
  HeartPulse,
  IdCard,
  Keyboard,
  LoaderCircle,
  Mic,
  PanelRightOpen,
  Pill,
  Plus,
  Printer,
  Repeat,
  Sparkles,
  Stethoscope,
  Thermometer,
  Trash2,
} from 'lucide-react'
import { memo, type MouseEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { DEMO_PLAY_TESTID, useDemoConsultationOffered } from '../../components/capture/DemoConsultation.tsx'
import { AllergyItems } from '../../components/clinical/AllergyItems.tsx'
import { ConsultationBanner, HIDE_WHEN_COMPACT, PatientStrip } from '../../components/clinical/ConsultationBanner.tsx'
import { ConsultationHeader, useOnScreen } from '../../components/clinical/ConsultationHeader.tsx'
import { ConsultationStatus, type ToolSection } from '../../components/clinical/ConsultationStatus.tsx'
import { PastHistoryPanel } from '../../components/clinical/PastHistory.tsx'
import { PatientBanner } from '../../components/clinical/PatientBanner.tsx'
import { PatientProfileDrawer } from '../../components/clinical/PatientProfileDrawer.tsx'
import { DiscardDraftDialog, RecordVerificationCard, StatusHistoryCard } from '../../components/clinical/RecordLifecycle.tsx'
import { Timeline } from '../../components/clinical/Timeline.tsx'
import { RecordVitalsDialog, VitalsInline, VitalsTiles } from '../../components/clinical/Vitals.tsx'
import { useFocusMode } from '../../components/shell/AppShell.tsx'
import { Menu, type MenuItem } from '../../components/ui/Menu.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Dialog } from '../../components/ui/Dialog.tsx'
import { Alert, Badge, Spinner } from '../../components/ui/Feedback.tsx'
import { CheckboxField, SelectField, TextAreaField, TextField } from '../../components/ui/Form.tsx'
import { Card } from '../../components/ui/Layout.tsx'
import { PanelBoundary } from '../../components/ui/PanelBoundary.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { AnalyzeButton } from '../../components/workspace/AnalyzeButton.tsx'
import { ModuleShell, runModuleAction } from '../../components/workspace/ModuleShell.tsx'
import { ConversationMeta, ConversationSummary, useConversationModule } from '../../components/workspace/summaries/ConversationSummary.tsx'
import { HistoryMeta, HistorySummary, useHistoryModule } from '../../components/workspace/summaries/HistorySummary.tsx'
import { StethoscopeMeta, StethoscopeSummary, useStethoscopeModule } from '../../components/workspace/summaries/StethoscopeSummary.tsx'
import { ThermalMeta, ThermalSummary, useThermalModule } from '../../components/workspace/summaries/ThermalSummary.tsx'
import { useVitalsModule, VitalsMeta, VitalsSummary } from '../../components/workspace/summaries/VitalsSummary.tsx'
import { WorkflowStrip } from '../../components/workspace/WorkflowStrip.tsx'
import type { NoteSaveState } from '../../lib/analysis.ts'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { useMe, useStillSamePerson } from '../../lib/auth.tsx'
import { usePortalBase } from '../../lib/clinical.ts'
import { encounterKey, useEncounter, useStartConsultation } from '../../lib/encounters.ts'
import { fmtDate, fmtDateTime, fmtTime } from '../../lib/format.ts'
import { historyKey } from '../../lib/history.ts'
import { consultKey } from '../../lib/consult.ts'
import { contextKey } from '../../lib/consultationContext.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { isMacPlatform, isTypingTarget, type Shortcut, shortcutOf, shortcutRows } from '../../lib/shortcuts.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { medicineCount } from '../../lib/workflow.ts'
import { MODULES, type PartId, revealPart, showPart } from '../../lib/workspace.ts'

export interface Draft {
  note: NoteFields
  diagnoses: DiagnosisInput[]
  prescription: PrescriptionItemInput[]
}

/** Lets other panels (Mana, the AI assistant, the photographs) insert reviewed AI text into the note, recorded on the server. */
export type SidePanel = (e: Encounter, inserter: NoteInserter) => ReactNode

/**
 * The panels of the doctor's consultation (Doctor HERO), supplied by the doctor's route; the page lays them out. The five inputs are numbered
 * modules in the rail on the left, in the order a consultation uses them (the patient's history and the visit's own vital signs are the
 * page's); Mana and the record are on the right. Each panel is given the consultation and the one way into the note: `NoteInserter`, which
 * saves the doctor's edits first and records on the server what was inserted, from which reviewed AI output. Without any of the five (the
 * nurse's route) the page keeps its earlier layout: the visit and the patient's history beside the note.
 */
export interface ConsultationPanels {
  /** Module 1, the conversation: live transcription and the important points. */
  conversation?: SidePanel
  /** Module 3, under the visit's own vital signs: the devices attached to the patient (the health band's readings). */
  devices?: SidePanel
  /** Module 4: the stethoscope recordings. */
  stethoscope?: SidePanel
  /** Module 5 (V6): thermal imaging for this patient and this encounter, with the research view. Its summary has its own quick actions. */
  thermal?: SidePanel
  /** The Mana area: the analysis' progress, the Mana result, the consultation overview with the safety rules, and Ask Mana. */
  mana?: SidePanel
  /** Beside the prescription: "Before you prescribe" (the medication considerations, what Mana never does, the allergy name check). */
  prescriptionLane?: SidePanel
  /** Not one of the five inputs (the clinical photographs, the older assistant): in the "More tools" sheet, drawn only while it is open. */
  more?: SidePanel
}

/** Whether the route supplies the Doctor HERO workspace (the doctor's) or none of it (the nurse's, which keeps the earlier layout). */
const isHero = (p: ConsultationPanels) => !!(p.conversation || p.devices || p.stethoscope || p.thermal || p.mana)

/** Where a status chip under the banner leads: the module that owns what it says, or the Mana result for the model. */
const CHIP_PART: Record<ToolSection, PartId> = { conversation: 'tools-conversation', draft: 'mana-result', devices: 'tools-devices' }

/**
 * Brings a part of the page into view and moves focus there (lib/workspace.ts: from 1024px a part of the inputs rail moves only the rail, and
 * the page stays where the doctor left it). Still exported from here for whatever led to a part through this page before.
 */
export { showPart }

/**
 * One panel of the consultation. It is drawn again when the consultation's AI insertions change (a panel says what is already in the note),
 * not on every keystroke in the note; and a fault inside it stays inside it (see PanelBoundary). `neutral`: its fallback does not speak of
 * the note (a panel beside it, not one of the inputs).
 */
const ToolSlot = memo(function ToolSlot({ render, encounter, inserter, label, neutral }: { render: SidePanel; encounter: Encounter; inserter: NoteInserter; label: string; neutral?: boolean; insertions: NoteInsertion[] }) {
  return (
    <PanelBoundary label={label} neutral={neutral}>
      {render(encounter, inserter)}
    </PanelBoundary>
  )
})

/** The workflow strip under the header, drawn again only when what it says changes (the save state, the number of medicines). */
const Strip = memo(WorkflowStrip)

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

type SaveState = NoteSaveState

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

/** A medicine on the patient's list as a prescription row: what the list records, the duration and instructions left for the doctor. */
const rxFromMedication = (m: Pick<Medication, 'drugName' | 'strength' | 'form' | 'dose' | 'route' | 'frequency'>): PrescriptionItemInput => ({
  drugName: m.drugName,
  strength: m.strength ?? '',
  form: m.form ?? '',
  dose: m.dose,
  route: m.route ?? '',
  frequency: m.frequency,
  duration: '',
  instructions: '',
})

const medicineName = (m: Pick<Medication, 'drugName' | 'strength' | 'form'>) => [m.drugName, m.strength, m.form].filter(Boolean).join(' ')

/** The class of a secondary control drawn as a link or a menu's button, the same as the secondary Button beside it (44px). */
const SECONDARY_CONTROL = 'inline-flex min-h-control items-center gap-2 rounded-md border border-line-strong bg-surface px-4 text-sm font-medium shadow-card hover:bg-canvas'

/**
 * "Repeat a current medicine": a menu of the medicines the patient's record lists as current (the medicine list staff keep, not an earlier
 * prescription), each with its strength, form, dose and frequency as recorded. Choosing one adds a new row filled from that entry: the doctor's
 * act, and from then on the row is the doctor's to change like any other (the duration and the instructions are left for the doctor). It reads
 * the history the prescription's allergy list already reads (observed: no request of its own). Missing is not none: when the list is not read
 * yet, cannot be read, or has no current medicine, the menu says so and offers nothing.
 */
function RepeatMedicineMenu({ patientId, items, onRepeat }: { patientId: string; items: PrescriptionItemInput[]; onRepeat: (m: Medication) => void }) {
  const history = useQuery({ queryKey: historyKey(patientId), queryFn: () => api<PatientHistory>(`/patients/${patientId}/history`), enabled: false })
  const current = history.data?.medications.filter((m) => m.status === 'current') ?? null
  const prescribed = new Set(items.map((p) => (p.drugName ?? '').trim().toLowerCase()).filter(Boolean))
  const note = (text: string): MenuItem => ({ label: text, name: text, disabled: true, onSelect: () => undefined })
  const menu: MenuItem[] = !current
    ? [note(history.isError ? 'The medicine list could not be read just now' : 'The medicine list has not been read yet')]
    : !current.length
      ? [note('No current medicines recorded')]
      : current.map((m) => {
          const name = medicineName(m)
          const how = [m.dose, m.route, m.frequency].filter(Boolean).join(' · ')
          const already = prescribed.has(m.drugName.trim().toLowerCase())
          return {
            name: `${name} ${m.id}`,
            icon: <Pill aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />,
            label: (
              <span className="min-w-0 py-1.5">
                <span className="block break-words">{name}</span>
                <span className="block text-xs font-normal break-words text-ink-muted">
                  {how}
                  {m.startedOn ? ` · on the list since ${fmtDate(m.startedOn)}` : ' · on the list'}
                  {already ? ' · already in this prescription' : ''}
                </span>
              </span>
            ),
            onSelect: () => onRepeat(m),
          }
        })
  return (
    <Menu
      label="Repeat a current medicine"
      items={menu}
      align="end"
      trigger={
        <>
          <Repeat aria-hidden="true" className="size-4" />
          Repeat a current medicine
        </>
      }
      triggerClassName={SECONDARY_CONTROL}
    />
  )
}

/**
 * The doctor's prescription, written by the doctor alone: one numbered row per medicine (medicine, strength and form; dose, route, frequency
 * and duration; instructions), each field with its own label, laid out by the width of the card. Nothing an AI writes is ever put here; the
 * "Before you prescribe" lane beside it keeps the medication considerations apart. It is a draft, saved as it is written, until the
 * consultation is signed. In the doctor's workspace (`onPrintPreview`) it also offers:
 * - "Repeat a current medicine" (see RepeatMedicineMenu);
 * - "Preview & print": the click saves what is pending first (`onPrintPreview`, the page's save chain), then opens the existing print page in
 *   a new tab, so the consultation (a recording, the device readings) goes on here; that page shows what the server holds, marked there as a
 *   draft that is not a valid prescription. A click with a modifier (a new tab or window, chosen by the doctor) is left to the browser.
 * `allergyCheck`: the workspace runs the fixed rules' allergy name match when the doctor analyses, and the footer says so.
 */
function PrescriptionEditor({
  encounter,
  items,
  onChange,
  onPrintPreview,
  allergyCheck = false,
}: {
  encounter: Encounter
  items: PrescriptionItemInput[]
  onChange: (next: PrescriptionItemInput[]) => void
  onPrintPreview?: () => Promise<NoteSaveState>
  allergyCheck?: boolean
}) {
  const toast = useToast()
  const set = (i: number, patch: Partial<PrescriptionItemInput>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  // A row added by the doctor's choice ("Repeat a current medicine") takes focus once it is drawn, so the doctor goes on in it.
  const [focusRow, setFocusRow] = useState<number | null>(null)
  useEffect(() => {
    if (focusRow === null) return
    document.querySelector<HTMLInputElement>(`[data-rx-row="${focusRow}"] input`)?.focus()
    setFocusRow(null)
  }, [focusRow, items.length])
  const repeat = (m: Medication) => {
    onChange([...items, rxFromMedication(m)])
    setFocusRow(items.length)
    toast('success', `Medicine ${items.length + 1} filled from the medicine list. Check each field and add the duration.`)
  }
  const [opening, setOpening] = useState(false)
  const printUrl = `/print/encounters/${encounter.id}`
  const preview = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onPrintPreview || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    if (opening) return
    setOpening(true)
    let saved: NoteSaveState
    try {
      saved = await onPrintPreview()
    } catch {
      saved = 'error'
    } finally {
      setOpening(false)
    }
    // Opened by this click (a few hundred milliseconds after it, once saved): a browser that still blocks it is told so, with the way round it.
    const tab = window.open(printUrl, '_blank')
    if (tab) tab.opener = null
    else toast('warning', 'The browser did not open the preview in a new tab. Use Preview & print again, or allow pop-ups for this site.')
    if (saved === 'error' || saved === 'conflict' || saved === 'blocked') toast('warning', 'Your latest changes could not be saved: the preview shows what was saved before them.')
  }
  return (
    <Card
      title="Prescription"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {onPrintPreview && <RepeatMedicineMenu patientId={encounter.patient.id} items={items} onRepeat={repeat} />}
          {onPrintPreview && (
            <Link to={printUrl} target="_blank" rel="noopener" onClick={(e) => void preview(e)} aria-busy={opening || undefined} className={SECONDARY_CONTROL} data-testid="print-preview">
              {opening ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Printer aria-hidden="true" className="size-4" />}
              Preview & print
              <span className="sr-only"> the prescription (saves first, then opens in a new tab)</span>
            </Link>
          )}
          <Button variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => onChange([...items, emptyRx()])} data-rx-add>
            Add medicine
          </Button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-line bg-canvas px-3 py-2" data-testid="prescription-allergies">
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
          <li key={i} className="min-w-0 rounded-lg border border-line" data-rx-row={i}>
            <div className="flex items-center justify-between gap-2 rounded-t-lg border-b border-line bg-canvas py-1 pr-1 pl-3">
              <p className="text-sm font-semibold tabular-nums">Medicine {i + 1}</p>
              <Button size="sm" variant="ghost" aria-label={`Remove medicine ${i + 1}`} icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 p-3 @sm:grid-cols-2 @xl:grid-cols-4">
              <TextField label="Medicine" value={p.drugName ?? ''} onChange={(e) => set(i, { drugName: e.target.value })} className="@sm:col-span-2" />
              <TextField label="Strength" placeholder="500 mg" value={p.strength ?? ''} onChange={(e) => set(i, { strength: e.target.value })} />
              <TextField label="Form" placeholder="Tablet" value={p.form ?? ''} onChange={(e) => set(i, { form: e.target.value })} />
              <TextField label="Dose" placeholder="1 tablet" value={p.dose ?? ''} onChange={(e) => set(i, { dose: e.target.value })} />
              <TextField label="Route" value={p.route ?? ''} onChange={(e) => set(i, { route: e.target.value })} />
              <TextField label="Frequency" list="frequency-presets" value={p.frequency ?? ''} onChange={(e) => set(i, { frequency: e.target.value })} />
              <TextField label="Duration" placeholder="5 days" value={p.duration ?? ''} onChange={(e) => set(i, { duration: e.target.value })} />
              <TextField label="Instructions" placeholder="After food" value={p.instructions ?? ''} onChange={(e) => set(i, { instructions: e.target.value })} className="@sm:col-span-2 @xl:col-span-4" />
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-ink-muted">
        <p>
          <span className="font-medium text-ink">Finalized when you sign the consultation.</span> Until then it is a draft, saved as you write it.
        </p>
        <p>
          {allergyCheck
            ? 'No drug-interaction or dose checking is performed by this system. A fixed-rule allergy name match runs when you use Analyze with Mana (its result is under “Before you prescribe”); it is not a drug database. Check the medicines against the allergies listed here.'
            : 'No drug-interaction, allergy or dose checking is performed by this system. Check the medicines against the allergies listed here.'}
        </p>
      </div>
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

/**
 * "Keyboard shortcuts" (Shift+? or the header's menu): every key the consultation takes, named as this computer names it, and when it is not
 * taken. A table, so each key is read with what it does.
 */
function ShortcutsDialog({ open, mac, onClose }: { open: boolean; mac: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" testId="keyboard-shortcuts">
      <div className="space-y-3 text-sm">
        <table className="w-full border-collapse">
          <caption className="sr-only">Keyboard shortcuts in this consultation</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-muted">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Keys
              </th>
              <th scope="col" className="py-1.5 font-medium">
                What it does
              </th>
            </tr>
          </thead>
          <tbody>
            {shortcutRows(mac).map((r) => (
              <tr key={r.does} className="border-b border-line align-top last:border-b-0">
                <td className="py-2 pr-3 whitespace-nowrap">
                  {r.keys.map((combo, i) => (
                    <span key={i} className="inline-flex items-center gap-1">
                      {combo.map((k, j) => (
                        <span key={j} className="inline-flex items-center gap-1">
                          {j > 0 && (
                            <span aria-hidden="true" className="text-ink-muted">
                              +
                            </span>
                          )}
                          <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-line-strong bg-canvas px-1.5 py-0.5 font-sans text-xs font-semibold text-ink shadow-card">{k}</kbd>
                        </span>
                      ))}
                    </span>
                  ))}
                </td>
                <td className="py-2">
                  {r.does}
                  {r.note && <span className="block text-xs text-ink-muted">{r.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-ink-muted">Every other key is left to what you are typing and to the browser. Undo and redo in the note work as usual.</p>
      </div>
    </Dialog>
  )
}

/**
 * Publishes on `ref`'s element, as `--room`, the height between its top and the bottom of the screen, kept current as the page scrolls and
 * changes size. A sticky column uses it for its height from 1024px (see the classes that read it): where it sticks, under the bars, its
 * height is the rest of the screen; but when the page opens it starts lower (the development notice and the workflow strip are above it), and
 * a height worked out for where it sticks would put its foot, "Analyze with Mana", below the screen.
 */
function useRoomBelow(ref: RefObject<HTMLElement | null>) {
  // Before the first paint, so the column is never drawn taller than its room and then shrunk.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    let last = ''
    const apply = () => {
      frame = 0
      const room = `${Math.max(0, Math.round(window.innerHeight - Math.max(0, el.getBoundingClientRect().top)))}px`
      if (room === last) return
      last = room
      el.style.setProperty('--room', room)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply)
    }
    apply()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // What is above the column can change height (the banner as the record loads, the strip as it wraps), which moves its top.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    ro?.observe(document.body)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      ro?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref])
}

/**
 * The conversation panel's own "Play demo consultation" (its demo player, components/capture/DemoConsultation.tsx), used from the closed module:
 * the module opens, comes into view, and that button is focused and pressed (ModuleShell runModuleAction), so there is one demo player on the
 * page. When it is not there or is off (the speech service not ready, a recording running), the module is left open where the panel says why.
 */
const playDemo = () => void runModuleAction('tools-conversation', { testId: DEMO_PLAY_TESTID })

/** The inputs rail's props, all unchanged while the doctor types (see ConsultationEditor): typing in the note does not draw the rail again. */
interface InputsRailProps {
  encounter: Encounter
  panels: ConsultationPanels
  inserter: NoteInserter
  insertions: NoteInsertion[]
  save: NoteSaveState
  /** The page's save chain, resolving with the note's save state once nothing is pending (what Analyze needs before it asks anything). */
  flush: () => Promise<NoteSaveState>
  onRecordVitals: () => void
}

/**
 * The left pane of the doctor's consultation (Doctor HERO): the five inputs in the order a consultation uses them, each a numbered module
 * (components/workspace/ModuleShell.tsx) whose compact summary is always shown and whose full panel stays mounted behind "Show", so a
 * recording, the device readings and every panel's reads go on, and the summaries and the chips under the banner, which only observe those
 * reads, stay current. Then what an analysis reads and, at the foot, "Analyze with Mana". From 1024px the rail keeps its place under the
 * consultation bar and scrolls on its own: a jump to a module (the workflow strip, a chip, the overview) moves the rail, not the page, so the
 * note stays where the doctor left it; the foot is always in view. Below 1024px it is the top of one column, and the page scrolls.
 */
const InputsRail = memo(function InputsRail({ encounter, panels, inserter, insertions, save, flush, onRecordVitals }: InputsRailProps) {
  const rail = useRef<HTMLElement>(null)
  useRoomBelow(rail)
  const conversation = useConversationModule(encounter)
  const history = useHistoryModule(encounter)
  const vitals = useVitalsModule(encounter)
  const stethoscope = useStethoscopeModule(encounter)
  const thermal = useThermalModule(encounter)
  // Offered only where the panel offers it: simulators allowed (the device and thermal simulators' gate) and the recording consent present.
  const demoAllowed = useDemoConsultationOffered(encounter)
  const slot = (key: 'conversation' | 'devices' | 'stethoscope' | 'thermal', label: string) => {
    const render = panels[key]
    return render ? <ToolSlot render={render} encounter={encounter} inserter={inserter} insertions={insertions} label={label} /> : null
  }
  const p = encounter.patient
  return (
    <aside
      ref={rail}
      aria-label="Clinical inputs"
      // Sticky under the top bar and the consultation bar (which publishes its height); no taller than the room below its top (useRoomBelow).
      className="min-w-0 lg:sticky lg:top-[calc(var(--spacing-topbar)+var(--consult-header-h,0px)+0.75rem)] lg:-ml-1 lg:flex lg:max-h-[min(calc(100dvh-var(--spacing-topbar)-var(--consult-header-h,0px)-1.25rem),calc(var(--room,100dvh)-0.5rem))] lg:flex-col"
      data-testid="consultation-tools"
    >
      {/* The note is after the inputs and Mana in the reading order; a keyboard user can go straight to it (visible when focused). */}
      <button type="button" onClick={() => showPart('consultation-note')} className="sr-only rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-pop focus:not-sr-only focus:inline-flex">
        Skip to the note
      </button>
      {/* relative: the scroller is the containing block of what is absolutely placed inside it (visually hidden labels), so that it clips
          them; otherwise they escape its overflow at their place far down the column and make the page taller than the workspace,
          which carries the sticky bar away at the bottom of the page. */}
      <div data-scroller className="relative min-w-0 space-y-1.5 lg:min-h-0 lg:space-y-1.25 lg:overflow-y-auto lg:overscroll-contain lg:pr-2 lg:pb-2 lg:pl-1">
        {/* The workflow strip's "Inputs" leads here (lib/workspace.ts showPart: inside the rail, so only the rail moves). Its top is the top of
            the Mana area's heading (and of the note's, where they stand side by side). Whose inputs these are is in the bar above (the name,
            age, sex and MRN stay there while the page scrolls), so no line repeats it here: the room goes to the modules. */}
        <h2 id="consultation-inputs" tabIndex={-1} className="scroll-mt-20 rounded px-1 text-lg font-semibold focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand lg:scroll-mt-0">
          Consultation inputs
        </h2>
        <ModuleShell
          id="tools-conversation"
          title="Conversation"
          icon={Mic}
          state={conversation.state}
          // "Play demo consultation" only where the panel offers it (simulators allowed, recording consent present).
          summary={<ConversationSummary encounter={encounter} onPlayDemo={demoAllowed ? playDemo : undefined} />}
          meta={<ConversationMeta encounter={encounter} />}
        >
          {slot('conversation', 'The conversation')}
        </ModuleShell>
        <ModuleShell id="tools-history" title="History" icon={ClipboardList} state={history.state} summary={<HistorySummary encounter={encounter} />} meta={<HistoryMeta encounter={encounter} />}>
          {/* No scroller of its own: the rail scrolls. The profile is opened from the bar ("View profile" beside the MRN). */}
          <Card title="Past history" level={3} bodyClassName="p-4">
            <PastHistoryPanel patientId={p.id} bare />
          </Card>
        </ModuleShell>
        <ModuleShell
          id="tools-devices"
          // "Vitals": the band's state is the chip's ("Not connected", "Live"), its values are in the line under the title.
          title="Vitals"
          icon={HeartPulse}
          state={vitals.state}
          summary={<VitalsSummary encounter={encounter} />}
          meta={<VitalsMeta encounter={encounter} />}
        >
          {/* The dialog is the page's: "Record vitals" is with the visit's own vital signs, in the open module. */}
          <Card
            title="This visit"
            level={3}
            actions={
              <Button size="sm" variant="secondary" icon={<Plus aria-hidden="true" className="size-4" />} onClick={onRecordVitals}>
                Record vitals
              </Button>
            }
          >
            <VitalsTiles vitals={encounter.vitals} />
          </Card>
          {slot('devices', 'The device readings')}
        </ModuleShell>
        <ModuleShell id="tools-stethoscope" title="Stethoscope" icon={Stethoscope} state={stethoscope.state} summary={<StethoscopeSummary encounter={encounter} />} meta={<StethoscopeMeta encounter={encounter} />}>
          {slot('stethoscope', 'The stethoscope recordings')}
        </ModuleShell>
        <ModuleShell
          id="tools-thermal"
          title="Thermal imaging"
          icon={Thermometer}
          state={thermal.state}
          // The summary has its own quick actions (Capture thermal or Open thermal, and Research), shown while the module is closed: the
          // full panel has the same ones once it is open, so each is on the screen once.
          summary={<ThermalSummary encounter={encounter} />}
          meta={<ThermalMeta encounter={encounter} />}
        >
          {slot('thermal', 'Thermal imaging')}
        </ModuleShell>
      </div>
      {/* The foot: "Analyze with Mana", and one line that opens what an analysis reads from each input (marks, never progress). */}
      <div className="min-w-0 pt-2 lg:shrink-0 lg:border-t lg:border-line lg:pt-1 lg:pr-2 lg:pl-1">
        <AnalyzeButton encounter={encounter} flush={flush} save={save} />
      </div>
    </aside>
  )
})

/**
 * The Mana area's column. Where the right-hand side is wide enough for Mana and the record side by side (from 72rem of its own width: a
 * 1920px screen), it keeps its place under the consultation bar and scrolls on its own, as the inputs rail does, so the draft stays in view
 * while the doctor writes the note beside it. Narrower, it is the top of the right-hand side and the page scrolls.
 */
function ManaColumn({ children }: { children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null)
  useRoomBelow(column)
  return (
    <div
      ref={column}
      data-scroller
      className="relative min-w-0 @min-[72rem]/main:sticky @min-[72rem]/main:top-[calc(var(--spacing-topbar)+var(--consult-header-h,0px)+0.75rem)] @min-[72rem]/main:-ml-1 @min-[72rem]/main:max-h-[min(calc(100dvh-var(--spacing-topbar)-var(--consult-header-h,0px)-1.25rem),calc(var(--room,100dvh)-0.5rem))] @min-[72rem]/main:self-start @min-[72rem]/main:overflow-y-auto @min-[72rem]/main:overscroll-contain @min-[72rem]/main:pr-2 @min-[72rem]/main:pb-4 @min-[72rem]/main:pl-1"
    >
      {children}
    </div>
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
  const [moreOpen, setMoreOpen] = useState(false)
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
            // The overview lists what is in the note: it reads the consultation again now, not at its next refresh.
            void qc.invalidateQueries({ queryKey: contextKey(initial.id) })
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
  const hero = isHero(panels)
  const noteHeadingId = useId()
  // What the rail is given does not change while the doctor types, so that typing in the note does not draw the five inputs again.
  const flushForAnalysis = useCallback(async (): Promise<NoteSaveState> => {
    await flush()
    return stateRef.current
  }, [flush])
  const openVitals = useCallback(() => setVitalsOpen(true), [])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const mac = useMemo(() => isMacPlatform(typeof navigator === 'undefined' ? '' : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)), [])
  const menu: MenuItem[] = [
    // The banner's own "View profile" is hidden while the bar is compact (scrolled): the profile is always here as well.
    { label: 'View profile', icon: <IdCard aria-hidden="true" className="size-4" />, onSelect: () => setProfileOpen(true) },
    ...(hero ? [{ label: 'Keyboard shortcuts', icon: <Keyboard aria-hidden="true" className="size-4" />, onSelect: () => setShortcutsOpen(true) }] : []),
    // Not one of the five inputs: the clinical photographs and the older assistant, in a sheet beside the consultation.
    ...(panels.more ? [{ label: 'More tools…', icon: <PanelRightOpen aria-hidden="true" className="size-4" />, onSelect: () => setMoreOpen(true) }] : []),
    // Closing a draft without signing is deliberate, so it is kept away from the save and complete buttons.
    { label: 'Discard draft…', tone: 'danger', icon: <Trash2 aria-hidden="true" className="size-4" />, disabled: locked, onSelect: () => void flush().then(() => setDiscarding(true)) },
  ]

  /*
   * The doctor's keyboard shortcuts (lib/shortcuts.ts says which key does what and when a key is left to the doctor's typing): save now,
   * Analyze with Mana, open and go to one of the five modules, the note, the prescription, and the list of them. One listener for the page, on
   * the document; what it does is read from the latest render, so it never acts on an old note.
   */
  const doShortcut = useRef<(s: Shortcut) => void>(() => undefined)
  doShortcut.current = (s) => {
    if (s.kind === 'save') return void flush()
    if (s.kind === 'help') return setShortcutsOpen(true)
    if (s.kind === 'module') return void revealPart(MODULES[s.n - 1]!.part)
    if (s.kind === 'note') {
      // The note's first field, with the caret after what is already written there.
      showPart('consultation-note')
      const field = document.querySelector<HTMLTextAreaElement>('#consultation-note textarea')
      field?.focus({ preventScroll: true })
      return field?.setSelectionRange(field.value.length, field.value.length)
    }
    if (s.kind === 'prescription') {
      // The first medicine's first field, or "Add medicine" when there is none yet.
      showPart('rx')
      return (document.querySelector<HTMLElement>('#rx [data-rx-row] input') ?? document.querySelector<HTMLElement>('#rx [data-rx-add]'))?.focus({ preventScroll: true })
    }
    // Analyze with Mana: the rail's own button, pressed where the doctor is (focus stays in the note); when it is off, why is said.
    const analyze = document.querySelector<HTMLButtonElement>('[data-testid="analyze-mana"]')
    if (!analyze) return
    if (!analyze.disabled) return analyze.click()
    if (analyze.dataset.state === 'running') return toast('warning', 'Mana is already analyzing this consultation.')
    const why = document.querySelector('[data-testid="analyze-reason"]')?.textContent?.trim()
    toast('warning', why ? `Analyze with Mana is not available: ${why}` : 'Analyze with Mana is not available just now.')
  }
  useEffect(() => {
    if (!hero) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const s = shortcutOf(
        { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: e.getModifierState?.('AltGraph') ?? false, isComposing: e.isComposing, defaultPrevented: e.defaultPrevented },
        // A dialog over the page, or an open menu: nothing behind it is jumped to (Ctrl+S still saves).
        { typing: isTypingTarget(target), mac, dialogOpen: !!document.querySelector('dialog[open], [role="menu"]') },
      )
      if (!s) return
      e.preventDefault()
      // Held down: taken (so the browser does not act on it either) but done once.
      if (e.repeat) return
      doShortcut.current(s)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hero, mac])

  // The record: what the doctor writes, and the only part of the page that becomes the signed consultation.
  const noteFields = (
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
  )
  const record = (
    <>
      {hero ? (
        // The doctor's workspace: the note's heading stands above it as the Mana area's does (an h2 and a line), so the tops of the panes'
        // headings line up; the region is still named "Consultation note".
        <section id="consultation-note" tabIndex={-1} aria-labelledby={noteHeadingId} className="scroll-mt-20 space-y-4 rounded-xl focus:outline-none">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <h2 id={noteHeadingId} className="text-lg font-semibold">
                Consultation note
              </h2>
              <p className="text-sm text-ink-muted">Yours to write. With the diagnosis and the prescription, it is what you sign.</p>
            </div>
            {inserting && <Badge tone="ai">Inserting AI text…</Badge>}
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-surface p-5 shadow-card">{noteFields}</div>
        </section>
      ) : (
        <div id="consultation-note" tabIndex={-1} className="scroll-mt-20 focus:outline-none">
          <Card title="Consultation note" actions={inserting ? <Badge tone="ai">Inserting AI text…</Badge> : undefined}>
            {noteFields}
          </Card>
        </div>
      )}
      <DiagnosesEditor items={draft.diagnoses} onChange={(diagnoses) => update((d) => ({ ...d, diagnoses }))} />
      {hero ? (
        // The prescription, with "Before you prescribe" under it; beside it only where the record is wide enough for both (64rem), so the
        // lane never stands as a tall column next to a short prescription. The prescription lays its fields out by its own width.
        <div id="rx" tabIndex={-1} className="@container/rx min-w-0 scroll-mt-20 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
          <div className="grid grid-cols-1 gap-4 @min-[64rem]/rx:grid-cols-[minmax(0,1fr)_22rem] @min-[64rem]/rx:items-start">
            <div className="@container min-w-0">
              <PrescriptionEditor encounter={initial} items={draft.prescription} onChange={(prescription) => update((d) => ({ ...d, prescription }))} onPrintPreview={flushForAnalysis} allergyCheck />
            </div>
            {panels.prescriptionLane && <ToolSlot render={panels.prescriptionLane} encounter={initial} inserter={toolInserter} insertions={insertions} label="Before you prescribe" neutral />}
          </div>
        </div>
      ) : (
        <PrescriptionEditor encounter={initial} items={draft.prescription} onChange={(prescription) => update((d) => ({ ...d, prescription }))} />
      )}
    </>
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
            <ConsultationBanner encounter={initial} onOpenProfile={() => setProfileOpen(true)} status={<ConsultationStatus encounterId={initial.id} patientId={initial.patient.id} onSelect={(s) => revealPart(CHIP_PART[s])} />} />
          </div>
        }
        actions={
          <>
            <SaveIndicator state={state} savedAt={savedAt} />
            {/* While the bar is compact (scrolled, from 1024px) the save state stays and Save gives way: Ctrl+S and the autosave still save. */}
            <Button variant="secondary" onClick={() => void flush()} disabled={state === 'saved' || locked} aria-keyshortcuts={hero ? (mac ? 'Meta+S' : 'Control+S') : undefined} className={HIDE_WHEN_COMPACT}>
              Save
            </Button>
            <Button onClick={() => setReviewing(true)} disabled={locked}>
              Complete consultation
            </Button>
            <Menu label="More consultation actions" items={menu} triggerClassName="inline-flex size-control items-center justify-center rounded-md border border-transparent text-ink-muted hover:bg-surface hover:text-ink" />
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
      {hero ? (
        <>
          {/* The story of the consultation, each step with the state it is in now and a way to its part of the page. */}
          <div className="mb-3">
            <Strip encounter={initial} save={state} medicines={medicineCount(draft.prescription)} />
          </div>
          {/*
            Inputs, then intelligence and action (Doctor HERO): from 1024px two panes, the five inputs on the left and, on the right, Mana (the
            analysis, the model's draft, the fixed rules' checks, Ask Mana) above the record (note, diagnosis, prescription). Where the right
            side is itself wide (72rem: a 1920px screen) Mana and the record stand side by side, each no wider than a line can be read. Below
            1024px one column, in the same order. Every input panel stays mounted: a recording, the device readings and the draft keep running
            while the doctor works elsewhere.
          */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)] 2xl:grid-cols-[24rem_minmax(0,1fr)]">
            <InputsRail encounter={initial} panels={panels} inserter={toolInserter} insertions={insertions} save={state} flush={flushForAnalysis} onRecordVitals={openVitals} />
            <div className="@container/main min-w-0">
              <div className="grid grid-cols-1 gap-6 @min-[72rem]/main:grid-cols-[minmax(0,46rem)_minmax(0,46rem)]">
                <ManaColumn>{panels.mana && <ToolSlot render={panels.mana} encounter={initial} inserter={toolInserter} insertions={insertions} label="The Mana area" neutral />}</ManaColumn>
                {/* The editors inside lay themselves out by the width of this column (container queries). */}
                <div className="@container min-w-0 space-y-6">{record}</div>
              </div>
            </div>
          </div>
        </>
      ) : (
        // No panels (the nurse's route): the earlier layout, the visit and the patient's history beside the note.
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
            {/* relative: the scroller clips what is absolutely placed inside it (visually hidden labels); see the inputs rail. */}
            <div data-scroller className="relative min-w-0 space-y-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-2 lg:pb-4 lg:pl-1">
              <div
                id="tools-history"
                role="group"
                aria-label="History"
                tabIndex={-1}
                className="scroll-mt-20 space-y-6 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand lg:scroll-mt-0"
              >
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
              </div>
            </div>
          </aside>
          {/* The editors inside lay themselves out by the width of this column (container queries). */}
          <div className="@container min-w-0 space-y-6">{record}</div>
        </div>
      )}
      {/* Room for the actions that stay at the bottom of the screen below 1024px: as tall as that bar actually is. */}
      <div aria-hidden="true" className="lg:hidden" style={{ height: 'calc(var(--action-bar-h, 7rem) + 1rem)' }} />
      <PatientProfileDrawer patientId={initial.patient.id} open={profileOpen} onClose={() => setProfileOpen(false)} />
      {panels.more && (
        // On demand, so drawn only while open (nothing else on the page reads what these panels read).
        <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More tools" placement="right" wide testId="more-tools">
          <div className="space-y-6">
            <p className="text-sm text-ink-muted">Tools that are not among the five inputs. They are drawn only while this sheet is open.</p>
            <ToolSlot render={panels.more} encounter={initial} inserter={toolInserter} insertions={insertions} label="More tools" />
          </div>
        </Dialog>
      )}
      {discarding && (
        <DiscardDraftDialog
          draft={{ id: initial.id, version: versionRef.current, patientName: initial.patient.fullName, visitStatus: initial.visit.status }}
          onClose={() => setDiscarding(false)}
          // Nothing more to save: the page now shows the discarded draft read-only.
          onDiscarded={() => (dirtyRef.current = false)}
        />
      )}
      {hero && <ShortcutsDialog open={shortcutsOpen} mac={mac} onClose={() => setShortcutsOpen(false)} />}
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
  // While the doctor writes it, the consultation has the whole screen (the navigation a drawer at every width); the read view keeps the frame
  // it had. Until the consultation is read, as its route says.
  useFocusMode(q.data ? q.data.canEdit && isHero(panels) : null)
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
