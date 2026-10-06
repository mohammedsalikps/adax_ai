/*
 * Pure rules of the consultation's live transcription panel (DESIGN §5.4 column 1): whether recording may start by itself and, when it does
 * not, the one honest line that says why; the live waveform's bars; how the important points are grouped and when confirming one needs the
 * explicit tick; when the conversation follows its newest line and which recording's line a point points at; how an answer of the API is
 * merged with a newer one already shown; and when the fixed rules are run again after a part. No React and no browser here: every rule is
 * tested (test/liveTranscription.test.ts).
 */
import { type CaptureStatus, type ClinicalFact, CONFIRM_FLAGS, type EncounterAi, FACT_CATEGORIES, FACT_FLAGS, type FactState, factState, type Transcript } from '@adaxai/contracts'
import type { RecordingState } from '../../lib/recordingState.ts'

// --- Not recording: why, in one line -------------------------------------------------------------------------------------------------------

export type NotRecordingReason =
  | 'consent'
  | 'withdrawn'
  | 'speech'
  | 'speech_loading'
  | 'microphone'
  | 'no_microphone'
  | 'microphone_busy'
  | 'unsupported'
  | 'busy'
  | 'ended'
  | 'closed'
  | 'error'

/** The words after "Not recording — ". Plain, true, and never blaming anyone. */
export const NOT_RECORDING: Record<NotRecordingReason, string> = {
  consent: 'the patient’s recording consent is not on record',
  withdrawn: 'consent to recording was withdrawn',
  speech: 'the speech service is not running',
  speech_loading: 'the speech service is still starting',
  microphone: 'the microphone is blocked',
  no_microphone: 'no microphone was found',
  microphone_busy: 'the microphone could not be opened',
  unsupported: 'this browser cannot record from a microphone',
  busy: 'another recording of this consultation is still open',
  ended: 'the recording was ended in another window',
  closed: 'this consultation is closed to recording',
  error: 'the recording could not be started',
}

export const notRecordingLine = (r: NotRecordingReason | null): string => (r ? `Not recording — ${NOT_RECORDING[r]}` : 'Not recording')

/**
 * The one action offered with a reason: record the patient's consent, try the microphone again, end the recording left open elsewhere, or
 * start a new recording (this one was ended elsewhere). A reason without one is cleared by itself when the capture status shows it is over.
 */
export type NotRecordingAction = 'record_consent' | 'try_again' | 'end_other' | 'start_new'
export const NOT_RECORDING_ACTION: Partial<Record<NotRecordingReason, NotRecordingAction>> = {
  consent: 'record_consent',
  withdrawn: 'record_consent',
  microphone: 'try_again',
  no_microphone: 'try_again',
  microphone_busy: 'try_again',
  error: 'try_again',
  busy: 'end_other',
  ended: 'start_new',
}

/** Why the browser would not give a microphone (a getUserMedia error's name), as a reason. */
export function microphoneReason(errorName: string): NotRecordingReason {
  if (errorName === 'NotAllowedError' || errorName === 'SecurityError') return 'microphone'
  if (errorName === 'NotFoundError' || errorName === 'OverconstrainedError') return 'no_microphone'
  if (errorName === 'NotReadableError' || errorName === 'AbortError') return 'microphone_busy'
  return 'error'
}

/** Why the API refused to open a recording (its error code and status), as a reason. */
export function startRefusalReason(code: string, status = 0): NotRecordingReason {
  if (code === 'recording_in_progress') return 'busy'
  if (code === 'stt_unavailable') return 'speech'
  if (code === 'consent_withdrawn') return 'withdrawn'
  if (/^(ai_)?consent_/.test(code)) return 'consent'
  if (status === 403 || ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(code)) return 'closed'
  return 'error'
}

export interface IdleReasonInput {
  /** The consultation is in progress and this doctor may write it. */
  open: boolean
  /** The browser has getUserMedia and MediaRecorder. */
  micSupported: boolean
  /** The patient's recording consent as the panel's AI state has it (ongoing, or for this consultation). */
  consentGranted: boolean
  /** GET /encounters/:id/capture; undefined while it is first read. */
  status: Pick<CaptureStatus, 'canRecord' | 'closedReason' | 'consent' | 'speech'> | undefined
  /** A recording of this consultation is open that this panel is not making (another window, a page that was reloaded, the demo). */
  otherRecordingOpen: boolean
  /** What stopped or refused the last attempt here (the microphone, the API), if anything; cleared when the doctor tries again. */
  problem: NotRecordingReason | null
}

/**
 * Why the microphone is not recording while the recorder is idle, or null when it could start now (or while the status is still being read,
 * when nothing is claimed). The order is what the doctor can act on first.
 */
export function idleReason(i: IdleReasonInput): NotRecordingReason | null {
  if (!i.open) return 'closed'
  if (!i.micSupported) return 'unsupported'
  if (i.problem) return i.problem
  const s = i.status
  if (!s) return null
  if (s.closedReason) return 'closed'
  if (i.otherRecordingOpen) return 'busy'
  if (!i.consentGranted || !s.consent.granted) return 'consent'
  if (!s.speech.available) return s.speech.state === 'loading' ? 'speech_loading' : 'speech'
  if (!s.canRecord) return 'closed'
  return null
}

/**
 * Whether what stopped or refused the last attempt here is over, as a capture status read AFTER it shows (the caller compares the times), so
 * that the line says what is true now and is never a dead end: the patient's consent on record again (here or anywhere else), the speech
 * service back, the other recording ended. What only this browser knows (the microphone was refused, the start failed, this recording was
 * ended elsewhere, the consultation was closed to it) is not judged by the status: those keep their line and their action.
 */
export function problemResolved(problem: NotRecordingReason, i: { consentGranted: boolean; status: Pick<CaptureStatus, 'consent' | 'speech'>; otherRecordingOpen: boolean }): boolean {
  if (problem === 'consent' || problem === 'withdrawn') return i.consentGranted && i.status.consent.granted
  if (problem === 'speech' || problem === 'speech_loading') return i.status.speech.available
  if (problem === 'busy') return !i.otherRecordingOpen
  return false
}

/**
 * The recording of this consultation that is open while this panel's recorder is idle (another window, a page that was reloaded, a start the
 * API refused because one was open), or null. Whichever was read last says it: the capture status (polled; it knows a recording the AI state
 * has not seen yet) or the AI state (updated by every answer; it knows a recording just stopped here before the status is read again). A
 * recording the AI state knows not to be another open microphone recording (finished, or the demo's) is never it.
 */
export function otherRecordingId(i: {
  recorderIdle: boolean
  /** The AI state's open recording (any), and when the AI state was read or updated (ms). */
  aiLiveId: string | null
  aiAt: number
  /** The capture status's open recording (undefined before the status was first read), and when it was read (ms). */
  statusLiveId: string | null | undefined
  statusAt: number
  /** Recordings the AI state knows are not one: finished ones, the demo's. */
  notOpen: ReadonlySet<string>
}): string | null {
  if (!i.recorderIdle) return null
  const id = i.statusLiveId !== undefined && i.statusAt >= i.aiAt ? i.statusLiveId : i.aiLiveId
  return id && !i.notOpen.has(id) ? id : null
}

/**
 * What the panel shows for its AI state's query: its body (and with it the recorder) whenever there is something to show, also after a later
 * refresh failed (the query keeps its data and reports the error: unmounting the body then would end a recording in progress while the
 * header still said "Recording"); the loading or error placeholder only before the first answer.
 */
export function panelContent(q: { hasData: boolean; isError: boolean }): 'body' | 'loading' | 'error' {
  if (q.hasData) return 'body'
  return q.isError ? 'error' : 'loading'
}

export type AutoStartDecision = { kind: 'none' } | { kind: 'wait' } | { kind: 'start' } | { kind: 'blocked'; reason: NotRecordingReason }

/**
 * Whether the microphone recording starts by itself now (DESIGN §5.4 "Recording auto-start"): only when the workspace asked for it (a NEW
 * Start consultation, not a resume or a reload), the recorder is idle, the capture status has been read, and nothing stands in the way (the
 * patient's recording consent is on record, the local speech service can record, no recording is open, the microphone was not refused).
 * Otherwise the reason, which the panel says in one line. It never decides for the demo: the demo is only ever played by the doctor.
 */
export function autoStartDecision(i: { requested: boolean; recorderIdle: boolean; statusKnown: boolean; reason: NotRecordingReason | null }): AutoStartDecision {
  if (!i.requested || !i.recorderIdle) return { kind: 'none' }
  if (i.reason) return { kind: 'blocked', reason: i.reason }
  if (!i.statusKnown) return { kind: 'wait' }
  return { kind: 'start' }
}

/**
 * What the auto-start request becomes after a decision: done once it started or was refused for good; still waiting while the only obstacle
 * is the patient's consent (the doctor can record it here, and then recording starts as asked) or while the status is being read.
 */
export function nextAutoIntent(d: AutoStartDecision): 'keep' | 'done' {
  if (d.kind === 'wait' || d.kind === 'none') return 'keep'
  if (d.kind === 'blocked' && (d.reason === 'consent' || d.reason === 'withdrawn')) return 'keep'
  return 'done'
}

/** What the consultation's header is told (lib/recordingState.ts): recording, paused, not recording with its reason, or nothing (idle). */
export function recordingSnapshot(i: { recorder: 'idle' | 'starting' | 'recording' | 'paused' | 'finishing'; elapsedMs: number; reason: NotRecordingReason | null; now: number; since?: number | null }): RecordingState {
  if (i.recorder === 'recording' || i.recorder === 'finishing') return { state: 'recording', since: i.now - Math.max(0, i.elapsedMs) }
  if (i.recorder === 'paused') return { state: 'paused', since: i.since ?? i.now, elapsedMs: Math.max(0, i.elapsedMs) }
  if (i.recorder === 'idle' && i.reason) return { state: 'not_recording', since: i.since ?? i.now, reason: NOT_RECORDING[i.reason] }
  return { state: 'idle', since: null }
}

// --- The live waveform ---------------------------------------------------------------------------------------------------------------------

/** The waveform's geometry (CSS px) and pace: 32px bars, a new bar every 80 ms from the microphone's real signal. */
export const WAVEFORM = { height: 32, barWidth: 3, gap: 2, minBar: 2, sampleMs: 80, gain: 4, maxHistory: 512 } as const

/** The loudness of a stretch of samples (-1..1) as 0..1: its RMS times `gain`, capped. Silence is 0; nothing is invented. */
export function rmsLevel(samples: ArrayLike<number>, gain: number = WAVEFORM.gain): number {
  const n = samples.length
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = samples[i]!
    sum += v * v
  }
  const level = Math.sqrt(sum / n) * gain
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0
}

/** The levels with a new one at the end, the oldest dropped beyond `max`. */
export const pushLevel = (history: readonly number[], level: number, max: number = WAVEFORM.maxHistory): number[] => [...history, level].slice(-Math.max(1, max))

/** How many bars fit in `width`. */
export const barCount = (width: number, barWidth: number = WAVEFORM.barWidth, gap: number = WAVEFORM.gap): number => (width > 0 ? Math.max(0, Math.floor((width + gap) / (barWidth + gap))) : 0)

export interface Bar {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The bars to draw: the newest level at the right edge, older ones to its left, as many as fit; each centred vertically, at least `minBar`
 * high (a flat line where there is silence), at most the full height.
 */
export function waveformBars(levels: readonly number[], o: { width: number; height: number; barWidth?: number; gap?: number; minBar?: number }): Bar[] {
  const barWidth = o.barWidth ?? WAVEFORM.barWidth
  const gap = o.gap ?? WAVEFORM.gap
  const minBar = Math.min(o.minBar ?? WAVEFORM.minBar, o.height)
  const n = barCount(o.width, barWidth, gap)
  if (!n || o.height <= 0) return []
  const shown = levels.slice(-n)
  return shown.map((level, i) => {
    const k = shown.length - 1 - i
    const h = Math.max(minBar, Math.min(o.height, Math.round(Math.min(1, Math.max(0, level)) * o.height)))
    return { x: o.width - barWidth - k * (barWidth + gap), y: Math.round((o.height - h) / 2), w: barWidth, h }
  })
}

// --- The conversation -----------------------------------------------------------------------------------------------------------------------

/** True when the list is scrolled to (or within `threshold` px of) its end: new lines are then followed; scrolled up, they are not. */
export const isNearBottom = (el: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = 32): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= threshold

/**
 * A line pointed at (lib/focusLines.ts), with its transcript: line labels restart at S1 in every transcript, so "S3" alone could be the
 * wrong recording's line. The important points always point this way.
 */
export const lineKey = (transcriptId: string, segmentId: string): string => `${transcriptId}:${segmentId}`

/**
 * The lines of this transcript being pointed at, in the order they were pointed at: those named with this transcript (lineKey) and, unless
 * `bare` is false, bare labels (a caller that does not say which transcript; they match by label as before). A line named with another
 * transcript is never one of them.
 */
export function focusedLineIds(focused: Iterable<string>, transcriptId: string, o: { bare?: boolean } = {}): string[] {
  const out: string[] = []
  for (const k of focused) {
    const i = k.indexOf(':')
    if (i < 0) {
      if (o.bare !== false) out.push(k)
    } else if (k.slice(0, i) === transcriptId) out.push(k.slice(i + 1))
  }
  return out
}

// --- Important points -----------------------------------------------------------------------------------------------------------------------

export interface PointGroupSpec {
  key: string
  label: string
  categories: readonly string[]
}

/** The groups of the important points, in the order a doctor reads them (DESIGN §5.4: Symptoms, Duration, History, Medicines, Allergy, Examination, Plan…). */
export const POINT_GROUPS: readonly PointGroupSpec[] = [
  { key: 'red_flags', label: 'Red flags', categories: ['red_flag'] },
  { key: 'symptoms', label: 'Symptoms', categories: ['chief_complaint', 'symptom', 'patient_concern'] },
  { key: 'duration', label: 'Duration', categories: ['duration'] },
  { key: 'history', label: 'History', categories: ['past_medical_history', 'family_history', 'social_history'] },
  { key: 'medicines', label: 'Medicines', categories: ['medication_history', 'medication_mention'] },
  { key: 'allergy', label: 'Allergy', categories: ['allergy'] },
  { key: 'examination', label: 'Examination', categories: ['examination_finding', 'vital_sign'] },
  { key: 'assessment', label: 'Assessment', categories: ['clinician_assessment'] },
  { key: 'plan', label: 'Plan', categories: ['plan', 'investigation_mention', 'follow_up'] },
]
/** A category this screen does not know yet (a newer server): its own group at the end, never dropped. */
export const OTHER_GROUP: PointGroupSpec = { key: 'other', label: 'Other', categories: [] }

export const pointGroupOf = (category: string): PointGroupSpec => POINT_GROUPS.find((g) => g.categories.includes(category)) ?? OTHER_GROUP

/** The words of a category ("Medicine mentioned in plan"); its code when the screen does not know it. */
export const categoryLabel = (category: string): string => (FACT_CATEGORIES as Record<string, string>)[category] ?? category

type PointLike = Pick<ClinicalFact, 'id' | 'category' | 'status' | 'flags' | 'createdAt' | 'transcriptId' | 'sourceSegmentIds'>

/** Where on the recording a point's first source line starts (ms), or null (typed lines have no time). */
export function pointTime(f: Pick<ClinicalFact, 'transcriptId' | 'sourceSegmentIds'>, transcripts: readonly Pick<Transcript, 'id' | 'segments'>[]): number | null {
  const t = transcripts.find((x) => x.id === f.transcriptId)
  const starts = f.sourceSegmentIds.map((id) => t?.segments.find((s) => s.id === id)?.startMs).filter((x): x is number => typeof x === 'number')
  return starts.length ? Math.min(...starts) : null
}

/**
 * Where a point's source lines are shown: in the conversation on the panel (the current recording) or in an earlier recording (in the
 * "Earlier recordings" sheet). Its time link goes there, never to the current recording's line that only shares the label.
 */
export const pointWhere = (f: Pick<ClinicalFact, 'transcriptId'>, currentTranscriptId: string | null | undefined): 'current' | 'earlier' => (f.transcriptId === currentTranscriptId ? 'current' : 'earlier')

/** The lines a point points at, each with its transcript (lineKey). */
export const pointLineKeys = (f: Pick<ClinicalFact, 'transcriptId'>, segmentIds: readonly string[]): string[] => segmentIds.map((s) => lineKey(f.transcriptId, s))

export interface PointGroup<T> {
  key: string
  label: string
  points: T[]
}

/**
 * The points to show, grouped: drafts and confirmed points by group (empty groups left out), red flags first within a group, then in the
 * order they were said, then as found; rejected points apart (shown folded); points replaced by a newer run not at all.
 */
export function groupPoints<T extends PointLike>(facts: readonly T[], transcripts: readonly Pick<Transcript, 'id' | 'segments'>[]): { groups: PointGroup<T>[]; rejected: T[]; toReview: number; confirmed: number } {
  const state = (f: T): FactState => factState(f.status)
  const shown = facts.filter((f) => state(f) !== 'superseded')
  const order = (a: T, b: T) => Number(b.flags.includes('red_flag')) - Number(a.flags.includes('red_flag')) || (pointTime(a, transcripts) ?? 1e15) - (pointTime(b, transcripts) ?? 1e15) || a.createdAt.localeCompare(b.createdAt)
  const live = shown.filter((f) => state(f) !== 'rejected')
  const groups: PointGroup<T>[] = []
  for (const spec of [...POINT_GROUPS, OTHER_GROUP]) {
    const points = live.filter((f) => pointGroupOf(f.category).key === spec.key).sort(order)
    if (points.length) groups.push({ key: spec.key, label: spec.label, points })
  }
  return { groups, rejected: shown.filter((f) => state(f) === 'rejected').sort(order), toReview: live.filter((f) => state(f) === 'extracted').length, confirmed: live.filter((f) => state(f) === 'confirmed').length }
}

/** Who stands on the patient's side and on the clinician's, when the doctor assigns a line (as the server reads them). */
export const PATIENT_SIDE: ReadonlySet<string> = new Set(['Patient', 'Mother', 'Father', 'Relative', 'Attendant'])
export const CLINICIAN_SIDE: ReadonlySet<string> = new Set(['Doctor', 'Nurse'])

const SAID: Record<string, string> = { patient_reported: 'Patient said', clinician_stated: 'Doctor said', other_speaker: 'Speaker not identified' }

/**
 * Who said a point, honestly: as the doctor assigned the source line; "Speaker not assigned: guessed patient" when the rules guessed it from the
 * wording; and, when the doctor has since marked a source line as the other side, that it is now out of date.
 */
export function pointSpeaker(f: Pick<ClinicalFact, 'attribution' | 'sourceSegmentIds'>, transcript: Pick<Transcript, 'segments'> | undefined): { text: string; guessed: boolean; contradicted: string | null } {
  const speakers = f.sourceSegmentIds.map((sid) => transcript?.segments.find((x) => x.id === sid)?.speaker ?? null)
  const sided = f.attribution === 'patient_reported' || f.attribution === 'clinician_stated'
  const contradicted = f.attribution === 'patient_reported' ? (speakers.find((x) => !!x && CLINICIAN_SIDE.has(x)) ?? null) : f.attribution === 'clinician_stated' ? (speakers.find((x) => !!x && PATIENT_SIDE.has(x)) ?? null) : null
  const guessed = sided && speakers.some((x) => !x)
  const said = SAID[f.attribution] ?? 'Speaker not identified'
  if (contradicted) return { text: `${said}, but the source line is now marked ${contradicted}`, guessed, contradicted }
  if (guessed) return { text: `Speaker not assigned: guessed ${f.attribution === 'patient_reported' ? 'patient' : 'doctor'}`, guessed, contradicted: null }
  return { text: said, guessed: false, contradicted: null }
}

const GUESSED_REASON = /^Who said this was guessed/

/**
 * The review flags shown under a point, each in a few words and its tone: what the doctor must check. Said once only: the rules' "who said
 * this was guessed" is already the point's speaker line, and a red flag is already its group ("Red flags"). An uncertain point says why.
 */
export function pointFlags(f: Pick<ClinicalFact, 'flags' | 'uncertaintyReason'>, speakerGuessed: boolean): { flag: string; text: string; tone: 'down' | 'pending' }[] {
  const out: { flag: string; text: string; tone: 'down' | 'pending' }[] = []
  for (const flag of new Set(f.flags)) {
    if (flag === 'red_flag') continue
    if (flag === 'uncertain') {
      const reasons = (f.uncertaintyReason ?? '').split(/\.\s+/).map((s) => s.trim()).filter(Boolean)
      const rest = speakerGuessed ? reasons.filter((r) => !GUESSED_REASON.test(r)) : reasons
      if (reasons.length && !rest.length) continue
      out.push({ flag, text: rest.length ? rest.join('. ') : FACT_FLAGS.uncertain, tone: 'pending' })
      continue
    }
    out.push({ flag, text: (FACT_FLAGS as Record<string, string>)[flag] ?? flag, tone: flag === 'conflicts_with_record' ? 'down' : 'pending' })
  }
  return out
}

/** Whether confirming a point needs the doctor's explicit tick, as the server requires it: a flag to check, or a source line now marked as the other side. */
export function pointNeedsTick(f: Pick<ClinicalFact, 'flags' | 'attribution' | 'sourceSegmentIds'>, transcript: Pick<Transcript, 'segments'> | undefined): boolean {
  return f.flags.some((x) => (CONFIRM_FLAGS as readonly string[]).includes(x)) || pointSpeaker(f, transcript).contradicted !== null
}

// --- Answers of the API that arrive out of order ---------------------------------------------------------------------------------------------

/** How far the recordings have got in an answer: transcripts, lines, parts and their outcomes, ended recordings. It only ever grows. */
export function transcriptProgress(ai: Pick<EncounterAi, 'transcripts'>): number {
  let n = 0
  for (const t of ai.transcripts) n += 1 + t.segments.length + t.chunks.length + t.chunks.filter((c) => c.status !== 'received').length + (t.status === 'final' ? 1 : 0)
  return n
}

/**
 * The AI state to show after an extraction answered: the answer, unless a newer part has arrived since it was read (its recordings are behind
 * the ones shown), in which case the recordings shown are kept and the answer's points, jobs and runs are taken.
 */
export function newerAi<T extends Pick<EncounterAi, 'transcripts' | 'audio'>>(shown: T | undefined, incoming: T): T {
  if (!shown || transcriptProgress(incoming) >= transcriptProgress(shown)) return incoming
  return { ...incoming, transcripts: shown.transcripts, audio: shown.audio }
}

// --- Finding the points after each part -----------------------------------------------------------------------------------------------------

/** After a part arrives, wait this long for another before running the fixed rules, and never run them more often than every `minGapMs`. */
export const AUTO_EXTRACT = { debounceMs: 2500, minGapMs: 6000, busyRetryMs: 15_000 } as const

/** How long to wait before the next run, given when the last one ended. */
export function extractionDelay(lastRunAt: number | null, now: number, o: { debounceMs: number; minGapMs: number } = AUTO_EXTRACT): number {
  const gap = lastRunAt === null ? 0 : lastRunAt + o.minGapMs - now
  return Math.max(o.debounceMs, gap)
}

/** Only the fixed rules on this computer run by themselves; another extractor (a hosted model) runs only when the doctor asks. */
export const autoExtractAllowed = (x: Pick<EncounterAi['status']['extraction'], 'available' | 'local' | 'provider'>): boolean => x.available && x.local && x.provider === 'adaxai-rules'
