// Unit tests (node --test) of the global Mana's pure rules (lib/manaGlobal.ts): which conversation a page opens, which one-tap questions it offers
// (those answered by fixed rules also while the model is down), how a spoken question is recorded and uploaded, which voices may read an answer aloud
// (only voices on this computer) and what is read, and how a proposed medicine is shown and becomes a draft row. No browser, no server.
import { MANA_RULES_QUESTIONS, type ManaActionProposal, type ManaMessage } from '@adaxai/contracts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  manaChips,
  manaScopeForPath,
  microphoneProblem,
  NO_DRAFT_OPEN,
  NO_LOCAL_VOICE,
  pickLocalVoice,
  pickRecorderType,
  proposalLines,
  RECORDER_TYPES,
  scopeKey,
  speakableText,
  suggestionFor,
  toPrescriptionItem,
  uploadType,
  VOICE_LIMIT_MS,
  voiceClock,
  withNames,
} from '../src/lib/manaGlobal.ts'

const E = '3f0c6c4e-8a52-4a8e-9d3a-6a1b2c3d4e5f'
const P = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

test('the route decides what Mana is about: the consultation (and its prescription page), the doctor’s patient page, or the clinic', () => {
  assert.deepEqual(manaScopeForPath(`/doctor/encounters/${E}`), { encounterId: E })
  assert.deepEqual(manaScopeForPath(`/doctor/encounters/${E}/prescription`), { encounterId: E })
  assert.deepEqual(manaScopeForPath(`/doctor/encounters/${E.toUpperCase()}/`), { encounterId: E })
  assert.deepEqual(manaScopeForPath(`/doctor/patients/${P}`), { patientId: P })
  for (const path of ['/doctor', '/doctor/queue', '/doctor/patients', '/doctor/thermal', `/doctor/thermal/${E}`, `/doctor/encounters/${E}/print`, `/print/encounters/${E}`, '/doctor/encounters/not-an-id', `/nurse/patients/${P}`]) {
    assert.deepEqual(manaScopeForPath(path), {}, path)
  }
  assert.equal(scopeKey({ encounterId: E }), `encounter:${E}`)
  assert.equal(scopeKey({ patientId: P }), `patient:${P}`)
  assert.equal(scopeKey({}), 'clinic')
})

test('the one-tap questions follow the design’s order, the patient’s questions only about a patient, and every one is answered by fixed rules', () => {
  assert.deepEqual(
    manaChips({ hasPatient: true, modelAvailable: true }).map((c) => c.label),
    ['Next patient', 'Seen today', 'Waiting longest', 'Allergies', 'Nurse triage', 'Lab / orders status', 'Summarize history', 'Recent lab reports'],
  )
  assert.deepEqual(
    manaChips({ hasPatient: true, modelAvailable: true, inConsultation: true }).map((c) => c.label),
    ['Next patient', 'Seen today', 'Waiting longest', 'Allergies', 'Nurse triage', 'Lab / orders status', 'Summarize history', 'Recent lab reports', 'Today’s consultation'],
  )
  assert.deepEqual(
    manaChips({ hasPatient: false, modelAvailable: true }).map((c) => c.label),
    ['Next patient', 'Seen today', 'Waiting longest', 'Lab / orders status'],
  )
  // Jury polish: "Summarize history" is answered from the record by fixed rules (no longer the model's brief), so the model's state does not
  // change what is offered, and no chip is a model suggestion.
  for (const o of [{ hasPatient: true, modelAvailable: true, inConsultation: true }, { hasPatient: true, modelAvailable: false }, { hasPatient: false, modelAvailable: false }]) {
    assert.ok(manaChips(o).every((c) => c.rules && !('suggestion' in c)), 'every chip is answered by fixed rules')
  }
  assert.deepEqual(manaChips({ hasPatient: true, modelAvailable: false }), manaChips({ hasPatient: true, modelAvailable: true }))
  const history = manaChips({ hasPatient: true, modelAvailable: true }).find((c) => c.label === 'Summarize history')!
  assert.deepEqual(history, { key: 'history_summary', label: 'Summarize history', text: 'Summarize this patient’s previous history.', rules: true })
  assert.equal(manaChips({ hasPatient: false, modelAvailable: false })[0]!.text, MANA_RULES_QUESTIONS.next_patient.text)
})

test('a question asked from elsewhere that is a suggestion’s exact words is asked as that suggestion, where it is offered', () => {
  assert.equal(suggestionFor('Brief me on this patient', { hasPatient: true, inConsultation: false }), 'brief_current')
  assert.equal(suggestionFor('  What still needs my review?  ', { hasPatient: true, inConsultation: true }), 'consultation_review')
  assert.equal(suggestionFor('What still needs my review?', { hasPatient: true, inConsultation: false }), undefined)
  assert.equal(suggestionFor('Brief me on this patient', { hasPatient: false, inConsultation: false }), undefined)
  assert.equal(suggestionFor('Who is my next patient?', { hasPatient: false, inConsultation: false }), undefined)
})

test('a spoken question: the first type the browser records, uploaded as the server accepts it, stopped at 30 seconds, failures said plainly', () => {
  assert.equal(pickRecorderType((t) => t === 'audio/ogg'), 'audio/ogg')
  assert.equal(pickRecorderType(() => true), RECORDER_TYPES[0])
  assert.equal(pickRecorderType(() => false), null)
  assert.equal(
    pickRecorderType(() => {
      throw new Error('unsupported')
    }),
    null,
  )
  assert.deepEqual(uploadType('audio/webm;codecs=opus'), { type: 'audio/webm', name: 'mana-question.webm' })
  assert.deepEqual(uploadType('audio/mp4'), { type: 'audio/mp4', name: 'mana-question.m4a' })
  assert.deepEqual(uploadType('audio/ogg; codecs=opus'), { type: 'audio/ogg', name: 'mana-question.ogg' })
  assert.deepEqual(uploadType(''), { type: 'audio/webm', name: 'mana-question.webm' })
  assert.equal(VOICE_LIMIT_MS, 30_000)
  assert.equal(voiceClock(7_400), '0:07 / 0:30')
  assert.equal(voiceClock(95_000), '0:30 / 0:30')
  assert.match(microphoneProblem('NotAllowedError'), /blocked/)
  assert.match(microphoneProblem('NotFoundError'), /No microphone/)
  assert.match(microphoneProblem('NotSupportedError'), /cannot record/)
  assert.match(microphoneProblem(null), /Type the question/)
})

test('only a voice on this computer may read answers aloud; a network voice never does, even when it is the default', () => {
  const google = { name: 'Google UK English Female', lang: 'en-GB', localService: false, default: true }
  const edge = { name: 'Microsoft Sonia Online (Natural) - English', lang: 'en-GB', localService: false }
  const hindi = { name: 'Microsoft Kalpana', lang: 'hi-IN', localService: true }
  const zira = { name: 'Microsoft Zira', lang: 'en-US', localService: true }
  assert.equal(pickLocalVoice([google, edge]), null)
  assert.equal(pickLocalVoice([google, edge, hindi, zira]), zira)
  assert.equal(pickLocalVoice([google, hindi]), hindi)
  assert.equal(pickLocalVoice([]), null)
  assert.equal(NO_LOCAL_VOICE, 'No voice on this computer')
})

const answer = (over: Partial<NonNullable<ManaMessage['answer']>> = {}): NonNullable<ManaMessage['answer']> => ({
  outcome: 'answered',
  notice: null,
  subjects: [],
  blocks: [{ text: 'Your next patient is P2: ready for you since 10:42 am.', refs: ['S1'], flags: [] }],
  findings: [],
  sources: [{ ref: 'S1', kind: 'operational', label: 'Queue', text: 'P2 (female, 20-29 years), token 4: ready.', patient: 'P2', items: [], cited: true }],
  candidates: [],
  entities: [{ alias: 'P2', displayName: 'Anita Das', mrn: 'ADX-000002', ageSex: '29 y · Female', lastVisit: null }],
  removed: 0,
  ...over,
})

test('what is read aloud: the verified statements with names, or the fixed notice; never the records behind them', () => {
  assert.equal(withNames('P2 then P3', [{ alias: 'P2', displayName: 'Anita Das' }]), 'Anita Das then P3')
  assert.equal(speakableText({ status: 'ready', answer: answer() }), 'Your next patient is Anita Das: ready for you since 10:42 am.')
  // The source's own words ("token 4", "20-29 years") are not read.
  assert.doesNotMatch(speakableText({ status: 'ready', answer: answer() })!, /token|years/)
  assert.equal(speakableText({ status: 'ready', answer: answer({ outcome: 'not_established', blocks: [], notice: 'That information is not established in the available records.' }) }), 'That information is not established in the available records.')
  assert.equal(speakableText({ status: 'unverified', answer: answer() }), 'Mana could not safely verify that response.')
  assert.equal(speakableText({ status: 'failed', answer: null }), null)
  assert.equal(speakableText({ status: 'pending', answer: null }), null)
})

const proposal: ManaActionProposal = {
  kind: 'add_prescription_item',
  encounterId: E,
  item: { drugName: 'Amoxicillin', strength: '500 mg', form: '', dose: '500 mg', route: '', frequency: 'Three times daily (TDS)', duration: '5 days', durationDays: 5, instructions: '' },
  summary: 'Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days',
  warnings: [{ kind: 'allergy_conflict', text: 'Amoxicillin and the recorded allergy to Penicillin belong to the same configured group (“penicillin”). Check before approving.' }],
}

test('a proposed medicine: its card shows only what the doctor said, and it becomes exactly that draft row after Approve', () => {
  assert.deepEqual(proposalLines(proposal), [
    { label: 'Medicine', value: 'Amoxicillin · 500 mg' },
    { label: 'Dose', value: '500 mg' },
    { label: 'Frequency', value: 'Three times daily (TDS)' },
    { label: 'Duration', value: '5 days' },
  ])
  assert.equal(proposalLines({ item: { ...proposal.item, duration: '2 weeks', durationDays: 14 } }).find((l) => l.label === 'Duration')!.value, '2 weeks (14 days)')
  assert.deepEqual(proposalLines({ item: { ...proposal.item, form: 'Capsule', durationDays: null, duration: '3 months', route: 'Oral', instructions: 'After food' } }).map((l) => l.label), ['Medicine', 'Dose', 'Frequency', 'Duration', 'Route', 'Instructions'])
  assert.deepEqual(toPrescriptionItem(proposal), { drugName: 'Amoxicillin', strength: '500 mg', form: '', dose: '500 mg', route: '', frequency: 'Three times daily (TDS)', duration: '5 days', instructions: '', durationDays: 5 })
  assert.equal(speakableText({ status: 'ready', answer: answer({ action: proposal }) }), 'Add to the prescription: Amoxicillin 500 mg · three times a day · 5 days. Approve or cancel on the screen.')
  assert.equal(NO_DRAFT_OPEN, 'Open the consultation or the prescription to add it')
})
