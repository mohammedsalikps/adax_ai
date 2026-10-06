import type { ConsultAttempt, ConsultDraft, ConsultInputsUsed, ConsultProgress, EncounterAi } from '@adaxai/contracts'
import { fmtClock } from './devices.ts'

/*
 * "Analyze with Mana" (Doctor HERO): what the one control says, what each step of a run shows, what the run reads from each of the five inputs,
 * and how long it took. A run is three real things in order: the doctor's note is saved; then the fixed safety rules (POST
 * /encounters/:id/recommendations) and the local model's draft (POST /encounters/:id/consultation-ai/drafts) are asked at the same time. Nothing
 * here estimates, animates or invents progress: every word comes from a state the page or the server already holds. Pure, so that it can be
 * tested without a browser.
 */

// --- the draft as the doctor reads it ----------------------------------------------------------------------------------------------------------

/** What a draft can be on the screen (the V3 panel's own states). */
export type DraftView = 'not_run' | 'generating' | 'ready' | 'partial' | 'failed' | 'cancelled' | 'unavailable' | 'stale' | 'insufficient'

/** The words of the V3 status badge, unchanged. */
export const DRAFT_VIEW_LABEL: Record<DraftView, string> = {
  not_run: 'NOT RUN',
  generating: 'GENERATING',
  ready: 'READY FOR REVIEW',
  partial: 'PARTIALLY AVAILABLE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  unavailable: 'UNAVAILABLE',
  stale: 'STALE',
  insufficient: 'INSUFFICIENT INFORMATION',
}

/** The tones used here: the existing badge tones (`ai` only for model output and the Analyze control). */
export type Tone = 'neutral' | 'ok' | 'warn' | 'down' | 'notice' | 'ai'

/**
 * What this file reads of a draft. `startedAt` (when the model began, after any wait for it) is optional: a server that does not send it yet
 * leaves the split of the time out, never guessed. So are `progress` (how far the model has got while it writes, as the server last heard it)
 * and `inputsUsed` (what was sent to the model, counted from the draft's own list of sources): absent or null, nothing is said of them.
 */
export type DraftFacts = Pick<ConsultDraft, 'id' | 'version' | 'status' | 'phase' | 'stale' | 'insufficient' | 'createdAt' | 'completedAt' | 'latencyMs' | 'errorMessage'> & {
  model?: ConsultDraft['model']
  startedAt?: string | null
  progress?: ConsultProgress | null
  inputsUsed?: ConsultInputsUsed | null
}

/** What this file reads of the consultation's AI state (GET /encounters/:id/consultation-ai). */
export interface AiFacts {
  status: { available: boolean; reason: string | null }
  canGenerate: boolean
  blockedReason: string | null
  draft: DraftFacts | null
  lastAttempt: Pick<ConsultAttempt, 'version' | 'status' | 'errorMessage' | 'createdAt'> | null
}

/**
 * The state of a draft as the V3 panel shows it. With the model not there now, a draft that failed or was cancelled is not what matters: that no
 * new draft can be made is.
 */
export function draftView(draft: DraftFacts | null, available: boolean): DraftView {
  if (!draft) return available ? 'not_run' : 'unavailable'
  if (!available && (draft.status === 'failed' || draft.status === 'cancelled' || draft.status === 'unavailable')) return 'unavailable'
  if (draft.status === 'generating') return 'generating'
  if (draft.status === 'cancelled') return 'cancelled'
  if (draft.status === 'failed') return 'failed'
  if (draft.status === 'unavailable') return 'unavailable'
  if (draft.insufficient) return 'insufficient'
  if (draft.stale) return 'stale'
  return draft.status === 'partial' ? 'partial' : 'ready'
}

/** The consultation's analysis as the workflow strip reads it; null while the AI state is not known. `ran` is false until a draft was ever asked for. */
export interface AnalysisFacts {
  view: DraftView
  phase: 'queued' | 'running' | null
  ran: boolean
}

export function analysisFacts(ai: AiFacts | null | undefined): AnalysisFacts | null {
  if (!ai) return null
  const view = draftView(ai.draft, ai.status.available)
  return { view, phase: view === 'generating' ? (ai.draft?.phase ?? null) : null, ran: !!ai.draft || !!ai.lastAttempt }
}

// --- the control ---------------------------------------------------------------------------------------------------------------------------

/** The note's save state, as the page's SaveIndicator shows it. */
export type NoteSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'blocked'

export const ANALYZE_LABEL = 'Analyze with Mana'
export const ANALYZE_AGAIN_LABEL = 'Analyze again'
export const ANALYZING_LABEL = 'Analyzing…'

/** What a run reads and does not read, under the control (consult/inputs.ts and mana/record.ts on the server). */
export const ANALYSIS_COVERAGE =
  'Reads the record, your saved note and the points you confirmed. Does not read the raw transcript, audio, stethoscope recordings, unapproved or simulated thermal images, or simulated device values.'

/** Said when the save before a run did not succeed: nothing was sent to the rules or the model. */
export const NOT_SAVED = 'Your note could not be saved, so Mana was not asked.'
/** Why the control is off while the note cannot be saved at all (changed elsewhere, or refused for good). */
export const NOTE_LOCKED = 'Your note cannot be saved just now, so Mana cannot be asked.'
export const CHECKING_MODEL = 'Checking the local model…'
export const MODEL_STATE_UNREAD = 'Whether the local model can be asked could not be checked just now.'

export interface AnalyzeControl {
  label: typeof ANALYZE_LABEL | typeof ANALYZE_AGAIN_LABEL | typeof ANALYZING_LABEL
  /** For `data-state`: ready (never run), again (run before), running, checking (the AI state is being read), blocked (off, with a reason). */
  state: 'ready' | 'again' | 'running' | 'checking' | 'blocked'
  disabled: boolean
  /** For `aria-busy`. */
  busy: boolean
  /** Why it is off, in the server's words where it gave them (for `aria-describedby`); null when it is on or running. */
  reason: string | null
}

/**
 * The one control. "Analyzing…" (busy, off) while this page's run is saving or asking, or while a draft is being made; else "Analyze with Mana"
 * before any draft, "Analyze again" after one (ready, partial, stale, insufficient, failed, cancelled or unavailable). It is off, with the reason,
 * while the AI state is not known, while the note cannot be saved, and when the server says a draft cannot be asked for (consent missing or old,
 * the visit not in consultation, another doctor's consultation, the model unavailable).
 */
export function analyzeControl({ ai, aiError = false, running = false, save }: { ai: AiFacts | null | undefined; aiError?: boolean; running?: boolean; save: NoteSaveState }): AnalyzeControl {
  if (running || ai?.draft?.status === 'generating') return { label: ANALYZING_LABEL, state: 'running', disabled: true, busy: true, reason: null }
  if (!ai) return aiError ? { label: ANALYZE_LABEL, state: 'blocked', disabled: true, busy: false, reason: MODEL_STATE_UNREAD } : { label: ANALYZE_LABEL, state: 'checking', disabled: true, busy: false, reason: CHECKING_MODEL }
  const again = !!ai.draft || !!ai.lastAttempt
  const label = again ? ANALYZE_AGAIN_LABEL : ANALYZE_LABEL
  if (save === 'conflict' || save === 'blocked') return { label, state: 'blocked', disabled: true, busy: false, reason: NOTE_LOCKED }
  if (!ai.canGenerate) {
    const reason = ai.blockedReason ?? (ai.status.available ? 'The local model cannot be asked now.' : (ai.status.reason ?? 'Local AI unavailable.'))
    return { label, state: 'blocked', disabled: true, busy: false, reason }
  }
  return { label, state: again ? 'again' : 'ready', disabled: false, busy: false, reason: null }
}

/** Whether a run goes on after its save: not when the save failed, the draft was changed elsewhere, or saving was refused for good. */
export const savedForAnalysis = (state: NoteSaveState): boolean => state !== 'error' && state !== 'conflict' && state !== 'blocked'

/** Why a draft could not be asked for, from the API's answer. `running`: one is already being made (409), and it is the one shown. */
export interface StartRefusal {
  kind: 'busy' | 'running' | 'failed'
  message: string
}

export const MODEL_BUSY = 'The local model is busy with another request. Try again when it finishes.'

export function startRefusal(err: { status: number; code: string; message: string }): StartRefusal {
  if (err.status === 429 && err.code === 'ai_busy') return { kind: 'busy', message: MODEL_BUSY }
  if (err.status === 409 && err.code === 'generation_in_progress') return { kind: 'running', message: err.message }
  return { kind: 'failed', message: err.message || 'The local model could not be asked.' }
}

// --- the steps of a run --------------------------------------------------------------------------------------------------------------------

/** idle: not started; running; done; failed; cancelled (the doctor stopped it); skipped (not run because the save before it failed). */
export type StepState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface AnalysisStep {
  id: 'save' | 'rules' | 'model'
  label: string
  state: StepState
  /** What the step is doing or did, in a few words. */
  detail: string
  tone: Tone
  /** The server's own words when a step failed (shown with it), else null. */
  message: string | null
}

export type SaveRun = { state: 'idle' } | { state: 'running' } | { state: 'done'; at: string } | { state: 'failed' }
export type RulesRun = { state: 'idle' } | { state: 'running' } | { state: 'done'; results: number; producedBy: string | null; at: string | null } | { state: 'failed'; message: string } | { state: 'skipped' }
/** This page's request for a draft. `sent` carries the draft the server answered with (202), or null when one was already being made (409). */
export type ModelAsk = { state: 'idle' } | { state: 'sending' } | { state: 'sent'; draft: DraftFacts | null } | { state: 'failed'; message: string } | { state: 'skipped' }

const NOT_ASKED = 'Not asked, because your note was not saved'

export function saveStep(run: SaveRun): AnalysisStep {
  const base = { id: 'save' as const, label: 'Your note', message: null }
  if (run.state === 'running') return { ...base, state: 'running', detail: 'Saving…', tone: 'notice' }
  if (run.state === 'done') return { ...base, state: 'done', detail: `Saved ${fmtClock(run.at)}`, tone: 'ok' }
  if (run.state === 'failed') return { ...base, state: 'failed', detail: 'Not saved', tone: 'down', message: NOT_SAVED }
  return { ...base, state: 'idle', detail: 'Not started', tone: 'neutral' }
}

const counted = (n: number, one: string, many: string) => `${n === 0 ? 'No' : n} ${n === 1 ? one : many}`

export function rulesStep(run: RulesRun): AnalysisStep {
  const base = { id: 'rules' as const, label: 'Fixed safety rules', message: null }
  if (run.state === 'running') return { ...base, state: 'running', detail: 'Checking…', tone: 'notice' }
  if (run.state === 'done') return { ...base, state: 'done', detail: `${counted(run.results, 'result', 'results')}${run.producedBy ? ` · ${run.producedBy}` : ''}`, tone: 'ok' }
  if (run.state === 'failed') return { ...base, state: 'failed', detail: 'Not run', tone: 'down', message: run.message }
  if (run.state === 'skipped') return { ...base, state: 'skipped', detail: 'Not run, because your note was not saved', tone: 'neutral' }
  return { ...base, state: 'idle', detail: 'Not run yet', tone: 'neutral' }
}

/**
 * The attempt this page asked for, as the server now tells it. The consultation's state shows the newest draft that is being made or has
 * statements: once this page's attempt failed or was cancelled it shows an earlier, finished draft instead, and this attempt is its `lastAttempt`.
 * Until the state is read again after the request, the draft the server answered with stands. With nothing asked from this page (a run found
 * under way on reload, or one already being made), the draft shown is the one.
 */
export function attemptDraft(ask: ModelAsk | null, ai: AiFacts | null | undefined): DraftFacts | null {
  const shown = ai?.draft ?? null
  if (!ask || ask.state !== 'sent' || !ask.draft) return shown
  const asked = ask.draft
  // A newer draft than the one asked for here (asked from another window) is the one there is now.
  if (shown && (shown.id === asked.id || shown.version > asked.version)) return shown
  const last = ai?.lastAttempt
  if (last && last.version === asked.version) return { ...asked, status: last.status, phase: null, errorMessage: last.errorMessage, completedAt: null, latencyMs: null }
  return asked
}

function modelOutcome(d: DraftFacts): Pick<AnalysisStep, 'state' | 'detail' | 'tone' | 'message'> {
  // The attempt's own outcome: whether the model is there now is for the control and the result, not for what this attempt did.
  const view = draftView(d, true)
  if (view === 'generating') return { state: 'running', detail: d.phase === 'running' ? (d.progress?.generatedTokens === 0 ? READING_SENT : 'Writing the draft') : 'Waiting for the local model', tone: 'notice', message: null }
  if (view === 'ready') return { state: 'done', detail: DRAFT_VIEW_LABEL.ready, tone: 'ai', message: null }
  if (view === 'partial') return { state: 'done', detail: DRAFT_VIEW_LABEL.partial, tone: 'warn', message: null }
  if (view === 'stale') return { state: 'done', detail: DRAFT_VIEW_LABEL.stale, tone: 'warn', message: null }
  if (view === 'insufficient') return { state: 'done', detail: d.model ? DRAFT_VIEW_LABEL.insufficient : `${DRAFT_VIEW_LABEL.insufficient} (the model was not asked)`, tone: 'neutral', message: null }
  if (view === 'cancelled') return { state: 'cancelled', detail: DRAFT_VIEW_LABEL.cancelled, tone: 'neutral', message: d.errorMessage }
  return { state: 'failed', detail: DRAFT_VIEW_LABEL[view], tone: 'down', message: d.errorMessage }
}

export function modelStep(ask: ModelAsk | null, ai: AiFacts | null | undefined): AnalysisStep {
  const base = { id: 'model' as const, label: 'Local model' }
  if (ask?.state === 'idle') return { ...base, state: 'idle', detail: 'Not asked yet', tone: 'neutral', message: null }
  if (ask?.state === 'sending') return { ...base, state: 'running', detail: 'Sending the request…', tone: 'notice', message: null }
  if (ask?.state === 'failed') return { ...base, state: 'failed', detail: 'Not asked', tone: 'down', message: ask.message }
  if (ask?.state === 'skipped') return { ...base, state: 'skipped', detail: NOT_ASKED, tone: 'neutral', message: null }
  const d = attemptDraft(ask, ai)
  if (!d) return { ...base, state: 'idle', detail: ai ? 'Not run' : CHECKING_MODEL, tone: 'neutral', message: null }
  return { ...base, ...modelOutcome(d) }
}

/**
 * The steps of a run, in order. A step this page did not run (a run found under way after a reload: no save or rules from here) is left out,
 * never shown as done.
 */
export function analysisSteps({ save, rules, ask, ai }: { save: SaveRun | null; rules: RulesRun | null; ask: ModelAsk | null; ai: AiFacts | null | undefined }): AnalysisStep[] {
  const out: AnalysisStep[] = []
  if (save) out.push(saveStep(save))
  if (rules) out.push(rulesStep(rules))
  out.push(modelStep(ask, ai))
  return out
}

/**
 * The fixed rules' answer (POST /encounters/:id/recommendations returns the consultation's AI state): its newest safety_check job, the rule
 * results that job made, the rules version that made them and when. Null when there is no such job.
 */
export function rulesRunOf(ai: Pick<EncounterAi, 'jobs' | 'recommendations'>): RulesRun | null {
  const jobs = ai.jobs.filter((j) => j.kind === 'safety_check')
  if (!jobs.length) return null
  const job = jobs.reduce((a, b) => (Date.parse(b.createdAt) > Date.parse(a.createdAt) ? b : a))
  if (job.status === 'running') return { state: 'running' }
  if (job.status === 'failed') return { state: 'failed', message: job.lastErrorMessage ?? 'The fixed safety rules could not be run.' }
  const results = ai.recommendations.filter((r) => r.jobId === job.id && r.source === 'rules')
  const producedBy = results[0]?.producedBy.model ?? job.runs.find((r) => r.kind === 'safety_check')?.model ?? null
  return { state: 'done', results: results.length, producedBy, at: job.completedAt ?? job.createdAt }
}

// --- what a run reads, per input -----------------------------------------------------------------------------------------------------------

/** What the page knows of each input, as plain counts (from queries the page already holds; nothing is fetched for this). */
export interface AnalysisInputFacts {
  /** Points the doctor confirmed in the conversation; null when they could not be counted on this screen. */
  confirmedPoints: number | null
  /** The patient's history as this screen read it. The server reads the record for every run whatever this says. */
  history: 'loaded' | 'loading' | 'error'
  /** Vital signs staff recorded for this visit. */
  staffVitals: number
  /** Device readings that are not simulated (unverified). */
  deviceReadings: number
  /** Simulated device readings: never read. */
  simulatedReadings: number
  /** The patient's approved thermal images that are not simulated. */
  approvedThermal: number
  /** Thermal summaries the doctor accepted or edited (of approved, not simulated images). */
  reviewedThermalSummaries: number
  /** Simulated thermal images: never read. */
  simulatedThermal: number
  /** The patient withdrew consent to thermal imaging: no thermal image is read. */
  thermalConsentWithdrawn?: boolean
}

export type InputKey = 'conversation' | 'history' | 'vitals' | 'stethoscope' | 'thermal'

export interface AnalysisInput {
  key: InputKey
  n: 1 | 2 | 3 | 4 | 5
  label: string
  /** Whether a run reads it: a mark (✓ or —), never progress. */
  included: boolean
  text: string
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * What a run reads from each of the five inputs, from what the page holds and the server's input rules (consult/inputs.ts, mana/record.ts):
 * only points the doctor confirmed, never the raw transcript; the patient's record; staff vital signs and device readings that are not
 * simulated; never a stethoscope recording; approved thermal images that are not simulated, with the doctor's reviewed summary. Shown before and
 * during a run as marks, never animated.
 */
export function analysisInputs(f: AnalysisInputFacts): AnalysisInput[] {
  const conversation: AnalysisInput =
    f.confirmedPoints === null
      ? { key: 'conversation', n: 1, label: 'Conversation', included: false, text: 'The points you confirmed could not be counted here (the raw transcript is never read)' }
      : f.confirmedPoints > 0
        ? { key: 'conversation', n: 1, label: 'Conversation', included: true, text: `${f.confirmedPoints} ${plural(f.confirmedPoints, 'point', 'points')} you confirmed` }
        : { key: 'conversation', n: 1, label: 'Conversation', included: false, text: 'No confirmed point (the raw transcript is never read)' }

  // The record is read on the server for every run (a run that cannot read it fails): it is marked as read whatever this screen managed to show.
  const history: AnalysisInput = { key: 'history', n: 2, label: 'History', included: true, text: f.history === 'error' ? 'The patient’s record (it could not be shown on this screen just now)' : 'The patient’s record' }

  const staff = f.staffVitals > 0
  const device = f.deviceReadings > 0
  const simulatedNote = f.simulatedReadings > 0 ? '; simulated values not read' : ''
  const vitals: AnalysisInput =
    staff || device
      ? { key: 'vitals', n: 3, label: 'Health band', included: true, text: `${staff && device ? 'Staff vital signs and device readings (unverified)' : staff ? 'Staff vital signs' : 'Device readings (unverified)'}${simulatedNote}` }
      : { key: 'vitals', n: 3, label: 'Health band', included: false, text: f.simulatedReadings > 0 ? 'Simulated values not read' : 'No vital sign or device reading' }

  const stethoscope: AnalysisInput = { key: 'stethoscope', n: 4, label: 'Stethoscope', included: false, text: 'Recordings are not analysed' }

  const simulatedImages = f.simulatedThermal > 0 ? '; simulated images not read' : ''
  const thermal: AnalysisInput = f.thermalConsentWithdrawn
    ? { key: 'thermal', n: 5, label: 'Thermal', included: false, text: 'Not read: the patient withdrew consent to thermal imaging' }
    : f.approvedThermal > 0
      ? {
          key: 'thermal',
          n: 5,
          label: 'Thermal',
          included: true,
          text: `${f.approvedThermal} approved ${plural(f.approvedThermal, 'image’s', 'images’')} measurements${f.reviewedThermalSummaries > 0 ? ` and the reviewed ${plural(f.reviewedThermalSummaries, 'summary', 'summaries')}` : ''}${simulatedImages}`,
        }
      : { key: 'thermal', n: 5, label: 'Thermal', included: false, text: `No approved image${simulatedImages}` }

  return [conversation, history, vitals, stethoscope, thermal]
}

// --- time ------------------------------------------------------------------------------------------------------------------------------------

/** A duration as m:ss (minutes are not capped at 59); a negative or unreadable one is not shown as a time. */
export function fmtDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * How long a finished draft took, from the server's own clock: `took` is its latencyMs (from the request to the end, any wait for the model
 * included); `waited` (request to the model starting) and `writing` (the model starting to the end, with the checks after it) only when the
 * server says when the model started and all three times read in order. Each null when it is not known.
 */
export function draftTiming(d: Pick<DraftFacts, 'createdAt' | 'completedAt' | 'latencyMs' | 'startedAt'>): { took: string | null; waited: string | null; writing: string | null } {
  const took = d.latencyMs === null || d.latencyMs === undefined ? null : fmtDuration(d.latencyMs)
  const created = Date.parse(d.createdAt)
  const started = d.startedAt ? Date.parse(d.startedAt) : Number.NaN
  const completed = d.completedAt ? Date.parse(d.completedAt) : Number.NaN
  const ordered = Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed) && created <= started && started <= completed
  return { took, waited: ordered ? fmtDuration(started - created) : null, writing: ordered ? fmtDuration(completed - started) : null }
}

/**
 * The timing line of a run (`analysis-timing`). While it runs: the time since the doctor's click on this page (`clickedAt` and `now` from
 * performance.now(), never the local clock against the server's); for a draft found under way without a click here (`ask` null), when it
 * started by the server's clock. Once the attempt ended: "took m:ss" from the server, and the wait and the writing when the server says when the
 * model started. Null when there is nothing true to say: the model was not asked (the save failed, the request was refused), or the attempt has
 * no latency (a cancelled one). An earlier draft's time is never shown for a run that has not reached the model yet.
 */
export function analysisTiming({ clickedAt, now, ask, ai }: { clickedAt: number | null; now: number; ask: ModelAsk | null; ai: AiFacts | null | undefined }): string | null {
  if (ask && (ask.state === 'failed' || ask.state === 'skipped')) return null
  const draft = ask && ask.state !== 'sent' ? null : attemptDraft(ask, ai)
  if (draft && draft.status !== 'generating') {
    const t = draftTiming(draft)
    if (!t.took) return null
    return t.waited && t.writing ? `took ${t.took} · waited ${t.waited} · writing and checks ${t.writing}` : `took ${t.took}`
  }
  if (clickedAt !== null) {
    const elapsed = fmtDuration(Math.max(0, now - clickedAt))
    return elapsed ? `elapsed ${elapsed}` : null
  }
  if (draft && Number.isFinite(Date.parse(draft.createdAt))) return `started ${fmtClock(draft.createdAt)} (server time)`
  return null
}

// --- the model writing: what the server reports ------------------------------------------------------------------------------------------

/**
 * The model's step while the record is with it and it has not written a piece yet (the server's progress says 0: the stream is open and the
 * model reads what was sent).
 */
export const READING_SENT = 'Reading what was sent'

/** A whole number with thousands separated by commas ("2,600"); fixed, so that it reads the same on every computer. */
export const fmtCount = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** What this file reads of a draft's progress (ConsultDraft.progress). */
export type ProgressFacts = Pick<ConsultProgress, 'generatedTokens' | 'maxTokens' | 'updatedAt'>

/** One progress value as this page read it: the draft, the server's count and the server's time of that count. */
export interface WritingSample {
  draftId: string
  tokens: number
  at: number
}

/** The last progress value this page read of a draft, and the writing speed from it and the one before (null when there is none to give). */
export interface Writing {
  sample: WritingSample | null
  rate: number | null
}

export const NO_WRITING: Writing = { sample: null, rate: null }

/**
 * Two progress values closer than this (by the server's clock) give no speed: too little time to say anything. The server reports at most
 * every 500 ms, and the page reads about every second.
 */
const MIN_RATE_GAP_MS = 250

/**
 * The writing speed, from two successive progress values of the same draft as the page read them: the tokens written between them over the
 * server's time between them. Nothing is estimated. There is no speed from the first value, from one taken while the model was still reading
 * (0: that time was reading, not writing), from values out of order, or when the count did not grow; the same value read again keeps the speed
 * found last. Progress gone (null: the stream could not be read and the server fell back to a whole answer) clears it.
 */
export function nextWriting(prev: Writing, draftId: string, p: ProgressFacts | null | undefined): Writing {
  if (!p) return NO_WRITING
  const at = Date.parse(p.updatedAt)
  if (!Number.isFinite(at) || !Number.isFinite(p.generatedTokens) || p.generatedTokens < 0) return NO_WRITING
  const sample: WritingSample = { draftId, tokens: p.generatedTokens, at }
  const last = prev.sample
  if (!last || last.draftId !== draftId) return { sample, rate: null }
  if (at === last.at && p.generatedTokens === last.tokens) return prev
  if (at < last.at) return prev
  const gap = at - last.at
  const rate = last.tokens > 0 && p.generatedTokens > last.tokens && gap >= MIN_RATE_GAP_MS ? ((p.generatedTokens - last.tokens) * 1000) / gap : null
  return { sample, rate }
}

/**
 * The progress line while the model writes: "812 tokens · 44 tokens/s", the speed only when there is one (nextWriting); "Reading what was
 * sent" while the count is 0. Never a percentage or a time left: neither is known (`maxTokens` is a cap, see writingCap). Null without progress.
 */
export function writingText(p: Pick<ProgressFacts, 'generatedTokens'> | null | undefined, rate: number | null): string | null {
  if (!p) return null
  const n = p.generatedTokens
  if (n === 0) return READING_SENT
  const speed = rate !== null && Number.isFinite(rate) && rate >= 0.5 ? ` · ${fmtCount(rate)} tokens/s` : ''
  return `${fmtCount(n)} ${n === 1 ? 'token' : 'tokens'}${speed}`
}

/** The most a draft may take ("at most 2,600 tokens"), said as the cap it is: the answer usually stops well before it. */
export const writingCap = (p: Pick<ProgressFacts, 'maxTokens'>): string => `at most ${fmtCount(p.maxTokens)} tokens`

/**
 * The draft as polled while it is being made (GET /consultation-ai/drafts/:id, read about every second) carries the newest progress; the
 * consultation's AI state is read again only when the draft's phase or status changes. This puts the polled phase and progress on the draft
 * the state shows, when it is the same draft and both say it is still being made; otherwise the state is returned as it is.
 */
export function withPolledProgress<A extends { draft: DraftFacts | null }>(ai: A | null | undefined, polled: Pick<DraftFacts, 'id' | 'status' | 'phase' | 'progress'> | null | undefined): A | null | undefined {
  const d = ai?.draft
  if (!ai || !d || !polled || polled.id !== d.id || d.status !== 'generating' || polled.status !== 'generating') return ai
  return { ...ai, draft: { ...d, phase: polled.phase ?? d.phase, progress: polled.progress ?? null } }
}

// --- what reached the model: "Mana analyzed …" ---------------------------------------------------------------------------------------------

export type AnalyzedKey = 'conversation' | 'history' | 'note' | 'vitals' | 'thermal' | 'stethoscope'

/** One line of what reached the model: ✓ with what was sent of it, or ○ with why nothing was. */
export interface AnalyzedInput {
  key: AnalyzedKey
  label: string
  /** Something of it was sent to the model. The stethoscope never is. */
  sent: boolean
  /** In brackets after the label when sent ("3 confirmed points"); after a dash when not ("no confirmed point was sent"). */
  text: string
  /** The parts that were sent, in a few words (the history's allergies, conditions, medicines…), or null. */
  detail: string | null
}

const counts = (n: number, one: string, many: string) => `${fmtCount(n)} ${n === 1 ? one : many}`

/**
 * What reached the local model for a draft, from ConsultDraft.inputsUsed (counted on the server from the draft's own list of sources, never
 * predicted): the conversation's confirmed points, the record, today's note, the vital signs (staff, and devices, unverified), the approved
 * thermal images, and always the stethoscope as not analysed (no recording is sent to any model). A part with nothing sent says that nothing
 * was sent, never that there is none: what was not sent may still be in the record.
 */
export function analyzedInputs(u: ConsultInputsUsed): AnalyzedInput[] {
  const c = u.conversation.confirmedPoints
  const conversation: AnalyzedInput =
    c > 0
      ? { key: 'conversation', label: 'Conversation', sent: true, text: counts(c, 'confirmed point', 'confirmed points'), detail: null }
      : { key: 'conversation', label: 'Conversation', sent: false, text: 'no confirmed point was sent (the transcript and the audio never are)', detail: null }

  const h = u.history
  const historyParts = [
    h.allergies > 0 ? counts(h.allergies, 'allergy', 'allergies') : null,
    h.allergyStatus > 0 ? 'the allergy status' : null,
    h.allergies === 0 && h.allergyStatus === 0 ? 'nothing on allergies' : null,
    h.conditions > 0 ? counts(h.conditions, 'condition', 'conditions') : null,
    h.medicines > 0 ? counts(h.medicines, 'medicine on the list', 'medicines on the list') : null,
    h.results > 0 ? counts(h.results, 'result', 'results') : null,
    h.previousConsultations > 0 ? counts(h.previousConsultations, 'earlier consultation', 'earlier consultations') : null,
    h.earlierVisitReasons > 0 ? counts(h.earlierVisitReasons, 'earlier visit reason', 'earlier visit reasons') : null,
  ].filter((s): s is string => s !== null)
  const history: AnalyzedInput =
    h.items > 0
      ? { key: 'history', label: 'History', sent: true, text: counts(h.items, 'record item', 'record items'), detail: historyParts.join(', ') }
      : { key: 'history', label: 'History', sent: false, text: 'nothing from the record was sent', detail: null }

  const n = u.note
  const noteParts = [
    n.sections > 0 ? counts(n.sections, 'section', 'sections') : null,
    n.diagnoses > 0 ? counts(n.diagnoses, 'diagnosis', 'diagnoses') : null,
    n.prescriptionItems > 0 ? counts(n.prescriptionItems, 'prescription line', 'prescription lines') : null,
    n.visitReason > 0 ? 'the reason for the visit' : null,
  ].filter((s): s is string => s !== null)
  const note: AnalyzedInput =
    n.items > 0
      ? { key: 'note', label: 'Your note', sent: true, text: noteParts.join(', ') || counts(n.items, 'item', 'items'), detail: null }
      : { key: 'note', label: 'Your note', sent: false, text: 'nothing from today’s note was sent', detail: null }

  const { staff, device } = u.vitals
  const vitalParts = [staff > 0 ? `${fmtCount(staff)} staff` : null, device > 0 ? `${fmtCount(device)} device, unverified` : null].filter((s): s is string => s !== null)
  const vitals: AnalyzedInput =
    vitalParts.length > 0
      ? { key: 'vitals', label: 'Vitals', sent: true, text: vitalParts.join(', '), detail: null }
      : { key: 'vitals', label: 'Vitals', sent: false, text: 'no vital sign was sent (a simulator’s values never are)', detail: null }

  const t = u.thermal
  const thermal: AnalyzedInput =
    t.images > 0
      ? { key: 'thermal', label: 'Thermal', sent: true, text: `${counts(t.images, 'approved image', 'approved images')}${t.reviewedSummaries > 0 ? `, ${counts(t.reviewedSummaries, 'reviewed summary', 'reviewed summaries')}` : ''}`, detail: null }
      : { key: 'thermal', label: 'Thermal', sent: false, text: 'no approved image was sent', detail: null }

  const stethoscope: AnalyzedInput = { key: 'stethoscope', label: 'Stethoscope', sent: false, text: 'recordings are not analysed', detail: null }

  return [conversation, history, note, vitals, thermal, stethoscope]
}

/** How many sources reached the model in all ("27 sources sent to the local model"). */
export const analyzedTotal = (u: Pick<ConsultInputsUsed, 'total'>): string => `${counts(u.total, 'source', 'sources')} sent to the local model`

/**
 * The heading of that list, by what became of the draft: "Mana analyzed" once it has statements to review; "Sent to the local model" while it
 * writes; "Sent to the local model before it stopped" when it failed, was cancelled or could not use the model after the record reached it.
 */
export function analyzedTitle(d: Pick<DraftFacts, 'status'>): string {
  if (d.status === 'ready' || d.status === 'partial') return 'Mana analyzed'
  if (d.status === 'generating') return 'Sent to the local model'
  return 'Sent to the local model before it stopped'
}

// --- Generate prescription (DESIGN §5.5): the bottom bar's one primary action -----------------------------------------------------------------

export const GENERATE_LABEL = 'Generate prescription'

/** Said when the local model cannot be asked: the prescription page opens without Mana's summary. */
export const MANA_UNAVAILABLE = 'Mana is unavailable — you can write the prescription yourself'

export interface GenerateControl {
  label: typeof GENERATE_LABEL
  /** For `data-state`: ready, running (a run or a draft is under way: a click shows its progress again), checking (the model's state is being read), blocked. */
  state: 'ready' | 'running' | 'checking' | 'blocked'
  disabled: boolean
  busy: boolean
  /** Why it is off (aria-describedby), else null. */
  reason: string | null
}

/**
 * "Generate prescription". Always there and on, because the prescription page opens whatever Mana can do (without the model the doctor writes
 * it alone): only a note that cannot be saved at all (changed elsewhere, or refused for good) turns it off, with the reason. While a run or a
 * draft is under way it is busy, and a click shows that run's progress again instead of starting another.
 */
export function generateControl({ ai, running = false, save }: { ai: AiFacts | null | undefined; running?: boolean; save: NoteSaveState }): GenerateControl {
  const label = GENERATE_LABEL
  if (save === 'conflict' || save === 'blocked') return { label, state: 'blocked', disabled: true, busy: false, reason: NOTE_LOCKED }
  if (running || ai?.draft?.status === 'generating') return { label, state: 'running', disabled: false, busy: true, reason: null }
  if (!ai) return { label, state: 'checking', disabled: false, busy: false, reason: null }
  return { label, state: 'ready', disabled: false, busy: false, reason: null }
}

/**
 * Why the local model is not asked at all, as the server already said it (no request is made for a draft the server would refuse): consent
 * missing or old, the visit not in consultation, the model not there. Null when it may be asked, or while that is not known yet (the server
 * then decides).
 */
export function modelRefusal(ai: AiFacts | null | undefined): string | null {
  if (!ai || ai.canGenerate) return null
  if (!ai.status.available) return MANA_UNAVAILABLE
  return ai.blockedReason ?? 'The local model cannot be asked now.'
}

// --- "Mana reads: n of 5 inputs" -------------------------------------------------------------------------------------------------------------

/** What the bottom bar knows of the five inputs (DESIGN §15), from the page's own observers and the draft: plain counts, nothing fetched. */
export interface WorkspaceReadFacts {
  /** Points the doctor confirmed in the conversation; null while they cannot be counted. */
  confirmedPoints: number | null
  staffVitals: number
  /** Device readings that are not simulated (unverified). */
  deviceReadings: number
  /** Something is written in the typed note. Handwriting is never read by Mana. */
  typedNote: boolean
  /** The patient's approved thermal images that are not simulated. */
  approvedThermal: number
  thermalConsentWithdrawn?: boolean
}

export type ReadKey = 'transcription' | 'inputs' | 'stethoscope' | 'notes' | 'thermal'

export interface ReadInput {
  key: ReadKey
  label: string
  read: boolean
  text: string
}

/**
 * Which of the five inputs Mana reads when the doctor generates the prescription, as the server's input rules say (consult/inputs.ts): only the
 * points the doctor confirmed, never the transcript or the audio; staff vital signs and device readings that are not simulated; never a
 * stethoscope recording; the typed note, never the handwriting; approved thermal images that are not simulated. (The patient's record is read
 * as well; it is not one of the five inputs.)
 */
export function manaReads(f: WorkspaceReadFacts): ReadInput[] {
  const c = f.confirmedPoints
  const transcription: ReadInput =
    c !== null && c > 0
      ? { key: 'transcription', label: 'Live transcription', read: true, text: `${c} ${c === 1 ? 'point' : 'points'} you confirmed` }
      : { key: 'transcription', label: 'Live transcription', read: false, text: 'Only points you confirm are read, never the transcript' }
  const staff = f.staffVitals > 0
  const device = f.deviceReadings > 0
  const inputs: ReadInput =
    staff || device
      ? { key: 'inputs', label: 'Clinical inputs', read: true, text: staff && device ? 'Staff vital signs and device readings (unverified)' : staff ? 'Staff vital signs' : 'Device readings (unverified)' }
      : { key: 'inputs', label: 'Clinical inputs', read: false, text: 'No vital sign recorded (simulated values are never read)' }
  const stethoscope: ReadInput = { key: 'stethoscope', label: 'Stethoscope', read: false, text: 'Recordings are not analysed' }
  const notes: ReadInput = f.typedNote
    ? { key: 'notes', label: 'Doctor notes', read: true, text: 'Your typed note (handwriting is never read)' }
    : { key: 'notes', label: 'Doctor notes', read: false, text: 'No typed note (handwriting is never read)' }
  const thermal: ReadInput = f.thermalConsentWithdrawn
    ? { key: 'thermal', label: 'Thermal', read: false, text: 'The patient withdrew consent to thermal imaging' }
    : f.approvedThermal > 0
      ? { key: 'thermal', label: 'Thermal', read: true, text: `${f.approvedThermal} approved ${f.approvedThermal === 1 ? 'image' : 'images'}` }
      : { key: 'thermal', label: 'Thermal', read: false, text: 'No approved thermal image' }
  return [transcription, inputs, stethoscope, notes, thermal]
}

/** "Mana reads: 3 of 5 inputs". */
export const manaReadsText = (inputs: readonly ReadInput[]): string => `Mana reads: ${inputs.filter((i) => i.read).length} of ${inputs.length} inputs`

// --- "Preparing the consultation": the checklist, each line from a real state --------------------------------------------------------------

/** waiting: not reached yet; running; done (✓); failed; skipped (not done, and said why). */
export type CheckState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
export type CheckKey = 'save' | 'conversation' | 'history' | 'inputs' | 'notes' | 'thermal' | 'model'

export interface CheckLine {
  key: CheckKey
  label: string
  state: CheckState
  /** After a dash ("3 confirmed points included"); null while there is nothing true to say yet. */
  text: string | null
  /** One more muted line (handwriting kept, the server's words when something failed), or null. */
  note: string | null
}

/** What the sheet does next: wait; open the prescription page (the draft is ready, or the model cannot be asked); stay (the doctor decides). */
export type PreparingNext = 'wait' | 'open' | 'stay'

export interface PreparingFacts {
  /** This page's run: the save and the request for the draft. Both null when the sheet shows a draft found under way (no click here). */
  save: SaveRun | null
  ask: ModelAsk | null
  ai: AiFacts | null | undefined
  /** Time since the doctor's click, on this page's clock (performance.now), or null. */
  elapsedMs: number | null
  /** Strokes of the handwritten notes as the pad last saved them (its query cache), or null when not known. */
  handwritingStrokes: number | null
}

export interface Preparing {
  lines: CheckLine[]
  next: PreparingNext
  /** The model's line in words without the clock, for a polite announcement (it changes only when the state does). */
  announce: string
}

export const CONSOLIDATING = 'Mana is consolidating the consultation…'
export const HANDWRITING_KEPT = 'Handwriting kept with the record; not read by Mana'
export const NOT_SENT = 'Not sent to Mana'

const nOf = (count: number, one: string, many: string) => `${fmtCount(count)} ${count === 1 ? one : many}`

/** The five inputs' lines, from what the server counted as SENT to the model (ConsultDraft.inputsUsed), never predicted. */
function inputLines(used: ConsultInputsUsed | null, closed: boolean, strokes: number | null): CheckLine[] {
  const handwriting = strokes !== null && strokes > 0 ? HANDWRITING_KEPT : null
  const line = (key: CheckKey, label: string, text: (u: ConsultInputsUsed) => string, note: string | null = null): CheckLine =>
    used ? { key, label, state: 'done', text: text(used), note } : closed ? { key, label, state: 'skipped', text: NOT_SENT, note } : { key, label, state: 'waiting', text: null, note }
  return [
    line('conversation', 'Conversation', (u) =>
      u.conversation.confirmedPoints > 0 ? `${nOf(u.conversation.confirmedPoints, 'confirmed point', 'confirmed points')} included` : 'No confirmed points — the transcript itself is not sent',
    ),
    line('history', 'Patient history', (u) => (u.history.items > 0 ? nOf(u.history.items, 'record item', 'record items') : 'Nothing from the record was sent')),
    line('inputs', 'Clinical inputs', (u) => {
      const parts = [u.vitals.staff > 0 ? nOf(u.vitals.staff, 'staff vital sign', 'staff vital signs') : null, u.vitals.device > 0 ? `${nOf(u.vitals.device, 'device reading', 'device readings')} (unverified)` : null].filter(Boolean)
      return parts.length ? parts.join(', ') : 'No vital signs sent — simulated values never are'
    }),
    line('notes', 'Doctor notes', (u) => (u.note.sections > 0 ? 'Your typed note' : 'No typed note'), handwriting),
    line('thermal', 'Thermal', (u) => (u.thermal.images > 0 ? `Approved measurements (${nOf(u.thermal.images, 'image', 'images')})` : 'No approved thermal image')),
  ]
}

/**
 * The checklist of "Preparing the consultation" (DESIGN §5.5), a state machine over what the page and the server actually hold. Each line ticks
 * only on its own signal: "Your notes saved" when the save chain answered; the five inputs when the server says what it SENT to the model
 * (inputsUsed, once the model's turn came); Mana's line from the draft's own state, with the tokens the model server counted and the time since
 * the click (no percentage, no time left). The page opens by itself when the draft is ready (or partial), and when the model cannot be asked
 * at all; on any other end (the save failed, the draft failed, was cancelled or had too little to draft from) the doctor decides.
 */
export function preparingChecklist({ save, ask, ai, elapsedMs, handwritingStrokes }: PreparingFacts): Preparing {
  const lines: CheckLine[] = []
  if (save) {
    lines.push(
      save.state === 'running'
        ? { key: 'save', label: 'Saving your notes…', state: 'running', text: null, note: null }
        : save.state === 'done'
          ? { key: 'save', label: 'Your notes saved', state: 'done', text: null, note: null }
          : save.state === 'failed'
            ? { key: 'save', label: 'Your notes could not be saved', state: 'failed', text: null, note: NOT_SAVED }
            : { key: 'save', label: 'Your notes', state: 'waiting', text: null, note: null },
    )
  }
  const clock = elapsedMs === null ? null : fmtDuration(elapsedMs)
  const withClock = (t: string) => (clock ? `${t} · ${clock}` : t)

  let model: CheckLine
  let next: PreparingNext = 'wait'
  let used: ConsultInputsUsed | null = null
  let closed = false
  const end = (line: Omit<CheckLine, 'key' | 'note'> & { note?: string | null }, then: PreparingNext, inputsClosed = true): CheckLine => {
    next = then
    closed = inputsClosed
    return { key: 'model', note: null, ...line }
  }
  if (save?.state === 'failed' || ask?.state === 'skipped') {
    model = end({ label: 'Mana was not asked', state: 'skipped', text: null }, 'stay')
  } else if (save && save.state !== 'done') {
    model = { key: 'model', label: CONSOLIDATING, state: 'waiting', text: null, note: null }
  } else if (ask?.state === 'idle') {
    model = { key: 'model', label: CONSOLIDATING, state: 'waiting', text: null, note: null }
  } else if (ask?.state === 'sending') {
    model = { key: 'model', label: 'Asking Mana…', state: 'running', text: clock, note: null }
  } else if (ask?.state === 'failed') {
    model =
      ai?.status.available === false || ask.message === MANA_UNAVAILABLE
        ? end({ label: MANA_UNAVAILABLE, state: 'failed', text: null }, 'open')
        : end({ label: 'Mana could not be asked — you can write the prescription yourself', state: 'failed', text: null, note: ask.message }, 'stay')
  } else {
    // Sent (or a draft found under way without a click here): the attempt as the server now tells it.
    const d = attemptDraft(ask, ai)
    used = d?.inputsUsed ?? null
    const view = d ? draftView(d, true) : null
    if (!d || view === 'generating') {
      const p = d?.progress ?? null
      model =
        d?.phase === 'running'
          ? { key: 'model', label: CONSOLIDATING, state: 'running', text: withClock(p && p.generatedTokens > 0 ? nOf(p.generatedTokens, 'token', 'tokens') : READING_SENT), note: null }
          : { key: 'model', label: 'Waiting for the local model', state: 'running', text: clock, note: null }
    } else if (view === 'ready' || view === 'partial' || view === 'stale') {
      model = end({ label: view === 'partial' ? 'Mana’s summary is ready (part of it could not be made)' : 'Mana’s summary is ready', state: 'done', text: null }, 'open', false)
    } else if (view === 'unavailable') {
      model = end({ label: MANA_UNAVAILABLE, state: 'failed', text: null }, 'open')
    } else if (view === 'insufficient') {
      model = end({ label: 'Too little is recorded for Mana to summarise — you can write the prescription yourself', state: 'skipped', text: null }, 'stay')
    } else if (view === 'cancelled') {
      model = end({ label: 'The summary was cancelled', state: 'skipped', text: null }, 'stay')
    } else {
      model = end({ label: 'Mana could not finish the summary — you can write the prescription yourself', state: 'failed', text: null, note: d.errorMessage }, 'stay')
    }
  }
  lines.push(...inputLines(used, closed, handwritingStrokes), model)
  return { lines, next, announce: model.label }
}
