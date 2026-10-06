// Unit tests (node --test) of the pure logic behind the doctor's Thermal page and thermal study (DESIGN §5.7): the page's URL state (which
// patient, which study open in place), today's patients as quick picks, the thermal-imaging consent decided as the server decides it, the
// doctor's consultation in progress an image goes into, whether Upload and Capture are possible and the exact words when not, what the camera
// pane may offer in a browser (never a working FLIR claim), which facts of a capture a doctor sees by default and which only behind "Details",
// how the numbers are written (missing never shown as 0), the simplified upload dialog's capture details, the open study's one place beside
// the camera, and the question before regions not saved are discarded. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { CaptureProtocol, type Consent, type MyConsultation, type ThermalCapture, type Visit } from '@adaxai/contracts'
import {
  CAPTURE_NEEDS_CONSULTATION,
  cameraOffer,
  captureFacts,
  captureStatusSpec,
  choosePatient,
  CLINICAL_FACTS,
  clearPatient,
  closeStudy,
  DETAIL_FACTS,
  discardGuard,
  effectivePatientId,
  fmtDiff,
  openConsultationFor,
  openStudy,
  readThermalParams,
  regionOf,
  roiStatsParts,
  simpleUploadProtocol,
  studyArea,
  type ThermalConsent,
  thermalAcquisition,
  thermalConsent,
  thermalQuickPicks,
  thermalSearch,
  wholeImageStats,
  wholeImageStatsText,
} from '../src/lib/thermalStudy.ts'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const E1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const E2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

// ------------------------------------------------------------------------------------------------------------------------------------------
// The picker's state: the URL
// ------------------------------------------------------------------------------------------------------------------------------------------

test('the page reads ?patientId= and ?capture= as ids only: anything else is ignored, so a mistyped link shows the picker', () => {
  assert.deepEqual(readThermalParams(new URLSearchParams(`patientId=${P1}&capture=${C1}`)), { patientId: P1, captureId: C1 })
  assert.deepEqual(readThermalParams(new URLSearchParams(`patientId=${P1.toUpperCase()}`)), { patientId: P1, captureId: null })
  assert.deepEqual(readThermalParams(new URLSearchParams('patientId=abc&capture=1%20OR%201')), { patientId: null, captureId: null })
  assert.deepEqual(readThermalParams(new URLSearchParams('')), { patientId: null, captureId: null })
})

test('the URL round-trips, and empty parameters are left out', () => {
  assert.equal(thermalSearch({ patientId: null, captureId: null }), '')
  assert.equal(thermalSearch({ patientId: P1, captureId: null }), `?patientId=${P1}`)
  const both = thermalSearch({ patientId: P1, captureId: C1 })
  assert.deepEqual(readThermalParams(new URLSearchParams(both)), { patientId: P1, captureId: C1 })
})

test('choosing a patient closes the study; opening a study chooses its patient; closing the study keeps the patient; Change patient clears both', () => {
  assert.deepEqual(choosePatient(P2), { patientId: P2, captureId: null })
  assert.deepEqual(openStudy({ id: C1, patientId: P1 }), { patientId: P1, captureId: C1 })
  assert.deepEqual(closeStudy({ patientId: P1, captureId: C1 }), { patientId: P1, captureId: null })
  assert.deepEqual(clearPatient(), { patientId: null, captureId: null })
})

test('a link that names only the study chooses the study’s own patient; a patient in the URL always wins', () => {
  assert.equal(effectivePatientId({ patientId: null, captureId: C1 }, P2), P2)
  assert.equal(effectivePatientId({ patientId: P1, captureId: C1 }, P2), P1)
  assert.equal(effectivePatientId({ patientId: null, captureId: C1 }, undefined), null)
  // Without a study, nothing is chosen from it.
  assert.equal(effectivePatientId({ patientId: null, captureId: null }, P2), null)
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// Today's patients
// ------------------------------------------------------------------------------------------------------------------------------------------

type V = Pick<Visit, 'status' | 'checkedInAt' | 'appointment' | 'patient' | 'tokenNumber'>
const visit = (id: string, name: string, status: Visit['status'], checkedInAt: string, token: number, scheduledAt?: string): V => ({
  status,
  checkedInAt,
  tokenNumber: token,
  appointment: scheduledAt ? { id: C1, scheduledAt, localTime: '' } : null,
  patient: { id, mrn: `MRN-${token}`, fullName: name, sex: 'female', dateOfBirth: '1990-01-01', noKnownAllergies: true, activeAllergies: [] },
})

test('quick picks are today’s patients in the order of the day (appointment time, else check-in), each once, cancelled and no-show left out', () => {
  const picks = thermalQuickPicks([
    visit(P1, 'Late walk-in', 'waiting', '2026-10-06T10:30:00Z', 4),
    visit(P2, 'Booked early', 'in_consultation', '2026-10-06T10:45:00Z', 5, '2026-10-06T09:00:00Z'),
    visit('33333333-3333-4333-8333-333333333333', 'Cancelled', 'cancelled', '2026-10-06T08:00:00Z', 1),
    visit('44444444-4444-4444-8444-444444444444', 'No show', 'no_show', '2026-10-06T08:10:00Z', 2),
    // The same patient again (a second visit today) is one pick, at the earlier time.
    visit(P1, 'Late walk-in', 'completed', '2026-10-06T11:30:00Z', 9),
  ])
  assert.deepEqual(
    picks.map((p) => [p.fullName, p.at]),
    [
      ['Booked early', '2026-10-06T09:00:00Z'],
      ['Late walk-in', '2026-10-06T10:30:00Z'],
    ],
  )
  // At most `max`, the earliest first.
  const many = thermalQuickPicks(Array.from({ length: 20 }, (_, i) => visit(`patient-${i}`, `P${i}`, 'waiting', `2026-10-06T08:${String(i).padStart(2, '0')}:00Z`, i)), 12)
  assert.equal(many.length, 12)
  assert.equal(many[0]!.fullName, 'P0')
  assert.deepEqual(thermalQuickPicks([]), [])
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// Consent, as the server decides it
// ------------------------------------------------------------------------------------------------------------------------------------------

type CR = Pick<Consent, 'type' | 'status' | 'scope' | 'encounterId' | 'recordedAt' | 'currentWording'>
const consent = (o: Partial<CR>): CR => ({ type: 'thermal_imaging', status: 'granted', scope: 'ongoing', encounterId: null, recordedAt: '2026-10-01T09:00:00Z', currentWording: true, ...o })

test('an ongoing grant with the current wording covers a new image; nothing recorded does not', () => {
  assert.deepEqual(thermalConsent([consent({})]), { state: 'granted', granted: true, label: 'Granted', reason: null })
  const none = thermalConsent([consent({ type: 'clinical_photography' })])
  assert.equal(none.state, 'not_recorded')
  assert.equal(none.granted, false)
  assert.match(none.reason!, /not recorded/)
})

test('a grant for one consultation covers that consultation only', () => {
  const rows = [consent({ scope: 'encounter', encounterId: E1 })]
  assert.equal(thermalConsent(rows, E1).state, 'granted')
  assert.equal(thermalConsent(rows, E1).label, 'Granted for this consultation')
  assert.equal(thermalConsent(rows, E2).state, 'not_recorded')
  assert.equal(thermalConsent(rows).state, 'not_recorded')
})

test('a grant with an earlier wording is refused (the server does not accept it for a thermal image), unless one with the current wording also covers', () => {
  const old = consent({ currentWording: false })
  assert.equal(thermalConsent([old]).state, 'outdated')
  assert.equal(thermalConsent([old]).granted, false)
  assert.equal(thermalConsent([old, consent({ scope: 'encounter', encounterId: E1, recordedAt: '2026-09-01T09:00:00Z' })], E1).state, 'granted')
})

test('a withdrawal is said as withdrawn; a superseded grant alone is not a grant', () => {
  assert.equal(thermalConsent([consent({ status: 'withdrawn' })]).state, 'withdrawn')
  assert.equal(thermalConsent([consent({ status: 'superseded' })]).state, 'not_recorded')
  // A consultation-only grant does not undo an ongoing withdrawal elsewhere, but covers its own consultation.
  const rows = [consent({ status: 'withdrawn', recordedAt: '2026-10-02T09:00:00Z' }), consent({ scope: 'encounter', encounterId: E1, recordedAt: '2026-10-03T09:00:00Z' })]
  assert.equal(thermalConsent(rows).state, 'withdrawn')
  assert.equal(thermalConsent(rows, E1).state, 'granted')
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// The doctor's consultation in progress, and Upload / Capture
// ------------------------------------------------------------------------------------------------------------------------------------------

const consultation = (encounterId: string, patientId: string, o: { status?: MyConsultation['status']; visitDate?: string; updatedAt?: string } = {}): MyConsultation => ({
  encounterId,
  status: o.status ?? 'in_progress',
  version: 1,
  startedAt: '2026-10-06T09:00:00Z',
  updatedAt: o.updatedAt ?? '2026-10-06T09:30:00Z',
  signedAt: null,
  patient: { id: patientId, fullName: 'Anaya Demo-Synthetic', mrn: 'MRN-1' },
  visit: { id: C1, visitDate: o.visitDate ?? '2026-10-06', tokenNumber: 3, status: 'in_consultation', departmentName: 'General medicine' },
  progress: { sectionsWithText: 0, diagnoses: 0, medicines: 0 },
  amendmentCount: 0,
})

test('the consultation an image goes into is the doctor’s own of this patient in progress: today’s first, then the most recently updated', () => {
  const items = [consultation(E1, P1, { visitDate: '2026-10-05', updatedAt: '2026-10-06T11:00:00Z' }), consultation(E2, P1, { visitDate: '2026-10-06', updatedAt: '2026-10-06T09:00:00Z' }), consultation(C1, P2)]
  assert.equal(openConsultationFor(items, P1, '2026-10-06')?.encounterId, E2)
  // Without the facility's date, the most recently updated.
  assert.equal(openConsultationFor(items, P1)?.encounterId, E1)
  assert.equal(openConsultationFor(items, '33333333-3333-4333-8333-333333333333', '2026-10-06'), null)
  assert.equal(openConsultationFor([consultation(E1, P1, { status: 'signed' })], P1), null)
  assert.equal(openConsultationFor(items, null), null)
})

const granted: ThermalConsent = { state: 'granted', granted: true, label: 'Granted', reason: null }

test('Capture needs the doctor’s consultation of this patient in progress, in the exact words of the design; Upload does not', () => {
  const a = thermalAcquisition({ patient: 'ready', consultations: 'ready', consent: granted, openEncounterId: null })
  assert.deepEqual(a.upload, { enabled: true, block: null, reason: null })
  assert.deepEqual(a.capture, { enabled: false, block: 'no_consultation', reason: CAPTURE_NEEDS_CONSULTATION })
  assert.equal(CAPTURE_NEEDS_CONSULTATION, "Capture needs this patient's consultation in progress — start it from My consultations")
  // The upload is then stored with the patient only.
  assert.equal(a.encounterId, null)
})

test('with the consultation in progress, both are possible and the image goes into it', () => {
  const a = thermalAcquisition({ patient: 'ready', consultations: 'ready', consent: granted, openEncounterId: E1 })
  assert.equal(a.upload.enabled, true)
  assert.equal(a.capture.enabled, true)
  assert.equal(a.encounterId, E1)
})

test('in order: a patient first, then what is still being read, then a read that failed, then consent; neither action guesses', () => {
  const blockOf = (i: Parameters<typeof thermalAcquisition>[0]) => {
    const a = thermalAcquisition(i)
    assert.equal(a.upload.enabled, false)
    assert.equal(a.capture.enabled, false)
    assert.equal(a.encounterId, null)
    return [a.upload.block, a.capture.block]
  }
  assert.deepEqual(blockOf({ patient: 'none', consultations: 'ready', consent: granted, openEncounterId: E1 }), ['no_patient', 'no_patient'])
  assert.deepEqual(blockOf({ patient: 'loading', consultations: 'ready', consent: null, openEncounterId: null }), ['checking', 'checking'])
  // An upload is never stored patient-only just because the consultations are not known yet.
  assert.deepEqual(blockOf({ patient: 'ready', consultations: 'loading', consent: granted, openEncounterId: null }), ['checking', 'checking'])
  assert.deepEqual(blockOf({ patient: 'ready', consultations: 'error', consent: granted, openEncounterId: null }), ['unavailable', 'unavailable'])
  assert.deepEqual(blockOf({ patient: 'error', consultations: 'ready', consent: null, openEncounterId: null }), ['unavailable', 'unavailable'])
  const withdrawn: ThermalConsent = { state: 'withdrawn', granted: false, label: 'Withdrawn', reason: 'The patient has withdrawn consent to thermal imaging: no new image can be added.' }
  assert.deepEqual(blockOf({ patient: 'ready', consultations: 'ready', consent: withdrawn, openEncounterId: E1 }), ['consent', 'consent'])
  assert.equal(thermalAcquisition({ patient: 'ready', consultations: 'ready', consent: withdrawn, openEncounterId: E1 }).capture.reason, withdrawn.reason)
})

test('the camera in a browser is "FLIR ONE not connected"; the simulator is offered only where allowed; nothing claims FLIR capture works', () => {
  assert.deepEqual(cameraOffer({ bridge: false, simulatorAllowed: false }), { bridge: false, simulator: false, line: 'FLIR ONE not connected' })
  assert.deepEqual(cameraOffer({ bridge: false, simulatorAllowed: undefined }), { bridge: false, simulator: false, line: 'FLIR ONE not connected' })
  const sim = cameraOffer({ bridge: false, simulatorAllowed: true })
  assert.equal(sim.simulator, true)
  assert.match(sim.line, /^FLIR ONE not connected · .*\(SIMULATED\)$/)
  const bridge = cameraOffer({ bridge: true, simulatorAllowed: false })
  for (const o of [sim, bridge, cameraOffer({ bridge: false, simulatorAllowed: false })]) assert.doesNotMatch(o.line, /FLIR ONE (is )?connected|LIVE|captur(ed|ing) with FLIR|verified/i)
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// What the doctor sees by default, and what waits behind "Details"
// ------------------------------------------------------------------------------------------------------------------------------------------

const capture = (o: Partial<ThermalCapture> = {}): ThermalCapture =>
  ({
    id: C1,
    patientId: P1,
    encounterId: E1,
    status: 'draft',
    originalName: 'flir_example.jpg',
    width: 240,
    height: 320,
    minC: 30.04,
    maxC: 36.66,
    meanC: 33.449,
    stdC: 0.8421,
    camera: { make: 'FLIR', model: 'E8', dateTime: null },
    parameters: { emissivity: 0.95, objectDistanceM: 1, reflectedTempC: 20, atmosphericTempC: 20, relativeHumidity: 0.5, irWindowTempC: null, irWindowTransmission: null },
    protocol: { bodyRegion: 'Right knee, anterior', bodySite: 'knee', view: 'anterior', roomTempC: 22, acclimatisationMin: 15, distanceM: 1, notes: '' },
    extractor: { name: 'flyr', version: '5.1.0' },
    rawFileId: C1,
    rawSha256: 'a'.repeat(64),
    matrixFileId: C1,
    visibleFileId: null,
    captureSource: 'file_upload',
    simulated: false,
    capturedAt: null,
    device: null,
    deviceReported: null,
    rois: [],
    pairs: [],
    review: null,
    createdAt: '2026-10-06T10:42:00Z',
    createdByName: 'Dr. Meera',
    dataOrigin: 'public_sample',
    labels: [],
    ...o,
  }) as ThermalCapture

test('the split is fixed: clinical facts and detail facts never overlap, and every fact of a capture is in one of them', () => {
  const f = captureFacts(capture())
  assert.deepEqual(
    f.clinical.map((x) => x.key),
    [...CLINICAL_FACTS],
  )
  assert.deepEqual(
    f.details.map((x) => x.key),
    [...DETAIL_FACTS],
  )
  const clinical = new Set<string>(CLINICAL_FACTS)
  for (const k of DETAIL_FACTS) assert.equal(clinical.has(k), false, `${k} is not both`)
})

test('emissivity, the extractor, the data origin, the resolution and the file’s SHA-256 are never in the default view, only in Details', () => {
  const f = captureFacts(capture())
  const shown = JSON.stringify(f.clinical)
  for (const word of ['0.95', 'flyr', '5.1.0', 'Public sample', '240 × 320', 'aaaaaaaa', 'Emissivity', 'Extractor', 'SHA-256', 'Data origin']) assert.doesNotMatch(shown, new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${word} stays out of the default view`)
  const details = Object.fromEntries(f.details.map((x) => [x.key, x.value]))
  assert.equal(details.emissivity, '0.95')
  assert.equal(details.extractor, 'flyr 5.1.0')
  assert.equal(details.sha256, 'a'.repeat(64))
  assert.equal(details.resolution, '240 × 320')
  assert.match(details.dataOrigin!, /sample/i)
  // What a doctor sees: where on the body, and when.
  assert.deepEqual(
    f.clinical.map((x) => [x.label, x.value]),
    [
      ['Region', 'Knee · Right knee, anterior'],
      ['Received', f.clinical[1]!.value],
    ],
  )
  assert.equal(captureFacts(capture({ capturedAt: '2026-10-06T10:40:00Z' })).clinical[1]!.label, 'Captured')
})

test('missing details say "Not recorded", never a bare dash; a simulated image has no camera parameters to show', () => {
  const bare = captureFacts(capture({ protocol: { bodyRegion: 'Knee', bodySite: 'knee', view: 'other', roomTempC: null, acclimatisationMin: null, distanceM: null, notes: null }, camera: { make: null, model: null, dateTime: null }, originalName: null }))
  const d = Object.fromEntries(bare.details.map((x) => [x.key, x.value]))
  for (const k of ['conditions', 'distance', 'camera', 'notes', 'fileName'] as const) assert.equal(d[k], 'Not recorded', k)
  assert.equal(d.reviewed, 'Not reviewed yet')
  for (const x of [...bare.clinical, ...bare.details]) assert.notEqual(x.value.trim(), '—', x.key)
  const sim = Object.fromEntries(captureFacts(capture({ captureSource: 'simulator', simulated: true })).details.map((x) => [x.key, x.value]))
  assert.equal(sim.emissivity, 'Not applicable (SIMULATED)')
  assert.equal(sim.reflected, 'Not applicable (SIMULATED)')
})

test('the region names the site and the description each once', () => {
  assert.equal(regionOf(capture({ protocol: { bodyRegion: 'Knee', bodySite: 'knee', view: 'other' } })), 'Knee')
  assert.equal(regionOf(capture({ protocol: { bodyRegion: 'Knees', bodySite: null, view: 'anterior' } })), 'Knees')
  assert.equal(regionOf(capture({ protocol: { bodyRegion: 'Left hand', bodySite: 'hand', view: 'dorsal' } })), 'Hand · Left hand')
})

test('the review status is always a word: Awaiting review, Approved, Rejected', () => {
  assert.deepEqual(captureStatusSpec('draft'), { label: 'Awaiting review', tone: 'warn' })
  assert.deepEqual(captureStatusSpec('approved'), { label: 'Approved', tone: 'ok' })
  assert.deepEqual(captureStatusSpec('rejected'), { label: 'Rejected', tone: 'neutral' })
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// Numbers
// ------------------------------------------------------------------------------------------------------------------------------------------

test('the whole image’s min, max, mean and SD are written to 0.1 °C; an SD not stored is said so, never 0', () => {
  assert.deepEqual(
    wholeImageStats(capture()).map((s) => [s.label, s.value, s.unit, s.missing]),
    [
      ['Min', '30.0', '°C', false],
      ['Max', '36.7', '°C', false],
      ['Mean', '33.4', '°C', false],
      ['SD', '0.8', '°C', false],
    ],
  )
  const old = wholeImageStats(capture({ stdC: null }))
  assert.deepEqual(old[3], { key: 'sd', label: 'SD', value: 'Not stored for this image', unit: '', missing: true })
  assert.equal(wholeImageStatsText(capture()), 'Min 30.0 °C · Max 36.7 °C · Mean 33.4 °C · SD 0.8 °C')
  assert.equal(wholeImageStatsText(capture({ stdC: null })), 'Min 30.0 °C · Max 36.7 °C · Mean 33.4 °C · SD not stored for this image')
  // A real 0 is a value, not a missing one.
  assert.equal(wholeImageStats(capture({ stdC: 0 }))[3]!.value, '0.0')
})

test('a region’s numbers are written to 0.01 °C with its pixel count; a region with no pixel that has a reading has none', () => {
  assert.deepEqual(roiStatsParts({ pixelCount: 12345, min: 31.111, max: 35.5, mean: 33.456, std: 0.4 }), { mean: '33.46 °C', min: '31.11 °C', max: '35.50 °C', sd: '0.40 °C', pixels: '12,345 px' })
  assert.equal(roiStatsParts({ pixelCount: 0, min: null, max: null, mean: null, std: null }), null)
  assert.equal(roiStatsParts(null), null)
  assert.equal(roiStatsParts({ pixelCount: 4, min: 30, max: 31, mean: 30.5, std: null })!.sd, 'No reading')
})

test('a paired difference carries its sign; one that could not be computed says so', () => {
  assert.equal(fmtDiff(0.844), '+0.84 °C')
  assert.equal(fmtDiff(-1.2), '-1.20 °C')
  assert.equal(fmtDiff(0), '0.00 °C')
  assert.equal(fmtDiff(null), 'Not available')
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// The simplified upload dialog
// ------------------------------------------------------------------------------------------------------------------------------------------

test('the simplified upload names the image by its body region, records the view as other, keeps the note, and passes the contract', () => {
  const p = simpleUploadProtocol({ bodySite: 'knee', notes: 'Right knee, anterior' })
  assert.deepEqual(p, { bodyRegion: 'Knee', bodySite: 'knee', view: 'other', notes: 'Right knee, anterior' })
  assert.equal(CaptureProtocol.safeParse(p).success, true)
  // No region chosen (or one not on the list): the contract refuses it, and nothing is uploaded.
  assert.equal(CaptureProtocol.safeParse(simpleUploadProtocol({ bodySite: '', notes: '' })).success, false)
  assert.equal(simpleUploadProtocol({ bodySite: 'toString', notes: '' }).bodySite, null)
})

// ------------------------------------------------------------------------------------------------------------------------------------------
// The open study: its place beside the camera, and regions not saved
// ------------------------------------------------------------------------------------------------------------------------------------------

test('opening or closing the camera keeps the open study in its one place (same area, same key), so nothing drawn on it is lost', () => {
  const alone = studyArea({ camera: false, study: true })
  const beside = studyArea({ camera: true, study: true })
  // The area is there in both layouts (its element is kept), and the study has the same key in both: React keeps the mounted study.
  assert.ok(alone && beside)
  assert.deepEqual(alone, { columns: false, slots: ['study'] })
  assert.deepEqual(beside, { columns: true, slots: ['camera', 'study'] })
  // Keys are unique within the area (one camera, one study).
  assert.equal(new Set(beside.slots).size, beside.slots.length)
})

test('the camera without a study holds the study’s place with a placeholder; with neither there is no area', () => {
  assert.deepEqual(studyArea({ camera: true, study: false }), { columns: true, slots: ['camera', 'waiting'] })
  assert.equal(studyArea({ camera: false, study: false }), null)
  // The placeholder never takes the study's key, so the first image captured mounts its study fresh.
  assert.ok(!studyArea({ camera: true, study: false })!.slots.includes('study'))
})

test('nothing unsaved: closing, opening another image or an upload goes ahead at once and nothing is asked', () => {
  const asked: boolean[] = []
  const g = discardGuard((a) => asked.push(a))
  let ran = 0
  g.guard(() => ran++)
  assert.equal(ran, 1)
  assert.deepEqual(asked, [])
  assert.equal(g.pending, null)
})

test('regions not saved: the action waits for the question; “Keep editing” drops it and keeps the regions; “Discard the regions” runs it', () => {
  const asked: boolean[] = []
  const g = discardGuard((a) => asked.push(a))
  let closed = 0
  g.dirty = true
  g.guard(() => closed++)
  assert.equal(closed, 0, 'nothing is discarded before the doctor answers')
  assert.deepEqual(asked, [true])
  g.keep()
  assert.equal(closed, 0)
  assert.equal(g.dirty, true, 'the regions are still unsaved')
  assert.equal(g.pending, null)
  assert.deepEqual(asked, [true, false])
  // Asked again (Escape a second time, the close button): this time discarded.
  g.guard(() => closed++)
  g.discard()
  assert.equal(closed, 1)
  assert.equal(g.dirty, false)
  assert.deepEqual(asked, [true, false, true, false])
  // Once discarded, nothing is unsaved: the next action goes ahead without a question.
  g.guard(() => closed++)
  assert.equal(closed, 2)
  assert.equal(asked.length, 4)
})

test('saving the regions (the viewer reports nothing unsaved) lets the study close without a question', () => {
  const asked: boolean[] = []
  const g = discardGuard((a) => asked.push(a))
  g.dirty = true
  g.dirty = false
  let closed = 0
  g.guard(() => closed++)
  assert.equal(closed, 1)
  assert.deepEqual(asked, [])
})
