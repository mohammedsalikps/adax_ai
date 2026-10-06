// Unit tests (node --test) of the patient record's compact lines (the consultation's "Patient history" panel and the doctor's patient page
// Summary) and of the Documents tab's grouping: what each line says, that missing is never said as none, that a result is never shown as
// normal unless it was compared, and how documents are grouped and ordered. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Investigation, Observation, PatientDocument, PatientHistory } from '@adaxai/contracts'
import {
  allergyChip,
  documentDate,
  documentInlineSrc,
  documentMeta,
  fileSize,
  groupDocuments,
  imagingTitle,
  localDay,
  NOT_AVAILABLE,
  NOT_RECORDED,
  procedureWhen,
  recentImaging,
  recentResults,
  recordLines,
  shortDate,
  vitalsText,
} from '../src/lib/patientRecord.ts'

// The facility's clock (India, UTC+05:30) for every date read from an instant, so these tests do not depend on the machine's timezone.
process.env.TZ = 'Asia/Kolkata'

const TODAY = '2026-10-06'
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function history(over: Partial<PatientHistory> = {}): PatientHistory {
  return {
    patientId: ID(1),
    generatedAt: '2026-10-06T09:00:00.000Z',
    noKnownAllergies: false,
    allergies: [],
    conditions: [],
    medications: [],
    investigations: [],
    consultations: [],
    latestVitals: [],
    more: { consultations: 0, investigations: 0 },
    procedures: [],
    documents: { total: 0, byCategory: { lab_report: 0, imaging_report: 0, imaging_image: 0, other: 0 }, latest: [] },
    ...over,
  }
}

const entry = { enteredByName: 'Dr. A', enteredAt: '2026-01-01T00:00:00.000Z', dataOrigin: 'synthetic' as const }

function result(testName: string, valueText: string, flag: Investigation['flag'], collectedOn: string, unit: string | null = null): Investigation {
  return { id: ID(Math.floor(Math.random() * 1e9)), testName, valueText, valueNumber: null, unit, refLow: null, refHigh: null, refText: null, flag, collectedOn, resultedOn: null, status: 'final', note: null, ...entry }
}

function doc(n: number, over: Partial<PatientDocument>): PatientDocument {
  return {
    id: ID(n),
    patientId: ID(1),
    encounterId: null,
    category: 'lab_report',
    modality: null,
    title: `Document ${n}`,
    studyDate: null,
    reportText: null,
    fileId: ID(100 + n),
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    originalName: 'x.pdf',
    status: 'recorded',
    statusReason: null,
    uploadedByName: 'Test',
    createdAt: '2026-10-01T10:00:00.000Z',
    dataOrigin: 'synthetic',
    ...over,
  }
}

const byKey = (h: PatientHistory, opts?: { vitals?: boolean }) => Object.fromEntries(recordLines(h, TODAY, opts).map((l) => [l.key, l]))

test('dates read as "04 Oct" this year and with the year otherwise; a surgery says its year, month and year, or that the date is not recorded', () => {
  assert.equal(shortDate('2026-10-04', TODAY), '04 Oct')
  assert.equal(shortDate('2025-09-21T10:00:00.000Z', TODAY), '21 Sep 2025')
  assert.equal(procedureWhen({ performedYear: 2022, performedMonth: null }), '2022')
  assert.equal(procedureWhen({ performedYear: 2019, performedMonth: 3 }), 'Mar 2019')
  assert.equal(procedureWhen({ performedYear: null, performedMonth: null }), 'date not recorded')
})

test('the lines are in the design order, and a record with nothing in it says "Not recorded" (never none, 0 or a dash), with the allergy status as a warning', () => {
  const lines = recordLines(history(), TODAY)
  assert.deepEqual(
    lines.map((l) => l.label),
    ['Allergies', 'Conditions', 'Surgeries', 'Medicines', 'Recent results', 'Recent imaging', 'Last consultation'],
  )
  const k = byKey(history())
  assert.deepEqual([k.allergies!.text, k.allergies!.tone, k.allergies!.missing], ['Allergy status not recorded', 'warn', true])
  for (const key of ['conditions', 'surgeries', 'medicines', 'results', 'imaging', 'lastConsultation']) {
    assert.equal(k[key]!.text, NOT_RECORDED, key)
    assert.equal(k[key]!.missing, true, key)
  }
  for (const l of lines) assert.doesNotMatch(l.text, /^(none|0|—|-)$/i, l.key)
})

test('surgeries and imaging the server did not send (an older server) are "Not available yet", not "Not recorded"', () => {
  const k = byKey(history({ procedures: undefined, documents: undefined }))
  assert.equal(k.surgeries!.text, NOT_AVAILABLE)
  assert.equal(k.imaging!.text, NOT_AVAILABLE)
  // The results line still works from the typed results alone.
  const withResult = byKey(history({ documents: undefined, investigations: [result('HbA1c', '7.2', 'high', '2026-10-04', '%')] }))
  assert.equal(withResult.results!.text, 'HbA1c 7.2 % (high) — 04 Oct')
})

test('a filled record: allergies with severity (severe in red), conditions, surgeries with their dates, current medicines, the last consultation', () => {
  const h = history({
    noKnownAllergies: false,
    allergies: [
      { id: ID(2), substance: 'Penicillin', reaction: 'Rash', severity: 'severe', status: 'active', recordedAt: '2026-01-01T00:00:00.000Z', recordedByName: null },
      { id: ID(3), substance: 'Sulfa', reaction: null, severity: 'unknown', status: 'active', recordedAt: '2026-01-01T00:00:00.000Z', recordedByName: null },
    ],
    conditions: [
      { id: ID(4), name: 'Type 2 diabetes', code: null, sinceYear: 2019, sinceMonth: 3, status: 'controlled', note: null, ...entry },
      { id: ID(5), name: 'Old fracture', code: null, sinceYear: 2001, sinceMonth: null, status: 'resolved', note: null, ...entry },
    ],
    procedures: [
      { id: ID(6), name: 'Appendectomy', performedYear: 2022, performedMonth: null, status: 'recorded', note: null, ...entry },
      { id: ID(7), name: 'Tonsillectomy', performedYear: null, performedMonth: null, status: 'recorded', note: null, ...entry },
    ],
    medications: [
      { id: ID(8), drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1', route: 'Oral', frequency: 'BD', startedOn: null, stoppedOn: null, status: 'current', reason: null, statusReason: null, ...entry },
      { id: ID(9), drugName: 'Glimepiride', strength: '1 mg', form: null, dose: '1', route: null, frequency: 'OD', startedOn: null, stoppedOn: '2026-01-01', status: 'stopped', reason: null, statusReason: 'Hypos', ...entry },
    ],
    consultations: [{ encounterId: ID(10), visitId: ID(11), date: '2026-09-12', signedAt: '2026-09-12T10:00:00.000Z', doctorName: 'Dr. Meera Iyer (synthetic)', departmentName: 'General', chiefComplaint: 'Diabetes review', diagnoses: [], prescription: [], amendmentCount: 0 }],
  })
  const k = byKey(h)
  assert.deepEqual([k.allergies!.text, k.allergies!.tone], ['Penicillin (severe), Sulfa (severity not recorded)', 'down'])
  assert.equal(k.conditions!.text, 'Type 2 diabetes')
  assert.equal(k.surgeries!.text, 'Appendectomy — 2022, Tonsillectomy — date not recorded')
  assert.equal(k.medicines!.text, 'Metformin 500 mg')
  assert.equal(k.lastConsultation!.text, '12 Sep · Dr. Meera Iyer · Diabetes review')
  assert.equal(byKey(history({ noKnownAllergies: true })).allergies!.text, 'No known allergies (recorded)')
  // More than three names: the rest are counted, never dropped silently.
  const many = history({ conditions: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: ID(20 + i), name, code: null, sinceYear: 2020, sinceMonth: null, status: 'active' as const, note: null, ...entry })) })
  assert.equal(byKey(many).conditions!.text, 'A, B, C +2')
})

test('recent results: the newest of each test with its value, a flag in words when it is not normal, "not compared with a range" never read as normal, lab reports beside them, newest first', () => {
  const h = history({
    investigations: [
      result('CRP', '12', 'unknown', '2026-10-05', 'mg/L'),
      result('HbA1c', '7.2', 'high', '2026-10-04', '%'),
      result('HbA1c', '6.1', 'normal', '2026-06-01', '%'),
      result('Haemoglobin', '13.1', 'normal', '2026-09-01', 'g/dL'),
    ],
    documents: { total: 1, byCategory: { lab_report: 1, imaging_report: 0, imaging_image: 0, other: 0 }, latest: [{ id: ID(30), title: 'CBC', category: 'lab_report', modality: null, studyDate: '2026-10-04', createdAt: '2026-10-04T12:00:00.000Z', hasReportText: false }] },
  })
  const items = recentResults(h, TODAY, 5)
  assert.deepEqual(
    items.map((i) => i.text),
    ['CRP 12 mg/L (not compared with a range) — 05 Oct', 'CBC — 04 Oct', 'HbA1c 7.2 % (high) — 04 Oct', 'Haemoglobin 13.1 g/dL — 01 Sep'],
  )
  // The old normal HbA1c is not today's picture of the test.
  assert.ok(!items.some((i) => i.text.includes('6.1')))
  // The line names three.
  assert.equal(byKey(h).results!.text, 'CRP 12 mg/L (not compared with a range) — 05 Oct, CBC — 04 Oct, HbA1c 7.2 % (high) — 04 Oct')
})

test('recent imaging: "MRI brain — 21 Sep" from the documents line (the modality before the title unless the title says it); older ones only counted', () => {
  assert.equal(imagingTitle({ title: 'brain', modality: 'mri' }), 'MRI brain')
  assert.equal(imagingTitle({ title: 'MRI lumbar spine', modality: 'mri' }), 'MRI lumbar spine')
  assert.equal(imagingTitle({ title: 'Chest', modality: 'xray' }), 'X-ray Chest')
  assert.equal(imagingTitle({ title: 'Scan', modality: null }), 'Scan')
  const latest = [
    { id: ID(40), title: 'brain', category: 'imaging_report' as const, modality: 'mri' as const, studyDate: '2026-09-21', createdAt: '2026-09-22T00:00:00.000Z', hasReportText: true },
    { id: ID(41), title: 'CBC', category: 'lab_report' as const, modality: null, studyDate: '2026-10-04', createdAt: '2026-10-04T00:00:00.000Z', hasReportText: false },
  ]
  assert.equal(recentImaging({ documents: { total: 3, byCategory: { lab_report: 1, imaging_report: 2, imaging_image: 0, other: 0 }, latest } }, TODAY), 'MRI brain — 21 Sep +1')
  assert.equal(recentImaging({ documents: { total: 6, byCategory: { lab_report: 5, imaging_report: 0, imaging_image: 1, other: 0 }, latest: [latest[1]!] } }, TODAY), '1 imaging document on the record')
  assert.equal(recentImaging({ documents: { total: 0, byCategory: { lab_report: 0, imaging_report: 0, imaging_image: 0, other: 0 }, latest: [] } }, TODAY), null)
})

const o = (kind: Observation['kind'], value: number, measuredAt: string, validationStatus: Observation['validationStatus'] = 'manual_entry'): Observation => ({
  id: ID(Math.floor(Math.random() * 1e9)),
  kind,
  value,
  unit: '',
  flag: null,
  measuredAt,
  source: validationStatus === 'manual_entry' ? 'manual' : 'device',
  validationStatus,
  deviceLabel: null,
  recordedByName: null,
  visitId: null,
  enteredInError: false,
})

test('last vitals: the latest staff values in the design order with the date of the newest; a device value is marked; a simulator never appears; none is "Not recorded"', () => {
  const vitals = [o('temperature', 38.6, '2026-10-04T09:00:00.000Z'), o('heart_rate', 124, '2026-10-04T09:05:00.000Z'), o('systolic_bp', 118, '2026-10-04T09:00:00.000Z'), o('diastolic_bp', 76, '2026-10-04T09:00:00.000Z'), o('spo2', 96, '2026-10-04T09:01:00.000Z', 'device_unverified'), o('respiratory_rate', 40, '2026-10-05T09:00:00.000Z', 'simulated')]
  assert.equal(vitalsText(vitals, TODAY), 'HR 124 · BP 118/76 · SpO₂ 96% (device, unverified) · Temp 38.6°C — 04 Oct')
  assert.equal(vitalsText([o('systolic_bp', 130, '2026-10-04T09:00:00.000Z')], TODAY), 'SBP 130 — 04 Oct')
  assert.equal(byKey(history(), { vitals: true }).lastVitals!.text, NOT_RECORDED)
})

test('last vitals from different days: each value measured before the newest day carries its own date, so an old fever never reads as current', () => {
  // HR today, a temperature of 38.6 from last year: the line's date is today's, and the fever says when it was.
  const mixed = [o('heart_rate', 82, '2026-10-06T04:00:00.000Z'), o('temperature', 38.6, '2025-03-12T06:00:00.000Z'), o('spo2', 97, '2026-09-01T06:00:00.000Z', 'device_unverified')]
  assert.equal(vitalsText(mixed, TODAY), 'HR 82 · SpO₂ 97% (device, unverified, 01 Sep) · Temp 38.6°C (12 Mar 2025) — 06 Oct')
  assert.equal(byKey(history({ latestVitals: mixed }), { vitals: true }).lastVitals!.text, 'HR 82 · SpO₂ 97% (device, unverified, 01 Sep) · Temp 38.6°C (12 Mar 2025) — 06 Oct')
  // A pressure pairs its halves only when measured on the same day; otherwise each half is said as what it is, with its own date.
  assert.equal(vitalsText([o('systolic_bp', 130, '2026-10-06T04:00:00.000Z'), o('diastolic_bp', 70, '2026-08-01T04:00:00.000Z')], TODAY), 'SBP 130 · DBP 70 (01 Aug) — 06 Oct')
  assert.equal(vitalsText([o('systolic_bp', 130, '2026-10-06T04:00:00.000Z'), o('diastolic_bp', 70, '2026-10-06T04:02:00.000Z', 'device_unverified')], TODAY), 'BP 130/70 (device, unverified) — 06 Oct')
})

test('a day is read on the facility clock, never the UTC day an instant starts with: 01:30 in India on 06 Oct is 06 Oct', () => {
  assert.equal(localDay('2026-10-05T20:00:00.000Z'), '2026-10-06')
  assert.equal(localDay('2026-10-05'), '2026-10-05')
  assert.equal(shortDate('2026-10-05T20:00:00.000Z', TODAY), '06 Oct')
  // HR at 01:30 and BP at 09:30 the same local morning (different UTC days) are one day: no per-value date, the line says 06 Oct.
  const morning = [o('heart_rate', 90, '2026-10-05T20:00:00.000Z'), o('systolic_bp', 120, '2026-10-06T04:00:00.000Z'), o('diastolic_bp', 80, '2026-10-06T04:00:00.000Z')]
  assert.equal(vitalsText(morning, TODAY), 'HR 90 · BP 120/80 — 06 Oct')
  // A document added at 02:00 in India, with no study date, is about that day.
  assert.equal(documentDate({ studyDate: null, createdAt: '2026-10-03T20:30:00.000Z' }), '2026-10-04')
  assert.equal(documentDate({ studyDate: '2026-09-21', createdAt: '2026-10-03T20:30:00.000Z' }), '2026-09-21')
})

test('documents are grouped Lab reports · Imaging · Other (empty groups kept), each newest first by the study date, else the day added', () => {
  const docs = [
    doc(1, { category: 'lab_report', title: 'CBC', studyDate: '2026-10-04' }),
    doc(2, { category: 'imaging_image', modality: 'xray', title: 'Chest', studyDate: null, createdAt: '2026-09-30T10:00:00.000Z', mimeType: 'image/jpeg' }),
    doc(3, { category: 'imaging_report', modality: 'mri', title: 'Brain', studyDate: '2026-09-21', createdAt: '2026-10-05T10:00:00.000Z' }),
    doc(4, { category: 'lab_report', title: 'Lipids', studyDate: '2026-08-01' }),
  ]
  const groups = groupDocuments(docs)
  assert.deepEqual(
    groups.map((g) => [g.label, g.documents.map((d) => d.title)]),
    [
      ['Lab reports', ['CBC', 'Lipids']],
      ['Imaging', ['Chest', 'Brain']],
      ['Other', []],
    ],
  )
  assert.equal(documentMeta(docs[2]!, TODAY), 'Imaging report · MRI · Study 21 Sep · PDF · 2 KB')
  assert.equal(documentMeta(docs[1]!, TODAY), 'Imaging image · X-ray · Study date not recorded · JPEG · 2 KB')
  assert.equal(fileSize(1_258_291), '1.2 MB')
})

test('the documents list reads no file until the doctor opens an image: no thumbnail of the original; a PDF never shows in place', () => {
  const jpeg = doc(5, { category: 'imaging_image', mimeType: 'image/jpeg' })
  const png = doc(6, { category: 'other', mimeType: 'image/png' })
  const pdf = doc(7, { mimeType: 'application/pdf' })
  for (const d of [jpeg, png, pdf]) assert.equal(documentInlineSrc(d, false), null, d.mimeType)
  assert.equal(documentInlineSrc(jpeg, true), `/api/files/${jpeg.fileId}`)
  assert.equal(documentInlineSrc(png, true), `/api/files/${png.fileId}`)
  assert.equal(documentInlineSrc(pdf, true), null)
})

test('the patients list shows an allergy chip only when an allergy is listed (the first, and how many more); none listed is no chip, never "none"', () => {
  assert.equal(allergyChip(['Penicillin']), 'Penicillin')
  assert.equal(allergyChip(['Penicillin', 'Sulfa', 'Latex']), 'Penicillin +2')
  assert.equal(allergyChip([]), null)
  assert.equal(allergyChip(undefined), null)
})
