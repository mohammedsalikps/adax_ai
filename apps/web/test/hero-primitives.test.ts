// Unit tests (node --test) of the Doctor HERO foundation: the status and source vocabulary of the primitives (one word and one tone per
// status, colour never alone; the exact simulated / unverified / AI marks), how a missing count or value is said (never 0, never none), the
// global Mana launcher's event channel, and the draft bridge registry through which an approved Mana action reaches a draft. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { HERO_STATUSES, isMissingValue, SOURCE_KINDS, sourceTagSpec, statusPillSpec, statValue } from '../src/components/hero/spec.ts'
import { type DraftBridge, getDraftBridge, registerDraftBridge } from '../src/lib/draftBridge.ts'
import { closeMana, onCloseMana, onOpenMana, openMana, type OpenManaOptions } from '../src/lib/manaLauncher.ts'

test('every status has its own word and the design tone: Completed ok, Waiting pending, In consultation notice, Yet to see neutral, Signed — to complete brand, Draft and Cancelled neutral', () => {
  assert.deepEqual(
    HERO_STATUSES.map((s) => [s, statusPillSpec(s).label, statusPillSpec(s).tone]),
    [
      ['completed', 'Completed', 'ok'],
      ['waiting', 'Waiting', 'pending'],
      ['in_consultation', 'In consultation', 'notice'],
      ['yet_to_see', 'Yet to see', 'neutral'],
      ['signed_to_complete', 'Signed — to complete', 'brand'],
      ['draft', 'Draft', 'neutral'],
      ['cancelled', 'Cancelled', 'neutral'],
    ],
  )
  // Colour is never the only cue: no two statuses share a word, and every word is non-empty sentence case.
  const labels = HERO_STATUSES.map((s) => statusPillSpec(s).label)
  assert.equal(new Set(labels).size, labels.length)
  for (const l of labels) assert.match(l, /^[A-Z][^A-Z]*$/, `${l} is sentence case`)
})

test('a status the client does not know (a newer server) is shown neutral in its own words, never as another status', () => {
  assert.deepEqual(statusPillSpec('on_hold'), { label: 'On hold', tone: 'neutral' })
  assert.deepEqual(statusPillSpec(''), { label: 'Unknown', tone: 'neutral' })
  // Inherited object keys are not statuses.
  assert.deepEqual(statusPillSpec('toString'), { label: 'ToString', tone: 'neutral' })
})

test('source tags keep the exact existing marks: SIMULATED dashed, Device · UNVERIFIED a solid pending outline, AI DRAFT violet; staff, rules and record neutral', () => {
  assert.deepEqual(
    SOURCE_KINDS.map((k) => [k, sourceTagSpec(k).label, sourceTagSpec(k).look]),
    [
      ['staff', 'Staff', 'neutral'],
      ['device', 'Device · UNVERIFIED', 'outline-pending'],
      ['simulated', 'SIMULATED', 'dashed'],
      ['ai', 'AI DRAFT', 'ai'],
      ['rules', 'Fixed rules', 'neutral'],
      ['record', 'From the record', 'neutral'],
    ],
  )
  // A simulated value and an unverified device are never drawn alike.
  assert.notEqual(sourceTagSpec('simulated').look, sourceTagSpec('device').look)
})

test('a count that is not available is a dash said as "not available", never 0; a real 0 is 0; numbers are grouped the Indian way', () => {
  assert.deepEqual(statValue(null), { text: '—', spoken: 'not available', missing: true })
  assert.deepEqual(statValue(undefined), { text: '—', spoken: 'not available', missing: true })
  assert.deepEqual(statValue(Number.NaN), { text: '—', spoken: 'not available', missing: true })
  assert.deepEqual(statValue(0), { text: '0', spoken: '0', missing: false })
  assert.deepEqual(statValue(18), { text: '18', spoken: '18', missing: false })
  assert.equal(statValue(123456).text, '1,23,456')
})

test('a key/value row is missing only when there is nothing: 0 and false are values, blank text and an empty list are not', () => {
  for (const v of [null, undefined, '', '   ', Number.NaN, []]) assert.equal(isMissingValue(v), true, String(v))
  for (const v of [0, false, 'Penicillin', ['a'], { a: 1 }]) assert.equal(isMissingValue(v), false, String(v))
})

test('openMana reaches every listener with a trimmed question (an empty one is dropped), says whether anyone listened, and stops after unsubscribe', () => {
  assert.equal(openMana(), false, 'no Mana mounted: the caller is told')
  const got: OpenManaOptions[] = []
  const stop = onOpenMana((o) => got.push(o))
  assert.equal(openMana({ ask: '  Summarize this patient’s history  ' }), true)
  assert.equal(openMana({ ask: '   ' }), true)
  assert.equal(openMana(), true)
  assert.deepEqual(got, [{ ask: 'Summarize this patient’s history' }, {}, {}])
  stop()
  stop()
  assert.equal(openMana({ ask: 'x' }), false)
  assert.equal(got.length, 3)
})

test('closeMana reaches the close listeners only; a listener that unsubscribes while called does not stop the others', () => {
  let opened = 0
  const calls: string[] = []
  const stopOpen = onOpenMana(() => opened++)
  let stopA = () => {}
  stopA = onCloseMana(() => {
    calls.push('a')
    stopA()
  })
  const stopB = onCloseMana(() => calls.push('b'))
  closeMana()
  closeMana()
  assert.deepEqual(calls, ['a', 'b', 'b'])
  assert.equal(opened, 0)
  stopB()
  stopOpen()
  closeMana()
  assert.deepEqual(calls, ['a', 'b', 'b'])
})

test('a draft bridge is found by its encounter only while registered; the newest registration wins and removing it falls back to the earlier one', async () => {
  const added: [string, string][] = []
  const bridge = (tag: string): DraftBridge => ({ encounterId: 'enc-1', addPrescriptionItem: (item) => void added.push([tag, item.drugName ?? '']) })
  assert.equal(getDraftBridge('enc-1'), undefined)
  assert.equal(getDraftBridge(undefined), undefined)
  assert.equal(getDraftBridge(''), undefined)

  const offWorkspace = registerDraftBridge(bridge('workspace'))
  const offRx = registerDraftBridge(bridge('prescription'))
  assert.equal(getDraftBridge('enc-2'), undefined, 'another encounter has no bridge')
  await getDraftBridge('enc-1')?.addPrescriptionItem({ drugName: 'Amoxicillin', dose: '500 mg', frequency: 'Three times daily (TDS)', duration: '5 days' })
  assert.deepEqual(added, [['prescription', 'Amoxicillin']])

  offRx()
  offRx()
  await getDraftBridge('enc-1')?.addPrescriptionItem({ drugName: 'Paracetamol' })
  assert.deepEqual(added.at(-1), ['workspace', 'Paracetamol'])

  offWorkspace()
  assert.equal(getDraftBridge('enc-1'), undefined, 'nothing is added once no page holds the draft')
})

test('the same functions registered twice are removed one registration at a time', () => {
  const fn = () => {}
  const offA = registerDraftBridge({ encounterId: 'enc-3', addPrescriptionItem: fn })
  const offB = registerDraftBridge({ encounterId: 'enc-3', addPrescriptionItem: fn })
  offA()
  assert.equal(getDraftBridge('enc-3')?.addPrescriptionItem, fn)
  offB()
  assert.equal(getDraftBridge('enc-3'), undefined)
})
