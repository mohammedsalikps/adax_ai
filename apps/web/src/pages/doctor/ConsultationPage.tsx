import { AmendmentRequest, type Encounter, NOTE_SECTIONS, VISIT_STATUS_LABELS } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, Images, Keyboard, LayoutList, NotebookPen, Printer, Stethoscope, Trash2 } from 'lucide-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { ConsultationHeader } from '../../components/clinical/ConsultationHeader.tsx'
import { ConsultationOverview } from '../../components/clinical/ConsultationOverview.tsx'
import { PatientBanner } from '../../components/clinical/PatientBanner.tsx'
import { PatientProfileDrawer, type ProfileDrawerTab } from '../../components/clinical/PatientProfileDrawer.tsx'
import { DiscardDraftDialog, RecordVerificationCard, StatusHistoryCard } from '../../components/clinical/RecordLifecycle.tsx'
import { Timeline } from '../../components/clinical/Timeline.tsx'
import { VitalsInline } from '../../components/clinical/Vitals.tsx'
import { BottomBar } from '../../components/hero/BottomBar.tsx'
import { Panel, PanelGroup } from '../../components/hero/Panel.tsx'
import { Sheet } from '../../components/hero/Sheet.tsx'
import { StatusPill } from '../../components/hero/StatusPill.tsx'
import { OrderServiceButton } from '../../components/orders/OrderServiceButton.tsx'
import { ServiceOrdersList } from '../../components/orders/ServiceOrdersList.tsx'
import { ManaPanel } from '../../components/mana/ManaPanel.tsx'
import { PatientHistoryPanel } from '../../components/patients/PatientHistoryPanel.tsx'
import { HandwritingPad } from '../../components/pen/HandwritingPad.tsx'
import { AiProvenance } from '../../components/rx/AiProvenance.tsx'
import { SignedActions } from '../../components/rx/CompleteConsultation.tsx'
import { SaveIndicator } from '../../components/rx/SaveIndicator.tsx'
import { useFocusMode } from '../../components/shell/AppShell.tsx'
import { Button } from '../../components/ui/Button.tsx'
import { Dialog } from '../../components/ui/Dialog.tsx'
import { Alert, Badge, Spinner } from '../../components/ui/Feedback.tsx'
import { TextAreaField, TextField } from '../../components/ui/Form.tsx'
import { Card } from '../../components/ui/Layout.tsx'
import type { MenuItem } from '../../components/ui/Menu.tsx'
import { PanelBoundary } from '../../components/ui/PanelBoundary.tsx'
import { TabPanel, Tabs } from '../../components/ui/Tabs.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { ClinicalInputs } from '../../components/workspace/ClinicalInputs.tsx'
import { GeneratePrescription, ManaReads } from '../../components/workspace/GeneratePrescription.tsx'
import { LiveTranscription } from '../../components/workspace/LiveTranscription.tsx'
import { ThermalContext } from '../../components/workspace/ThermalContext.tsx'
import { ApiError, api, errorMessage } from '../../lib/api.ts'
import { useMe } from '../../lib/auth.tsx'
import { usePortalBase } from '../../lib/clinical.ts'
import { useEncounterDraft, useFreshDraftGate } from '../../lib/encounterDraft.ts'
import { encounterKey, useEncounter, useStartConsultation } from '../../lib/encounters.ts'
import { fmtDate, fmtDateTime } from '../../lib/format.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { openMana } from '../../lib/manaLauncher.ts'
import { durationLines } from '../../lib/prescriptionCourse.ts'
import { isMacPlatform, isTypingTarget, type Shortcut, shortcutOf, shortcutRows } from '../../lib/shortcuts.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { elsewhereOf, type PartId, showPart, WORKSPACE_PANELS, workspaceDocument } from '../../lib/workspace.ts'

export type { Draft } from '../../lib/draftSaver.ts'

/** Lets other panels (the clinical photographs, the older assistant) insert reviewed AI text into the note, recorded on the server. */
export type SidePanel = (e: Encounter, inserter: NoteInserter) => ReactNode

/**
 * What the doctor's route adds to the consultation workspace beyond the five inputs, which the page composes itself (DESIGN §5.4): `more`, the
 * tools that are not among the five inputs (the clinical photographs, the older AI assistant), in a sheet from the header's ⋯ menu, drawn only
 * while it is open. The nurse's route gives none and only ever reads a consultation (the read view).
 */
export interface ConsultationPanels {
  more?: SidePanel
}

/** Brings a part of the page into view and moves focus there (lib/workspace.ts). Still exported from here for whatever led to a part through this page before. */
export { showPart }

/** Where AI-produced text in the note came from (components/rx/AiProvenance.tsx; still exported from here). */
export { AiProvenance }

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

/** A place a jump (Alt+1..5, the overview's evidence) can lead to: focusable, so a keyboard user arrives with it. */
const PART = 'min-w-0 rounded-xl focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand'

interface InputPanelsProps {
  encounter: Encounter
  inserter: NoteInserter
  autoRecord: boolean
  onProfile: (tab: ProfileDrawerTab) => void
}

/**
 * The workspace's three columns above the fold (DESIGN §5.4): the live transcription, the clinical inputs (with the stethoscope) and the patient
 * history with this consultation's orders. One grid for every width, placed by CSS only: from 1280px 5 / 3 / 4 of 12 columns, with the doctor
 * notes (8) and the thermal context (4) below; from 1024px two columns, the transcription then the notes (7) beside the inputs, the history and
 * the thermal context stacked (5); below, one column in the page's order (transcription, inputs, history, notes, thermal).
 * Each panel is mounted once and never moves between parents, so the recording, the device readings poller (inside ClinicalInputs) and the
 * reads go on whatever the width. Its props do not change while the doctor types, so typing never draws them again.
 */
const InputPanels = memo(function InputPanels({ encounter, inserter, autoRecord, onProfile }: InputPanelsProps) {
  const e = encounter
  return (
    <>
      <div id="tools-conversation" tabIndex={-1} className={`${PART} lg:col-span-7 lg:col-start-1 lg:row-start-1 xl:col-span-5`}>
        <PanelBoundary label="The live transcription">
          <LiveTranscription encounter={e} inserter={inserter} autoRecord={autoRecord} />
        </PanelBoundary>
      </div>
      <div id="tools-devices" tabIndex={-1} className={`${PART} lg:col-span-5 lg:col-start-8 lg:row-start-1 xl:col-span-3 xl:col-start-6`}>
        <PanelBoundary label="The clinical inputs">
          <ClinicalInputs encounter={e} />
        </PanelBoundary>
      </div>
      <div id="tools-history" tabIndex={-1} className={`${PART} lg:col-span-5 lg:col-start-8 lg:row-start-3 xl:col-span-4 xl:col-start-9 xl:row-start-2`}>
        <PanelBoundary label="The patient history" neutral>
          <PatientHistoryPanel encounter={e} onViewDetails={() => onProfile('history')} onDocuments={() => onProfile('documents')}>
            <PanelGroup label="Orders" actions={<OrderServiceButton encounterId={e.id} patientId={e.patient.id} />}>
              <ServiceOrdersList encounterId={e.id} patientId={e.patient.id} compact />
            </PanelGroup>
          </PatientHistoryPanel>
        </PanelBoundary>
      </div>
    </>
  )
})

type NotesTab = 'pen' | 'keyboard'

/**
 * The doctor's note in the workspace (jury design): five plain sections in the brief's order, on the note's own fields. Medical history and
 * follow-up stay on the prescription page's clinical note; nothing is lost (the same fields, the same autosave).
 */
const WORKSPACE_NOTE = (['chiefComplaint', 'history', 'examination', 'assessment', 'plan'] as const).map((key) => {
  const s = NOTE_SECTIONS.find((x) => x.key === key)!
  return { ...s, label: key === 'examination' ? 'Clinical findings (examination)' : s.label, rows: key === 'chiefComplaint' ? 2 : 3 }
})

/** The menu's sheets. */
type SheetKind = 'overview' | 'more' | null

/**
 * The doctor's consultation workspace (DESIGN §5.4): the compact sticky header, the five inputs (live transcription, clinical inputs with the
 * stethoscope, patient history with the orders; then the doctor notes and the thermal context), and the bottom bar with the save state, what
 * Mana reads, [Order service] and [Generate prescription]. The draft (the typed note) is saved as it is written (lib/encounterDraft.ts, shared
 * with the prescription page), which also registers Mana's draft bridge here. The diagnosis and the prescription are on the prescription page.
 */
function ConsultationEditor({ initial, panels }: { initial: Encounter; panels: ConsultationPanels }) {
  // The consultation as the server last answered (the query's data: a stable reference between reads, so the memoised panels keep theirs).
  const encounter = initial
  const qc = useQueryClient()
  const toast = useToast()
  const base = usePortalBase()
  const navigate = useNavigate()
  const location = useLocation()
  // A NEW Start consultation asks the live transcription to record by itself; the request is read once, then cleared from the history so a
  // reload never starts a recording (the panel reads it only when it first mounts).
  const [autoRecord] = useState(() => !!(location.state as { autoRecord?: unknown } | null)?.autoRecord)
  const cleared = useRef(false)
  useEffect(() => {
    if (!autoRecord || cleared.current) return
    cleared.current = true
    navigate(location.pathname, { replace: true, state: {} })
  }, [autoRecord, navigate, location.pathname])

  const editor = useEncounterDraft(initial)
  const { draft, state, savedAt, insertions, inserting, blocked, update, flush, locked } = editor
  const inserter = editor.inserter
  const [profileTab, setProfileTab] = useState<ProfileDrawerTab | null>(null)
  const openProfile = useCallback((tab: ProfileDrawerTab) => setProfileTab(tab), [])
  const [notesTab, setNotesTab] = useState<NotesTab>('keyboard')
  const [sheet, setSheet] = useState<SheetKind>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const mac = useMemo(() => isMacPlatform(typeof navigator === 'undefined' ? '' : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)), [])
  const prescriptionUrl = `${base}/encounters/${encounter.id}/prescription`
  // The drawer links uploads to this consultation only while it is the doctor's own draft in progress (never a signed or read-only one).
  const ownDraft = encounter.canEdit && encounter.status === 'in_progress' && !locked
  const typedNote = NOTE_SECTIONS.some((s) => draft.note[s.key].trim() !== '')

  const menu: MenuItem[] = [
    { label: 'Consultation overview', icon: <LayoutList aria-hidden="true" className="size-4" />, onSelect: () => setSheet('overview') },
    // Not one of the five inputs: the clinical photographs and the older assistant, in a sheet beside the consultation.
    ...(panels.more ? [{ label: 'Clinical photographs', icon: <Images aria-hidden="true" className="size-4" />, onSelect: () => setSheet('more') }] : []),
    { label: 'Keyboard shortcuts', icon: <Keyboard aria-hidden="true" className="size-4" />, onSelect: () => setShortcutsOpen(true) },
    // Closing a draft without signing is deliberate, so it is kept apart from the bottom bar's actions.
    { label: 'Discard draft…', tone: 'danger', icon: <Trash2 aria-hidden="true" className="size-4" />, disabled: locked, onSelect: () => void flush().then(() => setDiscarding(true)) },
  ]

  /** Brings a part of the workspace into view (the stethoscope through its panel's own element), or goes where it now lives. */
  const goTo = useCallback(
    (part: PartId) => {
      const elsewhere = elsewhereOf(part)
      if (elsewhere === 'mana') return void openMana()
      if (elsewhere === 'prescription') return void navigate(prescriptionUrl)
      showPart(part, workspaceDocument())
    },
    [navigate, prescriptionUrl],
  )

  /** The typed note's first field, with the caret after what is already written there. */
  const writeTyped = () => {
    flushSync(() => setNotesTab('keyboard'))
    goTo('consultation-note')
    const field = document.querySelector<HTMLTextAreaElement>('#consultation-note [role="tabpanel"]:not([hidden]) textarea')
    field?.focus({ preventScroll: true })
    field?.setSelectionRange(field.value.length, field.value.length)
  }

  /*
   * The doctor's keyboard shortcuts (lib/shortcuts.ts says which key does what and when a key is left to the doctor's typing): save now,
   * Generate prescription, go to one of the five panels, write in the typed note, and the list of them. One listener for the page, on the
   * document; what it does is read from the latest render.
   */
  const doShortcut = useRef<(s: Shortcut) => void>(() => undefined)
  doShortcut.current = (s) => {
    if (s.kind === 'save') return void flush()
    if (s.kind === 'help') return setShortcutsOpen(true)
    if (s.kind === 'panel') return goTo(WORKSPACE_PANELS[s.n - 1]!.part)
    if (s.kind === 'note') return writeTyped()
    // Generate prescription: the bottom bar's own button, pressed where the doctor is; when it is off, why is said.
    const generate = document.querySelector<HTMLButtonElement>('[data-testid="analyze-mana"]')
    if (!generate) return
    if (!generate.disabled) return generate.click()
    const why = document.querySelector('[data-testid="analyze-reason"]')?.textContent?.trim()
    toast('warning', why ? `Generate prescription is not available: ${why}` : 'Generate prescription is not available just now.')
  }
  useEffect(() => {
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
  }, [mac])

  // The typed note: what the doctor writes, with the same section labels as always (and as the prescription page's clinical note).
  const noteFields = (
    <div className="space-y-4">
      {WORKSPACE_NOTE.map((s) => (
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

  return (
    <>
      <ConsultationHeader encounter={encounter} backTo={`${base}/queue`} onOpenProfile={() => setProfileTab('overview')} onViewHistory={() => setProfileTab('history')} menu={menu} />
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
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12 lg:grid-rows-[auto_auto_auto_1fr] xl:grid-rows-[auto_1fr] xl:gap-5" data-testid="consultation-workspace">
        <InputPanels encounter={encounter} inserter={inserter} autoRecord={autoRecord} onProfile={openProfile} />
        {/* Mana docked in the right column (jury design, screen 3); nothing is asked of the server until the doctor uses it. */}
        <div id="mana-panel" tabIndex={-1} className={`${PART} lg:col-span-5 lg:col-start-8 lg:row-start-2 xl:col-span-4 xl:col-start-9 xl:row-start-1`}>
          <PanelBoundary label="Mana" neutral>
            <ManaPanel encounter={encounter} />
          </PanelBoundary>
        </div>
        <div id="consultation-note" tabIndex={-1} className={`${PART} lg:col-span-7 lg:col-start-1 lg:row-span-3 lg:row-start-2 xl:col-span-5 xl:col-start-1 xl:row-span-1 xl:row-start-2`}>
          <Panel
            label="Doctor’s note"
            icon={NotebookPen}
            testId="doctor-notes"
            actions={
              <>
                {inserting && <Badge tone="ai">Inserting AI text…</Badge>}
                <Tabs
                  label="Doctor notes"
                  prefix="doctor-notes"
                  variant="pill"
                  tabs={[
                    { id: 'keyboard', label: 'Keyboard' },
                    { id: 'pen', label: 'Handwriting' },
                  ]}
                  value={notesTab}
                  onChange={setNotesTab}
                />
              </>
            }
          >
            <TabPanel prefix="doctor-notes" id="pen" active={notesTab === 'pen'} focusable={false}>
              {/* Mounted only while its tab is open: each unmount is the pad's final save; the next mount reads the latest version. */}
              {notesTab === 'pen' && <HandwritingPad encounterId={encounter.id} patientId={encounter.patient.id} readOnly={!encounter.canEdit} />}
            </TabPanel>
            <TabPanel prefix="doctor-notes" id="keyboard" active={notesTab === 'keyboard'} focusable={false}>
              {noteFields}
            </TabPanel>
          </Panel>
        </div>
        <div id="tools-thermal" tabIndex={-1} className={`${PART} lg:col-span-5 lg:col-start-8 lg:row-start-4 xl:col-span-3 xl:col-start-6 xl:row-start-2`}>
          <PanelBoundary label="The thermal context" neutral>
            <ThermalContext encounter={encounter} inserter={inserter} />
          </PanelBoundary>
        </div>
      </div>

      <PatientProfileDrawer patientId={encounter.patient.id} open={profileTab !== null} initialTab={profileTab ?? 'overview'} encounterId={ownDraft ? encounter.id : undefined} onClose={() => setProfileTab(null)} />
      <Sheet open={sheet === 'overview'} onClose={() => setSheet(null)} title="Consultation overview" subtitle="From the record and the fixed rules; never AI." width="wide" testId="consultation-overview-sheet">
        <PanelBoundary label="The consultation overview" neutral>
          <ConsultationOverview
            encounter={encounter}
            safetyRules
            onJump={(part) => {
              setSheet(null)
              // After the sheet has closed and given focus back, so the jump's own focus stays.
              requestAnimationFrame(() => goTo(part))
            }}
          />
        </PanelBoundary>
      </Sheet>
      {panels.more && (
        // On demand, so drawn only while open (nothing else on the page reads what these panels read).
        <Sheet open={sheet === 'more'} onClose={() => setSheet(null)} title="Clinical photographs" subtitle="And the older AI consultation assistant. Not among the five inputs." width="wide" testId="more-tools">
          <PanelBoundary label="More tools">{panels.more(encounter, inserter)}</PanelBoundary>
        </Sheet>
      )}
      {discarding && (
        <DiscardDraftDialog
          draft={{ id: initial.id, version: editor.saver.version, patientName: initial.patient.fullName, visitStatus: initial.visit.status }}
          onClose={() => setDiscarding(false)}
          // Nothing more to save: the page now shows the discarded draft read-only.
          onDiscarded={() => editor.saver.markClean()}
        />
      )}
      <ShortcutsDialog open={shortcutsOpen} mac={mac} onClose={() => setShortcutsOpen(false)} />
      {/* The page's only --action-bar-h publisher (the global Mana button sits above it). */}
      <BottomBar
        label="Consultation actions"
        testId="consultation-actions"
        start={
          <>
            <SaveIndicator state={state} savedAt={savedAt} />
            <span aria-hidden="true">·</span>
            <ManaReads encounter={encounter} typedNote={typedNote} />
          </>
        }
      >
        <OrderServiceButton encounterId={encounter.id} patientId={encounter.patient.id} />
        <GeneratePrescription encounter={encounter} flush={editor.flushState} save={state} prescriptionUrl={prescriptionUrl} mac={mac} />
      </BottomBar>
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
          {signed && e.completedAt && <Badge tone="ok">Completed {fmtDateTime(e.completedAt)}</Badge>}
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
      {signed && e.canComplete && (
        // Signed, and the visit is still with this doctor (DESIGN §5.6, §17B): printing never completes it; Complete consultation does.
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/25 bg-brand-soft px-4 py-3" data-testid="signed-to-complete">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusPill status="signed_to_complete" />
            <span>Print the prescription, then complete the consultation when you are done with the patient.</span>
          </p>
          <SignedActions encounter={e} print={false} />
        </div>
      )}
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
                  <dd className="mt-0.5 whitespace-pre-wrap">{e.note[s.key] || <span className="text-ink-muted">Not recorded</span>}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Handwritten notes">
            {/* View only: the pages as last saved (the pad saves while the doctor writes; nothing is written after signing). */}
            <HandwritingPad encounterId={e.id} patientId={e.patient.id} readOnly />
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
                {e.prescription.map((p, i) => {
                  // The course as the printout says it ("5 days from 6 Oct 2026"), else the duration as written.
                  const course = durationLines(p)
                  return (
                    <li key={i}>
                      <strong>{[p.drugName, p.strength, p.form].filter(Boolean).join(' ')}</strong> — {p.dose}, {p.route}, {p.frequency}, {course.main}
                      {course.written && ` (${course.written})`}
                      {p.instructions && `; ${p.instructions}`}
                    </li>
                  )
                })}
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
          {/* Engineering detail, never in the main view (DESIGN §1): behind a "Details" disclosure. */}
          {signed && e.contentHash && (
            <details className="text-xs text-ink-muted" data-testid="record-details">
              <summary className="inline-flex min-h-control-sm cursor-pointer items-center rounded-md font-medium hover:text-ink">Details</summary>
              <p className="mt-1">
                Integrity hash (SHA-256 of the signed content): <span className="font-mono break-all">{e.contentHash}</span>
              </p>
            </details>
          )}
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

/** A consultation: the doctor's workspace (the doctor who is writing it), or the record read-only (everyone else, and after signing). */
export function ConsultationPage({ panels = {} }: { panels?: ConsultationPanels }) {
  const { encounterId } = useParams()
  const q = useEncounter(encounterId)
  const navigate = useNavigate()
  // The editor opens on a read made after the page opened, and after the last save of an editor of this consultation that went away (the
  // prescription page), so it never starts from an older version (lib/encounterDraft.ts).
  const ready = useFreshDraftGate(encounterId, q)
  useDocumentTitle(q.data ? `Consultation · ${q.data.patient.fullName}` : 'Consultation')
  // While the doctor writes it, the consultation has the whole screen (the navigation a drawer at every width); the read view keeps the frame
  // it had. Until the consultation is read, as its route says. (Only the consultation's own doctor can edit it: the nurse's route reads.)
  useFocusMode(q.data ? q.data.canEdit : null)
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
  if (q.data.canEdit && !ready) return <Spinner label="Opening the latest version…" />
  return q.data.canEdit ? <ConsultationEditor key={q.data.id} initial={q.data} panels={panels} /> : <EncounterReadView key={q.data.id} e={q.data} />
}
