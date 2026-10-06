import type { ConsultAttempt, ConsultDraft, EncounterAi } from '@adaxai/contracts'
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
 * leaves the split of the time out, never guessed.
 */
export type DraftFacts = Pick<ConsultDraft, 'id' | 'version' | 'status' | 'phase' | 'stale' | 'insufficient' | 'createdAt' | 'completedAt' | 'latencyMs' | 'errorMessage'> & {
  model?: ConsultDraft['model']
  startedAt?: string | null
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
  if (view === 'generating') return { state: 'running', detail: d.phase === 'running' ? 'Writing the draft' : 'Waiting for the local model', tone: 'notice', message: null }
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
