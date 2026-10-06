// Unit tests (node --test) of the final consultation workspace (Doctor HERO, DESIGN §5.4–5.5): "Generate prescription" (always there, off
// only while the note cannot be saved), which of the five inputs Mana reads ("Mana reads: n of 5 inputs"), the "Preparing the consultation"
// checklist (each line ticks only on its own real signal; the page opens by itself only when the summary is ready or the model cannot be
// asked), and where Alt+1..5 and the overview's jumps lead. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EVIDENCE_TARGETS, type ConsultInputsUsed } from '@adaxai/contracts'
import {
  type AiFacts,
  CONSOLIDATING,
  type DraftFacts,
  generateControl,
  HANDWRITING_KEPT,
  MANA_UNAVAILABLE,
  manaReads,
  manaReadsText,
  type ModelAsk,
  modelRefusal,
  NOT_SAVED,
  NOT_SENT,
  NOTE_LOCKED,
  type PreparingFacts,
  preparingChecklist,
  READING_SENT,
  type SaveRun,
} from '../src/lib/analysis.ts'
import { targetElementId } from '../src/lib/consultationContext.ts'
import { PANEL_NAMES } from '../src/lib/shortcuts.ts'
import { elsewhereOf, isPartId, PART_SELECTORS, WORKSPACE_PANELS, workspaceDocument } from '../src/lib/workspace.ts'

const T0 = Date.UTC(2026, 9, 6, 9, 0, 0)
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()

const draft = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  id: '00000000-0000-4000-8000-0000000000d1',
  version: 2,
  status: 'generating',
  phase: 'queued',
  stale: false,
  insufficient: false,
  createdAt: iso(0),
  completedAt: null,
  latencyMs: null,
  errorMessage: null,
  progress: null,
  inputsUsed: null,
  ...over,
})
const ai = (over: Partial<AiFacts> = {}): AiFacts => ({ status: { available: true, reason: null }, canGenerate: true, blockedReason: null, draft: null, lastAttempt: null, ...over })
const used = (over: Partial<ConsultInputsUsed> = {}): ConsultInputsUsed => ({
  conversation: { confirmedPoints: 3 },
  history: { items: 16, allergies: 1, allergyStatus: 1, conditions: 2, medicines: 3, results: 4, previousConsultations: 2, previousConsultationItems: 3, earlierVisitReasons: 0 },
  note: { items: 4, sections: 3, diagnoses: 0, prescriptionItems: 0, visitReason: 1 },
  vitals: { staff: 5, device: 2 },
  thermal: { images: 1, reviewedSummaries: 0 },
  total: 29,
  ...over,
})

const saving: SaveRun = { state: 'running' }
const saved: SaveRun = { state: 'done', at: iso(1) }
const sent = (d: DraftFacts | null): ModelAsk => ({ state: 'sent', draft: d })
const facts = (over: Partial<PreparingFacts>): PreparingFacts => ({ save: saved, ask: { state: 'idle' }, ai: ai(), elapsedMs: 21_000, handwritingStrokes: null, ...over })
const states = (f: PreparingFacts) => Object.fromEntries(preparingChecklist(f).lines.map((l) => [l.key, l.state]))
const line = (f: PreparingFacts, key: string) => preparingChecklist(f).lines.find((l) => l.key === key)!

test('Generate prescription is always on, busy while a run or a draft is under way, and off (with the reason) only while the note cannot be saved', () => {
  assert.deepEqual(generateControl({ ai: ai(), save: 'saved' }), { label: 'Generate prescription', state: 'ready', disabled: false, busy: false, reason: null })
  // Not known yet, or the model down: still on (the page opens and the doctor writes the prescription).
  assert.equal(generateControl({ ai: undefined, save: 'dirty' }).state, 'checking')
  assert.equal(generateControl({ ai: undefined, save: 'dirty' }).disabled, false)
  assert.equal(generateControl({ ai: ai({ status: { available: false, reason: 'down' }, canGenerate: false }), save: 'saved' }).disabled, false)
  // Under way: busy, and a click shows the progress again (not disabled).
  for (const c of [generateControl({ ai: ai(), running: true, save: 'saved' }), generateControl({ ai: ai({ draft: draft() }), save: 'saved' })]) {
    assert.equal(c.state, 'running')
    assert.equal(c.busy, true)
    assert.equal(c.disabled, false)
  }
  for (const save of ['conflict', 'blocked'] as const) assert.deepEqual(generateControl({ ai: ai(), save }), { label: 'Generate prescription', state: 'blocked', disabled: true, busy: false, reason: NOTE_LOCKED })
})

test('the model is not asked when the server already said it cannot be: the model down is "Mana is unavailable"; otherwise the server’s words', () => {
  assert.equal(modelRefusal(undefined), null)
  assert.equal(modelRefusal(ai()), null)
  assert.equal(modelRefusal(ai({ status: { available: false, reason: 'Local AI unavailable.' }, canGenerate: false })), MANA_UNAVAILABLE)
  assert.equal(modelRefusal(ai({ canGenerate: false, blockedReason: 'The patient’s consent to AI assistance is not recorded.' })), 'The patient’s consent to AI assistance is not recorded.')
  assert.equal(modelRefusal(ai({ canGenerate: false })), 'The local model cannot be asked now.')
})

test('Mana reads: the five inputs in order; only confirmed points, staff and device vitals, the typed note and approved thermal; never the stethoscope or the handwriting', () => {
  const none = manaReads({ confirmedPoints: 0, staffVitals: 0, deviceReadings: 0, typedNote: false, approvedThermal: 0 })
  assert.deepEqual(
    none.map((i) => [i.key, i.label, i.read]),
    [
      ['transcription', 'Live transcription', false],
      ['inputs', 'Clinical inputs', false],
      ['stethoscope', 'Stethoscope', false],
      ['notes', 'Doctor notes', false],
      ['thermal', 'Thermal', false],
    ],
  )
  assert.equal(manaReadsText(none), 'Mana reads: 0 of 5 inputs')
  const three = manaReads({ confirmedPoints: 3, staffVitals: 4, deviceReadings: 0, typedNote: true, approvedThermal: 0 })
  assert.equal(manaReadsText(three), 'Mana reads: 3 of 5 inputs')
  assert.equal(three[0]!.text, '3 points you confirmed')
  assert.equal(three[1]!.text, 'Staff vital signs')
  assert.match(three[3]!.text, /handwriting is never read/)
  // Not countable yet is not "none": it is not read.
  assert.equal(manaReads({ confirmedPoints: null, staffVitals: 0, deviceReadings: 2, typedNote: false, approvedThermal: 1 })[0]!.read, false)
  const all = manaReads({ confirmedPoints: 1, staffVitals: 1, deviceReadings: 1, typedNote: true, approvedThermal: 2 })
  assert.equal(manaReadsText(all), 'Mana reads: 4 of 5 inputs', 'the stethoscope is never read')
  assert.equal(all[1]!.text, 'Staff vital signs and device readings (unverified)')
  assert.equal(all[4]!.text, '2 approved images')
  // A withdrawn thermal consent: no image is read.
  assert.equal(manaReads({ confirmedPoints: 0, staffVitals: 0, deviceReadings: 0, typedNote: false, approvedThermal: 2, thermalConsentWithdrawn: true })[4]!.read, false)
})

test('the checklist: while saving nothing else is ticked; "Your notes saved" ticks only when the save answered', () => {
  const s = states(facts({ save: saving, ask: { state: 'idle' } }))
  assert.deepEqual(s, { save: 'running', conversation: 'waiting', history: 'waiting', inputs: 'waiting', notes: 'waiting', thermal: 'waiting', model: 'waiting' })
  assert.equal(line(facts({ save: saving }), 'save').label, 'Saving your notes…')
  assert.equal(preparingChecklist(facts({ save: saving })).next, 'wait')
  const after = facts({ save: saved, ask: { state: 'sending' } })
  assert.equal(line(after, 'save').label, 'Your notes saved')
  assert.equal(line(after, 'save').state, 'done')
  assert.equal(line(after, 'model').state, 'running')
  // The inputs are not ticked because the request was sent: only the server's own count ticks them.
  assert.equal(line(after, 'conversation').state, 'waiting')
})

test('the checklist: a failed save asks nothing; Mana is not asked and the doctor stays', () => {
  const f = facts({ save: { state: 'failed' }, ask: { state: 'skipped' } })
  const p = preparingChecklist(f)
  assert.equal(p.next, 'stay')
  assert.deepEqual(states(f), { save: 'failed', conversation: 'skipped', history: 'skipped', inputs: 'skipped', notes: 'skipped', thermal: 'skipped', model: 'skipped' })
  assert.equal(line(f, 'save').note, NOT_SAVED)
  assert.equal(line(f, 'conversation').text, NOT_SENT)
  assert.equal(line(f, 'model').label, 'Mana was not asked')
})

test('the checklist: the model waiting for its turn ticks no input; reading what was sent and the tokens come from the server, with the time since the click', () => {
  const queued = facts({ ask: sent(draft()), ai: ai({ draft: draft() }) })
  assert.equal(line(queued, 'model').label, 'Waiting for the local model')
  assert.equal(line(queued, 'model').text, '0:21')
  assert.equal(line(queued, 'history').state, 'waiting')
  const reading = draft({ phase: 'running', progress: { generatedTokens: 0, maxTokens: 2600, startedAt: iso(3), updatedAt: iso(4) }, inputsUsed: used() })
  const r = facts({ ask: sent(draft()), ai: ai({ draft: reading }) })
  assert.equal(line(r, 'model').label, CONSOLIDATING)
  assert.equal(line(r, 'model').text, `${READING_SENT} · 0:21`)
  const writing = draft({ phase: 'running', progress: { generatedTokens: 812, maxTokens: 2600, startedAt: iso(3), updatedAt: iso(20) }, inputsUsed: used() })
  const w = preparingChecklist(facts({ ask: sent(draft()), ai: ai({ draft: writing }) }))
  assert.equal(w.lines.find((l) => l.key === 'model')!.text, '812 tokens · 0:21')
  assert.equal(w.next, 'wait')
  assert.equal(w.announce, CONSOLIDATING, 'the announcement carries no clock')
  // No percentage and no time left anywhere.
  for (const l of w.lines) assert.doesNotMatch(`${l.label} ${l.text ?? ''}`, /%|left|remaining|ETA/)
})

test('the checklist: each input ticks with what the server says was SENT (inputsUsed), never predicted; nothing sent is said, never "none"', () => {
  const d = draft({ phase: 'running', progress: { generatedTokens: 40, maxTokens: 2600, startedAt: iso(3), updatedAt: iso(9) }, inputsUsed: used() })
  const f = facts({ ask: sent(draft()), ai: ai({ draft: d }), handwritingStrokes: 42 })
  assert.deepEqual(
    preparingChecklist(f).lines.filter((l) => l.key !== 'save' && l.key !== 'model').map((l) => [l.key, l.state, l.label, l.text, l.note]),
    [
      ['conversation', 'done', 'Conversation', '3 confirmed points included', null],
      ['history', 'done', 'Patient history', '16 record items', null],
      ['inputs', 'done', 'Clinical inputs', '5 staff vital signs, 2 device readings (unverified)', null],
      ['notes', 'done', 'Doctor notes', 'Your typed note', HANDWRITING_KEPT],
      ['thermal', 'done', 'Thermal', 'Approved measurements (1 image)', null],
    ],
  )
  const empty = used({ conversation: { confirmedPoints: 0 }, history: { ...used().history, items: 0 }, note: { items: 0, sections: 0, diagnoses: 0, prescriptionItems: 0, visitReason: 0 }, vitals: { staff: 0, device: 0 }, thermal: { images: 0, reviewedSummaries: 0 } })
  const e = facts({ ask: sent(draft()), ai: ai({ draft: draft({ phase: 'running', inputsUsed: empty }) }), handwritingStrokes: 0 })
  assert.equal(line(e, 'conversation').text, 'No confirmed points — the transcript itself is not sent')
  assert.equal(line(e, 'history').text, 'Nothing from the record was sent')
  assert.equal(line(e, 'inputs').text, 'No vital signs sent — simulated values never are')
  assert.equal(line(e, 'notes').text, 'No typed note')
  assert.equal(line(e, 'notes').note, null, 'no handwriting, no handwriting line')
  assert.equal(line(e, 'thermal').text, 'No approved thermal image')
})

test('the checklist: a ready or partial summary opens the prescription page; this attempt is followed, never an earlier draft', () => {
  const ready = draft({ id: '00000000-0000-4000-8000-0000000000d2', version: 3, status: 'ready', phase: null, completedAt: iso(30), latencyMs: 30_000, inputsUsed: used() })
  const asked = draft({ id: '00000000-0000-4000-8000-0000000000d2', version: 3 })
  const p = preparingChecklist(facts({ ask: sent(asked), ai: ai({ draft: ready }) }))
  assert.equal(p.next, 'open')
  assert.equal(p.lines.find((l) => l.key === 'model')!.state, 'done')
  assert.equal(p.lines.find((l) => l.key === 'model')!.label, 'Mana’s summary is ready')
  const partial = preparingChecklist(facts({ ask: sent(asked), ai: ai({ draft: { ...ready, status: 'partial' } }) }))
  assert.equal(partial.next, 'open')
  // The state still shows the previous, finished draft (version 1) while this attempt (version 3) is being made: not ready, keep waiting.
  const earlier = draft({ id: '00000000-0000-4000-8000-0000000000d0', version: 1, status: 'ready', phase: null, inputsUsed: used() })
  const q = preparingChecklist(facts({ ask: sent(asked), ai: ai({ draft: earlier }) }))
  assert.equal(q.next, 'wait')
  assert.equal(q.lines.find((l) => l.key === 'conversation')!.state, 'waiting', 'an earlier draft’s counts are not this attempt’s')
})

test('the checklist: the model down opens the page with "Mana is unavailable"; any other refusal or a failed, cancelled or insufficient summary lets the doctor decide', () => {
  const down = preparingChecklist(facts({ ask: { state: 'failed', message: MANA_UNAVAILABLE }, ai: ai({ status: { available: false, reason: 'x' }, canGenerate: false }) }))
  assert.equal(down.next, 'open')
  assert.equal(down.lines.find((l) => l.key === 'model')!.label, MANA_UNAVAILABLE)
  assert.equal(down.lines.find((l) => l.key === 'thermal')!.state, 'skipped')
  // The server said so after the request (the state not read yet): the same.
  assert.equal(preparingChecklist(facts({ ask: { state: 'failed', message: 'Local AI unavailable.' }, ai: ai({ status: { available: false, reason: null } }) })).next, 'open')
  const consent = preparingChecklist(facts({ ask: { state: 'failed', message: 'The patient’s consent to AI assistance is not recorded.' } }))
  assert.equal(consent.next, 'stay')
  assert.equal(consent.lines.find((l) => l.key === 'model')!.note, 'The patient’s consent to AI assistance is not recorded.')
  const asked = draft()
  for (const [d, label] of [
    [draft({ status: 'failed', phase: null, errorMessage: 'The model stopped.' }), /could not finish/],
    [draft({ status: 'cancelled', phase: null }), /cancelled/],
    [draft({ status: 'ready', phase: null, insufficient: true }), /Too little is recorded/],
  ] as const) {
    const p = preparingChecklist(facts({ ask: sent(asked), ai: ai({ draft: d }) }))
    assert.equal(p.next, 'stay')
    assert.match(p.lines.find((l) => l.key === 'model')!.label, label)
    assert.equal(p.lines.find((l) => l.key === 'history')!.state, 'skipped')
  }
  // The model became unavailable after the request: the page opens.
  assert.equal(preparingChecklist(facts({ ask: sent(asked), ai: ai({ draft: draft({ status: 'unavailable', phase: null }) }) })).next, 'open')
})

test('the checklist without a click here (a draft found under way): no save line, the draft’s own state, no clock', () => {
  const d = draft({ phase: 'running', progress: { generatedTokens: 120, maxTokens: 2600, startedAt: iso(3), updatedAt: iso(9) }, inputsUsed: used() })
  const p = preparingChecklist({ save: null, ask: null, ai: ai({ draft: d }), elapsedMs: null, handwritingStrokes: null })
  assert.equal(p.lines.some((l) => l.key === 'save'), false)
  assert.equal(p.lines.find((l) => l.key === 'model')!.text, '120 tokens')
  assert.equal(p.next, 'wait')
})

test('Alt+1..5 go to the five panels in the five-input order, each on the part its input already had; the stethoscope by its panel', () => {
  assert.deepEqual(
    WORKSPACE_PANELS.map((p) => [p.n, p.key, p.part]),
    [
      [1, 'transcription', 'tools-conversation'],
      [2, 'inputs', 'tools-devices'],
      [3, 'stethoscope', 'tools-stethoscope'],
      [4, 'notes', 'consultation-note'],
      [5, 'thermal', 'tools-thermal'],
    ],
  )
  assert.equal(WORKSPACE_PANELS.length, PANEL_NAMES.length)
  for (const p of WORKSPACE_PANELS) assert.ok(isPartId(p.part))
  assert.equal(PART_SELECTORS['tools-stethoscope'], '[data-testid="stethoscope-panel"]')
  const asked: string[] = []
  /** An element stand-in that knows whether a tabindex attribute was given (a div has none, and is then not focusable). */
  const element = (id: string, tabindex?: number) => {
    const attrs = new Map<string, string>(tabindex === undefined ? [] : [['tabindex', String(tabindex)]])
    return {
      id,
      attrs,
      hasAttribute: (name: string) => attrs.has(name),
      get tabIndex() {
        return Number(attrs.get('tabindex') ?? -1)
      },
      set tabIndex(v: number) {
        attrs.set('tabindex', String(v))
      },
    }
  }
  const stetho = element('stetho')
  const thermal = element('tools-thermal', -1)
  const doc = workspaceDocument({
    getElementById: (id: string) => (id === 'tools-thermal' ? (thermal as unknown as HTMLElement) : null),
    querySelector: ((sel: string) => {
      asked.push(sel)
      return sel === '[data-testid="stethoscope-panel"]' ? stetho : null
    }) as Document['querySelector'],
    defaultView: null,
  })
  assert.equal(stetho.hasAttribute('tabindex'), false)
  assert.equal(doc.getElementById('tools-stethoscope'), stetho)
  // Alt+3 and the overview's jump move focus there: the panel is made a focus target (not a tab stop).
  assert.equal(stetho.attrs.get('tabindex'), '-1')
  assert.equal((doc.getElementById('tools-thermal') as unknown as { id: string }).id, 'tools-thermal')
  assert.equal(thermal.attrs.get('tabindex'), '-1', 'a part with its own id keeps what it has')
  assert.equal(doc.getElementById('consultation-note'), null)
  assert.deepEqual(asked, ['[data-testid="stethoscope-panel"]'], 'only a part without an element id is looked up by its panel')
  // A panel that is already focusable in its own way is left as it is.
  const tabStop = element('stetho', 0)
  const doc2 = workspaceDocument({ getElementById: () => null, querySelector: (() => tabStop) as unknown as Document['querySelector'], defaultView: null })
  doc2.getElementById('tools-stethoscope')
  assert.equal(tabStop.attrs.get('tabindex'), '0')
})

test('every overview target leads somewhere: a panel of the workspace, the prescription page (the Mana result) or the global Mana (Ask Mana)', () => {
  const onPage = new Set<string>(['tools-conversation', 'tools-history', 'tools-devices', 'tools-stethoscope', 'tools-thermal', 'consultation-note'])
  for (const t of EVIDENCE_TARGETS) {
    const part = targetElementId(t)
    const where = elsewhereOf(part)
    assert.ok(where !== null || onPage.has(part), `${t} (${part}) leads somewhere`)
  }
  assert.equal(elsewhereOf('mana-result'), 'prescription')
  assert.equal(elsewhereOf('mana-review'), 'prescription')
  assert.equal(elsewhereOf('rx'), 'prescription')
  assert.equal(elsewhereOf('mana-chat'), 'mana')
  assert.equal(elsewhereOf('tools-history'), null)
})
