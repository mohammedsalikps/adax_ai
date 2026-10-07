// Unit tests (node --test) of the DEMO / SEED prescription (lib/demoPrescription.ts, final demo polish): a fixed keyword table over what the
// consultation says, never AI, filling only an empty draft and keeping whatever the doctor wrote. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EMPTY_NOTE, signIssues } from '@adaxai/contracts'
import { applyDemoPrescription, type DemoContext, demoPrescriptionFor, prescriptionEmpty } from '../src/lib/demoPrescription.ts'
import type { Draft } from '../src/lib/draftSaver.ts'

const ctx = (o: Partial<DemoContext>): DemoContext => ({ chiefComplaint: '', reasonForVisit: null, history: '', assessment: '', transcript: [], ...o })
const empty: Draft = { note: { ...EMPTY_NOTE }, diagnoses: [], prescription: [] }

test('stomach pain → acute gastritis / dyspepsia, pantoprazole 40 mg once daily before food for 5 days, advice and follow-up', () => {
  assert.deepEqual(demoPrescriptionFor(ctx({ chiefComplaint: 'Stomach pain since yesterday' })), {
    case: 'stomach',
    diagnoses: [{ description: 'Acute gastritis / dyspepsia', kind: 'primary' }],
    prescription: [{ drugName: 'Pantoprazole', strength: '40 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Once daily (OD)', duration: '5 days', durationDays: 5, instructions: 'Before food' }],
    advice: 'Avoid heavy/spicy meals. Maintain hydration.',
    followUp: 'Review after 5 days or earlier if symptoms worsen.',
  })
  for (const text of ['Abdominal discomfort', 'epigastric burning', 'acidity after meals']) assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: text }))?.case, 'stomach', text)
})

test('fever and headache have their own drafts; the earliest mention wins, and the most trusted source speaks first', () => {
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Sore throat and fever' }))?.case, 'fever')
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Sore throat and fever' }))?.prescription[0]?.drugName, 'Paracetamol')
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Headache for two days' }))?.diagnoses[0]?.description, 'Tension-type headache')
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Stomach pain with mild fever' }))?.case, 'stomach')
  // The chief complaint before the conversation.
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Headache', transcript: ['I have had stomach pain'] }))?.case, 'headache')
  // The visit's reason or the conversation when the note says nothing yet.
  assert.equal(demoPrescriptionFor(ctx({ reasonForVisit: 'Abdominal pain' }))?.case, 'stomach')
  assert.equal(demoPrescriptionFor(ctx({ transcript: ['Doctor: what brings you in?', 'Patient: I have a fever since Monday.'] }))?.case, 'fever')
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'Knee pain after a fall' })), null)
})

test('every call gives its own copy: filling one draft never changes the next', () => {
  const a = demoPrescriptionFor(ctx({ chiefComplaint: 'stomach ache' }))!
  a.prescription[0]!.drugName = 'Changed'
  assert.equal(demoPrescriptionFor(ctx({ chiefComplaint: 'stomach ache' }))!.prescription[0]!.drugName, 'Pantoprazole')
})

const demo = demoPrescriptionFor(ctx({ chiefComplaint: 'Stomach pain' }))!

test('an empty prescription is filled completely enough to sign once reviewed, keeping what the doctor wrote', () => {
  const d = applyDemoPrescription({ ...empty, note: { ...EMPTY_NOTE, chiefComplaint: 'Stomach pain', plan: 'Doctor’s own advice' } }, demo, null)
  assert.deepEqual(d.diagnoses, demo.diagnoses)
  assert.deepEqual(d.prescription, demo.prescription)
  assert.equal(d.note.plan, 'Doctor’s own advice')
  assert.equal(d.note.followUp, demo.followUp)
  assert.deepEqual(signIssues(d), [])
})

test('the chief complaint comes from the visit’s reason only when the note has none', () => {
  assert.equal(applyDemoPrescription(empty, demo, 'Stomach pain').note.chiefComplaint, 'Stomach pain')
  assert.equal(applyDemoPrescription({ ...empty, note: { ...EMPTY_NOTE, chiefComplaint: 'Epigastric pain' } }, demo, 'Stomach pain').note.chiefComplaint, 'Epigastric pain')
})

test('a prescription the doctor has started is never touched', () => {
  const started: Draft = { ...empty, diagnoses: [{ description: 'Acute pharyngitis', kind: 'primary' }] }
  assert.equal(prescriptionEmpty(started), false)
  assert.equal(applyDemoPrescription(started, demo, null), started)
  const withMedicine: Draft = { ...empty, prescription: [{ drugName: 'Amoxicillin' }] }
  assert.equal(applyDemoPrescription(withMedicine, demo, null), withMedicine)
  // Blank rows are not a prescription.
  assert.equal(prescriptionEmpty({ ...empty, diagnoses: [{ description: ' ' }], prescription: [{ drugName: '' }] }), true)
})
