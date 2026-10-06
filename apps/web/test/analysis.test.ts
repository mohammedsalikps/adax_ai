// Unit tests (node --test) of "Analyze with Mana" (Doctor HERO): what the one control says and when it is off (always with the reason), what
// each step of a run shows (the save, the fixed rules, the local model; never progress the server did not report), which attempt a step
// follows (this page's, not an earlier draft), what a run reads from each of the five inputs (a mark, in fixed words), and how long it took
// (m:ss, from the click on this page or from the server's own times). No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EncounterAi } from '@adaxai/contracts'
import {
  type AiFacts,
  ANALYSIS_COVERAGE,
  analysisFacts,
  analysisInputs,
  type AnalysisInputFacts,
  analysisSteps,
  analysisTiming,
  analyzeControl,
  attemptDraft,
  CHECKING_MODEL,
  type DraftFacts,
  draftTiming,
  draftView,
  fmtDuration,
  MODEL_BUSY,
  MODEL_STATE_UNREAD,
  modelStep,
  NOT_SAVED,
  NOTE_LOCKED,
  type NoteSaveState,
  rulesRunOf,
  rulesStep,
  savedForAnalysis,
  saveStep,
  startRefusal,
} from '../src/lib/analysis.ts'
import { fmtClock } from '../src/lib/devices.ts'

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0)
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()

const draft = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  id: '00000000-0000-4000-8000-0000000000d1',
  version: 1,
  status: 'ready',
  phase: null,
  stale: false,
  insufficient: false,
  createdAt: iso(0),
  completedAt: iso(17),
  latencyMs: 17_400,
  errorMessage: null,
  model: { provider: 'local', model: 'qwen3.5-4b-q4_k_m', runtime: 'llama.cpp', weightsSha256: null, local: true },
  ...over,
})

const ai = (over: Partial<AiFacts> = {}): AiFacts => ({ status: { available: true, reason: null }, canGenerate: true, blockedReason: null, draft: null, lastAttempt: null, ...over })

test('the draft is read as the V3 panel reads it; with the model gone, a failed or cancelled draft says the model is unavailable', () => {
  assert.equal(draftView(null, true), 'not_run')
  assert.equal(draftView(null, false), 'unavailable')
  assert.equal(draftView(draft({ status: 'generating', phase: 'queued' }), true), 'generating')
  assert.equal(draftView(draft(), true), 'ready')
  assert.equal(draftView(draft({ status: 'partial' }), true), 'partial')
  assert.equal(draftView(draft({ stale: true }), true), 'stale')
  assert.equal(draftView(draft({ insufficient: true, stale: true }), true), 'insufficient')
  assert.equal(draftView(draft({ status: 'failed' }), true), 'failed')
  assert.equal(draftView(draft({ status: 'cancelled' }), true), 'cancelled')
  assert.equal(draftView(draft({ status: 'failed' }), false), 'unavailable')
  assert.equal(draftView(draft({ status: 'cancelled' }), false), 'unavailable')
  // A finished draft stays what it is when the model goes away afterwards.
  assert.equal(draftView(draft(), false), 'ready')
  assert.deepEqual(analysisFacts(null), null)
  assert.deepEqual(analysisFacts(ai()), { view: 'not_run', phase: null, ran: false })
  assert.deepEqual(analysisFacts(ai({ draft: draft({ status: 'generating', phase: 'running', completedAt: null, latencyMs: null }) })), { view: 'generating', phase: 'running', ran: true })
  assert.deepEqual(analysisFacts(ai({ draft: draft() })), { view: 'ready', phase: null, ran: true })
})

test('one control: "Analyze with Mana" before any draft, "Analyze again" after one, "Analyzing…" (busy) while a run is under way', () => {
  assert.deepEqual(analyzeControl({ ai: ai(), save: 'saved' }), { label: 'Analyze with Mana', state: 'ready', disabled: false, busy: false, reason: null })
  // A run is on its way from this page (saving, asking) or the server is making a draft: busy and off, with no second button for the same act.
  assert.deepEqual(analyzeControl({ ai: ai(), save: 'saving', running: true }), { label: 'Analyzing…', state: 'running', disabled: true, busy: true, reason: null })
  assert.deepEqual(analyzeControl({ ai: ai({ draft: draft({ status: 'generating', phase: 'queued' }) }), save: 'saved' }), { label: 'Analyzing…', state: 'running', disabled: true, busy: true, reason: null })
  // After ready, partial, stale, insufficient, failed, cancelled or unavailable: "Analyze again".
  for (const d of [draft(), draft({ status: 'partial' }), draft({ stale: true }), draft({ insufficient: true }), draft({ status: 'failed' }), draft({ status: 'cancelled' }), draft({ status: 'unavailable' })]) {
    assert.deepEqual(analyzeControl({ ai: ai({ draft: d }), save: 'dirty' }), { label: 'Analyze again', state: 'again', disabled: false, busy: false, reason: null })
  }
  // An attempt that did not finish counts as a run too.
  assert.equal(analyzeControl({ ai: ai({ lastAttempt: { version: 1, status: 'failed', errorMessage: 'x', createdAt: iso(0) } }), save: 'saved' }).label, 'Analyze again')
  // Unsaved edits or a failed save that will be retried do not stop a run: the run saves first.
  for (const save of ['dirty', 'saving', 'error'] as NoteSaveState[]) assert.equal(analyzeControl({ ai: ai(), save }).disabled, false)
})

test('the control is off, with the reason, whenever a run could not be made: the server says so, the note cannot be saved, or the state is not known', () => {
  const consent = 'The patient’s consent to recording and AI assistance is missing or out of date.'
  assert.deepEqual(analyzeControl({ ai: ai({ canGenerate: false, blockedReason: consent }), save: 'saved' }), { label: 'Analyze with Mana', state: 'blocked', disabled: true, busy: false, reason: consent })
  // The model's own reason when the server gave no other.
  assert.equal(analyzeControl({ ai: ai({ canGenerate: false, status: { available: false, reason: 'Local AI unavailable: the model server is not running.' } }), save: 'saved' }).reason, 'Local AI unavailable: the model server is not running.')
  assert.equal(analyzeControl({ ai: ai({ canGenerate: false, status: { available: false, reason: null } }), save: 'saved' }).reason, 'Local AI unavailable.')
  assert.equal(analyzeControl({ ai: ai({ canGenerate: false }), save: 'saved' }).reason, 'The local model cannot be asked now.')
  // The note changed elsewhere, or saving was refused for good: a run would save first and fail, so it is off.
  for (const save of ['conflict', 'blocked'] as NoteSaveState[]) {
    assert.deepEqual(analyzeControl({ ai: ai({ draft: draft() }), save }), { label: 'Analyze again', state: 'blocked', disabled: true, busy: false, reason: NOTE_LOCKED })
  }
  // Not known yet, or not readable: off, and said.
  assert.deepEqual(analyzeControl({ ai: undefined, save: 'saved' }), { label: 'Analyze with Mana', state: 'checking', disabled: true, busy: false, reason: CHECKING_MODEL })
  assert.deepEqual(analyzeControl({ ai: null, aiError: true, save: 'saved' }), { label: 'Analyze with Mana', state: 'blocked', disabled: true, busy: false, reason: MODEL_STATE_UNREAD })
  // While a run is under way it is "Analyzing…", not off for another reason.
  assert.equal(analyzeControl({ ai: ai({ canGenerate: false, draft: draft({ status: 'generating', phase: 'running' }) }), save: 'saved' }).label, 'Analyzing…')
})

test('a run goes on after its save unless the save failed; a refusal to start is said in the right words', () => {
  assert.deepEqual(
    (['saved', 'dirty', 'saving', 'error', 'conflict', 'blocked'] as NoteSaveState[]).map((s) => [s, savedForAnalysis(s)]),
    [
      ['saved', true],
      // Typed again while saving: what was there at the click was saved.
      ['dirty', true],
      // A later autosave already running: the click's save finished before it.
      ['saving', true],
      ['error', false],
      ['conflict', false],
      ['blocked', false],
    ],
  )
  assert.equal(NOT_SAVED, 'Your note could not be saved, so Mana was not asked.')
  assert.deepEqual(startRefusal({ status: 429, code: 'ai_busy', message: 'The local model is busy with other drafts. Try again in a moment.' }), { kind: 'busy', message: MODEL_BUSY })
  assert.equal(MODEL_BUSY, 'The local model is busy with another request. Try again when it finishes.')
  assert.deepEqual(startRefusal({ status: 409, code: 'generation_in_progress', message: 'A draft for this consultation is already being made.' }), { kind: 'running', message: 'A draft for this consultation is already being made.' })
  assert.deepEqual(startRefusal({ status: 429, code: 'rate_limited', message: 'Too many attempts. Try again in 12 seconds.' }), { kind: 'failed', message: 'Too many attempts. Try again in 12 seconds.' })
  assert.deepEqual(startRefusal({ status: 0, code: 'network_error', message: '' }), { kind: 'failed', message: 'The local model could not be asked.' })
  assert.match(ANALYSIS_COVERAGE, /^Reads the record, your saved note and the points you confirmed\. Does not read the raw transcript, audio, stethoscope recordings/)
})

test('the save step says when the note was saved, or that Mana was not asked', () => {
  assert.deepEqual(saveStep({ state: 'running' }), { id: 'save', label: 'Your note', state: 'running', detail: 'Saving…', tone: 'notice', message: null })
  assert.deepEqual(saveStep({ state: 'done', at: iso(3) }), { id: 'save', label: 'Your note', state: 'done', detail: `Saved ${fmtClock(iso(3))}`, tone: 'ok', message: null })
  assert.match(saveStep({ state: 'done', at: iso(3) }).detail, /^Saved \d{1,2}:\d{2}:\d{2}/)
  assert.deepEqual(saveStep({ state: 'failed' }), { id: 'save', label: 'Your note', state: 'failed', detail: 'Not saved', tone: 'down', message: NOT_SAVED })
})

test('the rules step counts the results and names the rules that made them; a refusal is the server’s words; after a failed save it did not run', () => {
  assert.deepEqual(rulesStep({ state: 'done', results: 3, producedBy: 'safety-rules-v1', at: iso(2) }), { id: 'rules', label: 'Fixed safety rules', state: 'done', detail: '3 results · safety-rules-v1', tone: 'ok', message: null })
  assert.equal(rulesStep({ state: 'done', results: 1, producedBy: null, at: null }).detail, '1 result')
  assert.equal(rulesStep({ state: 'done', results: 0, producedBy: 'safety-rules-v1', at: null }).detail, 'No results · safety-rules-v1')
  assert.deepEqual(rulesStep({ state: 'failed', message: 'Too many attempts. Try again in 12 seconds.' }), { id: 'rules', label: 'Fixed safety rules', state: 'failed', detail: 'Not run', tone: 'down', message: 'Too many attempts. Try again in 12 seconds.' })
  assert.equal(rulesStep({ state: 'skipped' }).detail, 'Not run, because your note was not saved')
  assert.equal(rulesStep({ state: 'running' }).state, 'running')
})

test('the rules’ answer is read from its newest safety_check job: only that job’s rule results are counted, with their rules version', () => {
  const job = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, kind: 'safety_check', status: 'succeeded', lastErrorMessage: null, createdAt, completedAt: createdAt, runs: [{ kind: 'safety_check', model: 'safety-rules-v1' }], ...over })
  const rec = (jobId: string, source = 'rules') => ({ jobId, source, producedBy: { provider: 'adaxai-rules', model: 'safety-rules-v1', version: null } })
  const answer = (jobs: unknown[], recommendations: unknown[]) => ({ jobs, recommendations }) as unknown as Pick<EncounterAi, 'jobs' | 'recommendations'>
  assert.equal(rulesRunOf(answer([], [])), null)
  // The older run's results were superseded; a hosted model's are not rules.
  assert.deepEqual(
    rulesRunOf(answer([job('j1', iso(-600)), job('j2', iso(0)), { ...job('x', iso(5)), kind: 'recommendations' }], [rec('j1'), rec('j1'), rec('j2'), rec('j2'), rec('j2', 'llm')])),
    { state: 'done', results: 2, producedBy: 'safety-rules-v1', at: iso(0) },
  )
  // No result: the rules version comes from the run.
  assert.deepEqual(rulesRunOf(answer([job('j3', iso(0))], [])), { state: 'done', results: 0, producedBy: 'safety-rules-v1', at: iso(0) })
  assert.deepEqual(rulesRunOf(answer([job('j4', iso(0), { status: 'failed', lastErrorMessage: 'The rules could not read the record.' })], [])), { state: 'failed', message: 'The rules could not read the record.' })
  assert.deepEqual(rulesRunOf(answer([job('j5', iso(0), { status: 'running' })], [])), { state: 'running' })
})

test('the model step shows only what the server reported: waiting for the model, writing, then the attempt’s own outcome', () => {
  const generating = (phase: 'queued' | 'running') => draft({ status: 'generating', phase, completedAt: null, latencyMs: null })
  const detail = (d: DraftFacts) => modelStep({ state: 'sent', draft: d }, ai({ draft: d }))
  assert.deepEqual(detail(generating('queued')), { id: 'model', label: 'Local model', state: 'running', detail: 'Waiting for the local model', tone: 'notice', message: null })
  assert.deepEqual(detail(generating('running')), { id: 'model', label: 'Local model', state: 'running', detail: 'Writing the draft', tone: 'notice', message: null })
  assert.deepEqual(detail(draft()), { id: 'model', label: 'Local model', state: 'done', detail: 'READY FOR REVIEW', tone: 'ai', message: null })
  assert.equal(detail(draft({ status: 'partial' })).detail, 'PARTIALLY AVAILABLE')
  assert.equal(detail(draft({ stale: true })).detail, 'STALE')
  assert.equal(detail(draft({ insufficient: true })).detail, 'INSUFFICIENT INFORMATION')
  assert.equal(detail(draft({ insufficient: true, model: null })).detail, 'INSUFFICIENT INFORMATION (the model was not asked)')
  assert.deepEqual(detail(draft({ status: 'failed', errorMessage: 'The draft was interrupted by a restart.' })), { id: 'model', label: 'Local model', state: 'failed', detail: 'FAILED', tone: 'down', message: 'The draft was interrupted by a restart.' })
  assert.deepEqual(detail(draft({ status: 'cancelled', errorMessage: 'Cancelled by the doctor.' })), { id: 'model', label: 'Local model', state: 'cancelled', detail: 'CANCELLED', tone: 'neutral', message: 'Cancelled by the doctor.' })
  assert.equal(detail(draft({ status: 'unavailable' })).state, 'failed')
  // The attempt's own outcome, even when the model went away afterwards.
  assert.equal(modelStep({ state: 'sent', draft: draft({ status: 'cancelled' }) }, ai({ status: { available: false, reason: null }, draft: draft({ status: 'cancelled' }) })).detail, 'CANCELLED')
  // Before and while asking, and when not asked.
  assert.deepEqual(modelStep({ state: 'idle' }, ai()), { id: 'model', label: 'Local model', state: 'idle', detail: 'Not asked yet', tone: 'neutral', message: null })
  assert.equal(modelStep({ state: 'sending' }, ai()).detail, 'Sending the request…')
  assert.deepEqual(modelStep({ state: 'failed', message: MODEL_BUSY }, ai()), { id: 'model', label: 'Local model', state: 'failed', detail: 'Not asked', tone: 'down', message: MODEL_BUSY })
  assert.equal(modelStep({ state: 'skipped' }, ai()).detail, 'Not asked, because your note was not saved')
  // Nothing asked from this page: the draft shown (one found under way after a reload), or nothing.
  assert.equal(modelStep(null, ai({ draft: generating('running') })).detail, 'Writing the draft')
  assert.equal(modelStep(null, ai()).detail, 'Not run')
  assert.equal(modelStep(null, undefined).detail, CHECKING_MODEL)
  // Never a percentage, an estimate or a step the server does not report.
  for (const d of [generating('queued'), generating('running'), draft()]) assert.doesNotMatch(detail(d).detail, /%|remaining|ETA|estimate|planning|almost/i)
})

test('a step follows this page’s attempt: never an earlier draft’s outcome while the state is read again, nor after this attempt failed', () => {
  const earlier = draft({ id: '00000000-0000-4000-8000-0000000000a1', version: 1 })
  const asked = draft({ id: '00000000-0000-4000-8000-0000000000a2', version: 2, status: 'generating', phase: 'queued', completedAt: null, latencyMs: null })
  // The state still shows the earlier, finished draft (not read again yet): the answer to the request stands.
  assert.equal(attemptDraft({ state: 'sent', draft: asked }, ai({ draft: earlier })), asked)
  assert.equal(modelStep({ state: 'sent', draft: asked }, ai({ draft: earlier })).detail, 'Waiting for the local model')
  // Read again: this attempt is the draft shown.
  const running = { ...asked, phase: 'running' as const }
  assert.equal(attemptDraft({ state: 'sent', draft: asked }, ai({ draft: running })), running)
  // This attempt failed: the earlier draft is shown again and this one is the last attempt. The step says it failed, not READY.
  const failed = ai({ draft: earlier, lastAttempt: { version: 2, status: 'failed', errorMessage: 'The model did not answer in time.', createdAt: iso(0) } })
  assert.deepEqual(modelStep({ state: 'sent', draft: asked }, failed), { id: 'model', label: 'Local model', state: 'failed', detail: 'FAILED', tone: 'down', message: 'The model did not answer in time.' })
  assert.equal(modelStep({ state: 'sent', draft: asked }, ai({ draft: earlier, lastAttempt: { version: 2, status: 'cancelled', errorMessage: null, createdAt: iso(0) } })).state, 'cancelled')
  // A newer draft than this one (asked from another window) is the one there is now.
  const newer = draft({ id: '00000000-0000-4000-8000-0000000000a3', version: 3, status: 'generating', phase: 'running', completedAt: null, latencyMs: null })
  assert.equal(attemptDraft({ state: 'sent', draft: asked }, ai({ draft: newer })), newer)
  // One was already being made (409): the running one is followed.
  assert.equal(attemptDraft({ state: 'sent', draft: null }, ai({ draft: running })), running)
  assert.equal(attemptDraft(null, ai({ draft: earlier })), earlier)
})

test('the steps of a run are listed in order; a step this page did not run (a run found after a reload) is left out, never shown as done', () => {
  const d = draft({ status: 'generating', phase: 'running', completedAt: null, latencyMs: null })
  const steps = analysisSteps({ save: { state: 'done', at: iso(1) }, rules: { state: 'done', results: 2, producedBy: 'safety-rules-v1', at: iso(2) }, ask: { state: 'sent', draft: d }, ai: ai({ draft: d }) })
  assert.deepEqual(
    steps.map((s) => [s.id, s.state]),
    [
      ['save', 'done'],
      ['rules', 'done'],
      ['model', 'running'],
    ],
  )
  // The save failed: neither the rules nor the model was asked.
  assert.deepEqual(
    analysisSteps({ save: { state: 'failed' }, rules: { state: 'skipped' }, ask: { state: 'skipped' }, ai: ai() }).map((s) => [s.id, s.state]),
    [
      ['save', 'failed'],
      ['rules', 'skipped'],
      ['model', 'skipped'],
    ],
  )
  assert.deepEqual(
    analysisSteps({ save: null, rules: null, ask: null, ai: ai({ draft: d }) }).map((s) => s.id),
    ['model'],
  )
})

const facts = (over: Partial<AnalysisInputFacts> = {}): AnalysisInputFacts => ({
  confirmedPoints: 0,
  history: 'loaded',
  staffVitals: 0,
  deviceReadings: 0,
  simulatedReadings: 0,
  approvedThermal: 0,
  reviewedThermalSummaries: 0,
  simulatedThermal: 0,
  ...over,
})
const line = (list: ReturnType<typeof analysisInputs>, key: string) => list.find((i) => i.key === key)!

test('what a run reads from each input is listed in fixed words: the five inputs in order, each read or not', () => {
  const full = analysisInputs(facts({ confirmedPoints: 3, staffVitals: 2, deviceReadings: 4, approvedThermal: 2, reviewedThermalSummaries: 1 }))
  assert.deepEqual(
    full.map((i) => [i.n, i.key, i.label, i.included, i.text]),
    [
      [1, 'conversation', 'Conversation', true, '3 points you confirmed'],
      [2, 'history', 'History', true, 'The patient’s record'],
      [3, 'vitals', 'Health band', true, 'Staff vital signs and device readings (unverified)'],
      [4, 'stethoscope', 'Stethoscope', false, 'Recordings are not analysed'],
      [5, 'thermal', 'Thermal', true, '2 approved images’ measurements and the reviewed summary'],
    ],
  )
  const empty = analysisInputs(facts())
  assert.deepEqual(
    empty.map((i) => [i.key, i.included, i.text]),
    [
      ['conversation', false, 'No confirmed point (the raw transcript is never read)'],
      ['history', true, 'The patient’s record'],
      ['vitals', false, 'No vital sign or device reading'],
      ['stethoscope', false, 'Recordings are not analysed'],
      ['thermal', false, 'No approved image'],
    ],
  )
})

test('only confirmed points are read from the conversation; the stethoscope is never read; the record always is', () => {
  assert.equal(line(analysisInputs(facts({ confirmedPoints: 1 })), 'conversation').text, '1 point you confirmed')
  // Not counted on this screen: not claimed as read.
  assert.deepEqual(line(analysisInputs(facts({ confirmedPoints: null })), 'conversation'), { key: 'conversation', n: 1, label: 'Conversation', included: false, text: 'The points you confirmed could not be counted here (the raw transcript is never read)' })
  for (const f of [facts(), facts({ confirmedPoints: 9, staffVitals: 3, approvedThermal: 4 })]) assert.equal(line(analysisInputs(f), 'stethoscope').included, false)
  // The server reads the record for every run: it is marked as read even while this screen could not show it, and says so.
  assert.deepEqual(line(analysisInputs(facts({ history: 'loading' })), 'history'), { key: 'history', n: 2, label: 'History', included: true, text: 'The patient’s record' })
  assert.deepEqual(line(analysisInputs(facts({ history: 'error' })), 'history'), { key: 'history', n: 2, label: 'History', included: true, text: 'The patient’s record (it could not be shown on this screen just now)' })
})

test('vital signs: staff and device values are read (devices unverified); simulated values never are', () => {
  const vitals = (over: Partial<AnalysisInputFacts>) => line(analysisInputs(facts(over)), 'vitals')
  assert.deepEqual([vitals({ staffVitals: 2 }).included, vitals({ staffVitals: 2 }).text], [true, 'Staff vital signs'])
  assert.deepEqual([vitals({ deviceReadings: 1 }).included, vitals({ deviceReadings: 1 }).text], [true, 'Device readings (unverified)'])
  assert.equal(vitals({ staffVitals: 1, deviceReadings: 1, simulatedReadings: 3 }).text, 'Staff vital signs and device readings (unverified); simulated values not read')
  assert.deepEqual([vitals({ simulatedReadings: 3 }).included, vitals({ simulatedReadings: 3 }).text], [false, 'Simulated values not read'])
})

test('thermal: approved images that are not simulated are read, with the reviewed summary; simulated ones never; none after consent is withdrawn', () => {
  const thermal = (over: Partial<AnalysisInputFacts>) => line(analysisInputs(facts(over)), 'thermal')
  assert.deepEqual([thermal({ approvedThermal: 1 }).included, thermal({ approvedThermal: 1 }).text], [true, '1 approved image’s measurements'])
  assert.equal(thermal({ approvedThermal: 3, reviewedThermalSummaries: 2 }).text, '3 approved images’ measurements and the reviewed summaries')
  assert.equal(thermal({ approvedThermal: 1, simulatedThermal: 2 }).text, '1 approved image’s measurements; simulated images not read')
  assert.deepEqual([thermal({ simulatedThermal: 2 }).included, thermal({ simulatedThermal: 2 }).text], [false, 'No approved image; simulated images not read'])
  assert.deepEqual([thermal({ approvedThermal: 2, thermalConsentWithdrawn: true }).included, thermal({ approvedThermal: 2, thermalConsentWithdrawn: true }).text], [false, 'Not read: the patient withdrew consent to thermal imaging'])
  // Marks only: nothing in the list speaks of progress.
  for (const i of analysisInputs(facts({ confirmedPoints: 2, staffVitals: 1, approvedThermal: 1 }))) assert.doesNotMatch(i.text, /%|reading…|analysing…|processing/i)
})

test('durations are m:ss, minutes not capped; a negative or unreadable one is not shown as a time', () => {
  assert.equal(fmtDuration(0), '0:00')
  assert.equal(fmtDuration(999), '0:00')
  assert.equal(fmtDuration(17_400), '0:17')
  assert.equal(fmtDuration(60_000), '1:00')
  assert.equal(fmtDuration(214_000), '3:34')
  assert.equal(fmtDuration(75 * 60_000 + 3_000), '75:03')
  assert.equal(fmtDuration(-1), null)
  assert.equal(fmtDuration(Number.NaN), null)
  assert.equal(fmtDuration(Number.POSITIVE_INFINITY), null)
})

test('the time a draft took is the server’s; the wait and the writing are split only when the server says when the model started', () => {
  // Request at 0 s, the model free at 2 s, done at 17.4 s.
  assert.deepEqual(draftTiming(draft({ startedAt: iso(2), completedAt: new Date(T0 + 17_400).toISOString(), latencyMs: 17_400 })), { took: '0:17', waited: '0:02', writing: '0:15' })
  // No startedAt (an older server, or a draft that never reached the model): no split, never guessed.
  assert.deepEqual(draftTiming(draft({ startedAt: undefined })), { took: '0:17', waited: null, writing: null })
  assert.deepEqual(draftTiming(draft({ startedAt: null })), { took: '0:17', waited: null, writing: null })
  // Times out of order are not shown as durations.
  assert.deepEqual(draftTiming(draft({ startedAt: iso(30), completedAt: iso(17) })), { took: '0:17', waited: null, writing: null })
  assert.deepEqual(draftTiming(draft({ startedAt: iso(2), completedAt: null, latencyMs: null })), { took: null, waited: null, writing: null })
})

test('the timing line: elapsed from the click while a run is under way, the server’s start for one found after a reload, then took', () => {
  const generating = draft({ status: 'generating', phase: 'running', completedAt: null, latencyMs: null, startedAt: iso(2) })
  // From the click on this page (performance.now() values), while saving, asking and generating.
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 1_000, ask: { state: 'sending' }, ai: ai({ draft: draft() }) }), 'elapsed 0:00')
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 13_500, ask: { state: 'sent', draft: generating }, ai: ai({ draft: generating }) }), 'elapsed 0:12')
  // Not yet asked: an earlier draft's time is not shown for this run.
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 4_000, ask: { state: 'idle' }, ai: ai({ draft: draft() }) }), 'elapsed 0:03')
  // Found under way after a reload: when it started, by the server's clock (the local clock is not compared with it).
  assert.equal(analysisTiming({ clickedAt: null, now: 50_000, ask: null, ai: ai({ draft: generating }) }), `started ${fmtClock(iso(0))} (server time)`)
  // Ended: the server's time, split when it says when the model started.
  const done = draft({ startedAt: iso(2), completedAt: new Date(T0 + 17_400).toISOString(), latencyMs: 17_400 })
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 90_000, ask: { state: 'sent', draft: generating }, ai: ai({ draft: done }) }), 'took 0:17 · waited 0:02 · writing and checks 0:15')
  assert.equal(analysisTiming({ clickedAt: null, now: 0, ask: null, ai: ai({ draft: draft() }) }), 'took 0:17')
  // Nothing true to say: the model was not asked, or a cancelled attempt has no latency.
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 9_000, ask: { state: 'skipped' }, ai: ai() }), null)
  assert.equal(analysisTiming({ clickedAt: 1_000, now: 9_000, ask: { state: 'failed', message: MODEL_BUSY }, ai: ai() }), null)
  assert.equal(analysisTiming({ clickedAt: null, now: 0, ask: null, ai: ai({ draft: draft({ status: 'cancelled', latencyMs: null, completedAt: null }) }) }), null)
  assert.equal(analysisTiming({ clickedAt: null, now: 0, ask: null, ai: ai() }), null)
})
