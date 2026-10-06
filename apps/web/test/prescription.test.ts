// Unit tests (node --test) of the prescription page's decisions (components/rx/rxModel.ts, DESIGN §5.6): the page's state and its pill
// (draft, signed and to complete, completed), the completion toast's words, how the AI draft's statements are grouped and where each goes in the
// note, which acts a statement offers, a medicine's duration (the written words, the number of days and the first day, kept together, round
// trip), the model's real progress, and that a signed-out person's kept handwriting is forgotten. No browser.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { type ConsultationAi, type ConsultItem, type ConsultSection, CONSULT_SECTION_KEYS, type Me, type PrescriptionItemInput } from '@adaxai/contracts'
import { QueryClient } from '@tanstack/react-query'
import {
  ALLERGY_CHECK_DEBOUNCE_MS,
  allergyCheckView,
  allergyReviewNote,
  completionToast,
  courseStart,
  daysFromText,
  defaultNoteSection,
  draftProgressText,
  durationReading,
  durationText,
  emptyRx,
  groupStatements,
  medicinesKey,
  noteAreaMode,
  noteSectionChoices,
  PROGRESS_ANNOUNCEMENT,
  RowKeys,
  rxPageState,
  rxStatusPill,
  SUMMARY_GROUPS,
  settledDuration,
  settleDurationText,
  statementActions,
  summaryView,
  withDurationText,
  withStartDate,
} from '../src/components/rx/rxModel.ts'
import { keepUnsavedHandwriting, takeUnsavedHandwriting } from '../src/lib/handwritingApi.ts'
import { durationLines } from '../src/lib/prescriptionCourse.ts'
import { ME_KEY, replaceSession } from '../src/lib/session.ts'

const VISIT = '2026-10-06'

test('the page’s state: the doctor’s draft, a draft they cannot edit, signed and to complete, signed, completed, discarded; and its pill', () => {
  const e = (o: Partial<{ status: 'in_progress' | 'signed' | 'discarded'; canEdit: boolean; canComplete: boolean; completedAt: string | null; visit: 'in_consultation' | 'completed' | 'ready' }>) =>
    rxPageState({ status: o.status ?? 'in_progress', canEdit: o.canEdit ?? false, canComplete: o.canComplete, completedAt: o.completedAt ?? null, visit: { status: o.visit ?? 'in_consultation' } })
  assert.equal(e({ canEdit: true }), 'draft')
  assert.equal(e({ canEdit: false, visit: 'ready' }), 'readonly_draft')
  assert.equal(e({ status: 'signed', canComplete: true }), 'signed_to_complete')
  assert.equal(e({ status: 'signed', canComplete: false }), 'signed')
  assert.equal(e({ status: 'signed' }), 'signed', 'an older server without canComplete never offers Complete')
  assert.equal(e({ status: 'signed', completedAt: '2026-10-06T10:00:00.000Z', visit: 'completed' }), 'completed')
  assert.equal(e({ status: 'signed', canComplete: true, visit: 'completed' }), 'completed', 'the visit decides even before completedAt is read')
  assert.equal(e({ status: 'discarded', canEdit: true }), 'discarded')
  assert.deepEqual(rxStatusPill('draft'), { status: 'draft' })
  assert.deepEqual(rxStatusPill('readonly_draft'), { status: 'draft' })
  assert.deepEqual(rxStatusPill('signed_to_complete'), { status: 'signed_to_complete' })
  // Deliberate change (review nit 7): a signed record this person cannot complete is not "to complete" for them; its pill says "Signed".
  assert.deepEqual(rxStatusPill('signed'), { status: 'signed_to_complete', label: 'Signed' })
  assert.deepEqual(rxStatusPill('completed'), { status: 'completed' })
  assert.deepEqual(rxStatusPill('discarded'), { status: 'cancelled', label: 'Discarded' })
})

test('the completion toast says the record was updated, and whether the patient can see the prescription', () => {
  assert.equal(completionToast(true), 'Consultation completed · Patient record updated · Prescription available to the patient')
  assert.equal(completionToast(false), 'Consultation completed · Patient record updated · The patient has no portal access')
  assert.ok(!completionToast(false).includes('available to the patient'), 'never claims the patient can see it without portal access')
})

const item = (section: ConsultSection, o: Partial<ConsultItem> = {}): ConsultItem => ({
  id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
  section,
  position: 0,
  text: `${section} statement`,
  support: 'supported',
  rationale: null,
  uncertainty: null,
  flags: [],
  sources: [],
  sourceChanged: false,
  decision: 'pending',
  finalText: null,
  decidedByName: null,
  decidedAt: null,
  inNote: false,
  needsConfirmation: false,
  ...o,
})

test('every section of the draft belongs to exactly one group of the summary, in reading order, and statements keep the model’s order', () => {
  const all = SUMMARY_GROUPS.flatMap((g) => g.sections)
  assert.deepEqual([...all].sort(), [...CONSULT_SECTION_KEYS].sort())
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual(
    SUMMARY_GROUPS.map((g) => g.title),
    ['Symptoms & presenting problem', 'Relevant history', 'Findings & observations', 'Considerations', 'Missing information'],
  )
  const items = [item('symptoms', { position: 1, text: 'b' }), item('summary', { text: 'a' }), item('symptoms', { position: 0, text: 'c' }), item('observations'), item('uncertainties'), item('potential_medication_considerations'), item('allergies')]
  const g = groupStatements(items)
  assert.deepEqual(
    g.presenting.map((i) => i.text),
    ['a', 'c', 'b'],
  )
  assert.deepEqual(
    g.findings.map((i) => i.section),
    ['observations'],
  )
  assert.deepEqual(
    g.considerations.map((i) => i.section),
    ['potential_medication_considerations'],
  )
  assert.deepEqual(
    g.history.map((i) => i.section),
    ['allergies'],
  )
  assert.deepEqual(
    g.missing.map((i) => i.section),
    ['uncertainties'],
  )
})

test('each kind of statement goes to a sensible note section by default; a medication consideration only to the Plan; a comment on the record nowhere', () => {
  assert.equal(defaultNoteSection('symptoms'), 'history')
  assert.equal(defaultNoteSection('observations'), 'examination')
  assert.equal(defaultNoteSection('relevant_history'), 'pastHistory')
  assert.equal(defaultNoteSection('potential_considerations'), 'assessment')
  assert.equal(defaultNoteSection('potential_investigations'), 'plan')
  assert.equal(defaultNoteSection('uncertainties'), null)
  assert.deepEqual(noteSectionChoices('potential_medication_considerations'), ['plan'])
  assert.deepEqual(noteSectionChoices('uncertainties'), [])
  const obs = noteSectionChoices('observations')
  assert.equal(obs[0], 'examination', 'the default first')
  assert.equal(obs.length, 7, 'any other note section can be chosen from the menu')
  assert.equal(new Set(obs).size, 7)
})

test('a statement offers Add to note, Edit and Remove while pending; the tick where the server asks; only Add once accepted elsewhere; nothing in the note, removed, or read only', () => {
  const editable = { editable: true }
  assert.deepEqual(statementActions(item('symptoms'), editable), { add: true, edit: true, remove: true, tick: false, state: 'pending' })
  assert.deepEqual(statementActions(item('symptoms', { needsConfirmation: true }), editable), { add: true, edit: true, remove: true, tick: true, state: 'pending' })
  assert.deepEqual(statementActions(item('uncertainties', { needsConfirmation: true }), editable), { add: false, edit: false, remove: true, tick: false, state: 'pending' })
  assert.deepEqual(statementActions(item('symptoms', { decision: 'accepted' }), editable), { add: true, edit: false, remove: false, tick: false, state: 'accepted' })
  assert.deepEqual(statementActions(item('symptoms', { decision: 'edited' }), editable), { add: true, edit: false, remove: false, tick: false, state: 'accepted' })
  assert.equal(statementActions(item('symptoms', { decision: 'accepted', inNote: true }), editable).state, 'in_note')
  assert.equal(statementActions(item('symptoms', { decision: 'accepted' }), { editable: true, inserted: true }).state, 'in_note', 'inserted on this page before the draft is read again')
  assert.deepEqual(statementActions(item('symptoms', { decision: 'rejected' }), editable), { add: false, edit: false, remove: false, tick: false, state: 'removed' })
  assert.deepEqual(statementActions(item('symptoms'), { editable: false }), { add: false, edit: false, remove: false, tick: false, state: 'pending' })
})

const ai = (o: Partial<ConsultationAi> & { available?: boolean }): Pick<ConsultationAi, 'status' | 'draft' | 'canGenerate'> =>
  ({ status: { available: o.available ?? true }, draft: o.draft ?? null, canGenerate: o.canGenerate ?? true }) as Pick<ConsultationAi, 'status' | 'draft' | 'canGenerate'>
const draft = (o: Record<string, unknown>) => ({ status: 'ready', phase: null, insufficient: false, stale: false, items: [], ...o }) as unknown as ConsultationAi['draft']

test('the summary: unread, the model unavailable (write it yourself), none yet, being made, ended, too little, or its statements', () => {
  assert.deepEqual(summaryView(undefined), { kind: 'unread' })
  assert.deepEqual(summaryView(ai({ available: false })), { kind: 'unavailable' })
  assert.deepEqual(summaryView(ai({ available: false, draft: draft({ status: 'failed' }) })), { kind: 'unavailable' })
  assert.deepEqual(summaryView(ai({ canGenerate: false })), { kind: 'none', canGenerate: false })
  assert.deepEqual(summaryView(ai({ draft: draft({ status: 'generating', phase: 'running' }) })), { kind: 'generating', phase: 'running' })
  assert.deepEqual(summaryView(ai({ draft: draft({ status: 'cancelled' }) })), { kind: 'ended', status: 'cancelled', canGenerate: true })
  assert.deepEqual(summaryView(ai({ draft: draft({ insufficient: true }) })), { kind: 'insufficient' })
  const s = item('symptoms')
  assert.deepEqual(summaryView(ai({ available: false, draft: draft({ status: 'partial', stale: true, items: [s] }) })), { kind: 'shown', items: [s], stale: true, partial: true }, 'a finished draft is shown even when the model has gone since')
})

test('the model’s progress is its real token count and the time since its turn came; before that, what it is waiting for', () => {
  const now = Date.parse('2026-10-06T10:00:21.000Z')
  assert.equal(draftProgressText({ progress: { generatedTokens: 812, startedAt: '2026-10-06T10:00:00.000Z' }, startedAt: '2026-10-06T10:00:00.000Z', createdAt: '2026-10-06T09:59:50.000Z' }, now), '812 tokens · 0:21')
  assert.equal(draftProgressText({ progress: { generatedTokens: 1, startedAt: '2026-10-06T10:00:20.000Z' }, startedAt: null, createdAt: '2026-10-06T09:59:50.000Z' }, now), '1 token · 0:01')
  assert.equal(draftProgressText({ progress: null, startedAt: '2026-10-06T10:00:00.000Z', createdAt: '2026-10-06T09:59:50.000Z' }, now), 'Reading the record · 0:21')
  assert.equal(draftProgressText({ progress: null, startedAt: null, createdAt: '2026-10-06T09:59:50.000Z' }, now), 'Waiting for the local model · 0:31')
})

test('a medicine’s duration: the words, the number of days and the first day are kept together, and round-trip through what is saved and printed', () => {
  assert.equal(durationText(1), '1 day')
  assert.equal(durationText(5), '5 days')
  for (const [text, days] of [
    ['5', 5],
    ['5 days', 5],
    [' 1 day ', 1],
    ['7d', 7],
    ['1 week', 7],
    ['2 weeks', 14],
    ['3650 days', 3650],
  ] as const)
    assert.equal(daysFromText(text), days, text)
  for (const text of ['', 'When needed (SOS)', 'Until review', '1 month', '0 days', '3651 days', '5 days, then review', '-2', '2.5 days']) assert.equal(daysFromText(text), null, text)

  // Written as days: the course is carried with the words; the first day defaults to the consultation's date.
  const base: PrescriptionItemInput = { ...emptyRx(), drugName: 'Paracetamol', dose: '1 tablet', frequency: 'TDS' }
  const five = withDurationText(base, '5 days')
  assert.deepEqual([five.duration, five.durationDays, five.startDate], ['5 days', 5, null])
  assert.equal(courseStart(five, VISIT), VISIT)
  assert.deepEqual(durationReading(five, VISIT), { kind: 'course', text: '5 days from 6 Oct 2026' })
  // A later first day, then the words change: the first day is kept with the new course.
  const later = withStartDate(five, '2026-10-08')
  assert.equal(later.startDate, '2026-10-08')
  const seven = withDurationText(later, '1 week')
  assert.deepEqual([seven.duration, seven.durationDays, seven.startDate], ['1 week', 7, '2026-10-08'])
  assert.deepEqual(durationReading(seven, VISIT), { kind: 'course', text: '7 days from 8 Oct 2026' })
  // What the printout and the patient app read from the saved row (the server stores the visit date when no first day is sent).
  assert.deepEqual(durationLines({ duration: seven.duration!, durationDays: seven.durationDays, startDate: seven.startDate }), { main: '7 days from 8 Oct 2026', written: '1 week' })
  assert.deepEqual(durationLines({ duration: five.duration!, durationDays: five.durationDays, startDate: courseStart(five, VISIT) }), { main: '5 days from 6 Oct 2026', written: null })
  // Free text (when needed, until review): no course, and no first day left behind.
  const sos = withDurationText(later, 'When needed (SOS)')
  assert.deepEqual([sos.duration, sos.durationDays, sos.startDate], ['When needed (SOS)', null, null])
  assert.deepEqual(durationReading(sos, VISIT), { kind: 'open', text: 'No fixed number of days' })
  assert.equal(withStartDate(sos, '2026-10-09').startDate, null, 'no first day without a course')
  // While typing "14" the course follows; leaving the field writes "14 days".
  const typing = withDurationText(base, '14')
  assert.deepEqual([typing.duration, typing.durationDays], ['14', 14])
  const settled = settleDurationText(typing)
  assert.deepEqual([settled.duration, settled.durationDays], ['14 days', 14])
  assert.equal(settleDurationText(withDurationText(base, '  Until review ')).duration, 'Until review')
  assert.deepEqual(durationReading(withDurationText(base, ''), VISIT), { kind: 'empty', text: '' })
  // A new row has no course until the doctor writes one.
  assert.deepEqual([emptyRx().durationDays, emptyRx().startDate, emptyRx().route], [null, null, 'Oral'])
})

test('signing out forgets the handwriting a pad could not save, kept for its writer', () => {
  const me = { id: 'u1', role: 'doctor' } as Me
  const qc = new QueryClient()
  qc.setQueryData(ME_KEY, me)
  keepUnsavedHandwriting('enc-1', { userId: 'u1', document: { version: 1, pageCount: 1, strokes: [] }, baseVersion: 2, base: null } as unknown as Parameters<typeof keepUnsavedHandwriting>[1])
  replaceSession(qc, null)
  assert.equal(takeUnsavedHandwriting('enc-1', 'u1'), null)
  qc.clear()
})

test('leaving the duration field changes the medicine only when the words settle differently, so tabbing through saves nothing', () => {
  const base: PrescriptionItemInput = { ...emptyRx(), drugName: 'Paracetamol' }
  for (const item of [withDurationText(base, '5 days'), withDurationText(base, 'When needed (SOS)'), withDurationText(base, ''), withStartDate(withDurationText(base, '1 week'), '2026-10-08')]) assert.equal(settledDuration(item), null, String(item.duration))
  // A bare number is written out; spaces are trimmed; the course follows the words.
  assert.equal(settledDuration(withDurationText(base, '14'))?.duration, '14 days')
  assert.equal(settledDuration({ ...withDurationText(base, 'Until review'), duration: ' Until review ' })?.duration, 'Until review')
  // A row read from the server whose course did not follow its words: leaving the field sets it.
  assert.equal(settledDuration({ ...base, duration: '5 days', durationDays: null })?.durationDays, 5)
  // The editor changes the draft on leaving the field only through this.
  const editor = fs.readFileSync(new URL('../src/components/rx/MedicinesEditor.tsx', import.meta.url), 'utf8')
  assert.match(editor, /if \(settledDuration\(p\)\) onChange\(\(x\) => settledDuration\(x\) \?\? x\)/)
})

test('each medicine row keeps its key when a row above it is removed, so its own state (Change start) stays with it', () => {
  const k = new RowKeys()
  assert.deepEqual([...k.of(3)], [0, 1, 2])
  assert.deepEqual([...k.of(3)], [0, 1, 2], 'drawn again: the same keys')
  k.remove(1)
  assert.deepEqual([...k.of(2)], [0, 2], 'the third row keeps its key after the second is removed')
  assert.deepEqual([...k.of(3)], [0, 2, 3], 'a row added at the end gets a new key')
  assert.deepEqual([...k.of(1)], [0], 'rows gone from the end lose theirs')
  assert.deepEqual([...k.of(2)], [0, 4], 'a key is never given twice')
  const editor = fs.readFileSync(new URL('../src/components/rx/MedicinesEditor.tsx', import.meta.url), 'utf8')
  assert.match(editor, /<MedicineRow key=\{keys\[i\]\}/)
})

test('the prescription’s advice and follow-up take no typing while an insertion into the note runs (its answer replaces the whole note)', () => {
  assert.equal(noteAreaMode({ editable: true, locked: false, inserting: false }), 'editable')
  assert.equal(noteAreaMode({ editable: true, locked: false, inserting: true }), 'frozen')
  assert.equal(noteAreaMode({ editable: true, locked: true, inserting: true }), 'document')
  assert.equal(noteAreaMode({ editable: false, locked: false, inserting: false }), 'document')
  // The page gives the document the insertion state, and the document draws its note parts from it.
  const page = fs.readFileSync(new URL('../src/pages/doctor/PrescriptionPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /<PrescriptionDocument [^>]*inserting=\{d\.inserting\}/)
  const doc = fs.readFileSync(new URL('../src/components/rx/PrescriptionDocument.tsx', import.meta.url), 'utf8')
  assert.match(doc, /noteAreaMode\(\{ editable, locked, inserting \}\)/)
  assert.equal((doc.match(/frozen=\{frozen\}/g) ?? []).length, 2, 'advice / diet and follow-up')
  // Sign & print waits for the insertion too.
  assert.match(page, /disabled=\{d\.locked \|\| d\.inserting\}/)
})

test('what the allergy name check reads: the medicines’ names, in any order and case; nothing named is nothing to check', () => {
  assert.equal(medicinesKey([]), '')
  assert.equal(medicinesKey([{ drugName: '  ' }, { drugName: '' }]), '')
  assert.equal(medicinesKey([{ drugName: 'Amoxicillin ' }, { drugName: 'paracetamol' }]), medicinesKey([{ drugName: 'Paracetamol' }, { drugName: 'amoxicillin' }]))
  assert.notEqual(medicinesKey([{ drugName: 'Amoxicillin' }]), medicinesKey([{ drugName: 'Amoxicillin' }, { drugName: 'Ibuprofen' }]))
  assert.ok(ALLERGY_CHECK_DEBOUNCE_MS > 0 && ALLERGY_CHECK_DEBOUNCE_MS <= 2000)
})

test('the allergy name check speaks of the medicines as they are only when it was asked for exactly those; otherwise it says they are not checked', () => {
  const amox = medicinesKey([{ drugName: 'Amoxicillin' }])
  const both = medicinesKey([{ drugName: 'Amoxicillin' }, { drugName: 'Ibuprofen' }])
  const match = { id: 'r1', text: 'Check Amoxicillin: the patient has a recorded allergy to Penicillin.', finalText: null }
  const done = (matches: (typeof match)[] = []) => ({ state: 'done' as const, at: '2026-10-06T10:00:00.000Z', matches })
  const v = (o: Partial<Parameters<typeof allergyCheckView>[0]>) => allergyCheckView({ draftKey: amox, checkedKey: amox, checking: false, failed: null, server: done(), ...o })

  // The reviewed journey: Generate ran the rules on an empty prescription; the medicines were written here afterwards.
  assert.deepEqual(v({ checkedKey: null, server: done() }), { state: 'unchecked', ever: true }, 'never "no medicine matched" for a check of other medicines')
  assert.deepEqual(v({ checkedKey: null, server: { state: 'not_run' } }), { state: 'unchecked', ever: false })
  // Typed but not saved and checked yet, or saved and waiting for the check.
  assert.deepEqual(v({ draftKey: both }), { state: 'unchecked', ever: true })
  assert.deepEqual(v({ draftKey: both, checking: true }), { state: 'checking' })
  // Checked for exactly these medicines: the result.
  assert.deepEqual(v({}), done())
  assert.deepEqual(v({ server: done([match]) }), done([match]))
  assert.deepEqual(v({ server: { state: 'failed', message: 'Rules error' } }), { state: 'failed', message: 'Rules error' })
  assert.deepEqual(v({ server: { state: 'running' } }), { state: 'checking' })
  assert.deepEqual(v({ server: null }), { state: 'unread' })
  // This page's request for these medicines failed: said with its words (and not for other medicines).
  assert.deepEqual(v({ checkedKey: null, failed: { key: amox, message: 'Too many requests' } }), { state: 'not_run_failed', message: 'Too many requests' })
  assert.deepEqual(v({ draftKey: both, failed: { key: amox, message: 'x' } }), { state: 'unchecked', ever: true })
  // No medicine named: nothing to check, whatever ran before.
  assert.deepEqual(v({ draftKey: '', server: done([match]) }), { state: 'none' })
  // None of these says that nothing matched: only a check of these medicines does.
  for (const s of [v({ checkedKey: null }), v({ draftKey: both }), v({ checking: true }), v({ server: null })]) assert.notEqual(s.state, 'done')
})

test('Review and sign says what the check found, or that the medicines are not checked and why; nothing when it is clear', () => {
  assert.equal(allergyReviewNote({ state: 'none' }), null)
  assert.equal(allergyReviewNote({ state: 'done', at: 'x', matches: [] }), null)
  const found = allergyReviewNote({ state: 'done', at: 'x', matches: [{ id: 'r1', text: 'Check Amoxicillin: allergy to Penicillin.', finalText: null }] })
  assert.equal(found?.tone, 'error')
  assert.match(found!.text, /Check Amoxicillin: allergy to Penicillin\./)
  const failed = allergyReviewNote({ state: 'not_run_failed', message: 'Too many requests.' })
  assert.equal(failed?.tone, 'warning')
  assert.match(failed!.text, /could not be run: Too many requests\. Check the medicines against the recorded allergies yourself/)
  assert.match(allergyReviewNote({ state: 'failed', message: 'Rules error.' })!.text, /could not be run: Rules error\./)
  assert.match(allergyReviewNote({ state: 'unchecked', ever: true })!.text, /has not run for the medicines as they are now/)
  assert.match(allergyReviewNote({ state: 'unread' })!.text, /could not be read/)
})

test('the prescription page runs the fixed rules only, after a saved change, on Check now, and before Review and sign opens', () => {
  const hook = fs.readFileSync(new URL('../src/components/rx/BeforeYouPrescribe.tsx', import.meta.url), 'utf8')
  assert.ok(hook.includes("`/encounters/${encounterId}/recommendations`, { method: 'POST', body: { includeLlm: false, idempotencyKey: newIdempotencyKey() } }"), 'the rules only, never the model')
  assert.ok(hook.includes('setTimeout(() => void run(savedKey), ALLERGY_CHECK_DEBOUNCE_MS)'), 'debounced after a saved change')
  assert.ok(hook.includes('Not checked since the medicines changed.'))
  assert.ok(hook.includes('Check now'))
  const page = fs.readFileSync(new URL('../src/pages/doctor/PrescriptionPage.tsx', import.meta.url), 'utf8')
  // Review and sign opens after the save and the check have answered.
  const open = page.slice(page.indexOf('const openReview'), page.indexOf('setReviewing(true)\n  }'))
  assert.ok(open.indexOf('await flushState()') >= 0 && open.indexOf('await flushState()') < open.indexOf('await allergy.ensure(key)'))
  assert.ok(open.includes('finally'), 'it opens when the check failed too (the dialog says so)')
  assert.ok(page.includes('onClick={() => void openReview()}'))
  assert.ok(page.includes('allergyNote={allergyReviewNote(allergy.view)}'))
})

test('the model’s progress: the live region says the same words throughout; the clock and the token count beside it are not announced', () => {
  const draft = { progress: { generatedTokens: 812, startedAt: '2026-10-06T10:00:00.000Z' }, startedAt: '2026-10-06T10:00:00.000Z', createdAt: '2026-10-06T09:59:50.000Z' }
  assert.notEqual(draftProgressText(draft, Date.parse('2026-10-06T10:00:21.000Z')), draftProgressText(draft, Date.parse('2026-10-06T10:00:22.000Z')))
  assert.ok(!/\d/.test(PROGRESS_ANNOUNCEMENT), 'no number in what is announced')
  const src = fs.readFileSync(new URL('../src/components/rx/ClinicalSummary.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('<span role="status">{PROGRESS_ANNOUNCEMENT}</span> <span className="tabular-nums">{draftProgressText(draft, now)}</span>'))
  assert.equal((src.match(/role="status"/g) ?? []).length, 1)
  // Asking Mana from here saves the pending edits first (Mana reads what is saved).
  assert.ok(src.indexOf('await flushState()') >= 0 && src.indexOf('await flushState()') < src.indexOf('generate.mutate()'))
})

test('the signed record says "Not recorded" for an empty note section, and keeps the integrity hash behind Details', () => {
  const src = fs.readFileSync(new URL('../src/pages/doctor/ConsultationPage.tsx', import.meta.url), 'utf8')
  assert.ok(src.includes('e.note[s.key] || <span className="text-ink-muted">Not recorded</span>'))
  assert.ok(!src.includes('<span className="text-ink-muted">—</span>'), 'never a dash alone')
  const details = src.indexOf('<summary')
  assert.ok(details > 0 && src.indexOf('Integrity hash (SHA-256') > details, 'the hash is inside the Details disclosure')
  assert.ok(src.slice(details, details + 200).includes('>Details</summary>'))
})
