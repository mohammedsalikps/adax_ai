// Unit tests (node --test) of the compact summaries of the consultation's five input modules (Doctor HERO): the word and tone of each module's
// chip in every state the plan names (loading, not updated, recording, ready, consent needed, speech-to-text unavailable, empty; history
// recorded or not; device live, stale, simulated, none attached, an answer that cannot be read; recordings; images), the counts the workflow
// strip adds up, and the lines under the title, including the fixed ones. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachedDevice, AuscultationRecording, CaptureStatus, ClinicalFact, DeviceReading, EncounterAi, Observation, PatientDetail, PatientHistory, ThermalCapture, ThermalModelStatus, Transcript } from '@adaxai/contracts'
import { fmtDate } from '../src/lib/format.ts'
import type { ReceivedDeviceReadings } from '../src/lib/devices.ts'
import {
  behind,
  compactVitals,
  consentOf,
  conversationView,
  count,
  deviceCore,
  historyView,
  LOADING,
  NOT_UPDATED,
  recordingClock,
  recordingLength,
  SPEECH_UNAVAILABLE_LINE,
  STETHOSCOPE_HONESTY,
  stethoscopeCore,
  stethoscopeView,
  thermalCameraLine,
  thermalCore,
  thermalModelLine,
  thermalView,
  vitalsView,
} from '../src/components/workspace/summaries/state.ts'

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0)
const iso = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString()
const ENC = '00000000-0000-4000-8000-0000000000e1'
const OTHER = '00000000-0000-4000-8000-0000000000e2'
const ok = { ai: false, capture: false }

// --- builders ----------------------------------------------------------------------------------------------------------------------------------

const speech = (over: Partial<EncounterAi['status']['stt']> = {}): EncounterAi['status']['stt'] => ({
  available: true,
  provider: 'whisper',
  model: 'small',
  reason: null,
  state: 'ready',
  local: true,
  host: null,
  runtime: null,
  weightsSha256: null,
  ...over,
})
const transcript = (over: Partial<Transcript> = {}): Transcript => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  source: 'browser_recording',
  status: 'final',
  audioFileId: null,
  segments: [
    { id: 'S1', speaker: null, text: 'a' },
    { id: 'S2', speaker: null, text: 'b' },
  ],
  language: 'en',
  chunks: [],
  endedAt: null,
  endReason: null,
  createdAt: iso(0),
  createdByName: 'Dr A',
  ...over,
})
const fact = (status: ClinicalFact['status']): ClinicalFact => ({ status }) as ClinicalFact
const ai = (over: { consented?: boolean; stt?: Partial<EncounterAi['status']['stt']>; transcripts?: Transcript[]; facts?: ClinicalFact[] } = {}): EncounterAi =>
  ({
    consent: { granted: over.consented ?? true, scope: 'encounter', recordedAt: iso(0), version: 'v1', current: true },
    status: { stt: speech(over.stt) },
    audio: [],
    transcripts: over.transcripts ?? [],
    drafts: [],
    runs: [],
    jobs: [],
    facts: over.facts ?? [],
    recommendations: [],
    reviewActions: [],
    audit: [],
  }) as unknown as EncounterAi
const capture = (over: Partial<CaptureStatus> = {}): CaptureStatus => ({
  consent: { granted: true, scope: 'encounter', recordedAt: iso(0), current: true },
  speech: speech(),
  live: { transcriptId: null, startedAt: null, lastChunkAt: null },
  canRecord: true,
  blockedReason: null,
  closedReason: null,
  ...over,
})

// --- shared ------------------------------------------------------------------------------------------------------------------------------------

test('a kept answer after a failed read says "not updated" and drops its colour; counts are worded once and many', () => {
  assert.deepEqual(behind({ kind: 'ready', word: 'Ready', tone: 'ok' }, true), { kind: 'ready', word: 'Ready · not updated', tone: 'neutral', behind: true })
  assert.deepEqual(behind({ kind: 'ready', word: 'Ready', tone: 'ok' }, false), { kind: 'ready', word: 'Ready', tone: 'ok' })
  assert.equal(count(1, 'image'), '1 image')
  assert.equal(count(3, 'image'), '3 images')
})

test('a consent is granted, withdrawn (and not granted again) or missing; not known while the patient is not read', () => {
  const consents = (...xs: [string, string][]) => ({ consents: xs.map(([type, status]) => ({ type, status })) }) as unknown as PatientDetail
  assert.equal(consentOf(undefined, 'thermal_imaging'), null)
  assert.equal(consentOf(consents(['thermal_imaging', 'granted']), 'thermal_imaging'), 'granted')
  assert.equal(consentOf(consents(['thermal_imaging', 'withdrawn']), 'thermal_imaging'), 'withdrawn')
  assert.equal(consentOf(consents(['thermal_imaging', 'withdrawn'], ['thermal_imaging', 'granted']), 'thermal_imaging'), 'granted')
  assert.equal(consentOf(consents(['device_monitoring', 'granted']), 'thermal_imaging'), 'missing')
})

// --- 1 conversation ----------------------------------------------------------------------------------------------------------------------------

test('conversation: Loading before the panel reads, Not updated when its read failed with nothing to show', () => {
  assert.deepEqual(conversationView({ failed: ok }).state, LOADING)
  const failed = conversationView({ failed: { ai: true, capture: false } })
  assert.deepEqual(failed.state, NOT_UPDATED)
  assert.deepEqual(failed.lines, ['The conversation could not be read just now.'])
  assert.equal(failed.facts, null)
  assert.equal(failed.confirmedPoints, null)
})

test('conversation: while recording it says so, that it is stopped from the full panel, and since when (the recorder’s own times)', () => {
  const t = transcript({ status: 'live', createdAt: iso(5) })
  const v = conversationView({ ai: ai({ transcripts: [t] }), capture: capture({ live: { transcriptId: t.id, startedAt: iso(10), lastChunkAt: iso(70) } }), failed: ok })
  assert.equal(v.state.kind, 'recording')
  assert.equal(v.state.word, 'Recording')
  assert.equal(v.state.tone, 'down')
  assert.equal(v.lines[0], 'Recording — open to stop.')
  assert.match(v.lines[1]!, /^Started .+ · last part received .+$/)
  assert.deepEqual(v.facts, { transcripts: 1, points: 0 })
})

test('conversation: points waiting for review come first, then confirmed ones, then a transcript alone; replaced points are not counted', () => {
  const t = transcript()
  const review = conversationView({ ai: ai({ transcripts: [t], facts: [fact('pending'), fact('pending'), fact('accepted'), fact('superseded')] }), failed: ok })
  assert.deepEqual(review.state, { kind: 'to_review', word: '2 points to review', tone: 'warn' })
  assert.equal(review.lines[0], '1 transcript · 2 lines')
  assert.equal(review.lines[1], 'Points found by fixed rules: 2 to review · 1 confirmed')
  // Closed, the same in two short lines.
  assert.deepEqual(review.compact, ['1 transcript · 2 lines', 'Points: 2 to review · 1 confirmed'])
  assert.deepEqual(review.facts, { transcripts: 1, points: 3 })
  assert.equal(review.confirmedPoints, 1)
  assert.equal(conversationView({ ai: ai({ transcripts: [t], facts: [fact('pending')] }), failed: ok }).state.word, '1 point to review')

  const confirmed = conversationView({ ai: ai({ transcripts: [t], facts: [fact('accepted'), fact('edited'), fact('rejected')] }), failed: ok })
  assert.deepEqual(confirmed.state, { kind: 'confirmed', word: '2 points confirmed', tone: 'ok' })
  assert.equal(confirmed.lines[1], 'Points found by fixed rules: 0 to review · 2 confirmed · 1 rejected')

  const only = conversationView({ ai: ai({ transcripts: [t] }), failed: ok })
  assert.deepEqual(only.state, { kind: 'transcript', word: 'Transcript only', tone: 'neutral' })
  assert.equal(only.lines[1], 'No important points yet.')
  assert.equal(conversationView({ ai: ai({ transcripts: [t], facts: [fact('rejected')] }), failed: ok }).state.word, 'No point confirmed')
  assert.match(only.meta!, /^Microphone recording · /)
})

test('conversation, nothing recorded yet: consent needed, speech-to-text unavailable or not set up, ready, or nothing recorded', () => {
  const consent = conversationView({ ai: ai({ consented: false }), capture: capture({ canRecord: false, blockedReason: 'No consent' }), failed: ok })
  assert.deepEqual(consent.state, { kind: 'consent_needed', word: 'Consent needed', tone: 'warn' })
  assert.deepEqual(consent.lines, ['Nothing recorded or typed yet.', 'The patient’s consent to recording is not recorded.'])

  // Closed, the consent line stays (the chip says only "Consent needed").
  assert.deepEqual(consent.compact, ['Nothing recorded or typed yet.', 'The patient’s consent to recording is not recorded.'])

  // The recorder's status is the newer read of the speech service when it is on the page. The summary says it in the clinician's words, never
  // the service's own reason, which can be a setup instruction for whoever runs the computer (Doctor HERO polish: 'Start it with "npm run
  // speech:dev"' was shown in the module); the transcription panel keeps the service's wording.
  const down = conversationView({ ai: ai(), capture: capture({ canRecord: false, speech: speech({ available: false, state: 'unavailable', reason: 'The local speech service is not running. Start it with "npm run speech:dev".' }) }), failed: ok })
  assert.deepEqual(down.state, { kind: 'speech_unavailable', word: 'Speech-to-text unavailable', tone: 'down' })
  // Open, the transcription panel under the summary says it (once), so the summary does not say it again.
  assert.deepEqual(down.lines, ['Nothing recorded or typed yet.'])
  assert.equal(down.lines.some((l) => l.includes('npm') || l === SPEECH_UNAVAILABLE_LINE), false)
  // Closed, nothing the chip already says.
  assert.deepEqual(down.compact, ['Nothing recorded or typed yet.'])
  assert.equal(conversationView({ ai: ai({ stt: { available: false, state: 'loading' } }), failed: ok }).state.tone, 'warn')
  assert.deepEqual(conversationView({ ai: ai({ stt: { available: false, state: 'not_configured' } }), failed: ok }).state, { kind: 'speech_not_set_up', word: 'Speech-to-text not set up', tone: 'neutral' })

  const ready = conversationView({ ai: ai(), capture: capture(), failed: ok, readAt: T0 })
  assert.deepEqual(ready.state, { kind: 'ready', word: 'Ready', tone: 'ok' })
  assert.equal(ready.lines[1], 'Consent recorded; local speech-to-text ready.')
  assert.match(ready.meta!, /^Speech-to-text on this computer \(small\) · checked /)

  const closed = conversationView({ ai: ai(), capture: capture({ canRecord: false, blockedReason: 'This consultation is signed.' }), failed: ok })
  assert.deepEqual(closed.state, { kind: 'empty', word: 'Nothing recorded', tone: 'neutral' })
  assert.equal(closed.lines[1], 'This consultation is signed.')
  assert.deepEqual(closed.compact, ['Nothing recorded or typed yet.', 'This consultation is signed.'])
  assert.deepEqual(ready.compact, ['Nothing recorded or typed yet.'])
  assert.equal(conversationView({ ai: ai(), failed: ok }).state.kind, 'empty')
})

test('conversation: an old answer after a failed read says so; an answer the screen cannot read is Not updated, never "Consent needed"', () => {
  const v = conversationView({ ai: ai({ transcripts: [transcript()] }), failed: { ai: true, capture: false } })
  assert.equal(v.state.word, 'Transcript only · not updated')
  assert.equal(v.state.behind, true)
  for (const odd of [{ ...ai(), transcripts: 'nope' }, { transcripts: 'x' }, { ...ai(), consent: null }, 'text']) {
    const view = conversationView({ ai: odd as unknown as EncounterAi, failed: ok })
    assert.deepEqual(view.state, NOT_UPDATED)
    assert.deepEqual(view.lines, ['The conversation could not be read just now.'])
    assert.equal(view.facts, null)
  }
  // A recorder status that is not an object is left aside.
  assert.equal(conversationView({ ai: ai(), capture: 'x' as unknown as CaptureStatus, failed: ok }).state.kind, 'empty')
})

// --- 2 history ---------------------------------------------------------------------------------------------------------------------------------

const history = (over: Partial<PatientHistory> = {}): PatientHistory =>
  ({ patientId: 'p', generatedAt: iso(0), noKnownAllergies: false, allergies: [], conditions: [], medications: [], investigations: [], consultations: [], latestVitals: [], more: { consultations: 0, investigations: 0 }, ...over }) as PatientHistory

test('history: Loading, Not updated, No history recorded (allergy status not recorded), History recorded', () => {
  assert.deepEqual(historyView({ failed: false }).state, LOADING)
  const failed = historyView({ failed: true })
  assert.deepEqual(failed.state, NOT_UPDATED)
  assert.equal(failed.status, 'error')
  assert.equal(failed.message, 'The patient’s history could not be read just now.')

  const empty = historyView({ history: history(), failed: false })
  assert.deepEqual(empty.state, { kind: 'empty', word: 'No history recorded', tone: 'neutral' })
  assert.deepEqual(empty.allergies, { text: 'Allergy status not recorded', tone: 'warn' })
  assert.deepEqual(empty.facts, { entries: 0, allergyStatusRecorded: false })

  // "No known allergies" is a recorded allergy status: the history counts.
  const nka = historyView({ history: history({ noKnownAllergies: true }), failed: false })
  assert.deepEqual(nka.state, { kind: 'recorded', word: 'History recorded', tone: 'ok' })
  assert.deepEqual(nka.allergies, { text: 'No known allergies', tone: 'neutral' })
  assert.equal(historyView({ history: history({ noKnownAllergies: true }), failed: true }).state.word, 'History recorded · not updated')
  // An answer the screen cannot read is Not updated, never "No history recorded".
  const odd = historyView({ history: { allergies: 'x' } as unknown as PatientHistory, failed: false })
  assert.deepEqual(odd.state, NOT_UPDATED)
  assert.equal(odd.status, 'error')
  assert.equal(odd.facts, null)
})

test('history: allergies with their severity, open conditions (three, then +n), medicines, results, the last consultation, the reason for the visit', () => {
  const v = historyView({
    history: history({
      allergies: [{ substance: 'Penicillin', severity: 'severe' }, { substance: 'Dust', severity: 'unknown' }] as PatientHistory['allergies'],
      conditions: [
        { name: 'Asthma', status: 'active' },
        { name: 'Hypertension', status: 'controlled' },
        { name: 'Fracture', status: 'resolved' },
        { name: 'Diabetes', status: 'active' },
        { name: 'Migraine', status: 'active' },
      ] as PatientHistory['conditions'],
      medications: [{ status: 'current' }, { status: 'stopped' }] as PatientHistory['medications'],
      investigations: [{}, {}] as PatientHistory['investigations'],
      consultations: [{ date: '2026-09-01' }] as PatientHistory['consultations'],
      more: { consultations: 0, investigations: 1 },
    }),
    failed: false,
    reasonForVisit: ' Fever ',
  })
  assert.deepEqual(v.allergies, { text: 'Allergies: Penicillin (severe), Dust (severity not recorded)', tone: 'down' })
  assert.equal(v.conditions, 'Conditions: Asthma, Hypertension, Diabetes +1')
  assert.equal(v.record, `1 current medicine · 3 results · last consultation ${fmtDate('2026-09-01')}`)
  assert.equal(v.reason, 'Reason for visit: Fever')
  // Closed: the open conditions and the current medicines, counted, in one line.
  assert.equal(v.counts, '4 open conditions · 1 current medicine')
  assert.equal(historyView({ history: history({}), failed: false }).counts, 'No open condition · 0 current medicines')
  assert.deepEqual(v.facts, { entries: 10, allergyStatusRecorded: true })
  assert.match(v.meta!, /^Patient record · as of /)
  assert.equal(historyView({ history: history({ allergies: [{ substance: 'Nuts', severity: 'mild' }] as PatientHistory['allergies'] }), failed: false }).allergies?.tone, 'neutral')
})

// --- 3 vitals ----------------------------------------------------------------------------------------------------------------------------------

const obs = (kind: Observation['kind'], value: number, at: number, over: Partial<Observation> = {}): Observation => ({
  id: `00000000-0000-4000-8000-${String(Math.abs(at)).padStart(12, '0')}`,
  kind,
  value,
  unit: '',
  flag: null,
  measuredAt: iso(at),
  source: 'manual',
  validationStatus: 'manual_entry',
  deviceLabel: null,
  recordedByName: 'Nurse',
  visitId: null,
  enteredInError: false,
  ...over,
})
const reading = (kind: DeviceReading['kind'], value: number, measuredAt: number, over: Partial<DeviceReading> = {}): DeviceReading => ({
  observationId: '00000000-0000-4000-8000-000000000b01',
  kind,
  value,
  unit: '',
  flag: null,
  measuredAt: iso(measuredAt),
  receivedAt: iso(measuredAt),
  state: 'live',
  validationStatus: 'device_unverified',
  ...over,
})
const device = (over: Partial<AttachedDevice> = {}): AttachedDevice => ({
  assignmentId: '00000000-0000-4000-8000-000000000c01',
  deviceId: '00000000-0000-4000-8000-000000000c02',
  label: 'Band',
  kind: 'wearable_band',
  integration: 'gateway_api',
  simulated: false,
  assignedAt: iso(-600),
  validUntil: null,
  visitId: null,
  encounterId: null,
  lastSeenAt: iso(0),
  state: 'live',
  reason: null,
  kinds: ['heart_rate', 'spo2', 'temperature', 'respiratory_rate'],
  readings: [],
  readingsStored: 0,
  ...over,
})
/** An answer the server gave at T0 that arrived on this computer at `receivedAt` (this computer's clock). */
const answer = (devices: AttachedDevice[], over: { consent?: 'granted' | 'outdated' | 'missing'; receivedAt?: number } = {}): ReceivedDeviceReadings => ({
  view: { serverTime: iso(0), thresholds: { liveSeconds: 30, disconnectedSeconds: 120 }, consent: over.consent ?? 'granted', devices },
  receivedAt: over.receivedAt ?? 1_000_000,
})
const adult = '1980-01-01'

test('vitals: an answer the screen cannot read is Not updated, never a crash (the forced device fault of the workspace spec)', () => {
  const broken = { view: { serverTime: iso(0), thresholds: { liveSeconds: 6, disconnectedSeconds: 14 }, consent: 'granted', devices: 'not a list' }, receivedAt: 1_000_000 } as unknown as ReceivedDeviceReadings
  const v = vitalsView({ vitals: [], dateOfBirth: adult, devices: broken, devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(v.state, NOT_UPDATED)
  assert.equal(v.deviceLine, 'Device readings could not be read just now.')
  assert.deepEqual(deviceCore(broken, 1_000_000), { readable: false, attached: 0, state: null, consent: null, readings: 0, simulated: 0 })
  // Staff values are still shown beside it.
  const withStaff = vitalsView({ vitals: [obs('heart_rate', 88, 0)], dateOfBirth: adult, devices: broken, devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(withStaff.state, NOT_UPDATED)
  assert.equal(withStaff.tiles.find((t) => t.kind === 'heart_rate')?.values[0]?.value, '88')
  // Never read and the read failed.
  assert.deepEqual(vitalsView({ vitals: [], devicesFailed: true, nowLocal: 0 }).state, NOT_UPDATED)
  assert.deepEqual(vitalsView({ vitals: [], devicesFailed: false, nowLocal: 0 }).state, LOADING)
})

test('vitals with no device: Staff vitals when staff measured, else the device consent when it is missing, else No device attached', () => {
  const none = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([]), devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(none.state, { kind: 'no_device', word: 'No device attached', tone: 'neutral' })
  assert.equal(none.deviceLine, 'No device attached.')
  assert.deepEqual(none.tiles, [])
  const noConsent = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([], { consent: 'missing' }), devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(noConsent.state, { kind: 'consent_needed', word: 'Consent needed', tone: 'warn' })
  assert.equal(noConsent.consentLine, 'Consent to device readings is not recorded, so no device can be attached.')

  const staff = vitalsView({
    vitals: [obs('heart_rate', 72, 0), obs('heart_rate', 80, 60), obs('systolic_bp', 120, 0), obs('diastolic_bp', 80, 0), obs('weight', 70, 0), obs('spo2', 90, 30, { enteredInError: true })],
    dateOfBirth: adult,
    devices: answer([]),
    devicesFailed: false,
    nowLocal: 1_000_000,
  })
  assert.deepEqual(staff.state, { kind: 'staff', word: 'Staff vitals', tone: 'ok' })
  const hr = staff.tiles.find((t) => t.kind === 'heart_rate')!
  assert.equal(hr.short, 'HR')
  assert.deepEqual(
    hr.values.map((v) => [v.source, v.value]),
    [['staff', '80']],
  )
  // A value entered in error is not shown.
  assert.deepEqual(staff.tiles.find((t) => t.kind === 'spo2')?.values, [])
  assert.equal(staff.also, 'BP 120/80 mmHg · Wt 70.0 kg')
  assert.deepEqual(staff.facts, { staff: 4, device: 0, simulated: 0 })
})

test('vitals with devices: live, stale (aged on the server’s clock), a simulator never LIVE, and an old answer after a failed read', () => {
  const real = device({ readings: [reading('heart_rate', 101, -2, { flag: 'high' }), reading('spo2', 96, -2)] })
  const live = vitalsView({ vitals: [obs('heart_rate', 92, -300)], dateOfBirth: adult, devices: answer([real]), devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(live.state, { kind: 'live', word: 'Device live', tone: 'ok' })
  const hr = live.tiles.find((t) => t.kind === 'heart_rate')!
  assert.deepEqual(
    hr.values.map((v) => [v.source, v.value, v.state, v.showState, v.flag]),
    [
      ['staff', '92', null, false, null],
      ['device', '101', 'live', true, 'high'],
    ],
  )
  assert.equal(live.deviceLine, null)
  assert.deepEqual(live.facts, { staff: 1, device: 2, simulated: 0 })
  assert.match(live.meta!, /^Staff, .+ · Device gateway, read .+$/)

  // 40 seconds later on this computer: the readings are older than the 30 live seconds.
  const stale = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([real]), devicesFailed: false, nowLocal: 1_000_000 + 40_000 })
  assert.equal(stale.state.kind, 'stale')
  assert.equal(stale.state.tone, 'warn')
  assert.equal(stale.deviceLine?.startsWith('Device readings not updated since '), true)

  const sim = device({ simulated: true, integration: 'simulator', label: 'Simulator', readings: [reading('heart_rate', 140, -1, { validationStatus: 'simulated', flag: 'critical_high' })] })
  const simulated = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([sim]), devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(simulated.state, { kind: 'simulated', word: 'Simulated device', tone: 'neutral' })
  const value = simulated.tiles.find((t) => t.kind === 'heart_rate')!.values[0]!
  assert.equal(value.simulated, true)
  assert.equal(value.state, 'live')
  assert.equal(value.showState, false)
  assert.equal(value.flag, null)
  assert.deepEqual(simulated.facts, { staff: 0, device: 0, simulated: 1 })
  // A real device live beside a simulator: the real one is counted as live, the simulator is not.
  assert.equal(vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([real, sim]), devicesFailed: false, nowLocal: 1_000_000 }).state.word, 'Device live (1 of 2)')

  // Closed: one line of the four, each the newest current value that is not simulated; the sources grouped, each naming its kinds.
  assert.deepEqual(
    live.compact?.values.map((v) => [v.short, v.value, v.mark, v.current]),
    [
      ['HR', '101', 'device', true],
      ['SpO₂', '96', 'device', true],
      ['RR', null, null, true],
      ['Temp', null, null, true],
    ].sort((a, b) => ['HR', 'SpO₂', 'Temp', 'RR'].indexOf(a[0] as string) - ['HR', 'SpO₂', 'Temp', 'RR'].indexOf(b[0] as string)),
  )
  assert.deepEqual(
    live.compact?.sources.map((g) => [g.mark, g.kinds]),
    [['device', ['HR', 'SpO₂']]],
  )
  // A device gone quiet is not current: staff's value stands for that kind, the device's last one only where staff has none (greyed, with its state).
  const quietReal = vitalsView({ vitals: [obs('heart_rate', 92, -300)], dateOfBirth: adult, devices: answer([real]), devicesFailed: false, nowLocal: 1_000_000 + 200_000 })
  assert.deepEqual(
    quietReal.compact?.values.filter((v) => v.value).map((v) => [v.short, v.value, v.mark, v.current, v.state]),
    [
      ['HR', '92', 'staff', true, null],
      ['SpO₂', '96', 'device', false, 'disconnected'],
    ],
  )
  // A simulator's value only where nothing else has that kind, and marked SIMULATED.
  const both = compactVitals(vitalsView({ vitals: [obs('heart_rate', 92, -300)], dateOfBirth: adult, devices: answer([sim]), devicesFailed: false, nowLocal: 1_000_000 }).tiles)
  assert.deepEqual(
    both.values.filter((v) => v.value).map((v) => [v.short, v.value, v.mark]),
    [['HR', '92', 'staff']],
  )
  assert.deepEqual(
    simulated.compact?.values.filter((v) => v.value).map((v) => [v.short, v.value, v.mark, v.flag]),
    [['HR', '140', 'simulated', null]],
  )

  const old = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([real]), devicesFailed: true, nowLocal: 1_000_000 })
  assert.equal(old.state.word, 'Device live · not updated')
  assert.equal(old.state.tone, 'neutral')
})

test('vitals: the device words for a gateway gone quiet, one that sent nothing yet, and an assignment whose time is over', () => {
  const at = (d: AttachedDevice) => vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([d]), devicesFailed: false, nowLocal: 1_000_000 }).state
  assert.deepEqual(at(device({ lastSeenAt: iso(-200), readings: [reading('heart_rate', 80, -200)] })), { kind: 'disconnected', word: 'Device not connected', tone: 'down' })
  assert.deepEqual(at(device()), { kind: 'no_data', word: 'Device: no data', tone: 'neutral' })
  assert.deepEqual(at(device({ validUntil: iso(-1), readings: [reading('heart_rate', 80, -2)] })), { kind: 'unavailable', word: 'Device unavailable', tone: 'neutral' })
  // A simulator gone quiet is said to be so (only "live" is never said of a simulator).
  const quiet = vitalsView({ vitals: [], dateOfBirth: adult, devices: answer([device({ simulated: true, lastSeenAt: iso(-200), readings: [reading('heart_rate', 80, -200, { validationStatus: 'simulated' })] })]), devicesFailed: false, nowLocal: 1_000_000 })
  assert.equal(quiet.state.kind, 'disconnected')
  assert.equal(quiet.tiles[0]?.values[0]?.showState, true)
})

test('vitals: a device value stored with the visit stands where no attached device sends that kind; the fixed lines for children', () => {
  const v = vitalsView({ vitals: [obs('temperature', 37.25, 0, { source: 'device', validationStatus: 'device_unverified', deviceLabel: 'Band 2' })], dateOfBirth: adult, devices: answer([]), devicesFailed: false, nowLocal: 1_000_000 })
  assert.deepEqual(
    v.tiles.find((t) => t.kind === 'temperature')?.values.map((x) => [x.source, x.value, x.device]),
    [['stored', '37.3', 'Band 2']],
  )
  assert.equal(v.facts.device, 1)
  // A simulator's value is never in the visit's vital signs; if one were, it would not be shown.
  assert.deepEqual(vitalsView({ vitals: [obs('temperature', 39, 0, { source: 'device', validationStatus: 'simulated' })], devicesFailed: false, nowLocal: 0 }).tiles, [])
  const child = vitalsView({ vitals: [], dateOfBirth: '2018-03-01', devices: answer([]), devicesFailed: false, nowLocal: 0, today: new Date(T0) })
  assert.equal(child.paediatric, true)
  assert.equal(vitalsView({ vitals: [], dateOfBirth: adult, devicesFailed: false, nowLocal: 0, today: new Date(T0) }).paediatric, false)
})

// --- 4 stethoscope -----------------------------------------------------------------------------------------------------------------------------

const recording = (over: Partial<AuscultationRecording> = {}): AuscultationRecording => ({
  id: '00000000-0000-4000-8000-000000000d01',
  patientId: 'p',
  encounterId: ENC,
  fileId: '00000000-0000-4000-8000-000000000d02',
  mimeType: 'audio/webm',
  sizeBytes: 2048,
  site: 'mitral',
  note: null,
  device: null,
  captureMethod: 'browser_recording',
  simulated: false,
  durationMs: 12_345,
  inputLabel: null,
  dataOrigin: 'synthetic',
  createdAt: iso(0),
  createdByName: 'Dr A',
  ...over,
})
const granted = (type: string) => ({ consents: [{ type, status: 'granted' }] }) as unknown as PatientDetail
const noConsents = { consents: [] } as unknown as PatientDetail

test('stethoscope: a length says who timed it; an upload reports none', () => {
  assert.equal(recordingLength(recording()), '0:12, timed by the browser')
  // The closed module's clock: m:ss, rounded to the second.
  assert.equal(recordingClock(recording({ durationMs: 2200 })), '0:02')
  assert.equal(recordingClock(recording({ durationMs: 75_600 })), '1:16')
  assert.equal(recordingClock(recording({ durationMs: null })), 'length not reported')
  assert.equal(recordingLength(recording({ captureMethod: 'file_upload', durationMs: null })), 'length not reported')
  assert.equal(recordingLength(recording({ captureMethod: 'gateway', durationMs: 4000 })), '0:04, as reported by the gateway')
})

test('stethoscope: this consultation’s recordings, the newest one’s site and length, Simulated only, Consent needed, No recording, Not updated', () => {
  assert.deepEqual(stethoscopeView({ failed: false, encounterId: ENC }).state, LOADING)
  assert.deepEqual(stethoscopeView({ failed: true, encounterId: ENC }).state, NOT_UPDATED)
  assert.deepEqual(stethoscopeView({ recordings: 'not a list', failed: false, encounterId: ENC }).state, NOT_UPDATED)
  assert.equal(stethoscopeCore('not a list', ENC), null)

  const list = [recording({ createdAt: iso(0), site: 'aortic' }), recording({ createdAt: iso(60), site: 'mitral', captureMethod: 'file_upload', durationMs: null }), recording({ encounterId: OTHER })]
  const v = stethoscopeView({ recordings: list, failed: false, patient: granted('device_monitoring'), encounterId: ENC })
  assert.deepEqual(v.state, { kind: 'recorded', word: '2 recordings', tone: 'ok' })
  assert.equal(v.count, '2 recordings in this consultation · 1 earlier recording of this patient')
  // Closed: the count, the newest one's site without its parenthesis, and its length.
  assert.equal(v.compact, '2 recordings · Mitral area · length not reported')
  assert.deepEqual(v.last, { site: 'Mitral area (apex)', length: 'length not reported', simulated: false })
  assert.deepEqual(v.facts, { recordings: 2, simulated: 0 })
  assert.match(v.meta!, /^Uploaded file, Dr A · /)
  assert.equal(STETHOSCOPE_HONESTY, 'Recorded, not analysed. No stethoscope has been connected to or tested with this system.')

  const sim = stethoscopeView({ recordings: [recording({ simulated: true, captureMethod: 'gateway' })], failed: false, patient: granted('device_monitoring'), encounterId: ENC })
  assert.deepEqual(sim.state, { kind: 'simulated', word: 'Simulated only', tone: 'neutral' })
  assert.equal(sim.last?.simulated, true)
  assert.deepEqual(sim.facts, { recordings: 1, simulated: 1 })

  const consent = stethoscopeView({ recordings: [], failed: false, patient: noConsents, encounterId: ENC })
  assert.deepEqual(consent.state, { kind: 'consent_needed', word: 'Consent needed', tone: 'warn' })
  assert.equal(consent.consentLine, 'Consent to device readings is not recorded, so no recording can be added.')
  const empty = stethoscopeView({ recordings: [recording({ encounterId: OTHER })], failed: false, patient: granted('device_monitoring'), encounterId: ENC })
  assert.deepEqual(empty.state, { kind: 'empty', word: 'No recording', tone: 'neutral' })
  assert.equal(empty.count, 'No recording in this consultation · 1 earlier recording of this patient')
  assert.equal(stethoscopeView({ recordings: [recording()], failed: true, encounterId: ENC }).state.word, '1 recording · not updated')
})

// --- 5 thermal ---------------------------------------------------------------------------------------------------------------------------------

const capture5 = (over: Partial<ThermalCapture> = {}): ThermalCapture =>
  ({
    id: '00000000-0000-4000-8000-000000000f01',
    patientId: 'p',
    encounterId: ENC,
    status: 'draft',
    width: 160,
    height: 120,
    minC: 28.04,
    maxC: 35.21,
    meanC: 31.5,
    protocol: { bodyRegion: 'Left hand, dorsum', bodySite: 'hand', view: 'dorsal' },
    rois: [{}, {}],
    pairs: [],
    captureSource: 'gallery_import',
    simulated: false,
    capturedAt: null,
    createdAt: iso(0),
    ...over,
  }) as ThermalCapture

test('thermal: the newest image of this consultation in words, Images: n (approved m), the camera, the model, the research view', () => {
  const list = [
    capture5({ id: 'a', createdAt: iso(0), status: 'approved' }),
    capture5({ id: 'b', createdAt: iso(60), status: 'draft', protocol: { bodyRegion: 'Right knee', bodySite: null, view: 'anterior' } as ThermalCapture['protocol'] }),
    capture5({ id: 'c', createdAt: iso(120), encounterId: OTHER, status: 'approved' }),
    capture5({ id: 'd', createdAt: iso(30), encounterId: OTHER, captureSource: 'simulator', simulated: true }),
  ]
  const v = thermalView({ captures: list, failed: false, patient: granted('thermal_imaging'), encounterId: ENC, model: { available: false, reason: 'No trained thermal model is installed.' } as ThermalModelStatus, modelFailed: false, bridge: false })
  // What waits is said, not the count: the amber chip is the draft waiting for review (the count is in "Images: 2 (approved 1)").
  assert.deepEqual(v.state, { kind: 'images', word: '1 to review', tone: 'warn' })
  assert.equal(v.images, 'Images: 2 (approved 1)')
  assert.equal(v.newest?.capture.id, 'b')
  assert.equal(v.newest?.body, 'Right knee')
  assert.deepEqual(v.newest?.status, { word: 'Draft', tone: 'warn' })
  assert.equal(v.newest?.stats, 'Min 28.0 °C · max 35.2 °C · mean 31.5 °C')
  assert.equal(v.newest?.range, '28.0–35.2 °C')
  assert.equal(v.newest?.radiometric, 'Radiometric: yes')
  assert.equal(v.newest?.regions, '2 regions')
  assert.equal(v.camera, 'FLIR ONE not connected')
  assert.deepEqual(v.model, { chip: 'MODEL UNAVAILABLE', available: false, text: null })
  assert.equal(v.research, 'Research mode available')
  assert.match(v.meta!, /^Imported · /)
  assert.deepEqual(v.facts, { images: 2, simulated: 0 })
  // An analysis reads the patient's approved images that are not simulated, whichever consultation they were taken in.
  assert.deepEqual(v.analysis, { approvedThermal: 2, simulatedThermal: 1, thermalConsentWithdrawn: false })
  assert.equal(thermalView({ captures: [capture5({ status: 'approved' })], failed: false, encounterId: ENC, modelFailed: false, bridge: false }).state.tone, 'ok')
})

test('thermal: Simulated only (never radiometric), No image, Consent needed (or withdrawn), Loading, Not updated', () => {
  const sim = thermalView({ captures: [capture5({ captureSource: 'simulator', simulated: true })], failed: false, encounterId: ENC, modelFailed: false, bridge: false })
  assert.deepEqual(sim.state, { kind: 'simulated', word: 'Simulated only', tone: 'neutral' })
  assert.equal(sim.newest?.simulated, true)
  assert.equal(sim.newest?.radiometric, 'Radiometric: no, generated numbers')
  assert.deepEqual(sim.facts, { images: 1, simulated: 1 })

  assert.deepEqual(thermalView({ captures: [], failed: false, patient: granted('thermal_imaging'), encounterId: ENC, modelFailed: false, bridge: false }).state, { kind: 'no_image', word: 'No image', tone: 'neutral' })
  const missing = thermalView({ captures: [], failed: false, patient: noConsents, encounterId: ENC, modelFailed: false, bridge: false })
  assert.deepEqual(missing.state, { kind: 'consent_needed', word: 'Consent needed', tone: 'warn' })
  assert.equal(missing.consentLine, 'Consent to thermal imaging is not recorded, so no image can be captured.')
  const withdrawn = thermalView({ captures: [], failed: false, patient: { consents: [{ type: 'thermal_imaging', status: 'withdrawn' }] } as unknown as PatientDetail, encounterId: ENC, modelFailed: false, bridge: false })
  assert.equal(withdrawn.consentLine, 'The patient withdrew consent to thermal imaging: no image can be captured.')
  assert.equal(withdrawn.analysis.thermalConsentWithdrawn, true)

  assert.deepEqual(thermalView({ failed: false, encounterId: ENC, modelFailed: false, bridge: false }).state, LOADING)
  assert.deepEqual(thermalView({ failed: true, encounterId: ENC, modelFailed: false, bridge: false }).state, NOT_UPDATED)
  assert.deepEqual(thermalView({ captures: null, failed: false, encounterId: ENC, modelFailed: false, bridge: false }).state, NOT_UPDATED)
  assert.equal(thermalCore({}, ENC), null)
})

test('thermal: the model and the camera as the server and the page say them', () => {
  assert.deepEqual(thermalModelLine(undefined, false), { chip: null, available: null, text: 'Checking the thermal model…' })
  assert.deepEqual(thermalModelLine(undefined, true), { chip: null, available: null, text: 'Thermal model status could not be read.' })
  assert.equal(thermalCameraLine(false), 'FLIR ONE not connected')
  assert.equal(thermalCameraLine(true), 'Camera bridge present: a FLIR ONE can be connected in the thermal workspace.')
})
