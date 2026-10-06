import type { PendingReview } from '@adaxai/contracts'
import type { AnalysisFacts, DraftView, NoteSaveState, Tone } from './analysis.ts'
import type { ModuleKey, PartId } from './workspace.ts'

/*
 * The workflow strip at the top of the consultation (Doctor HERO): 1 Inputs → 2 Mana analysis → 3 Your review → 4 Note & prescription → 5 Sign,
 * each with the state it is in now. Every word comes from data the page already holds (the panels' queries, read as observers; the save state;
 * the prescription rows): the strip asks for nothing of its own and never says more than those say. Pure, so that it can be tested without a
 * browser.
 */

/**
 * What the page knows of each input module, as counts; null when that module's data has not been read on this screen. `simulated` counts items
 * a simulator made (never a measurement); the rest are real.
 */
export interface InputModuleFacts {
  conversation: { transcripts: number; points: number } | null
  history: { entries: number; allergyStatusRecorded: boolean } | null
  vitals: { staff: number; device: number; simulated: number } | null
  stethoscope: { recordings: number; simulated: number } | null
  thermal: { images: number; simulated: number } | null
}

/** One module's fill: whether it holds anything, and whether all it holds is simulated. */
export interface ModuleFill {
  key: ModuleKey
  filled: boolean
  simulatedOnly: boolean
}

/**
 * Which modules hold information. A module counts when it has any item: a transcript or a point; a history with at least one entry or a
 * recorded allergy status; a staff vital sign or a device reading; a stethoscope recording; a thermal image. A module whose only items are
 * simulated counts, and says so (`simulatedOnly`). A module not read on this screen does not count.
 */
export function moduleFills(f: InputModuleFacts): ModuleFill[] {
  const fill = (key: ModuleKey, real: number, simulated = 0): ModuleFill => ({ key, filled: real + simulated > 0, simulatedOnly: real <= 0 && simulated > 0 })
  const c = f.conversation
  const h = f.history
  const v = f.vitals
  const s = f.stethoscope
  const t = f.thermal
  return [
    fill('conversation', c ? c.transcripts + c.points : 0),
    fill('history', h ? h.entries + (h.allergyStatusRecorded ? 1 : 0) : 0),
    fill('vitals', v ? v.staff + v.device : 0, v?.simulated ?? 0),
    // A recording's count includes the simulated ones: only those beyond them are real.
    fill('stethoscope', s ? s.recordings - s.simulated : 0, s?.simulated ?? 0),
    fill('thermal', t ? t.images - t.simulated : 0, t?.simulated ?? 0),
  ]
}

export type WorkflowStepId = 'inputs' | 'analysis' | 'review' | 'record' | 'sign'

export interface WorkflowStep {
  id: WorkflowStepId
  n: 1 | 2 | 3 | 4 | 5
  label: string
  /** The state in a few words ("3 of 5 with information", "Writing", "2 to review", "1 medicine · saved", "Not signed"); "—" when not yet. */
  state: string
  tone: Tone
  /** Where the step leads (`showPart`); null for Sign, which moves focus to "Complete consultation" instead. */
  target: PartId | null
  /** The step's accessible name: its label and its state, with "—" said as "not yet". */
  name: string
}

export interface WorkflowFacts {
  inputs: InputModuleFacts
  /** The local model's draft as the page reads it (`analysisFacts`); null while it is not known. */
  analysis: AnalysisFacts | null
  /** Draft statements the doctor has not decided on, from the consultation's AI state; null when not known (the Overview's count is used then). */
  undecided: number | null
  /** What waits for review, as the Overview (D2) counts it; null when not read. */
  pending: PendingReview | null
  save: NoteSaveState
  /** Prescription rows with a medicine named (see `medicineCount`). */
  medicines: number
  signed?: boolean
}

const NOT_YET = '—'

export const WORKFLOW_LABEL: Record<WorkflowStepId, string> = {
  inputs: 'Inputs',
  analysis: 'Mana analysis',
  review: 'Your review',
  record: 'Note & prescription',
  sign: 'Sign',
}

const ANALYSIS_WORD: Record<Exclude<DraftView, 'generating'>, { state: string; tone: Tone }> = {
  not_run: { state: 'Not run', tone: 'neutral' },
  ready: { state: 'Ready for review', tone: 'ai' },
  partial: { state: 'Partly available', tone: 'warn' },
  failed: { state: 'Failed', tone: 'down' },
  cancelled: { state: 'Cancelled', tone: 'neutral' },
  unavailable: { state: 'Unavailable', tone: 'down' },
  stale: { state: 'Stale', tone: 'warn' },
  insufficient: { state: 'Insufficient information', tone: 'neutral' },
}

/** Step 2: the draft's state; while it is being made, waiting for the local model (it serves one request at a time) or writing. */
export function analysisState(a: AnalysisFacts | null): { state: string; tone: Tone } {
  if (!a) return { state: NOT_YET, tone: 'neutral' }
  if (a.view === 'generating') return { state: a.phase === 'running' ? 'Writing' : 'Waiting for the local model', tone: 'notice' }
  return ANALYSIS_WORD[a.view]
}

/** Step 1: how many of the five modules hold information, and whether any of those holds only simulated items. */
export function inputsState(f: InputModuleFacts): { state: string; tone: Tone } {
  const fills = moduleFills(f).filter((m) => m.filled)
  const simulated = fills.some((m) => m.simulatedOnly) ? ' (incl. simulated)' : ''
  return { state: `${fills.length} of 5 with information${simulated}`, tone: fills.length ? 'ok' : 'neutral' }
}

/**
 * Step 3: what waits for the doctor. The draft statements not yet decided (the AI state's count when known, it changes as the doctor decides;
 * else the Overview's) plus the Overview's important points, thermal images and thermal summaries. "—" before any analysis was asked for, and
 * while the first one is being made with nothing else waiting. "Nothing waiting" only when the Overview read and counted every kind
 * (`unread` empty); otherwise a 0 is not said to mean that nothing waits.
 */
export function reviewState(analysis: AnalysisFacts | null, undecided: number | null, pending: PendingReview | null): { state: string; tone: Tone } {
  if (!analysis?.ran) return { state: NOT_YET, tone: 'neutral' }
  const statements = undecided ?? pending?.draftStatements ?? 0
  const others = pending ? Math.max(0, pending.points) + Math.max(0, pending.thermalImages) + Math.max(0, pending.thermalSummaries) : 0
  const total = Math.max(0, statements) + others
  if (total > 0) return { state: `${total} to review`, tone: 'warn' }
  if (analysis.view === 'generating') return { state: NOT_YET, tone: 'neutral' }
  if (pending && pending.unread.length === 0) return { state: 'Nothing waiting', tone: 'ok' }
  return { state: 'Not all counted', tone: 'neutral' }
}

const SAVE_WORD: Record<NoteSaveState, { word: string; tone: Tone }> = {
  saved: { word: 'saved', tone: 'ok' },
  dirty: { word: 'unsaved changes', tone: 'neutral' },
  saving: { word: 'saving…', tone: 'neutral' },
  error: { word: 'not saved, retrying', tone: 'down' },
  conflict: { word: 'changed elsewhere', tone: 'down' },
  blocked: { word: 'not saved', tone: 'down' },
}

/** Step 4: the prescription's medicines and whether the note and prescription are saved (the SaveIndicator's state). */
export function recordState(save: NoteSaveState, medicines: number): { state: string; tone: Tone } {
  const n = Math.max(0, medicines)
  const s = SAVE_WORD[save]
  return { state: `${n === 0 ? 'No medicines' : `${n} ${n === 1 ? 'medicine' : 'medicines'}`} · ${s.word}`, tone: s.tone }
}

/** Prescription rows that name a medicine: a row added and left empty is not a medicine. */
export const medicineCount = (rows: readonly { drugName?: string | null }[]): number => rows.filter((r) => (r.drugName ?? '').trim() !== '').length

/** The five steps, in order, each with its state and where it leads. */
export function workflowSteps(f: WorkflowFacts): WorkflowStep[] {
  const steps: Omit<WorkflowStep, 'name'>[] = [
    { id: 'inputs', n: 1, label: WORKFLOW_LABEL.inputs, ...inputsState(f.inputs), target: 'consultation-inputs' },
    { id: 'analysis', n: 2, label: WORKFLOW_LABEL.analysis, ...analysisState(f.analysis), target: 'mana-result' },
    { id: 'review', n: 3, label: WORKFLOW_LABEL.review, ...reviewState(f.analysis, f.undecided, f.pending), target: 'mana-review' },
    { id: 'record', n: 4, label: WORKFLOW_LABEL.record, ...recordState(f.save, f.medicines), target: 'consultation-note' },
    { id: 'sign', n: 5, label: WORKFLOW_LABEL.sign, state: f.signed ? 'Signed' : 'Not signed', tone: f.signed ? 'ok' : 'neutral', target: null },
  ]
  return steps.map((s) => ({ ...s, name: `${s.label}: ${s.state === NOT_YET ? 'not yet' : s.state}` }))
}
