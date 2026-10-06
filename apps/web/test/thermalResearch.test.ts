// Unit tests (node --test) of the pediatric shock research view's pure logic (lib/thermalResearch.ts): which images of a consultation enter
// the feature set and why the others do not, the values shown for an image (as stored, "not stored" or "not recorded" where nothing was kept),
// pairs as "A minus B", the dataset evaluation's four numbers with a missing value shown as missing and never as the 0.0 the evaluation uses,
// each pipeline stage's status from the images and from what the code has, the exact age, the research consent, and the published research
// held as data (each figure attributed to its primary study, saying whether the review reports it). No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConsentSummary, ThermalCapture, ThermalModelStatus, ThermalRoi } from '@adaxai/contracts'
import {
  captureTitle,
  conditionsText,
  consultationCaptures,
  EXCLUSION_TEXT,
  evaluationInputs,
  evaluationMeasures,
  exactAge,
  imageFeatures,
  MODEL_NOT_AVAILABLE,
  MODEL_UNAVAILABLE,
  PRIMARY_STUDIES,
  PUBLISHED_LINE,
  PUBLISHED_REVIEW,
  researchConsent,
  researchFeatures,
  researchPipeline,
  type ResearchStage,
  type StageId,
} from '../src/lib/thermalResearch.ts'

const ENC = '00000000-0000-4000-8000-0000000000e1'
const OTHER_ENC = '00000000-0000-4000-8000-0000000000e2'
let seq = 0

function roi(label: string, over: Partial<ThermalRoi> = {}, stats: Partial<ThermalRoi['stats']> = {}): ThermalRoi {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    label,
    shape: 'rect',
    x: 1,
    y: 1,
    width: 4,
    height: 4,
    points: null,
    pairWith: null,
    note: null,
    stats: { pixelCount: 16, min: 30.1, max: 33.4, mean: 31.25, std: 0.5, ...stats },
    createdByName: 'Dr A',
    createdAt: '2026-10-06T04:00:00.000Z',
    ...over,
  }
}

function capture(over: Partial<ThermalCapture> = {}): ThermalCapture {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    patientId: '00000000-0000-4000-8000-0000000000a1',
    encounterId: ENC,
    status: 'approved',
    originalName: 'flir.jpg',
    width: 160,
    height: 120,
    minC: 28.123,
    maxC: 35.987,
    meanC: 32.5,
    camera: { make: 'FLIR', model: 'FLIR ONE', dateTime: null },
    parameters: { emissivity: 0.95, objectDistanceM: 1, reflectedTempC: 20, atmosphericTempC: 20, relativeHumidity: 0.5, irWindowTempC: null, irWindowTransmission: null },
    protocol: { bodyRegion: 'Left hand', bodySite: 'hand', view: 'other', roomTempC: null, acclimatisationMin: null, distanceM: null, notes: null },
    extractor: { name: 'flyr', version: '3.3.1' },
    rawFileId: '00000000-0000-4000-8000-0000000000f1',
    rawSha256: 'a'.repeat(64),
    matrixFileId: '00000000-0000-4000-8000-0000000000f2',
    visibleFileId: null,
    stdC: 1.234,
    captureSource: 'file_upload',
    simulated: false,
    capturedAt: null,
    device: null,
    deviceReported: null,
    rois: [],
    pairs: [],
    review: null,
    createdAt: '2026-10-06T04:00:00.000Z',
    createdByName: 'Dr A',
    dataOrigin: 'clinical',
    labels: [],
    ...over,
  }
}

const simulatedCapture = (over: Partial<ThermalCapture> = {}) => capture({ captureSource: 'simulator', simulated: true, dataOrigin: 'synthetic', ...over })
const NO_MODEL: ThermalModelStatus = { available: false, kind: null, modelId: null, version: null, artifactSha256: null, intendedUse: null, evaluation: null, reason: 'No trained thermal model is installed.' }
const byId = (stages: ResearchStage[]) => Object.fromEntries(stages.map((s) => [s.id, s])) as Record<StageId, ResearchStage>
const statuses = (stages: ResearchStage[]) => Object.fromEntries(stages.map((s) => [s.id, s.status]))
const allText = (stages: ResearchStage[]) => stages.flatMap((s) => [s.label, ...s.detail, ...s.parts.map((p) => p.text)]).join('\n')

test('the images of this consultation only, newest first by the camera’s time or else the time stored', () => {
  const old = capture({ createdAt: '2026-10-06T03:00:00.000Z' })
  const newer = capture({ createdAt: '2026-10-06T03:30:00.000Z' })
  const cameraTime = capture({ createdAt: '2026-10-06T02:00:00.000Z', capturedAt: '2026-10-06T05:00:00.000Z' })
  const otherVisit = capture({ encounterId: OTHER_ENC, createdAt: '2026-10-06T06:00:00.000Z' })
  const noVisit = capture({ encounterId: null })
  assert.deepEqual(
    consultationCaptures([old, otherVisit, newer, noVisit, cameraTime], ENC).map((c) => c.id),
    [cameraTime.id, newer.id, old.id],
  )
})

test('the feature set takes approved, non-simulated images; a simulator’s image is excluded as SIMULATED whatever its review, and drafts and rejected images are listed with why', () => {
  const approved = capture()
  const draft = capture({ status: 'draft' })
  const rejected = capture({ status: 'rejected' })
  const simApproved = simulatedCapture({ status: 'approved' })
  const simDraft = simulatedCapture({ status: 'draft' })
  // Either mark is enough: a capture whose source is the simulator is SIMULATED even if the flag were missing.
  const simBySource = capture({ captureSource: 'simulator', simulated: false })
  const f = researchFeatures([approved, draft, rejected, simApproved, simDraft, simBySource])
  assert.deepEqual(
    f.included.map((i) => i.capture.id),
    [approved.id],
  )
  assert.deepEqual(
    f.excluded.map((e) => [e.capture.id, e.reason, e.text]),
    [
      [draft.id, 'draft', 'awaiting approval, not in the feature set'],
      [rejected.id, 'rejected', 'rejected, not in the feature set'],
      [simApproved.id, 'simulated', 'SIMULATED, excluded'],
      [simDraft.id, 'simulated', 'SIMULATED, excluded'],
      [simBySource.id, 'simulated', 'SIMULATED, excluded'],
    ],
  )
  assert.equal(EXCLUSION_TEXT.simulated, 'SIMULATED, excluded')
})

test('an image’s values are the stored ones: min/max/mean/SD to 0.01 °C, SD "not stored" for an older image, size, emissivity and distance from the file, capture conditions or "not recorded"', () => {
  const f = imageFeatures(capture())
  assert.equal(f.title, 'Hand · Left hand')
  assert.deepEqual(f.whole, [
    { label: 'Min', value: '28.12 °C' },
    { label: 'Max', value: '35.99 °C' },
    { label: 'Mean', value: '32.50 °C' },
    { label: 'SD', value: '1.23 °C' },
  ])
  assert.equal(f.size, '160 × 120 px')
  assert.deepEqual([f.origin, f.clinical], ['Clinical', true])
  assert.deepEqual(
    [imageFeatures(capture({ dataOrigin: 'public_sample' })).origin, imageFeatures(capture({ dataOrigin: 'public_sample' })).clinical],
    ['Public sample file', false],
  )
  assert.equal(f.camera, 'Emissivity 0.95 · object distance 1 m (from the file)')
  assert.equal(f.conditions, 'Capture conditions not recorded')
  assert.equal(f.extractor, 'flyr 3.3.1')

  const older = imageFeatures(capture({ stdC: null }))
  assert.equal(older.whole.find((m) => m.label === 'SD')!.value, 'not stored')

  // The file gave neither emissivity nor distance: no camera line at all, rather than dashes.
  assert.equal(imageFeatures(capture({ parameters: { emissivity: null, objectDistanceM: null, reflectedTempC: null, atmosphericTempC: null, relativeHumidity: null, irWindowTempC: null, irWindowTransmission: null } })).camera, null)
  assert.equal(imageFeatures(capture({ parameters: { emissivity: null, objectDistanceM: 0.45, reflectedTempC: null, atmosphericTempC: null, relativeHumidity: null, irWindowTempC: null, irWindowTransmission: null } })).camera, 'object distance 0.45 m (from the file)')

  // Conditions: each one that was not recorded says so; all three missing is one phrase.
  assert.equal(conditionsText(capture({ protocol: { bodyRegion: 'Knee', view: 'anterior', roomTempC: 22, acclimatisationMin: 15, distanceM: 0.5 } })), 'Room 22.0 °C · acclimatisation 15 min · distance 0.5 m')
  assert.equal(conditionsText(capture({ protocol: { bodyRegion: 'Knee', view: 'anterior', roomTempC: 21.5 } })), 'Room 21.5 °C · acclimatisation not recorded · distance not recorded')
  assert.equal(captureTitle(capture({ protocol: { bodyRegion: 'Knee', view: 'anterior' } })), 'Knee')
  assert.equal(captureTitle(capture({ protocol: { bodyRegion: 'Hand', bodySite: 'hand', view: 'other' } })), 'Hand')
})

test('regions: label, shape, pixels and their stored statistics; a region with no pixel with a reading shows dashes', () => {
  const r1 = roi('Palm', { shape: 'ellipse' })
  const r2 = roi('Thumb', { shape: 'polygon', points: [[0, 0], [3, 0], [0, 3]] }, { pixelCount: 0, min: null, max: null, mean: null, std: null })
  const f = imageFeatures(capture({ rois: [r1, r2] }))
  assert.deepEqual(f.regions, [
    { id: r1.id, label: 'Palm', shape: 'Ellipse', pixels: '16 px', values: [{ label: 'Min', value: '30.10 °C' }, { label: 'Max', value: '33.40 °C' }, { label: 'Mean', value: '31.25 °C' }, { label: 'SD', value: '0.50 °C' }] },
    { id: r2.id, label: 'Thumb', shape: 'Polygon', pixels: 'no pixel with a reading', values: [{ label: 'Min', value: '—' }, { label: 'Max', value: '—' }, { label: 'Mean', value: '—' }, { label: 'SD', value: '—' }] },
  ])
})

test('pairs are the doctor’s, shown as "A minus B" with the stored differences and their sign; an image without a pair has none (shown "No pair")', () => {
  const f = imageFeatures(
    capture({
      pairs: [
        { a: 'Left hand', b: 'Right hand', meanDiff: -0.4249, maxDiff: 1.2 },
        { a: 'Palm', b: 'Wrist', meanDiff: 0, maxDiff: null },
      ],
    }),
  )
  assert.deepEqual(f.pairs, [
    { name: 'Left hand minus Right hand', meanDiff: '-0.42 °C', maxDiff: '+1.20 °C' },
    { name: 'Palm minus Wrist', meanDiff: '0.00 °C', maxDiff: '—' },
  ])
  assert.deepEqual(imageFeatures(capture()).pairs, [])
})

test('the evaluation’s four numbers: the largest absolute pair differences, the image SD and the largest region SD; where the evaluation silently uses 0.0, the value is missing, never a zero', () => {
  const c = capture({
    stdC: 1.5,
    rois: [roi('A', {}, { std: 0.3 }), roi('B', {}, { std: 0.9 }), roi('C', {}, { std: null })],
    pairs: [
      { a: 'A', b: 'B', meanDiff: -1.25, maxDiff: 0.5 },
      { a: 'C', b: 'B', meanDiff: 0.75, maxDiff: -2 },
    ],
  })
  assert.deepEqual(evaluationInputs(c), { maxAbsPairMeanDiffC: 1.25, maxAbsPairMaxDiffC: 2, imageStdC: 1.5, maxRoiStdC: 0.9 })
  assert.deepEqual(
    evaluationMeasures(c).map((m) => m.value),
    ['1.25 °C', '2.00 °C', '1.50 °C', '0.90 °C'],
  )

  // Nothing to take them from: evaluate.py would put 0.0 in each; here they are missing, in words.
  const bare = capture({ stdC: null })
  assert.deepEqual(evaluationInputs(bare), { maxAbsPairMeanDiffC: null, maxAbsPairMaxDiffC: null, imageStdC: null, maxRoiStdC: null })
  assert.deepEqual(
    evaluationMeasures(bare).map((m) => m.value),
    ['no pair', 'no pair', 'not stored', 'no region'],
  )
  // Pairs and regions that exist but carry no value are "no value", not "no pair".
  const empty = capture({ rois: [roi('A', {}, { std: null })], pairs: [{ a: 'A', b: 'B', meanDiff: null, maxDiff: null }] })
  assert.deepEqual(
    evaluationMeasures(empty).map((m) => m.value),
    ['no value', 'no value', '1.23 °C', 'no value'],
  )
  // A real zero is a value and is shown as one.
  const zero = capture({ pairs: [{ a: 'A', b: 'B', meanDiff: 0, maxDiff: -0 }] })
  assert.deepEqual(evaluationMeasures(zero).slice(0, 2).map((m) => m.value), ['0.00 °C', '0.00 °C'])
})

test('the pipeline before any image: acquisition and the stages after it wait for data, normalisation and everything from the model on are not built; in a browser, FLIR ONE not connected', () => {
  const stages = researchPipeline({ captures: [], bridge: false, model: NO_MODEL })
  assert.deepEqual(
    stages.map((s) => [s.n, s.id, s.label]),
    [
      [1, 'acquisition', 'Thermal acquisition'],
      [2, 'preprocessing', 'Preprocessing'],
      [3, 'quality', 'Temperature normalisation & quality checks'],
      [4, 'extraction', 'Feature extraction'],
      [5, 'feature-set', 'Feature set'],
      [6, 'model', 'Research ML model'],
      [7, 'output', 'Research output'],
      [8, 'review', 'Doctor/researcher review'],
    ],
  )
  assert.deepEqual(statuses(stages), { acquisition: 'depends', preprocessing: 'depends', quality: 'not_built', extraction: 'depends', 'feature-set': 'depends', model: 'not_built', output: 'not_built', review: 'not_built' })
  const s = byId(stages)
  assert.deepEqual(s.acquisition.detail, ['No radiometric image in this consultation yet.'])
  assert.ok(s.acquisition.parts.some((p) => p.status === 'not_built' && p.text.includes('FLIR ONE not connected')))
  assert.deepEqual(s.model.detail, [MODEL_UNAVAILABLE, MODEL_NOT_AVAILABLE])
  assert.equal(MODEL_UNAVAILABLE, 'Research model unavailable.')
  assert.equal(MODEL_NOT_AVAILABLE, 'Not currently available. Research pipeline ready for model integration.')
  assert.deepEqual(s.model.parts, [])
  assert.ok(s.quality.detail[0] === 'Temperature normalisation is not built.')
  // Capture conditions: the code fact, that only the upload form records them.
  assert.ok(s.quality.parts.some((p) => p.status === 'depends' && p.text.includes('recorded by the upload form only')))
})

test('with a camera bridge on the page, live capture waits for a FLIR ONE instead of being unavailable', () => {
  const s = byId(researchPipeline({ captures: [], bridge: true, model: NO_MODEL }))
  assert.ok(s.acquisition.parts.some((p) => p.status === 'depends' && p.text.startsWith('Live capture: the tablet app’s camera bridge is present')))
  assert.ok(!s.acquisition.parts.some((p) => p.text.includes('FLIR ONE not connected')))
})

test('with an approved image and a draft, the stages up to the feature set are built from the data, and the counts are the images’ own', () => {
  const a = capture({ rois: [roi('A'), roi('B')], pairs: [{ a: 'A', b: 'B', meanDiff: 0.2, maxDiff: 0.4 }], protocol: { bodyRegion: 'Hand', view: 'other', roomTempC: 22 } })
  const d = capture({ status: 'draft' })
  const sim = simulatedCapture()
  const stages = researchPipeline({ captures: [a, d, sim], bridge: false, model: NO_MODEL })
  assert.deepEqual(statuses(stages), { acquisition: 'built', preprocessing: 'built', quality: 'not_built', extraction: 'built', 'feature-set': 'built', model: 'not_built', output: 'not_built', review: 'not_built' })
  const s = byId(stages)
  assert.deepEqual(s.acquisition.detail, ['2 radiometric images in this consultation.', '1 simulated image in this consultation: SIMULATED, excluded.'])
  assert.deepEqual(s.preprocessing.detail, ['Raw values converted to °C with each file’s own calibration (flyr 3.3.1).'])
  assert.equal(s.quality.detail[1], 'The checks that do run: the radiometric check, and the doctor’s approval (1 approved, 1 awaiting, 0 rejected).')
  assert.ok(s.quality.parts.some((p) => p.text === 'Capture conditions (room temperature, acclimatisation, distance): recorded for 1 of 2 images'))
  assert.ok(s.extraction.parts.some((p) => p.status === 'built' && p.text === 'Region statistics: 2 regions drawn by the doctor'))
  assert.ok(s.extraction.parts.some((p) => p.status === 'built' && p.text === 'Pairs as A minus B: 1 pair'))
  assert.deepEqual(s['feature-set'].detail, ['1 approved image, below, with the values stored for it.'])
})

test('a simulator’s images alone build nothing: acquisition and the feature set still wait for a real image', () => {
  const s = byId(researchPipeline({ captures: [simulatedCapture(), simulatedCapture({ status: 'draft' })], bridge: false, model: NO_MODEL }))
  assert.equal(s.acquisition.status, 'depends')
  assert.equal(s['feature-set'].status, 'depends')
  assert.deepEqual(s.acquisition.detail, ['No radiometric image in this consultation yet.', '2 simulated images in this consultation: SIMULATED, excluded.'])
  assert.deepEqual(s['feature-set'].detail, ['No approved, non-simulated image in this consultation.'])
})

test('drafts only: the feature set waits for the doctor’s approval and says how many wait', () => {
  const s = byId(researchPipeline({ captures: [capture({ status: 'draft' }), capture({ status: 'draft' })], bridge: false, model: NO_MODEL }))
  assert.equal(s.acquisition.status, 'built')
  assert.equal(s['feature-set'].status, 'depends')
  assert.deepEqual(s['feature-set'].detail, ['No approved image yet: 2 images awaiting approval.'])
})

test('images that could not be read: the data stages wait and say so, rather than claiming there are none', () => {
  const s = byId(researchPipeline({ captures: null, bridge: false, model: null }))
  assert.equal(s.acquisition.status, 'depends')
  assert.equal(s.acquisition.detail[0], 'The thermal images of this consultation could not be read just now.')
  assert.equal(s['feature-set'].detail[0], 'The thermal images of this consultation could not be read just now.')
  // The model status not known yet: the stage still says there is no research model.
  assert.deepEqual(s.model.detail, [MODEL_UNAVAILABLE, MODEL_NOT_AVAILABLE])
})

test('if the server ever reports an installed thermal model, the research model stage is still not built and runs nothing; no output is claimed', () => {
  const installed: ThermalModelStatus = { ...NO_MODEL, available: true, kind: 'research', modelId: 'm', version: '1', reason: null }
  const s = byId(researchPipeline({ captures: [capture()], bridge: false, model: installed }))
  assert.equal(s.model.status, 'not_built')
  assert.ok(!s.model.detail.includes(MODEL_UNAVAILABLE))
  assert.equal(s.model.detail[0], 'No research model is integrated with this pipeline.')
  assert.equal(s.output.status, 'not_built')
})

test('no stage or feature text rates anything: no score, threshold, probability, prediction or "gradient" wording, and no published metric', () => {
  const a = capture({ rois: [roi('A'), roi('B')], pairs: [{ a: 'A', b: 'B', meanDiff: 0.2, maxDiff: 0.4 }] })
  const texts = [
    allText(researchPipeline({ captures: [], bridge: false, model: NO_MODEL })),
    allText(researchPipeline({ captures: [a, capture({ status: 'draft' }), simulatedCapture()], bridge: true, model: NO_MODEL })),
    allText(researchPipeline({ captures: null, bridge: false, model: { ...NO_MODEL, available: true } })),
    JSON.stringify(researchFeatures([a, capture({ status: 'draft' }), simulatedCapture()]).included.map((i) => i.features)),
    Object.values(EXCLUSION_TEXT).join('\n'),
  ].join('\n')
  for (const word of [/score/i, /threshold/i, /probab/i, /gradient/i, /predict/i, /\bAUC\b/, /AUROC/, /AUPRC/, /\bshock (likely|risk|detected)/i, /%/]) assert.doesNotMatch(texts, word)
})

test('the exact age from the date of birth: years and months for a child, years for an adult; nothing classed by it', () => {
  const today = new Date(2026, 9, 6)
  assert.equal(exactAge('2023-06-15', today), '3 years 3 months')
  assert.equal(exactAge('2023-06-06', today), '3 years 4 months')
  assert.equal(exactAge('2025-10-06', today), '1 year')
  assert.equal(exactAge('2026-03-01', today), '7 months')
  assert.equal(exactAge('2026-09-20', today), 'under 1 month')
  assert.equal(exactAge('2008-10-07', today), '17 years 11 months')
  assert.equal(exactAge('2008-10-06', today), '18 years')
  assert.equal(exactAge('1990-01-01', today), '36 years')
  assert.equal(exactAge('2027-01-01', today), null)
  assert.equal(exactAge('not a date', today), null)
})

test('the research consent in the record’s words; "Not read" when the record is not loaded here', () => {
  const states: ConsentSummary[] = [
    { type: 'thermal_imaging', state: 'granted', consentId: null },
    { type: 'research_use', state: 'withdrawn', consentId: null },
  ]
  assert.equal(researchConsent(states), 'Withdrawn')
  assert.equal(researchConsent([{ type: 'research_use', state: 'outdated', consentId: null }]), 'Granted (earlier wording)')
  assert.equal(researchConsent([{ type: 'thermal_imaging', state: 'granted', consentId: null }]), 'Not recorded')
  assert.equal(researchConsent(undefined), 'Not read')
})

test('published research: the verified fields of the review, and every figure attributed to its primary study with whether the review reports it', () => {
  assert.equal(PUBLISHED_REVIEW.title, 'Thermal Imaging Applications in Shock Detection: Technological Advancements and Clinical Implications')
  assert.deepEqual(PUBLISHED_REVIEW.authors, ['Manu Sudhi', 'Dasharathraj K. Shetty', 'Jayaraj Mymbilly Balakrishnan', 'Deekshith R Prabhu', 'Ritesh Kamath', 'S. Girisha'])
  assert.equal(`${PUBLISHED_REVIEW.journal} ${PUBLISHED_REVIEW.year} ${PUBLISHED_REVIEW.volume} ${PUBLISHED_REVIEW.article}`, 'Engineered Science 2025 33 1367')
  assert.equal(PUBLISHED_REVIEW.url, 'https://doi.org/10.30919/es1367')
  assert.equal(PUBLISHED_REVIEW.type, 'Review article')
  assert.equal(PUBLISHED_REVIEW.licence, 'CC BY 4.0')
  assert.ok(PUBLISHED_REVIEW.gaps.some((g) => g.startsWith('No established temperature profiles for any type of shock')))
  assert.match(PUBLISHED_LINE, /ADAXAI implements no method from it; the figures here are other studies’ published results, not ADAXAI’s\./)
  // The review's own summaries cite no figure: the numbers live only with the primary studies.
  assert.doesNotMatch([PUBLISHED_REVIEW.objective, ...PUBLISHED_REVIEW.approaches, ...PUBLISHED_REVIEW.limitations, ...PUBLISHED_REVIEW.gaps].join(' '), /AUC|AUROC|\b0\.\d\d\b/)

  const [nagori, vats] = PRIMARY_STUDIES
  assert.equal(nagori!.doi, '10.1038/s41598-018-36586-8')
  assert.deepEqual(
    nagori!.figures.map((f) => [f.when.split(' ')[0], f.values, f.basis]),
    [
      ['0', 'AUROC 0.75', 'primary_and_review'],
      ['3', 'AUROC 0.77', 'primary_and_review'],
      ['6', 'AUROC 0.68', 'primary_only'],
      ['12', 'AUROC 0.69', 'primary_and_review'],
    ],
  )
  assert.equal(vats!.doi, '10.3389/fphys.2022.862411')
  assert.equal(vats!.figures.length, 7)
  // The review's 0.81 / 0.78 is the 5 h result, the only one it reports.
  assert.deepEqual(
    vats!.figures.filter((f) => f.basis === 'primary_and_review').map((f) => [f.when, f.values]),
    [['5 h ahead', 'AUROC 0.81 · AUPRC 0.78']],
  )
  assert.equal(vats!.figures.at(-1)!.values, 'AUROC 0.73 · AUPRC 0.66')
  // Vats is never called prospective (the paper does not say so).
  assert.doesNotMatch(vats!.design, /prospective/i)
})
