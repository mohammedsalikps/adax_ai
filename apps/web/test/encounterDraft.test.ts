// Unit tests (node --test) of the consultation draft's save chain (lib/draftSaver.ts, the pure core of lib/encounterDraft.ts, shared by the
// consultation and the prescription page): one save at a time with the server's version, edits made during a save sent after it, a version
// conflict and a refusal that retrying cannot fix stopping the saves, other failures retried, an insertion of reviewed AI text on the same
// chain after what is pending, nothing sent for another person, Mana's medicine row added through the draft and refused when it is full, and
// the last save of an editor that went away. Fake server functions; no browser, no network.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import type { Encounter, NoteInsertion, PrescriptionItemInput } from '@adaxai/contracts'
import { ApiError } from '../src/lib/api.ts'
import {
  appendPrescriptionItem,
  AUTOSAVE_MS,
  autosaveDelay,
  type Draft,
  DraftSaver,
  type DraftSaverIo,
  draftExitPending,
  failedSaveState,
  isLocked,
  isTerminalSaveError,
  MAX_PRESCRIPTION_ITEMS,
  RETRY_MS,
  subscribeDraftExits,
  trackDraftExit,
} from '../src/lib/draftSaver.ts'

const NOTE = { chiefComplaint: '', history: '', pastHistory: '', examination: '', assessment: '', plan: '', followUp: '' }
const ITEM: PrescriptionItemInput = { drugName: 'Amoxicillin', strength: '500 mg', form: 'Capsule', dose: '1 capsule', route: 'Oral', frequency: 'Three times daily (TDS)', duration: '5 days', instructions: '', durationDays: 5 }

/** What the server answers: the draft it stored, at the next version. */
const answer = (version: number, draft: Partial<Draft> & { note?: Encounter['note'] } = {}, aiInsertions: NoteInsertion[] = []) =>
  ({ version, note: draft.note ?? NOTE, diagnoses: [], prescription: draft.prescription ?? [], aiInsertions }) as unknown as Encounter

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function saverWith(io: Partial<DraftSaverIo> = {}) {
  const sent: { kind: 'draft' | 'insert'; body: Record<string, unknown> }[] = []
  let version = 3
  // The prescription the fake server holds (an insertion answers with the whole consultation, its stored prescription included).
  let stored: PrescriptionItemInput[] = []
  const saver = new DraftSaver(
    { note: NOTE, diagnoses: [], prescription: [], version: 3, aiInsertions: [] },
    {
      saveDraft: async (body) => {
        sent.push({ kind: 'draft', body })
        version = body.version + 1
        stored = body.prescription
        return answer(version, body)
      },
      insert: async (body) => {
        sent.push({ kind: 'insert', body: body as unknown as Record<string, unknown> })
        version = body.version + 1
        return answer(version, { note: { ...NOTE, history: `inserted: ${body.text}` }, prescription: stored }, [{ id: 'i1', subjectType: body.subjectType, subjectId: body.subjectId } as NoteInsertion])
      },
      samePerson: () => true,
      ...io,
    },
  )
  return { saver, sent }
}

const chief = (text: string) => (d: Draft): Draft => ({ ...d, note: { ...d.note, chiefComplaint: text } })

test('the autosave waits after a change, waits longer after a failure, and never runs once nothing more can be saved', () => {
  assert.equal(autosaveDelay('dirty'), AUTOSAVE_MS)
  assert.equal(autosaveDelay('error'), RETRY_MS)
  for (const s of ['saved', 'saving', 'conflict', 'blocked'] as const) assert.equal(autosaveDelay(s), null, s)
  assert.deepEqual(
    (['saved', 'dirty', 'saving', 'error', 'conflict', 'blocked'] as const).filter(isLocked),
    ['conflict', 'blocked'],
  )
  // Why a save failed decides what happens next.
  assert.equal(failedSaveState(new ApiError(409, 'version_conflict', 'x')), 'conflict')
  for (const code of ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation']) assert.equal(failedSaveState(new ApiError(409, code, 'x')), 'blocked', code)
  assert.equal(failedSaveState(new ApiError(403, 'forbidden', 'x')), 'blocked')
  assert.equal(failedSaveState(new ApiError(404, 'not_found', 'x')), 'blocked')
  assert.equal(failedSaveState(new ApiError(500, 'internal', 'x')), 'error')
  assert.equal(failedSaveState(new TypeError('Failed to fetch')), 'error')
  assert.equal(isTerminalSaveError(new ApiError(429, 'rate_limited', 'x')), false)
})

test('one save at a time, with the version the server last gave; edits made during a save are sent after it', async () => {
  const gate = deferred<void>()
  const bodies: { version: number; chief: string }[] = []
  let v = 3
  const { saver } = saverWith({
    saveDraft: async (body) => {
      bodies.push({ version: body.version, chief: body.note.chiefComplaint })
      if (bodies.length === 1) await gate.promise
      v = body.version + 1
      return answer(v, body)
    },
  })
  const states: string[] = []
  saver.subscribe(() => states.push(saver.state))
  assert.equal(saver.update(chief('Fever')), true)
  assert.equal(saver.getSnapshot().state, 'dirty')
  const first = saver.flush()
  await Promise.resolve()
  // While the first save is in flight the doctor types on; a second flush waits for the first.
  saver.update(chief('Fever for 3 days'))
  const second = saver.flush()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(bodies.length, 1, 'never two saves at once')
  gate.resolve()
  await first
  // The first save's answer does not say "saved": the edit made during it is still to send (it is being sent next).
  assert.notEqual(saver.getSnapshot().state, 'saved')
  await second
  assert.deepEqual(bodies, [
    { version: 3, chief: 'Fever' },
    { version: 4, chief: 'Fever for 3 days' },
  ])
  assert.equal(saver.version, 5)
  assert.equal(saver.getSnapshot().state, 'saved')
  assert.ok(saver.getSnapshot().savedAt instanceof Date)
  assert.equal(saver.isDirty, false)
  assert.ok(states.includes('saving'))
  // Nothing pending: a flush sends nothing.
  await saver.flush()
  assert.equal(bodies.length, 2)
})

test('a version conflict stops saving; a refusal that retrying cannot fix blocks it with the server’s words; anything else is retried', async () => {
  const conflict = saverWith({ saveDraft: async () => Promise.reject(new ApiError(409, 'version_conflict', 'Changed elsewhere')) }).saver
  conflict.update(chief('a'))
  assert.equal(await conflict.flushState(), 'conflict')
  assert.equal(conflict.update(chief('b')), false, 'nothing more is accepted')
  assert.equal(conflict.getSnapshot().draft.note.chiefComplaint, 'a')

  const blocked = saverWith({ saveDraft: async () => Promise.reject(new ApiError(409, 'encounter_signed', 'This consultation is already signed.')) }).saver
  blocked.update(chief('a'))
  assert.equal(await blocked.flushState(), 'blocked')
  assert.equal(blocked.getSnapshot().blocked, 'This consultation is already signed.')
  assert.equal(blocked.isDirty, false)

  let fail = true
  const calls: number[] = []
  const flaky = saverWith({
    saveDraft: async (body) => {
      calls.push(body.version)
      if (fail) throw new TypeError('Failed to fetch')
      return answer(body.version + 1, body)
    },
  }).saver
  flaky.update(chief('a'))
  assert.equal(await flaky.flushState(), 'error')
  assert.equal(flaky.isDirty, true, 'kept to be sent again')
  fail = false
  assert.equal(await flaky.flushState(), 'saved')
  assert.deepEqual(calls, [3, 3], 'the retry is sent with the same version')
})

test('nothing is sent for another person who has signed in on this browser since', async () => {
  let same = true
  const { saver, sent } = saverWith({ samePerson: () => same })
  saver.update(chief('Fever'))
  same = false
  await saver.flush()
  assert.equal(sent.length, 0)
  assert.equal(saver.isDirty, false)
})

test('an insertion of reviewed AI text runs after what is pending, on the same chain and version, and the note becomes the server’s', async () => {
  const { saver, sent } = saverWith()
  saver.update((d) => ({ ...d, diagnoses: [{ description: 'Pharyngitis', code: null, kind: 'primary' }] }))
  const seen: boolean[] = []
  saver.subscribe(() => seen.push(saver.getSnapshot().inserting))
  await saver.insert('history', 'Fever for 3 days', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' })
  assert.deepEqual(
    sent.map((s) => [s.kind, s.body.version]),
    [
      ['draft', 3],
      ['insert', 4],
    ],
  )
  assert.equal(saver.getSnapshot().draft.note.history, 'inserted: Fever for 3 days')
  assert.equal(saver.inserted('consultation_item', '00000000-0000-4000-8000-000000000001'), true)
  assert.equal(saver.inserted('consultation_item', '00000000-0000-4000-8000-000000000002'), false)
  assert.equal(saver.getSnapshot().state, 'saved')
  assert.equal(seen[0], true, 'the note is read-only while it runs')
  assert.equal(saver.getSnapshot().inserting, false)
})

test('an insertion refused because the draft changed elsewhere stops the saves, and says why', async () => {
  const { saver } = saverWith({ insert: async () => Promise.reject(new ApiError(409, 'version_conflict', 'Changed')) })
  await assert.rejects(saver.insert('plan', 'Rest', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' }), { code: 'version_conflict' })
  assert.equal(saver.getSnapshot().state, 'conflict')
  // A second insertion is refused at once, without asking the server.
  await assert.rejects(saver.insert('plan', 'Rest', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' }), { code: 'version_conflict' })
})

test('Mana’s approved medicine is one more row of the draft, refused when the prescription is full', () => {
  const d: Draft = { note: NOTE, diagnoses: [], prescription: [] }
  const one = appendPrescriptionItem(d, ITEM)
  assert.deepEqual(one.prescription, [ITEM])
  assert.deepEqual(d.prescription, [], 'the draft given is not changed')
  const full: Draft = { ...d, prescription: Array.from({ length: MAX_PRESCRIPTION_ITEMS }, () => ITEM) }
  assert.throws(() => appendPrescriptionItem(full, ITEM), /at most 30 medicines/)
  // Through the saver: added and to be saved; refused once nothing more can be saved.
  const { saver } = saverWith()
  assert.equal(
    saver.update((x) => appendPrescriptionItem(x, ITEM)),
    true,
  )
  assert.equal(saver.getSnapshot().draft.prescription[0]?.durationDays, 5, 'the course is part of the row the autosave sends')
  assert.equal(saver.getSnapshot().state, 'dirty')
})

test('the prescription the server last stored is kept apart from the edits still to send (what the allergy name check reads)', async () => {
  const { saver } = saverWith()
  assert.deepEqual(saver.getSnapshot().savedPrescription, [])
  saver.update((d) => appendPrescriptionItem(d, ITEM))
  assert.deepEqual(saver.getSnapshot().savedPrescription, [], 'typed, not stored yet')
  assert.equal(saver.getSnapshot().draft.prescription.length, 1)
  await saver.flush()
  assert.deepEqual(saver.getSnapshot().savedPrescription, [ITEM])
  // An insertion answers with the whole consultation: its prescription is the stored one too.
  saver.update((d) => appendPrescriptionItem(d, { ...ITEM, drugName: 'Ibuprofen' }))
  await saver.insert('plan', 'Rest', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' })
  assert.deepEqual(
    saver.getSnapshot().savedPrescription.map((p) => p.drugName),
    ['Amoxicillin', 'Ibuprofen'],
  )
})

test('leaving waits for everything under way: a save in flight, an insertion, and the edits made during them', async () => {
  const saveGate = deferred<void>()
  const insertGate = deferred<void>()
  const sent: string[] = []
  const { saver } = saverWith({
    saveDraft: async (body) => {
      sent.push(`draft:${body.version}:${body.diagnoses.length}`)
      if (sent.length === 1) await saveGate.promise
      return answer(body.version + 1, body)
    },
    insert: async (body) => {
      sent.push(`insert:${body.version}`)
      await insertGate.promise
      return answer(body.version + 1, { note: { ...NOTE, plan: body.text } })
    },
  })
  assert.equal(saver.busy, false)
  // A save in flight: nothing is dirty any more, but leaving now must still wait for it.
  saver.update(chief('Fever'))
  const first = saver.flush()
  await Promise.resolve()
  assert.equal(saver.isDirty, false)
  assert.equal(saver.state, 'saving')
  assert.equal(saver.busy, true, 'a save in flight is still under way')
  let idle = false
  const left = saver.idle().then(() => (idle = true))
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(idle, false)
  saveGate.resolve()
  await first
  await left
  assert.equal(saver.busy, false)

  // An insertion (Add to note) under way, and a diagnosis written meanwhile: leaving waits for the insertion, then saves the diagnosis.
  const inserting = saver.insert('plan', 'Rest', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(saver.busy, true, 'an insertion is under way')
  saver.update((d) => ({ ...d, diagnoses: [{ description: 'Pharyngitis', code: null, kind: 'primary' }] }))
  idle = false
  const left2 = saver.idle().then(() => (idle = true))
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(idle, false, 'not before the insertion has answered')
  insertGate.resolve()
  await inserting
  await left2
  assert.equal(saver.busy, false)
  assert.equal(saver.getSnapshot().draft.note.plan, 'Rest')
  assert.deepEqual(sent, ['draft:3:0', 'insert:4', 'draft:5:1'], 'the diagnosis written during the insertion is saved after it, before leaving')
  assert.equal(saver.state, 'saved')
})

test('an editor going away tracks its last save whenever anything is under way, and Back to the consultation waits for it', () => {
  const hook = fs.readFileSync(new URL('../src/lib/encounterDraft.ts', import.meta.url), 'utf8')
  assert.ok(hook.includes('if (saver.busy) void trackDraftExit(id, saver.idle().then('), 'not only when edits are unsent: a save in flight or an insertion too')
  const page = fs.readFileSync(new URL('../src/pages/doctor/PrescriptionPage.tsx', import.meta.url), 'utf8')
  assert.ok(page.includes('void d.idle().then(() => navigate(consultationUrl(initial.id)))'))
})

test('leaving waits for a refused insertion too, and never rejects', async () => {
  const { saver } = saverWith({ insert: async () => Promise.reject(new ApiError(500, 'internal', 'x')) })
  const refused = saver.insert('plan', 'Rest', { type: 'consultation_item', id: '00000000-0000-4000-8000-000000000001' })
  refused.catch(() => undefined)
  assert.equal(saver.busy, true)
  await saver.idle()
  await assert.rejects(refused)
  assert.equal(saver.busy, false)
  assert.equal(saver.getSnapshot().inserting, false)
})

test('the last save of an editor that went away is tracked until it is done, so the next editor opens on what it stored', async () => {
  const id = 'enc-1'
  let changes = 0
  const off = subscribeDraftExits(() => changes++)
  const save = deferred<void>()
  const done = trackDraftExit(id, save.promise)
  assert.equal(draftExitPending(id), true)
  assert.equal(draftExitPending('enc-2'), false)
  assert.equal(draftExitPending(undefined), false)
  // A second exit of the same consultation waits for the first too.
  const second = deferred<void>()
  const both = trackDraftExit(id, second.promise)
  save.resolve()
  await done
  assert.equal(draftExitPending(id), true, 'still saving: the later exit')
  second.reject(new Error('offline'))
  await both
  assert.equal(draftExitPending(id), false, 'a failed save ends the wait too')
  assert.ok(changes >= 3)
  off()
})
