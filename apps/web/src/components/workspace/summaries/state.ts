import {
  AUSCULTATION_CAPTURE,
  AUSCULTATION_SITES,
  type AuscultationRecording,
  BODY_SITES,
  type CaptureStatus,
  type ClinicalFact,
  type ConsentType,
  DEVICE_READING_KINDS,
  type EncounterAi,
  factState,
  type Observation,
  type PatientDetail,
  type PatientDeviceReadings,
  type PatientHistory,
  type ReadingState,
  type SpeechStatus,
  THERMAL_CAPTURE_SOURCES,
  type ThermalCapture,
  type ThermalModelStatus,
  type Transcript,
  VITAL_ORDER,
  type VitalFlag,
  type VitalKind,
  VITALS,
} from '@adaxai/contracts'
import { ageView, DEVICE_POLL_MS, fmtClock, type ReceivedDeviceReadings, summarizeDevices } from '../../../lib/devices.ts'
import { ageFrom, fmtDate, fmtTime } from '../../../lib/format.ts'
import { fmtC } from '../../../lib/thermal.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import type { ModuleState, ModuleTone } from '../ModuleShell.tsx'

/*
 * The compact summaries of the five input modules of a consultation (Doctor HERO, plan §1.3): what each module's chip says (a word and a
 * tone), the counts the workflow strip adds up, and the few short lines under the module's title. All of it comes from the data the module's
 * own full panel already fetched; the components beside this file read the panels' queries as observers (they never fetch) and draw what these
 * functions return. Pure and JSX-free, so that every state can be tested without a browser. Nothing here guesses: a module whose data has not
 * arrived says "Loading", one whose panel could not read it says "Not updated", an old answer kept after a failed read says "· not updated",
 * and an answer the screen cannot read (a list that is not a list) is "Not updated" too, never a crash.
 */

/** A module's state: the chip's word and tone (ModuleShell), `kind` a fixed name for it (data-state, tests), `behind` when it is an old answer. */
export interface SummaryState extends ModuleState {
  kind: string
  behind?: boolean
}

/** The panel has not answered yet. */
export const LOADING: SummaryState = { kind: 'loading', word: 'Loading', tone: 'neutral' }
/** The panel's read failed and there is nothing earlier to show, or its answer could not be read. */
export const NOT_UPDATED: SummaryState = { kind: 'not_updated', word: 'Not updated', tone: 'neutral' }

/** An answer kept on the screen after the panel's last read failed: it may have changed since, so the word says so and the colour is dropped. */
export const behind = (s: SummaryState, failed: boolean): SummaryState => (failed ? { ...s, word: `${s.word} · not updated`, tone: 'neutral', behind: true } : s)

/** "1 recording", "3 recordings". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** An object whose fields named here are all lists: what an answer must be before it is summarised (else it is "Not updated"). */
const hasLists = (x: unknown, ...fields: string[]): boolean => !!x && typeof x === 'object' && fields.every((k) => Array.isArray((x as Record<string, unknown>)[k]))

/** A list from an answer, or none when the answer holds something else there. */
const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]).filter((v) => v !== null && v !== undefined) : [])
const clockOf = (ms: number | null | undefined) => (ms ? fmtClock(new Date(ms).toISOString()) : null)

/** Runs a summary over an answer, and says "Not updated" instead of failing when the answer is not what it should be. */
export function safely<T>(make: () => T, fallback: T): T {
  try {
    return make()
  } catch {
    return fallback
  }
}

/** Whether the patient's consent of a kind is granted, was withdrawn (and not granted again), or is not recorded; null while the patient is not read. */
export type ConsentStatus = 'granted' | 'withdrawn' | 'missing'
export function consentOf(p: Pick<PatientDetail, 'consents'> | null | undefined, type: ConsentType): ConsentStatus | null {
  if (!p) return null
  const mine = list<PatientDetail['consents'][number]>(p.consents).filter((c) => c.type === type)
  if (mine.some((c) => c.status === 'granted')) return 'granted'
  return mine.some((c) => c.status === 'withdrawn') ? 'withdrawn' : 'missing'
}

const CONSENT_NEEDED: SummaryState = { kind: 'consent_needed', word: 'Consent needed', tone: 'warn' }

// --- 1 Conversation ----------------------------------------------------------------------------------------------------------------------------

type Speech = Pick<SpeechStatus, 'available' | 'state' | 'reason'>
const speechOf = (s: Partial<SpeechStatus> | null | undefined): Speech | null => (s ? { available: !!s.available, state: s.state ?? 'unavailable', reason: s.reason ?? null } : null)

/** What the conversation's chip needs of the consultation's AI state (the transcription panel's query): small, so that two reads compare equal. */
export interface ConversationAiCore {
  transcripts: number
  /** Lines of every transcript. */
  lines: number
  /** Important points found by fixed rules, not counting those replaced by a newer run. */
  points: number
  toReview: number
  confirmed: number
  rejected: number
  /** The transcript being recorded now, if any. */
  liveId: string | null
  /** The patient's consent to recording (the panel and its recorder go by this one). */
  consented: boolean
  speech: Speech | null
}

/** Null when the answer is not one the screen can read (it is "Not updated", never "Consent needed"). */
export function conversationAiCore(ai: EncounterAi | null | undefined): ConversationAiCore | null {
  if (!ai || !hasLists(ai, 'transcripts', 'facts') || !ai.consent || typeof ai.consent !== 'object') return null
  const transcripts = list<Transcript>(ai.transcripts)
  const states = list<ClinicalFact>(ai.facts)
    .map((f) => factState(f.status))
    .filter((s) => s !== 'superseded')
  return {
    transcripts: transcripts.length,
    lines: transcripts.reduce((n, t) => n + list(t.segments).length, 0),
    points: states.length,
    toReview: states.filter((s) => s === 'extracted').length,
    confirmed: states.filter((s) => s === 'confirmed').length,
    rejected: states.filter((s) => s === 'rejected').length,
    liveId: transcripts.find((t) => t.status === 'live')?.id ?? null,
    consented: !!ai.consent?.granted,
    speech: speechOf(ai.status?.stt),
  }
}

/** What it needs of the recorder's status (polled while the recorder is on the page): whether recording may start, why not, and the speech service. */
export interface ConversationCaptureCore {
  canRecord: boolean
  reason: string | null
  speech: Speech | null
}

/** Null when the answer is not an object (it is then left aside, as if the recorder had not read it). */
export const conversationCaptureCore = (c: CaptureStatus | null | undefined): ConversationCaptureCore | null =>
  c && typeof c === 'object' ? { canRecord: !!c.canRecord, reason: c.blockedReason ?? c.closedReason ?? null, speech: speechOf(c.speech) } : null

/** The speech service as the newer read has it: the recorder's status (polled) when it is on the page, else the AI state's. */
const speechNow = (a: ConversationAiCore, c: ConversationCaptureCore | null | undefined) => c?.speech ?? a.speech

function readiness(a: ConversationAiCore, c: ConversationCaptureCore | null | undefined): SummaryState {
  const speech = speechNow(a, c)
  if (!a.consented) return CONSENT_NEEDED
  if (speech && !speech.available) {
    return speech.state === 'not_configured' ? { kind: 'speech_not_set_up', word: 'Speech-to-text not set up', tone: 'neutral' } : { kind: 'speech_unavailable', word: 'Speech-to-text unavailable', tone: speech.state === 'loading' ? 'warn' : 'down' }
  }
  if (c?.canRecord) return { kind: 'ready', word: 'Ready', tone: 'ok' }
  return { kind: 'empty', word: 'Nothing recorded', tone: 'neutral' }
}

/**
 * The conversation's chip. While recording: Recording (stopped from the full panel). With something recorded: the important points waiting for
 * the doctor, else those confirmed, else that there is a transcript only. With nothing yet: whether recording can start (consent, the local
 * speech service), Ready when it can.
 */
export function conversationState(a: ConversationAiCore | null | undefined, c: ConversationCaptureCore | null | undefined, failed: { ai: boolean; capture: boolean }): SummaryState {
  if (a === null) return NOT_UPDATED
  if (!a) return failed.ai ? NOT_UPDATED : LOADING
  const late = failed.ai || (!!c && failed.capture)
  if (a.liveId) return behind({ kind: 'recording', word: 'Recording', tone: 'down' }, late)
  if (a.toReview) return behind({ kind: 'to_review', word: `${count(a.toReview, 'point')} to review`, tone: 'warn' }, late)
  if (a.confirmed) return behind({ kind: 'confirmed', word: `${count(a.confirmed, 'point')} confirmed`, tone: 'ok' }, late)
  if (a.transcripts) return behind({ kind: 'transcript', word: a.rejected ? 'No point confirmed' : 'Transcript only', tone: 'neutral' }, late)
  return behind(readiness(a, c), late)
}

const TRANSCRIPT_SOURCE: Record<string, string> = { browser_recording: 'Microphone recording', audio_upload: 'Uploaded audio', typed: 'Typed transcript', pasted: 'Typed transcript' }

export interface ConversationView {
  state: SummaryState
  facts: InputModuleFacts['conversation']
  /** Points the doctor confirmed (what an analysis reads of the conversation); null when not read. */
  confirmedPoints: number | null
  /** The fuller lines, shown while the module is open. */
  lines: string[]
  /** At most two short lines, shown while the module is closed: nothing the chip already says. */
  compact: string[]
  meta: string | null
}

/**
 * What the summary says of the speech service when it cannot be used: in the clinician's words, never the service's own reason (which can be a
 * setup instruction for whoever runs the computer). The transcription panel keeps the service's own wording.
 */
export const SPEECH_UNAVAILABLE_LINE = 'Speech-to-text unavailable.'
export const SPEECH_NOT_SET_UP_LINE = 'Speech-to-text is not set up on this computer.'

/** The conversation module's summary: the chip, two short lines, and where it came from and when. `readAt` is when the newer of the two reads arrived. */
export function conversationView(i: { ai?: EncounterAi | undefined; capture?: CaptureStatus | undefined; failed: { ai: boolean; capture: boolean }; readAt?: number | null }): ConversationView {
  const a = i.ai === undefined ? undefined : conversationAiCore(i.ai)
  const c = i.capture === undefined ? undefined : conversationCaptureCore(i.capture)
  const state = conversationState(a, c, i.failed)
  if (!i.ai || !a) {
    const line = a === null || i.failed.ai ? 'The conversation could not be read just now.' : 'Reading the conversation…'
    return { state, facts: null, confirmedPoints: null, lines: [line], compact: [line], meta: null }
  }
  const transcripts = list<Transcript>(i.ai.transcripts)
  const latest = transcripts.find((t) => t.id === a.liveId) ?? transcripts.at(-1) ?? null
  const lines: string[] = []
  const compact: string[] = []
  if (a.liveId && latest) {
    const same = i.capture?.live?.transcriptId === a.liveId
    const started = (same ? i.capture?.live?.startedAt : null) ?? latest.createdAt
    const lastPart = same ? (i.capture?.live?.lastChunkAt ?? null) : null
    lines.push('Recording — open to stop.', `Started ${fmtClock(started)}${lastPart ? ` · last part received ${fmtClock(lastPart)}` : ''}`)
    compact.push('Recording — open to stop.', `Started ${fmtClock(started)}`)
  } else if (a.transcripts) {
    lines.push(`${count(a.transcripts, 'transcript')} · ${count(a.lines, 'line')}`)
    lines.push(a.points ? `Points found by fixed rules: ${a.toReview} to review · ${a.confirmed} confirmed${a.rejected ? ` · ${a.rejected} rejected` : ''}` : 'No important points yet.')
    compact.push(lines[0]!, a.points ? `Points: ${a.toReview} to review · ${a.confirmed} confirmed` : 'No important points yet.')
  } else {
    lines.push('Nothing recorded or typed yet.')
    compact.push('Nothing recorded or typed yet.')
    const speech = speechNow(a, c)
    const why = !a.consented
      ? 'The patient’s consent to recording is not recorded.'
      : speech && !speech.available
        ? speech.state === 'not_configured'
          ? SPEECH_NOT_SET_UP_LINE
          : SPEECH_UNAVAILABLE_LINE
        : c && !c.canRecord
          ? (c.reason ?? 'Recording cannot start now.')
          : c?.canRecord
            ? 'Consent recorded; local speech-to-text ready.'
            : null
    // Closed, only what the chip does not say already ("Speech-to-text unavailable", "Speech-to-text not set up", "Ready"). Open, not that the
    // speech service cannot be used either: the transcription panel under it says so, with what can be done instead.
    const chipSays = a.consented && ((!!speech && !speech.available) || !!c?.canRecord)
    const panelSays = a.consented && !!speech && !speech.available
    if (why && !panelSays) lines.push(why)
    if (why && !chipSays) compact.push(why)
  }
  let meta: string | null = null
  if (latest) meta = `${TRANSCRIPT_SOURCE[latest.source] ?? 'Transcript'} · ${fmtTime(latest.createdAt)}`
  else {
    const s = i.capture?.speech ?? i.ai.status?.stt
    if (s) {
      const where = s.local ? 'on this computer' : `on ${s.host ?? 'another computer'}`
      const at = clockOf(i.readAt)
      meta = `Speech-to-text ${where}${s.model ? ` (${s.model})` : ''}${at ? ` · checked ${at}` : ''}`
    }
  }
  return { state, facts: { transcripts: a.transcripts, points: a.points }, confirmedPoints: a.confirmed, lines, compact, meta }
}

// --- 2 History ---------------------------------------------------------------------------------------------------------------------------------

/** What the history's chip and the workflow strip need of the patient's history: entries (conditions, medicines, results, earlier consultations) and whether the allergy status is recorded. */
export type HistoryCore = NonNullable<InputModuleFacts['history']>

/** Null when the answer is not one the screen can read (it is "Not updated", never "No history recorded"). */
export function historyCore(h: PatientHistory | null | undefined): HistoryCore | null {
  if (!hasLists(h, 'allergies', 'conditions', 'medications', 'investigations', 'consultations') || !h) return null
  const n = (x: unknown) => list(x).length
  return { entries: n(h.conditions) + n(h.medications) + n(h.investigations) + n(h.consultations), allergyStatusRecorded: n(h.allergies) > 0 || !!h.noKnownAllergies }
}

export function historyState(core: HistoryCore | null | undefined, failed: boolean): SummaryState {
  if (core === null) return NOT_UPDATED
  if (!core) return failed ? NOT_UPDATED : LOADING
  return behind(core.entries || core.allergyStatusRecorded ? { kind: 'recorded', word: 'History recorded', tone: 'ok' } : { kind: 'empty', word: 'No history recorded', tone: 'neutral' }, failed)
}

const SEVERITY: Record<string, string> = { severe: 'severe', moderate: 'moderate', mild: 'mild', unknown: 'severity not recorded' }
/** How many names a line lists before "+n". */
const NAMED = 3

export interface HistoryView {
  state: SummaryState
  facts: InputModuleFacts['history']
  /** The history as this screen read it, for the analysis' list of inputs. */
  status: 'loaded' | 'loading' | 'error'
  /** A line while there is nothing to show. */
  message: string | null
  /** The allergies with their severity, "No known allergies", or "Allergy status not recorded"; `tone` down when one is severe, warn when a severity or the status is not recorded. */
  allergies: { text: string; tone: 'down' | 'warn' | 'neutral' } | null
  conditions: string | null
  record: string | null
  /** Closed: the open conditions and the current medicines, counted, in one short line. */
  counts: string | null
  reason: string | null
  meta: string | null
}

/** The history module's summary: allergies, open conditions, then medicines, results and the last consultation; the reason for this visit. */
export function historyView(i: { history?: PatientHistory | undefined; failed: boolean; reasonForVisit?: string | null | undefined }): HistoryView {
  const h = i.history
  const reason = i.reasonForVisit?.trim() ? `Reason for visit: ${i.reasonForVisit.trim()}` : null
  const core = h === undefined ? undefined : historyCore(h)
  if (!h || !core) {
    const unread = core === null || i.failed
    return { state: historyState(core, i.failed), facts: null, status: unread ? 'error' : 'loading', message: unread ? 'The patient’s history could not be read just now.' : 'Reading the patient’s history…', allergies: null, conditions: null, record: null, counts: null, reason, meta: null }
  }
  const allergies = list<PatientHistory['allergies'][number]>(h.allergies)
  const more = (n: number) => (n > NAMED ? ` +${n - NAMED}` : '')
  const allergyLine: HistoryView['allergies'] = allergies.length
    ? {
        text: `Allergies: ${allergies
          .slice(0, NAMED)
          .map((a) => `${a.substance} (${SEVERITY[a.severity] ?? SEVERITY.unknown})`)
          .join(', ')}${more(allergies.length)}`,
        tone: allergies.some((a) => a.severity === 'severe') ? 'down' : allergies.some((a) => a.severity !== 'mild' && a.severity !== 'moderate') ? 'warn' : 'neutral',
      }
    : h.noKnownAllergies
      ? { text: 'No known allergies', tone: 'neutral' }
      : { text: 'Allergy status not recorded', tone: 'warn' }
  const open = list<PatientHistory['conditions'][number]>(h.conditions).filter((c) => c.status !== 'resolved' && c.status !== 'entered_in_error')
  const conditions = open.length
    ? `Conditions: ${open
        .slice(0, NAMED)
        .map((c) => c.name)
        .join(', ')}${more(open.length)}`
    : 'No open condition recorded'
  const current = list<PatientHistory['medications'][number]>(h.medications).filter((m) => m.status === 'current').length
  const results = list(h.investigations).length + Math.max(0, h.more?.investigations ?? 0)
  const last = list<PatientHistory['consultations'][number]>(h.consultations)[0]
  const record = `${count(current, 'current medicine')} · ${count(results, 'result')} · ${last ? `last consultation ${fmtDate(last.date)}` : 'no earlier consultation'}`
  return {
    state: historyState(core, i.failed),
    facts: core,
    status: 'loaded',
    message: null,
    allergies: allergyLine,
    conditions,
    record,
    counts: `${open.length ? count(open.length, 'open condition') : 'No open condition'} · ${count(current, 'current medicine')}`,
    reason,
    meta: `Patient record · as of ${fmtClock(h.generatedAt)}`,
  }
}

// --- 3 Vitals ----------------------------------------------------------------------------------------------------------------------------------

/** What a wearable band may send (the device gate): the four values the module shows large, in this order. */
export const BAND_KINDS: readonly VitalKind[] = DEVICE_READING_KINDS.wearable_band

const STATE_TONE: Record<ReadingState, ModuleTone> = { live: 'ok', stale: 'warn', disconnected: 'down', no_data: 'neutral', unavailable: 'neutral' }

/** The device answer aged to now (as the device card ages it), or null when it is not an answer the screen can read. */
export function agedDevices(d: ReceivedDeviceReadings | null | undefined, nowLocal: number): { view: PatientDeviceReadings; now: number; receivedAt: number } | null {
  const v = d?.view
  if (!d || !v || typeof v.serverTime !== 'string' || !v.thresholds || !Array.isArray(v.devices)) return null
  if (!v.devices.every((x) => !!x && typeof x === 'object' && Array.isArray(x.readings) && Array.isArray(x.kinds) && typeof x.state === 'string')) return null
  const aged = safely(() => ageView(d, nowLocal), null)
  return aged && Number.isFinite(aged.now) ? { ...aged, receivedAt: d.receivedAt } : null
}

/** What the vitals chip and the strip need of the device answer: small, so that two reads that say the same compare equal (no times in it). */
export interface DeviceCore {
  /** False when the answer could not be read (it is "Not updated"). */
  readable: boolean
  attached: number
  /** The devices' state for the chip, when any is attached. */
  state: SummaryState | null
  consent: PatientDeviceReadings['consent'] | null
  /** Newest readings (one per kind per device) that are not simulated. */
  readings: number
  /** Newest readings a simulator made. */
  simulated: number
}

/**
 * The devices' state in one word, as the header's device chip says it (the most concerning first). A simulator is never said to be live: when
 * the only live devices are simulators, the word is "Simulated device".
 */
export function deviceCore(d: ReceivedDeviceReadings | null | undefined, nowLocal: number): DeviceCore {
  const aged = agedDevices(d, nowLocal)
  if (!aged) return { readable: false, attached: 0, state: null, consent: null, readings: 0, simulated: 0 }
  const devices = aged.view.devices
  const s = summarizeDevices(aged.view)
  let state: SummaryState | null = null
  if (devices.length && s.state !== 'none') {
    const live = devices.filter((x) => x.state === 'live')
    const realLive = live.filter((x) => !x.simulated).length
    if (s.state === 'live' && realLive === 0) state = { kind: 'simulated', word: live.length > 1 ? 'Simulated devices' : 'Simulated device', tone: 'neutral' }
    else if (s.state === 'live') state = { kind: 'live', word: `Device live${devices.length > 1 ? ` (${realLive} of ${devices.length})` : ''}`, tone: 'ok' }
    else state = { kind: s.state, word: s.label, tone: STATE_TONE[s.state] }
  }
  const all = devices.flatMap((x) => x.readings.map((r) => ({ simulated: x.simulated || r.validationStatus === 'simulated' })))
  return { readable: true, attached: devices.length, state, consent: aged.view.consent ?? null, readings: all.filter((r) => !r.simulated).length, simulated: all.filter((r) => r.simulated).length }
}

const usable = (o: Observation) => !!o && !o.enteredInError && o.validationStatus !== 'simulated'
function newestPerKind(xs: Observation[]): Map<VitalKind, Observation> {
  const m = new Map<VitalKind, Observation>()
  for (const o of xs) {
    const c = m.get(o.kind)
    if (!c || o.measuredAt > c.measuredAt) m.set(o.kind, o)
  }
  return m
}

/** This visit's vital signs as the encounter holds them: the newest that staff measured of each kind, and the newest a device stored of each. */
export function visitVitals(vitals: Observation[] | null | undefined) {
  const all = list<Observation>(vitals).filter(usable)
  return { staff: newestPerKind(all.filter((o) => o.source !== 'device')), stored: newestPerKind(all.filter((o) => o.source === 'device')) }
}

/**
 * The vitals chip. Devices attached: their state (live, stale, disconnected, no data, unavailable; a simulator never live). An answer that
 * could not be read: Not updated. No device: Staff vitals when staff measured any, else the device consent if it is missing, else No device
 * attached.
 */
export function vitalsState(staffKinds: number, dev: DeviceCore | null | undefined, failed: boolean): SummaryState {
  if (dev?.readable && dev.attached && dev.state) return behind(dev.state, failed)
  if (dev && !dev.readable) return NOT_UPDATED
  if (!dev && failed) return NOT_UPDATED
  if (staffKinds) return { kind: 'staff', word: 'Staff vitals', tone: 'ok' }
  if (!dev) return LOADING
  if (dev.consent === 'missing') return behind(CONSENT_NEEDED, failed)
  return behind({ kind: 'no_device', word: 'No device attached', tone: 'neutral' }, failed)
}

/** The counts of the workflow strip: kinds staff measured, device readings that are not simulated (at least), simulated ones. */
export function vitalsFacts(staffKinds: number, storedKinds: number, dev: DeviceCore | null | undefined): NonNullable<InputModuleFacts['vitals']> {
  return { staff: staffKinds, device: Math.max(dev?.readable ? dev.readings : 0, storedKinds), simulated: dev?.readable ? dev.simulated : 0 }
}

/** The same counts in the words of the analysis' list of inputs (lib/analysis.ts AnalysisInputFacts): only "more than none" matters there. */
export function vitalsAnalysis(staffKinds: number, storedKinds: number, dev: DeviceCore | null | undefined): { staffVitals: number; deviceReadings: number; simulatedReadings: number } {
  const f = vitalsFacts(staffKinds, storedKinds, dev)
  return { staffVitals: f.staff, deviceReadings: f.device, simulatedReadings: f.simulated }
}

/** One value of a tile: what staff measured, what an attached device sent (with its state), or what a device stored with this visit earlier. */
export interface VitalValue {
  source: 'staff' | 'device' | 'stored'
  value: string
  unit: string
  /** The adult reference-range flag (none under 18, none for a simulator). */
  flag: VitalFlag | null
  /** When it was measured (ISO). */
  at: string
  /** A device value's state, as the device card ages it. */
  state: ReadingState | null
  /** Whether its state is shown: never LIVE for a simulator's value (SIMULATED and its age say what it is). */
  showState: boolean
  simulated: boolean
  device: string | null
}

export interface VitalTile {
  kind: VitalKind
  /** HR, SpO₂, Temp, RR. */
  short: string
  label: string
  values: VitalValue[]
}

const fmtNumber = (kind: VitalKind, v: number) => (Number.isFinite(v) ? v.toFixed(VITALS[kind]?.decimals ?? 0) : '—')

/** Where a value of the closed module's one line came from: staff, an attached device (unverified), a device's reading stored with the visit, a simulator. */
export type VitalMark = 'staff' | 'device' | 'stored' | 'simulated'

/**
 * One value of the closed module's line: the newest current value of its kind (staff's, one stored with the visit, or a live device's), else
 * the newest value that is not current (a device's last value, greyed, with its state), else a simulator's (only when nothing else has that
 * kind). Never a simulator's where a real value exists.
 */
export interface CompactVital {
  kind: VitalKind
  short: string
  label: string
  /** Null when nothing has this kind. */
  value: string | null
  unit: string
  flag: VitalFlag | null
  mark: VitalMark | null
  /** False for a device's value that is not live (stale, disconnected): shown greyed, with its state. */
  current: boolean
  state: ReadingState | null
}

/** The closed module's line: the four values in their order, and where they came from, grouped (each group names its kinds when there are several). */
export interface CompactVitals {
  values: CompactVital[]
  sources: { mark: VitalMark; state: ReadingState | null; kinds: string[]; at: string | null }[]
}

const markOf = (v: VitalValue): VitalMark => (v.simulated ? 'simulated' : v.source)

const isCurrent = (v: VitalValue) => v.source !== 'device' || v.state === 'live'

/** The value of each tile the closed line shows (see CompactVital), and the sources of what is shown, grouped by source and state. */
export function compactVitals(tiles: VitalTile[]): CompactVitals {
  const values = tiles.map((t): CompactVital => {
    const byTime = [...t.values].sort((a, b) => b.at.localeCompare(a.at))
    const v = byTime.find((x) => !x.simulated && isCurrent(x)) ?? byTime.find((x) => !x.simulated) ?? byTime[0] ?? null
    if (!v) return { kind: t.kind, short: t.short, label: t.label, value: null, unit: '', flag: null, mark: null, current: true, state: null }
    const current = isCurrent(v)
    return { kind: t.kind, short: t.short, label: t.label, value: v.value, unit: v.unit, flag: v.simulated ? null : v.flag, mark: markOf(v), current, state: v.source === 'device' && !current ? v.state : null }
  })
  const sources: CompactVitals['sources'] = []
  for (const v of values) {
    if (!v.mark) continue
    const tile = tiles.find((t) => t.kind === v.kind)
    const at = tile?.values.find((x) => markOf(x) === v.mark)?.at ?? null
    const group = sources.find((g) => g.mark === v.mark && g.state === v.state)
    if (group) {
      group.kinds.push(v.short)
      if (at && (!group.at || at > group.at)) group.at = at
    } else sources.push({ mark: v.mark, state: v.state, kinds: [v.short], at })
  }
  return { values, sources }
}

export interface VitalsView {
  state: SummaryState
  facts: NonNullable<InputModuleFacts['vitals']>
  /** What an analysis reads (and does not) of this module. */
  analysis: { staffVitals: number; deviceReadings: number; simulatedReadings: number }
  /** Heart rate, SpO₂, temperature and respiratory rate; empty when there is none of them from anywhere. */
  tiles: VitalTile[]
  /** The closed module's one line of the same four (null when there is none of them). */
  compact: CompactVitals | null
  /** Other kinds staff measured, in one line ("BP 120/80 mmHg · Wt 70.0 kg"). */
  also: string | null
  /** The devices, when something about them is not in the tiles (none attached, not read, not updated). */
  deviceLine: string | null
  consentLine: string | null
  /** The patient is under 18: no reference range is applied (none is implemented for children). */
  paediatric: boolean
  /** The server's clock carried forward, for a device value's age; null when the devices were not read. */
  now: number | null
  attached: number
  meta: string | null
}

/** The vitals module's summary: staff vital signs and what the attached devices are sending, large, each with its source and state. */
export function vitalsView(i: { vitals: Observation[]; dateOfBirth?: string | null | undefined; devices?: ReceivedDeviceReadings | undefined; devicesFailed: boolean; nowLocal: number; today?: Date }): VitalsView {
  const { staff, stored } = visitVitals(i.vitals)
  const aged = i.devices ? agedDevices(i.devices, i.nowLocal) : null
  const dev = i.devices ? deviceCore(i.devices, i.nowLocal) : null
  const tiles: VitalTile[] = []
  for (const kind of BAND_KINDS) {
    const values: VitalValue[] = []
    const s = staff.get(kind)
    if (s) values.push({ source: 'staff', value: fmtNumber(kind, s.value), unit: s.unit || VITALS[kind].unit, flag: s.flag, at: s.measuredAt, state: null, showState: false, simulated: false, device: null })
    let newest: VitalValue | null = null
    for (const d of aged?.view.devices ?? []) {
      for (const r of d.readings) {
        if (r.kind !== kind || (newest && r.measuredAt <= newest.at)) continue
        const simulated = d.simulated || r.validationStatus === 'simulated'
        newest = { source: 'device', value: fmtNumber(kind, r.value), unit: r.unit || VITALS[kind].unit, flag: simulated ? null : r.flag, at: r.measuredAt, state: r.state, showState: !(simulated && r.state === 'live'), simulated, device: d.label }
      }
    }
    const kept = stored.get(kind)
    if (newest) values.push(newest)
    else if (kept) values.push({ source: 'stored', value: fmtNumber(kind, kept.value), unit: kept.unit || VITALS[kind].unit, flag: kept.flag, at: kept.measuredAt, state: null, showState: false, simulated: false, device: kept.deviceLabel })
    tiles.push({ kind, short: VITALS[kind].short, label: VITALS[kind].label, values })
  }
  const others = VITAL_ORDER.filter((k) => !BAND_KINDS.includes(k))
  const sbp = staff.get('systolic_bp')
  const dbp = staff.get('diastolic_bp')
  const also = others
    .flatMap((k) => {
      if (k === 'diastolic_bp' && sbp) return []
      if (k === 'systolic_bp' && sbp && dbp) return [`BP ${fmtNumber('systolic_bp', sbp.value)}/${fmtNumber('diastolic_bp', dbp.value)} ${sbp.unit || 'mmHg'}`]
      const o = staff.get(k)
      return o ? [`${VITALS[k].short} ${fmtNumber(k, o.value)} ${o.unit || VITALS[k].unit}`] : []
    })
    .join(' · ')
  const fresh = !!aged && !i.devicesFailed && i.nowLocal - aged.receivedAt <= 2 * DEVICE_POLL_MS + 1000
  const deviceLine = !aged
    ? i.devices || i.devicesFailed
      ? 'Device readings could not be read just now.'
      : null
    : !fresh
      ? `Device readings not updated since ${clockOf(aged.receivedAt)}.`
      : aged.view.devices.length
        ? null
        : 'No device attached.'
  const consent = aged?.view.consent
  const consentLine = consent === 'missing' ? 'Consent to device readings is not recorded, so no device can be attached.' : consent === 'outdated' ? 'Consent to device readings must be recorded again before a device is attached.' : null
  const age = i.dateOfBirth ? ageFrom(i.dateOfBirth, i.today) : Number.NaN
  const staffTimes = [...staff.values()].map((o) => o.measuredAt).sort()
  const metaParts = [staffTimes.length ? `Staff, ${fmtTime(staffTimes.at(-1))}` : null, aged ? `Device gateway, read ${clockOf(aged.receivedAt)}` : null].filter(Boolean)
  return {
    state: vitalsState(staff.size, dev, i.devicesFailed),
    facts: vitalsFacts(staff.size, stored.size, dev),
    analysis: vitalsAnalysis(staff.size, stored.size, dev),
    tiles: tiles.some((t) => t.values.length) ? tiles : [],
    compact: tiles.some((t) => t.values.length) ? compactVitals(tiles) : null,
    also: also || null,
    deviceLine,
    consentLine,
    paediatric: Number.isFinite(age) && age < 18,
    now: aged?.now ?? null,
    attached: aged?.view.devices.length ?? 0,
    meta: metaParts.length ? metaParts.join(' · ') : null,
  }
}

// --- 4 Stethoscope -----------------------------------------------------------------------------------------------------------------------------

/**
 * How long a recording is, and who says so: the server measures no length. A browser recording is timed by the browser; an upload reports
 * none. As m:ss, the way the closed module says it (recordingClock), so a length is written one way everywhere.
 */
export function recordingLength(r: Pick<AuscultationRecording, 'captureMethod' | 'durationMs'>): string {
  if (!r.durationMs) return 'length not reported'
  const s = recordingClock(r)
  return r.captureMethod === 'browser_recording' ? `${s}, timed by the browser` : r.captureMethod === 'gateway' ? `${s}, as reported by the gateway` : `${s}, as reported with the file`
}

/** The recordings of this consultation, newest first. */
const ofConsultation = (recordings: unknown, encounterId: string) =>
  list<AuscultationRecording>(recordings)
    .filter((r) => r.encounterId === encounterId)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

/** What the stethoscope chip and the strip need: this consultation's recordings and how many of them a simulator made; the patient's others. */
export interface StethoscopeCore {
  recordings: number
  simulated: number
  earlier: number
}

/** Null when the answer holds no list of recordings (it is "Not updated", never "No recording"). */
export function stethoscopeCore(recordings: unknown, encounterId: string): StethoscopeCore | null {
  if (!Array.isArray(recordings)) return null
  const all = list<AuscultationRecording>(recordings)
  const mine = ofConsultation(all, encounterId)
  return { recordings: mine.length, simulated: mine.filter((r) => r.simulated).length, earlier: all.length - mine.length }
}

/** The stethoscope chip: this consultation's recordings (or that a simulator made all of them), else the device consent if it is missing, else No recording. */
export function stethoscopeState(core: StethoscopeCore | null | undefined, consent: ConsentStatus | null, failed: boolean): SummaryState {
  if (core === null) return NOT_UPDATED
  if (!core) return failed ? NOT_UPDATED : LOADING
  if (core.recordings) return behind(core.recordings > core.simulated ? { kind: 'recorded', word: count(core.recordings, 'recording'), tone: 'ok' } : { kind: 'simulated', word: 'Simulated only', tone: 'neutral' }, failed)
  if (consent && consent !== 'granted') return behind(CONSENT_NEEDED, failed)
  return behind({ kind: 'empty', word: 'No recording', tone: 'neutral' }, failed)
}

/** Said in the module whatever it holds: nothing listens to or analyses a recording. */
export const STETHOSCOPE_HONESTY = 'Recorded, not analysed. No stethoscope has been connected to or tested with this system.'

/** A recording's length as m:ss, or that none was reported (the server measures none). */
export const recordingClock = (r: Pick<AuscultationRecording, 'durationMs'>): string => {
  if (!r.durationMs) return 'length not reported'
  const s = Math.round(r.durationMs / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A site's name without its parenthesis ("Mitral area (apex)" → "Mitral area"), for the closed module's one line. */
const shortSite = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '')

export interface StethoscopeView {
  state: SummaryState
  facts: InputModuleFacts['stethoscope']
  /** Closed: "1 recording · Mitral area · 0:02", or that there is none, or that the list is not read. */
  compact: string
  /** How many in this consultation (and the patient's others), or that there is none, or that the list is not read. */
  count: string
  /** The newest of this consultation: its site and length, and whether a simulator made it (SIMULATED AUDIO). */
  last: { site: string; length: string; simulated: boolean } | null
  consentLine: string | null
  meta: string | null
}

export function stethoscopeView(i: { recordings?: unknown; failed: boolean; patient?: Pick<PatientDetail, 'consents'> | undefined; encounterId: string }): StethoscopeView {
  const consent = consentOf(i.patient, 'device_monitoring')
  const core = i.recordings === undefined ? undefined : stethoscopeCore(i.recordings, i.encounterId)
  if (!core) {
    const unread = core === null || i.failed
    const line = unread ? 'The recordings could not be read just now.' : 'Reading the recordings…'
    return { state: stethoscopeState(core, consent, i.failed), facts: null, compact: line, count: line, last: null, consentLine: null, meta: null }
  }
  const newest = ofConsultation(i.recordings, i.encounterId)[0]
  const earlier = core.earlier ? ` · ${count(core.earlier, 'earlier recording')} of this patient` : ''
  return {
    state: stethoscopeState(core, consent, i.failed),
    facts: { recordings: core.recordings, simulated: core.simulated },
    compact: newest ? `${count(core.recordings, 'recording')} · ${shortSite(AUSCULTATION_SITES[newest.site] ?? 'Site not stated')} · ${recordingClock(newest)}` : 'No recording in this consultation',
    count: core.recordings ? `${count(core.recordings, 'recording')} in this consultation${earlier}` : `No recording in this consultation${earlier}`,
    last: newest ? { site: AUSCULTATION_SITES[newest.site] ?? 'Site not stated', length: recordingLength(newest), simulated: !!newest.simulated } : null,
    consentLine: consent === 'withdrawn' ? 'The patient withdrew consent to device readings: no recording can be added.' : consent === 'missing' ? 'Consent to device readings is not recorded, so no recording can be added.' : null,
    meta: newest ? `${AUSCULTATION_CAPTURE[newest.captureMethod] ?? 'Recording'}${newest.createdByName ? `, ${newest.createdByName}` : ''} · ${fmtTime(newest.createdAt)}` : null,
  }
}

// --- 5 Thermal ---------------------------------------------------------------------------------------------------------------------------------

const isSimulated = (c: Pick<ThermalCapture, 'simulated' | 'captureSource'>) => !!c.simulated || c.captureSource === 'simulator'
/** This consultation's images, newest first (by when the server received them). */
const imagesOf = (captures: unknown, encounterId: string) =>
  list<ThermalCapture>(captures)
    .filter((c) => c.encounterId === encounterId)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

/** What the thermal chip, the strip and the analysis' list need: this consultation's images by status, and the patient's approved and simulated ones. */
export interface ThermalCore {
  images: number
  simulated: number
  approved: number
  drafts: number
  /** The patient's approved images that are not simulated (an analysis reads these). */
  approvedReal: number
  /** The patient's simulated images (never read). */
  simulatedAll: number
}

/** Null when the answer holds no list of images (it is "Not updated", never "No image"). */
export function thermalCore(captures: unknown, encounterId: string): ThermalCore | null {
  if (!Array.isArray(captures)) return null
  const all = list<ThermalCapture>(captures)
  const mine = imagesOf(all, encounterId)
  return {
    images: mine.length,
    simulated: mine.filter(isSimulated).length,
    approved: mine.filter((c) => c.status === 'approved').length,
    drafts: mine.filter((c) => c.status === 'draft').length,
    approvedReal: all.filter((c) => c.status === 'approved' && !isSimulated(c)).length,
    simulatedAll: all.filter(isSimulated).length,
  }
}

/**
 * The thermal chip: what waits for the doctor ("1 to review", in the pending tint) while an image waits for review, else this consultation's
 * images (green once one is approved), or that a simulator made all of them; else the consent if missing; else No image.
 */
export function thermalState(core: ThermalCore | null | undefined, consent: ConsentStatus | null, failed: boolean): SummaryState {
  if (core === null) return NOT_UPDATED
  if (!core) return failed ? NOT_UPDATED : LOADING
  if (core.images) {
    if (core.simulated >= core.images) return behind({ kind: 'simulated', word: 'Simulated only', tone: 'neutral' }, failed)
    return behind({ kind: 'images', word: core.drafts ? `${core.drafts} to review` : count(core.images, 'image'), tone: core.drafts ? 'warn' : core.approved ? 'ok' : 'neutral' }, failed)
  }
  if (consent && consent !== 'granted') return behind(CONSENT_NEEDED, failed)
  return behind({ kind: 'no_image', word: 'No image', tone: 'neutral' }, failed)
}

const STATUS: Record<ThermalCapture['status'], { word: string; tone: 'warn' | 'ok' | 'neutral' }> = { draft: { word: 'Draft', tone: 'warn' }, approved: { word: 'Approved', tone: 'ok' }, rejected: { word: 'Rejected', tone: 'neutral' } }

/** The newest image of the consultation in words: where on the body, its approval, its range, whether it is radiometric, its regions. */
export interface ThermalNewest {
  capture: ThermalCapture
  body: string
  status: { word: string; tone: 'warn' | 'ok' | 'neutral' }
  /** The image's range in one short span ("25.9–62.3 °C"). */
  range: string
  stats: string
  radiometric: string
  regions: string
  simulated: boolean
}

export interface ThermalView {
  state: SummaryState
  facts: InputModuleFacts['thermal']
  analysis: { approvedThermal: number; simulatedThermal: number; thermalConsentWithdrawn: boolean }
  newest: ThermalNewest | null
  /** "Images: 3 (approved 1)", or that there is none, or that the list is not read. */
  images: string
  consentLine: string | null
  camera: string
  /** The thermal model as the server describes it: MODEL UNAVAILABLE today (`chip`), with what to say beside it. */
  model: { chip: string | null; available: boolean | null; text: string | null }
  research: string
  meta: string | null
}

/** Whether the server says a thermal model is installed (it says none is), in the words of the thermal pages. */
export function thermalModelLine(status: ThermalModelStatus | undefined, failed: boolean): ThermalView['model'] {
  if (!status) return { chip: null, available: null, text: failed ? 'Thermal model status could not be read.' : 'Checking the thermal model…' }
  if (!status.available) return { chip: 'MODEL UNAVAILABLE', available: false, text: null }
  return { chip: status.kind ? status.kind.toUpperCase() : 'KIND NOT STATED', available: true, text: `Thermal model: ${status.modelId ?? 'not named'}` }
}

/** The camera from this page: without the tablet app's bridge no FLIR ONE can be reached (a browser cannot read its radiometric data). */
export const thermalCameraLine = (bridge: boolean) => (bridge ? 'Camera bridge present: a FLIR ONE can be connected in the thermal workspace.' : 'FLIR ONE not connected')

export function thermalView(i: { captures?: unknown; failed: boolean; patient?: Pick<PatientDetail, 'consents'> | undefined; encounterId: string; model?: ThermalModelStatus | undefined; modelFailed: boolean; bridge: boolean }): ThermalView {
  const consent = consentOf(i.patient, 'thermal_imaging')
  const camera = thermalCameraLine(i.bridge)
  const model = thermalModelLine(i.model, i.modelFailed)
  const research = 'Research mode available'
  const core = i.captures === undefined ? undefined : thermalCore(i.captures, i.encounterId)
  if (!core) {
    return {
      state: thermalState(core, consent, i.failed),
      facts: null,
      analysis: { approvedThermal: 0, simulatedThermal: 0, thermalConsentWithdrawn: consent === 'withdrawn' },
      newest: null,
      images: core === null || i.failed ? 'The thermal images could not be read just now.' : 'Reading the thermal images…',
      consentLine: null,
      camera,
      model,
      research,
      meta: null,
    }
  }
  const c = imagesOf(i.captures, i.encounterId)[0]
  const simulated = !!c && isSimulated(c)
  const newest: ThermalNewest | null = c
    ? {
        capture: c,
        body: (c.protocol?.bodySite ? BODY_SITES[c.protocol.bodySite] : null) ?? c.protocol?.bodyRegion ?? 'Body region not stated',
        status: STATUS[c.status] ?? { word: 'Status not stated', tone: 'neutral' },
        range: Number.isFinite(c.minC) && Number.isFinite(c.maxC) ? `${c.minC.toFixed(1)}–${c.maxC.toFixed(1)} °C` : 'Range not stated',
        stats: `Min ${fmtC(c.minC)} · max ${fmtC(c.maxC)} · mean ${fmtC(c.meanC)}`,
        radiometric: simulated ? 'Radiometric: no, generated numbers' : 'Radiometric: yes',
        regions: count(list(c.rois).length, 'region'),
        simulated,
      }
    : null
  return {
    state: thermalState(core, consent, i.failed),
    facts: { images: core.images, simulated: core.simulated },
    analysis: { approvedThermal: core.approvedReal, simulatedThermal: core.simulatedAll, thermalConsentWithdrawn: consent === 'withdrawn' },
    newest,
    images: core.images ? `Images: ${core.images} (approved ${core.approved})` : 'No image in this consultation yet',
    consentLine: consent === 'withdrawn' ? 'The patient withdrew consent to thermal imaging: no image can be captured.' : consent === 'missing' ? 'Consent to thermal imaging is not recorded, so no image can be captured.' : null,
    camera,
    model,
    research,
    meta: c ? `${THERMAL_CAPTURE_SOURCES[c.captureSource] ?? 'Source not stated'} · ${fmtTime(c.capturedAt ?? c.createdAt)}` : null,
  }
}
