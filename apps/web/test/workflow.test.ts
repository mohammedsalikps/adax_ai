// Unit tests (node --test) of the consultation's workflow strip (Doctor HERO): five steps, 1 Inputs → 2 Mana analysis → 3 Your review → 4 Note &
// prescription → 5 Sign, each with a state word and a tone taken only from what the page already holds; where each step leads; that a module
// holding only simulated items is counted and said so; and that nothing is said to wait for nobody when a kind was not counted. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { PendingReview } from '@adaxai/contracts'
import type { AnalysisFacts } from '../src/lib/analysis.ts'
import { analysisState, type InputModuleFacts, inputsState, medicineCount, moduleFills, recordState, reviewState, type WorkflowFacts, workflowSteps } from '../src/lib/workflow.ts'
import { isPartId } from '../src/lib/workspace.ts'

const none: InputModuleFacts = { conversation: null, history: null, vitals: null, stethoscope: null, thermal: null }
const pending = (over: Partial<PendingReview> = {}): PendingReview => ({ points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: [], ...over })
const ran = (view: AnalysisFacts['view'], phase: AnalysisFacts['phase'] = null): AnalysisFacts => ({ view, phase, ran: true })

test('a module counts when it holds any item; one not read on this screen does not; one holding only simulated items counts and says so', () => {
  assert.deepEqual(
    moduleFills(none).map((m) => [m.key, m.filled]),
    [
      ['conversation', false],
      ['history', false],
      ['vitals', false],
      ['stethoscope', false],
      ['thermal', false],
    ],
  )
  const fills = moduleFills({
    conversation: { transcripts: 1, points: 0 },
    // An allergy status recorded ("no known allergies") is information.
    history: { entries: 0, allergyStatusRecorded: true },
    vitals: { staff: 0, device: 0, simulated: 4 },
    stethoscope: { recordings: 2, simulated: 1 },
    thermal: { images: 1, simulated: 1 },
  })
  assert.deepEqual(
    fills.map((m) => [m.key, m.filled, m.simulatedOnly]),
    [
      ['conversation', true, false],
      ['history', true, false],
      ['vitals', true, true],
      ['stethoscope', true, false],
      ['thermal', true, true],
    ],
  )
  // Empty when read: still not counted.
  assert.equal(moduleFills({ ...none, history: { entries: 0, allergyStatusRecorded: false }, conversation: { transcripts: 0, points: 0 } }).filter((m) => m.filled).length, 0)
})

test('step 1 says how many of the five modules hold information, and "(incl. simulated)" when one of them holds only simulated items', () => {
  assert.deepEqual(inputsState(none), { state: '0 of 5 with information', tone: 'neutral' })
  assert.deepEqual(inputsState({ ...none, conversation: { transcripts: 1, points: 3 }, history: { entries: 4, allergyStatusRecorded: true }, vitals: { staff: 2, device: 1, simulated: 0 } }), { state: '3 of 5 with information', tone: 'ok' })
  // A real staff value beside a simulated band: not simulated-only.
  assert.equal(inputsState({ ...none, vitals: { staff: 1, device: 0, simulated: 5 } }).state, '1 of 5 with information')
  assert.equal(inputsState({ ...none, vitals: { staff: 0, device: 0, simulated: 5 }, thermal: { images: 2, simulated: 0 } }).state, '2 of 5 with information (incl. simulated)')
  assert.equal(inputsState({ ...none, stethoscope: { recordings: 1, simulated: 1 } }).state, '1 of 5 with information (incl. simulated)')
})

test('step 2 is the local model’s draft as the server reports it; while being made, waiting for the model or writing', () => {
  assert.deepEqual(analysisState(null), { state: '—', tone: 'neutral' })
  const words = (['not_run', 'ready', 'partial', 'failed', 'cancelled', 'unavailable', 'stale', 'insufficient'] as const).map((v) => [v, analysisState(ran(v)).state, analysisState(ran(v)).tone])
  assert.deepEqual(words, [
    ['not_run', 'Not run', 'neutral'],
    ['ready', 'Ready for review', 'ai'],
    ['partial', 'Partly available', 'warn'],
    ['failed', 'Failed', 'down'],
    ['cancelled', 'Cancelled', 'neutral'],
    ['unavailable', 'Unavailable', 'down'],
    ['stale', 'Stale', 'warn'],
    ['insufficient', 'Insufficient information', 'neutral'],
  ])
  assert.deepEqual(analysisState(ran('generating', 'queued')), { state: 'Waiting for the local model', tone: 'notice' })
  assert.deepEqual(analysisState(ran('generating', 'running')), { state: 'Writing', tone: 'notice' })
  // No progress the server does not report.
  for (const p of ['queued', 'running'] as const) assert.doesNotMatch(analysisState(ran('generating', p)).state, /%|\d/)
})

test('step 3 counts what waits for the doctor, the draft statements once; "Nothing waiting" only when every kind was counted; "—" before an analysis', () => {
  // Before any analysis was asked for.
  assert.deepEqual(reviewState(null, null, pending({ points: 3 })), { state: '—', tone: 'neutral' })
  assert.deepEqual(reviewState({ view: 'not_run', phase: null, ran: false }, null, pending()), { state: '—', tone: 'neutral' })
  // The draft's undecided statements (the AI state's count, which moves as the doctor decides) plus the Overview's points and thermal items;
  // the Overview's own draft count is the same statements, so it is not added again.
  assert.deepEqual(reviewState(ran('ready'), 4, pending({ points: 2, draftStatements: 5, thermalImages: 1, thermalSummaries: 1 })), { state: '8 to review', tone: 'warn' })
  // The AI state's count not known: the Overview's is used.
  assert.equal(reviewState(ran('ready'), null, pending({ draftStatements: 5 })).state, '5 to review')
  // Everything counted and nothing waits.
  assert.deepEqual(reviewState(ran('ready'), 0, pending()), { state: 'Nothing waiting', tone: 'ok' })
  // A kind the Overview could not count, or no Overview at all: a 0 is not "nothing waits".
  assert.deepEqual(reviewState(ran('ready'), 0, pending({ unread: ['thermalImages'] })), { state: 'Not all counted', tone: 'neutral' })
  assert.deepEqual(reviewState(ran('ready'), 0, null), { state: 'Not all counted', tone: 'neutral' })
  // A count that is there is said even when another kind was not read.
  assert.equal(reviewState(ran('ready'), 2, pending({ unread: ['thermalImages'] })).state, '2 to review')
  // While the draft is being made with nothing else waiting: not yet.
  assert.deepEqual(reviewState(ran('generating', 'running'), 0, pending()), { state: '—', tone: 'neutral' })
  assert.equal(reviewState(ran('generating', 'running'), 0, pending({ points: 1 })).state, '1 to review')
})

test('step 4 counts the medicines named and says whether the note and prescription are saved', () => {
  assert.deepEqual(recordState('saved', 2), { state: '2 medicines · saved', tone: 'ok' })
  assert.deepEqual(recordState('saved', 1), { state: '1 medicine · saved', tone: 'ok' })
  assert.deepEqual(recordState('saved', 0), { state: 'No medicines · saved', tone: 'ok' })
  assert.deepEqual(recordState('dirty', 1), { state: '1 medicine · unsaved changes', tone: 'neutral' })
  assert.equal(recordState('saving', 0).state, 'No medicines · saving…')
  assert.deepEqual(recordState('error', 0), { state: 'No medicines · not saved, retrying', tone: 'down' })
  assert.deepEqual(recordState('conflict', 3), { state: '3 medicines · changed elsewhere', tone: 'down' })
  assert.deepEqual(recordState('blocked', 3), { state: '3 medicines · not saved', tone: 'down' })
  // A row added and left empty is not a medicine.
  assert.equal(medicineCount([{ drugName: 'Paracetamol' }, { drugName: '  ' }, { drugName: '' }, { drugName: 'Amoxicillin' }]), 2)
  assert.equal(medicineCount([]), 0)
})

test('the five steps, in order, each with its state, its accessible name and where it leads; Sign leads to "Complete consultation"', () => {
  const f: WorkflowFacts = {
    inputs: { ...none, conversation: { transcripts: 1, points: 2 }, history: { entries: 3, allergyStatusRecorded: true } },
    analysis: ran('generating', 'queued'),
    undecided: null,
    pending: pending({ points: 2 }),
    save: 'saved',
    medicines: 1,
  }
  const steps = workflowSteps(f)
  assert.deepEqual(
    steps.map((s) => [s.n, s.id, s.label, s.state, s.target]),
    [
      [1, 'inputs', 'Inputs', '2 of 5 with information', 'consultation-inputs'],
      [2, 'analysis', 'Mana analysis', 'Waiting for the local model', 'mana-result'],
      [3, 'review', 'Your review', '2 to review', 'mana-review'],
      [4, 'record', 'Note & prescription', '1 medicine · saved', 'consultation-note'],
      [5, 'sign', 'Sign', 'Not signed', null],
    ],
  )
  for (const s of steps) if (s.target) assert.ok(isPartId(s.target))
  assert.deepEqual(
    steps.map((s) => s.name),
    ['Inputs: 2 of 5 with information', 'Mana analysis: Waiting for the local model', 'Your review: 2 to review', 'Note & prescription: 1 medicine · saved', 'Sign: Not signed'],
  )
  // "—" is said as "not yet".
  const before = workflowSteps({ ...f, analysis: null, pending: null })
  assert.equal(before[1]!.state, '—')
  assert.equal(before[1]!.name, 'Mana analysis: not yet')
  assert.equal(before[2]!.name, 'Your review: not yet')
  assert.deepEqual(workflowSteps({ ...f, signed: true })[4], { id: 'sign', n: 5, label: 'Sign', state: 'Signed', tone: 'ok', target: null, name: 'Sign: Signed' })
})
