// Unit tests (node --test) of the consultation's live transcription (Doctor HERO, DESIGN §5.4 column 1): when recording starts by itself and,
// when it does not, the one honest line that says why; the store the header reads ("Recording 03:12"); the live waveform's bars; how the
// important points are grouped and when confirming one needs the explicit tick; and the small rules around the automatic extraction. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { type ClinicalFact, FACT_CATEGORIES, type Transcript } from '@adaxai/contracts'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  AUTO_EXTRACT,
  autoExtractAllowed,
  autoStartDecision,
  barCount,
  extractionDelay,
  focusedLineIds,
  groupPoints,
  idleReason,
  type IdleReasonInput,
  isNearBottom,
  lineKey,
  microphoneReason,
  newerAi,
  NOT_RECORDING,
  NOT_RECORDING_ACTION,
  type NotRecordingReason,
  nextAutoIntent,
  notRecordingLine,
  otherRecordingId,
  panelContent,
  POINT_GROUPS,
  pointFlags,
  pointGroupOf,
  pointLineKeys,
  pointNeedsTick,
  pointSpeaker,
  pointWhere,
  problemResolved,
  pushLevel,
  recordingSnapshot,
  rmsLevel,
  startRefusalReason,
  WAVEFORM,
  waveformBars,
} from '../src/components/capture/live.ts'
import { clearRecordingState, getRecordingState, recordedMs, recordingLabel, setRecordingState, subscribeRecordingState } from '../src/lib/recordingState.ts'

// --- When recording starts by itself ------------------------------------------------------------------------------------------------------

const status = (over: Partial<{ canRecord: boolean; closedReason: string | null; consent: boolean; speech: boolean; state: 'ready' | 'loading' | 'unavailable' | 'not_configured' }> = {}) => ({
  canRecord: over.canRecord ?? true,
  closedReason: over.closedReason ?? null,
  consent: { granted: over.consent ?? true, scope: 'ongoing' as const, recordedAt: '2026-10-06T09:00:00Z', current: true },
  speech: { available: over.speech ?? true, provider: 'local', model: 'm', reason: null, state: over.state ?? 'ready', local: true, host: null, runtime: null, weightsSha256: null },
})
const ready = (over: Partial<IdleReasonInput> = {}): IdleReasonInput => ({ open: true, micSupported: true, consentGranted: true, status: status(), otherRecordingOpen: false, problem: null, ...over })

test('nothing stands in the way: no reason, and a requested recording starts', () => {
  assert.equal(idleReason(ready()), null)
  assert.deepEqual(autoStartDecision({ requested: true, recorderIdle: true, statusKnown: true, reason: null }), { kind: 'start' })
})

test('every obstacle is named, in the order the doctor can act on it, and a requested recording is then not started', () => {
  const cases: [Partial<IdleReasonInput>, string][] = [
    [{ open: false }, 'closed'],
    [{ micSupported: false }, 'unsupported'],
    [{ problem: 'microphone' }, 'microphone'],
    [{ status: status({ closedReason: 'This consultation is signed.' }) }, 'closed'],
    [{ otherRecordingOpen: true }, 'busy'],
    [{ consentGranted: false }, 'consent'],
    [{ status: status({ consent: false }) }, 'consent'],
    [{ status: status({ speech: false, state: 'unavailable' }) }, 'speech'],
    [{ status: status({ speech: false, state: 'not_configured' }) }, 'speech'],
    [{ status: status({ speech: false, state: 'loading' }) }, 'speech_loading'],
    [{ status: status({ canRecord: false }) }, 'closed'],
    // Several at once: the first the doctor can do something about wins (consent before the speech service).
    [{ consentGranted: false, status: status({ speech: false }) }, 'consent'],
    [{ open: false, consentGranted: false }, 'closed'],
  ]
  for (const [over, want] of cases) {
    const reason = idleReason(ready(over))
    assert.equal(reason, want, JSON.stringify(over))
    assert.deepEqual(autoStartDecision({ requested: true, recorderIdle: true, statusKnown: true, reason }), { kind: 'blocked', reason: want })
  }
})

test('while the status is still being read nothing is claimed and nothing starts; not asked, or already recording, nothing happens', () => {
  assert.equal(idleReason(ready({ status: undefined })), null)
  assert.deepEqual(autoStartDecision({ requested: true, recorderIdle: true, statusKnown: false, reason: null }), { kind: 'wait' })
  assert.deepEqual(autoStartDecision({ requested: false, recorderIdle: true, statusKnown: true, reason: null }), { kind: 'none' })
  assert.deepEqual(autoStartDecision({ requested: true, recorderIdle: false, statusKnown: true, reason: null }), { kind: 'none' })
  // A reason known without the status (the browser cannot record) is said at once.
  assert.deepEqual(autoStartDecision({ requested: true, recorderIdle: true, statusKnown: false, reason: 'unsupported' }), { kind: 'blocked', reason: 'unsupported' })
})

test('the request waits only for the patient’s consent (recorded here, then recording starts as asked); any other obstacle ends it', () => {
  assert.equal(nextAutoIntent({ kind: 'blocked', reason: 'consent' }), 'keep')
  assert.equal(nextAutoIntent({ kind: 'blocked', reason: 'withdrawn' }), 'keep')
  assert.equal(nextAutoIntent({ kind: 'wait' }), 'keep')
  for (const r of ['speech', 'speech_loading', 'microphone', 'busy', 'closed', 'unsupported', 'error'] as const) assert.equal(nextAutoIntent({ kind: 'blocked', reason: r }), 'done', r)
  assert.equal(nextAutoIntent({ kind: 'start' }), 'done')
})

test('the honest lines and their one action are the design’s words', () => {
  assert.equal(notRecordingLine('consent'), 'Not recording — the patient’s recording consent is not on record')
  assert.equal(notRecordingLine('speech'), 'Not recording — the speech service is not running')
  assert.equal(notRecordingLine('microphone'), 'Not recording — the microphone is blocked')
  assert.equal(notRecordingLine(null), 'Not recording')
  assert.equal(NOT_RECORDING_ACTION.consent, 'record_consent')
  assert.equal(NOT_RECORDING_ACTION.microphone, 'try_again')
  assert.equal(NOT_RECORDING_ACTION.speech, undefined)
  for (const [k, v] of Object.entries(NOT_RECORDING)) assert.match(v, /^[a-z]/, `${k} continues the sentence`)
})

test('no line is a dead end: each reason has its action, or clears by itself once a later status shows it is over; only what nothing here can change has neither', () => {
  const st = status()
  const clears = (r: NotRecordingReason, over: Partial<Parameters<typeof problemResolved>[1]> = {}) => problemResolved(r, { consentGranted: true, status: st, otherRecordingOpen: false, ...over })
  // The recording was ended in another window: a new one can be started from here (the old Recorder kept "Start recording" for this).
  assert.equal(NOT_RECORDING_ACTION.ended, 'start_new')
  // Consent recorded here or anywhere else: over once both the panel's state and the status say so (and not before).
  assert.equal(clears('consent'), true)
  assert.equal(clears('withdrawn'), true)
  assert.equal(clears('consent', { consentGranted: false }), false)
  assert.equal(clears('withdrawn', { status: status({ consent: false }) }), false)
  // The speech service is back.
  assert.equal(clears('speech'), true)
  assert.equal(clears('speech_loading'), true)
  assert.equal(clears('speech', { status: status({ speech: false, state: 'unavailable' }) }), false)
  // The other recording was ended (by "End that recording", or where it was made).
  assert.equal(clears('busy'), true)
  assert.equal(clears('busy', { otherRecordingOpen: true }), false)
  // What only this browser knows is not judged by the status: those keep their line and their action.
  for (const r of ['microphone', 'no_microphone', 'microphone_busy', 'error', 'ended', 'closed', 'unsupported'] as const) assert.equal(clears(r), false, r)
  const reasons = Object.keys(NOT_RECORDING) as NotRecordingReason[]
  const stuck = reasons.filter((r) => !NOT_RECORDING_ACTION[r] && !clears(r))
  assert.deepEqual(stuck.sort(), ['closed', 'unsupported'])
})

test('another recording open elsewhere: whichever of the status and the AI state was read last says it; a finished one or the demo never counts', () => {
  const none = new Set<string>()
  const base = { recorderIdle: true, aiLiveId: null, aiAt: 1000, statusLiveId: null, statusAt: 2000, notOpen: none }
  // A start refused because one is open that the AI state has not seen yet: the status names it, so "End that recording" can end it.
  assert.equal(otherRecordingId({ ...base, statusLiveId: 'x' }), 'x')
  // Just stopped here: the AI state already says it is finished; the status read during the recording still names it.
  assert.equal(otherRecordingId({ ...base, statusLiveId: 'mine', statusAt: 1000, aiAt: 3000, notOpen: new Set(['mine']) }), null)
  assert.equal(otherRecordingId({ ...base, statusLiveId: 'mine', statusAt: 1000, aiAt: 3000 }), null)
  // The status read after the AI state says nothing is open: the AI state's open one ended elsewhere meanwhile.
  assert.equal(otherRecordingId({ ...base, aiLiveId: 'old', statusLiveId: null }), null)
  // The AI state read later (or the status not read yet) says it.
  assert.equal(otherRecordingId({ ...base, aiLiveId: 'y', aiAt: 3000 }), 'y')
  assert.equal(otherRecordingId({ ...base, aiLiveId: 'y', statusLiveId: undefined, statusAt: 0 }), 'y')
  // The demo's own recording is never "another recording"; nothing is "open elsewhere" while this recorder is busy.
  assert.equal(otherRecordingId({ ...base, statusLiveId: 'demo', notOpen: new Set(['demo']) }), null)
  assert.equal(otherRecordingId({ ...base, statusLiveId: 'x', recorderIdle: false }), null)
})

test('a failed refresh keeps the panel (and its recording) on the page; the placeholder is only for before the first answer', async () => {
  assert.equal(panelContent({ hasData: false, isError: false }), 'loading')
  assert.equal(panelContent({ hasData: false, isError: true }), 'error')
  assert.equal(panelContent({ hasData: true, isError: true }), 'body')
  assert.equal(panelContent({ hasData: true, isError: false }), 'body')
  // The case it guards against, as the query library reports it: a refetch that fails after data was read is an error WITH the data kept.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let fail = false
  const observer = new QueryObserver(client, {
    queryKey: ['ai', 'e1'],
    queryFn: async () => {
      if (fail) throw new Error('network')
      return { transcripts: [] }
    },
  })
  const unsubscribe = observer.subscribe(() => undefined)
  await observer.refetch()
  fail = true
  const r = await observer.refetch()
  unsubscribe()
  client.clear()
  assert.equal(r.isError, true)
  assert.deepEqual(r.data, { transcripts: [] })
  assert.equal(panelContent({ hasData: r.data !== undefined, isError: r.isError }), 'body')
})

test('what the browser and the API refuse with is read as a reason', () => {
  assert.equal(microphoneReason('NotAllowedError'), 'microphone')
  assert.equal(microphoneReason('SecurityError'), 'microphone')
  assert.equal(microphoneReason('NotFoundError'), 'no_microphone')
  assert.equal(microphoneReason('NotReadableError'), 'microphone_busy')
  assert.equal(microphoneReason('Whatever'), 'error')
  assert.equal(startRefusalReason('recording_in_progress', 409), 'busy')
  assert.equal(startRefusalReason('stt_unavailable', 503), 'speech')
  assert.equal(startRefusalReason('consent_required', 409), 'consent')
  assert.equal(startRefusalReason('consent_withdrawn', 409), 'withdrawn')
  assert.equal(startRefusalReason('encounter_signed', 409), 'closed')
  assert.equal(startRefusalReason('forbidden', 403), 'closed')
  assert.equal(startRefusalReason('internal_error', 500), 'error')
})

// --- What the header reads -------------------------------------------------------------------------------------------------------------------

test('the recording state store: idle by default, real changes only reach listeners, each consultation apart, back to idle on clear', () => {
  const e1 = 'enc-store-1'
  const e2 = 'enc-store-2'
  assert.deepEqual(getRecordingState(e1), { state: 'idle', since: null })
  let heard = 0
  const off = subscribeRecordingState(e1, () => heard++)
  setRecordingState(e1, { state: 'recording', since: 1000 })
  setRecordingState(e1, { state: 'recording', since: 1000 })
  assert.equal(heard, 1)
  assert.deepEqual(getRecordingState(e1), { state: 'recording', since: 1000 })
  assert.deepEqual(getRecordingState(e2), { state: 'idle', since: null })
  setRecordingState(e1, { state: 'paused', since: 5000, elapsedMs: 4000 })
  assert.equal(heard, 2)
  clearRecordingState(e1)
  assert.equal(heard, 3)
  assert.equal(getRecordingState(e1).state, 'idle')
  off()
  setRecordingState(e1, { state: 'recording', since: 1 })
  assert.equal(heard, 3)
  clearRecordingState(e1)
})

test('the header’s words: the time recorded ticks while recording, holds while paused; not recording says why', () => {
  assert.equal(recordingLabel({ state: 'recording', since: 10_000 }, 10_000 + 192_000), 'Recording 03:12')
  assert.equal(recordedMs({ state: 'recording', since: 10_000 }, 9_000), 0)
  assert.equal(recordingLabel({ state: 'paused', since: 50_000, elapsedMs: 61_000 }, 999_999), 'Paused 01:01')
  assert.equal(recordingLabel({ state: 'not_recording', since: 1, reason: NOT_RECORDING.speech }), 'Not recording — the speech service is not running')
  assert.equal(recordingLabel({ state: 'not_recording', since: 1 }), 'Not recording')
  assert.equal(recordingLabel({ state: 'idle', since: null }), null)
  assert.equal(recordedMs({ state: 'idle', since: null }), null)
})

test('what the panel tells the header follows the recorder: recording from its time recorded, paused with it held, idle with a reason as not recording', () => {
  assert.deepEqual(recordingSnapshot({ recorder: 'recording', elapsedMs: 3000, reason: null, now: 100_000 }), { state: 'recording', since: 97_000 })
  assert.deepEqual(recordingSnapshot({ recorder: 'paused', elapsedMs: 3000, reason: null, now: 100_000 }), { state: 'paused', since: 100_000, elapsedMs: 3000 })
  assert.deepEqual(recordingSnapshot({ recorder: 'idle', elapsedMs: 0, reason: 'consent', now: 5 }), { state: 'not_recording', since: 5, reason: NOT_RECORDING.consent })
  assert.deepEqual(recordingSnapshot({ recorder: 'idle', elapsedMs: 0, reason: null, now: 5 }), { state: 'idle', since: null })
  // Starting is not yet recording: the header claims nothing.
  assert.deepEqual(recordingSnapshot({ recorder: 'starting', elapsedMs: 0, reason: null, now: 5 }), { state: 'idle', since: null })
})

// --- The live waveform ------------------------------------------------------------------------------------------------------------------------

test('a level is the real signal’s loudness: silence is 0, it never goes past 1, nothing is made up', () => {
  assert.equal(rmsLevel(new Float32Array(512)), 0)
  assert.equal(rmsLevel([]), 0)
  assert.equal(rmsLevel([0.1, -0.1, 0.1, -0.1]), 0.4)
  assert.equal(rmsLevel([1, -1, 1, -1]), 1)
  assert.equal(rmsLevel([Number.NaN, 0]), 0)
  assert.deepEqual(pushLevel([0.1, 0.2], 0.3, 2), [0.2, 0.3])
  assert.deepEqual(pushLevel([], 0.5), [0.5])
})

test('32px bars, newest at the right, as many as fit, centred, a flat line for silence', () => {
  assert.equal(WAVEFORM.height, 32)
  assert.equal(barCount(0), 0)
  assert.equal(barCount(3), 1)
  assert.equal(barCount(100), 20)
  const bars = waveformBars([0, 0.5, 1], { width: 100, height: 32 })
  assert.equal(bars.length, 3)
  assert.deepEqual(bars.at(-1), { x: 97, y: 0, w: 3, h: 32 })
  assert.deepEqual(bars[1], { x: 92, y: 8, w: 3, h: 16 })
  assert.deepEqual(bars[0], { x: 87, y: 15, w: 3, h: 2 })
  // Only the newest that fit are drawn.
  const many = waveformBars(Array.from({ length: 50 }, (_, i) => i / 50), { width: 24, height: 32 })
  assert.equal(many.length, barCount(24))
  assert.ok(many.every((b) => b.x >= 0 && b.x + b.w <= 24 && b.h >= 2 && b.h <= 32))
  assert.deepEqual(waveformBars([0.5], { width: 0, height: 32 }), [])
})

// --- Important points -------------------------------------------------------------------------------------------------------------------

const transcript = (segments: { id: string; startMs: number | null; speaker?: string | null }[]): Transcript => ({
  id: 't1',
  source: 'browser_recording',
  audioOrigin: 'microphone',
  status: 'live',
  audioFileId: null,
  segments: segments.map((s) => ({ id: s.id, speaker: s.speaker ?? null, text: s.id, startMs: s.startMs, endMs: s.startMs })),
  language: 'en',
  chunks: [],
  endedAt: null,
  endReason: null,
  createdAt: '2026-10-06T10:00:00Z',
  createdByName: 'Dr',
})
let n = 0
const fact = (over: Partial<ClinicalFact>): ClinicalFact => ({
  id: `f${++n}`,
  jobId: 'j',
  transcriptId: 't1',
  category: 'symptom',
  text: 'x',
  attribution: 'patient_reported',
  certainty: 'stated',
  uncertaintyReason: null,
  negated: false,
  attributes: {},
  flags: [],
  status: 'pending',
  finalText: null,
  decidedAt: null,
  evidence: [],
  createdAt: '2026-10-06T10:00:00Z',
  sourceSegmentIds: ['S1'],
  producedBy: { provider: 'adaxai-rules', model: 'extract-rules-v1', version: 'extract-rules-v1', local: true },
  speakerChanged: false,
  ...over,
})

test('every category of point has exactly one group, in the design’s order; one the screen does not know goes to Other', () => {
  for (const c of Object.keys(FACT_CATEGORIES)) assert.equal(POINT_GROUPS.filter((g) => g.categories.includes(c)).length, 1, c)
  assert.deepEqual(
    POINT_GROUPS.map((g) => g.label),
    ['Red flags', 'Symptoms', 'Duration', 'History', 'Medicines', 'Allergy', 'Examination', 'Assessment', 'Plan'],
  )
  assert.equal(pointGroupOf('chief_complaint').label, 'Symptoms')
  assert.equal(pointGroupOf('medication_mention').label, 'Medicines')
  assert.equal(pointGroupOf('vital_sign').label, 'Examination')
  assert.equal(pointGroupOf('follow_up').label, 'Plan')
  assert.equal(pointGroupOf('something_new').label, 'Other')
})

test('points are grouped, drafts and confirmed together, in the order they were said; rejected apart; replaced ones not shown', () => {
  const t = transcript([
    { id: 'S1', startMs: 0 },
    { id: 'S2', startMs: 5000 },
    { id: 'S3', startMs: 9000 },
  ])
  const later = fact({ category: 'symptom', sourceSegmentIds: ['S3'], text: 'cough' })
  const earlier = fact({ category: 'chief_complaint', sourceSegmentIds: ['S1'], text: 'fever', status: 'accepted' })
  const duration = fact({ category: 'duration', sourceSegmentIds: ['S1'], text: '3 days' })
  const allergy = fact({ category: 'allergy', sourceSegmentIds: ['S2'], text: 'penicillin', status: 'rejected' })
  const replaced = fact({ category: 'symptom', sourceSegmentIds: ['S2'], text: 'old', status: 'superseded' })
  const red = fact({ category: 'symptom', sourceSegmentIds: ['S3'], text: 'chest pain', flags: ['red_flag'], status: 'deferred' })
  const typed = fact({ category: 'other_new' as ClinicalFact['category'], transcriptId: 'typed', sourceSegmentIds: ['S1'], text: 'typed' })
  const g = groupPoints([later, earlier, duration, allergy, replaced, red, typed], [t])
  assert.deepEqual(
    g.groups.map((x) => [x.label, x.points.map((p) => p.text)]),
    [
      ['Symptoms', ['chest pain', 'fever', 'cough']],
      ['Duration', ['3 days']],
      ['Other', ['typed']],
    ],
  )
  assert.deepEqual(
    g.rejected.map((p) => p.text),
    ['penicillin'],
  )
  assert.equal(g.toReview, 4)
  assert.equal(g.confirmed, 1)
})

test('who said it is told honestly: as assigned, guessed when nobody assigned the line, and out of date when the line was marked as the other side', () => {
  const unassigned = transcript([{ id: 'S1', startMs: 0 }])
  const patient = transcript([{ id: 'S1', startMs: 0, speaker: 'Patient' }])
  const doctor = transcript([{ id: 'S1', startMs: 0, speaker: 'Doctor' }])
  assert.deepEqual(pointSpeaker(fact({}), patient), { text: 'Patient said', guessed: false, contradicted: null })
  assert.deepEqual(pointSpeaker(fact({}), unassigned), { text: 'Speaker not assigned: guessed patient', guessed: true, contradicted: null })
  assert.deepEqual(pointSpeaker(fact({ attribution: 'clinician_stated' }), unassigned), { text: 'Speaker not assigned: guessed doctor', guessed: true, contradicted: null })
  assert.equal(pointSpeaker(fact({}), doctor).text, 'Patient said, but the source line is now marked Doctor')
  assert.equal(pointSpeaker(fact({ attribution: 'other_speaker' }), unassigned).text, 'Speaker not identified')
})

test('confirming needs the explicit tick exactly when the server requires it: a flag to check, or a source line now marked as the other side', () => {
  const patient = transcript([{ id: 'S1', startMs: 0, speaker: 'Patient' }])
  const doctor = transcript([{ id: 'S1', startMs: 0, speaker: 'Doctor' }])
  const relative = transcript([{ id: 'S1', startMs: 0, speaker: 'Relative' }])
  assert.equal(pointNeedsTick(fact({}), patient), false)
  assert.equal(pointNeedsTick(fact({ flags: ['not_in_record'] }), patient), false)
  assert.equal(pointNeedsTick(fact({ flags: ['red_flag'] }), patient), false)
  for (const flag of ['uncertain', 'no_source', 'conflicts_with_record', 'speaker_mismatch']) assert.equal(pointNeedsTick(fact({ flags: [flag] }), patient), true, flag)
  assert.equal(pointNeedsTick(fact({}), doctor), true)
  assert.equal(pointNeedsTick(fact({ attribution: 'clinician_stated' }), relative), true)
  assert.equal(pointNeedsTick(fact({ attribution: 'clinician_stated' }), doctor), false)
})

test('each flag is said once: a guessed speaker only on the speaker line, a red flag by its group, an uncertain point with its own reason', () => {
  const guessed = 'Who said this was guessed from the wording (no speaker label): assign speakers, or check it against the conversation'
  assert.deepEqual(pointFlags({ flags: ['uncertain', 'not_in_record'], uncertaintyReason: guessed }, true), [{ flag: 'not_in_record', text: 'Not in the existing record', tone: 'pending' }])
  assert.deepEqual(pointFlags({ flags: ['uncertain'], uncertaintyReason: `Hedged in the conversation ("maybe"). ${guessed}` }, true), [{ flag: 'uncertain', text: 'Hedged in the conversation ("maybe")', tone: 'pending' }])
  // When the speaker is not shown as guessed, nothing is dropped.
  assert.equal(pointFlags({ flags: ['uncertain'], uncertaintyReason: guessed }, false)[0]!.text, guessed)
  assert.deepEqual(pointFlags({ flags: ['uncertain'], uncertaintyReason: null }, false), [{ flag: 'uncertain', text: 'Uncertain or unclear in the conversation', tone: 'pending' }])
  assert.deepEqual(pointFlags({ flags: ['red_flag', 'conflicts_with_record'], uncertaintyReason: null }, false), [{ flag: 'conflicts_with_record', text: 'Conflicts with the existing record', tone: 'down' }])
})

// --- Around the automatic extraction ------------------------------------------------------------------------------------------------------------

test('the fixed rules run after the parts pause, never more often than every few seconds, and only when they are the fixed rules on this computer', () => {
  assert.equal(extractionDelay(null, 0), AUTO_EXTRACT.debounceMs)
  assert.equal(extractionDelay(10_000, 11_000), AUTO_EXTRACT.minGapMs - 1000)
  assert.equal(extractionDelay(10_000, 60_000), AUTO_EXTRACT.debounceMs)
  assert.equal(autoExtractAllowed({ available: true, local: true, provider: 'adaxai-rules' }), true)
  assert.equal(autoExtractAllowed({ available: true, local: false, provider: 'anthropic' }), false)
  assert.equal(autoExtractAllowed({ available: true, local: true, provider: 'some-local-model' }), false)
  assert.equal(autoExtractAllowed({ available: false, local: true, provider: 'adaxai-rules' }), false)
})

test('an extraction answer older than the lines shown keeps the lines and takes its points', () => {
  const t = (lines: number, chunks: number) => ({ ...transcript(Array.from({ length: lines }, (_, i) => ({ id: `S${i + 1}`, startMs: i }))), chunks: Array.from({ length: chunks }, (_, i) => ({ index: i, offsetMs: 0, durationMs: 1, language: 'en', status: 'transcribed' as const })) })
  const shown = { transcripts: [t(6, 2)], audio: [], facts: ['old'] }
  const older = { transcripts: [t(3, 1)], audio: [], facts: ['new'] }
  const same = { transcripts: [t(6, 2)], audio: [], facts: ['new'] }
  assert.deepEqual(newerAi(shown, older), { transcripts: shown.transcripts, audio: [], facts: ['new'] })
  assert.equal(newerAi(shown, same), same)
  assert.equal(newerAi(undefined, older), older)
})

test('a point points at its own recording’s lines: labels restart at S1 in every recording, so a bare label never lights another recording’s line', () => {
  const p = fact({ transcriptId: 'earlier', sourceSegmentIds: ['S3', 'S4'] })
  assert.deepEqual(pointLineKeys(p, p.sourceSegmentIds), ['earlier:S3', 'earlier:S4'])
  assert.equal(lineKey('t9', 'S1'), 't9:S1')
  // Its time link goes where its lines are.
  assert.equal(pointWhere(p, 'current'), 'earlier')
  assert.equal(pointWhere(fact({ transcriptId: 'current' }), 'current'), 'current')
  assert.equal(pointWhere(p, null), 'earlier')
  // Pointed at in the earlier recording: only that recording's S3 and S4, never the current recording's S3.
  const focused = new Set(pointLineKeys(p, p.sourceSegmentIds))
  assert.deepEqual(focusedLineIds(focused, 'earlier'), ['S3', 'S4'])
  assert.deepEqual(focusedLineIds(focused, 'current'), [])
  // A caller that names no recording (a bare label) still matches by label, as before; an earlier recording opens only for its own lines.
  assert.deepEqual(focusedLineIds(new Set(['S2']), 'current'), ['S2'])
  assert.deepEqual(focusedLineIds(new Set(['S2', 'earlier:S5']), 'earlier', { bare: false }), ['S5'])
})

test('new lines are followed only while the doctor is at the end of the conversation', () => {
  assert.equal(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 }), true)
  assert.equal(isNearBottom({ scrollTop: 580, clientHeight: 400, scrollHeight: 1000 }), true)
  assert.equal(isNearBottom({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 }), false)
})
