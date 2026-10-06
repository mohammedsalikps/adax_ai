// Unit tests (node --test) of the pure logic behind the consultation's Overview (D2): how each trust is marked (SIMULATED and UNVERIFIED never
// in plain words, never taken for each other), how the pending reviews are grouped by where they are reviewed (and that nothing is said to wait
// for nobody when a kind was not counted), how times are worded on the server's clock, how a LIVE device value is aged (only ever towards STALE)
// and coloured (only a device value as a device state), where a disagreement leads, which items are listed, and which failed reads are tried
// again. No browser, no server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConsultationContext, type ContextConflict, EVIDENCE_TARGETS, EVIDENCE_TRUST, type EvidenceItem, type EvidenceTrust, type PendingReview } from '@adaxai/contracts'
import { ApiError } from '../src/lib/api.ts'
import {
  conflictTargets,
  contextKey,
  EVIDENCE_LIMIT,
  exactTime,
  groupPending,
  INCOMPLETE_REVIEW,
  isLiveDeviceItem,
  newestFirst,
  pendingNotShown,
  relativeTime,
  retryContextRead,
  reviewNotes,
  serverNow,
  shownStatus,
  statusTone,
  TARGET_LABEL,
  targetElementId,
  targetLabel,
  trustLabel,
  trustTone,
  visibleEvidence,
} from '../src/lib/consultationContext.ts'
import { isPartId } from '../src/lib/workspace.ts'

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0)
const iso = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString()

const item = (id: string, at: number, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id,
  kind: 'vital_staff',
  title: `Item ${id}`,
  detail: null,
  at: iso(at),
  status: 'Recorded',
  trust: 'clinician_entered',
  source: 'Nurse (synthetic)',
  provenance: null,
  target: 'history',
  ...over,
})

test('the context lives under the encounter, so that refreshing the encounter refreshes it', () => {
  assert.deepEqual(contextKey('e1'), ['encounter', 'e1', 'context'])
})

test('a simulated value is marked SIMULATED, a device value UNVERIFIED, AI output as AI, a rule-extracted point as to review (not AI), and every other trust in its own words', () => {
  const tones = Object.fromEntries((Object.keys(EVIDENCE_TRUST) as EvidenceTrust[]).map((t) => [t, trustTone(t)]))
  // `extracted` is new in the contract (an important point found by fixed rules, not yet decided): marked for review, never in the AI colour.
  assert.deepEqual(tones, {
    clinician_entered: 'plain',
    doctor_reviewed: 'plain',
    measured: 'plain',
    measured_unverified: 'unverified',
    simulated: 'simulated',
    observed: 'plain',
    extracted: 'review',
    rule_output: 'plain',
    model_output: 'ai',
    recorded: 'plain',
    // Added with the demo consultation (the contract's new trust): synthetic demo audio is marked like a simulator's output.
    synthetic_audio: 'simulated',
  })
  // The words are the contract's; a simulated value says it is not a measurement, and a rule-extracted point is not called AI.
  assert.equal(trustLabel('simulated'), 'SIMULATED, not a measurement')
  assert.equal(trustLabel('recorded'), 'Recorded, not analysed')
  assert.equal(trustLabel('extracted'), 'Extracted from the conversation, to review')
  assert.doesNotMatch(trustLabel('extracted'), /\bAI\b/)
  for (const t of Object.keys(EVIDENCE_TRUST) as EvidenceTrust[]) assert.equal(trustLabel(t), EVIDENCE_TRUST[t])
})

const pending = (over: Partial<PendingReview> = {}): PendingReview => ({ points: 0, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: [], ...over })

test('pending reviews are grouped by where they are reviewed; a part with nothing waiting is left out', () => {
  assert.deepEqual(groupPending(pending()), [])
  assert.deepEqual(groupPending(pending({ points: 3, draftStatements: 1, thermalImages: 1, thermalSummaries: 2 })), [
    { target: 'conversation', count: 3, text: '3 important points to review' },
    { target: 'draft', count: 1, text: '1 AI draft statement to review' },
    { target: 'thermal', count: 3, text: '1 thermal image and 2 thermal summaries to review' },
  ])
  assert.deepEqual(groupPending(pending({ points: 1, thermalSummaries: 1 })), [
    { target: 'conversation', count: 1, text: '1 important point to review' },
    { target: 'thermal', count: 1, text: '1 thermal summary to review' },
  ])
  assert.deepEqual(groupPending(pending({ draftStatements: 4, thermalImages: 2 })), [
    { target: 'draft', count: 4, text: '4 AI draft statements to review' },
    { target: 'thermal', count: 2, text: '2 thermal images to review' },
  ])
})

test('nothing is said to wait unless every kind was counted: a kind that could not be read makes the list incomplete, one not shown is reviewed by the doctor', () => {
  // Everything counted, nothing waits, nothing disagrees: that is said.
  assert.deepEqual(reviewNotes(pending(), 0, []), { nothingWaiting: true, incomplete: null, notShown: null })
  // Something waits, or two sources disagree: not "nothing".
  assert.equal(reviewNotes(pending({ thermalImages: 1 }), 0, []).nothingWaiting, false)
  assert.equal(reviewNotes(pending(), 1, []).nothingWaiting, false)
  // A kind that could not be read: its 0 is not "nothing waits"; the list may be incomplete.
  assert.deepEqual(reviewNotes(pending({ unread: ['thermalSummaries'] }), 0, []), { nothingWaiting: false, incomplete: INCOMPLETE_REVIEW, notShown: null })
  assert.equal(INCOMPLETE_REVIEW, 'Some items could not be read just now, so this list may be incomplete.')
  assert.equal(reviewNotes(pending({ points: 2, unread: ['draftStatements'] }), 0, []).incomplete, INCOMPLETE_REVIEW)
  // A nurse is not shown the important points or the AI draft: her thermal counts stand, and a line says the doctor reviews the rest.
  const nurse = pendingNotShown({ id: 'n1', role: 'nurse' }, 'd1')
  assert.deepEqual(nurse, ['points', 'draftStatements'])
  assert.deepEqual(reviewNotes(pending({ thermalImages: 1, unread: ['points', 'draftStatements'] }), 0, nurse), {
    nothingWaiting: false,
    incomplete: null,
    notShown: 'The conversation’s important points and the AI draft are reviewed by the consultation’s doctor and are not counted in this view.',
  })
  // With nothing else waiting, the nurse is still not told that nothing waits.
  assert.equal(reviewNotes(pending({ unread: ['points', 'draftStatements'] }), 0, nurse).nothingWaiting, false)
  // A doctor who is not the consultation's: the AI draft is not shown; the points are.
  const colleague = pendingNotShown({ id: 'd2', role: 'doctor' }, 'd1')
  assert.deepEqual(colleague, ['draftStatements'])
  assert.deepEqual(reviewNotes(pending({ unread: ['draftStatements'] }), 0, colleague), {
    nothingWaiting: false,
    incomplete: null,
    notShown: 'The AI draft is reviewed by the consultation’s doctor and is not counted in this view.',
  })
  // Not shown and not read at once: both are said.
  const both = reviewNotes(pending({ unread: ['draftStatements', 'thermalImages'] }), 0, colleague)
  assert.equal(both.incomplete, INCOMPLETE_REVIEW)
  assert.match(both.notShown ?? '', /^The AI draft is reviewed/)
  // The consultation's doctor is shown everything: whatever is unread could not be read.
  assert.deepEqual(pendingNotShown({ id: 'd1', role: 'doctor' }, 'd1'), [])
  // No viewer known: nothing is taken to be hidden, so an uncounted kind is never passed over as if nothing waited.
  assert.deepEqual(pendingNotShown(null, 'd1'), [])
  assert.equal(reviewNotes(pending({ unread: ['points'] }), 0, pendingNotShown(undefined, 'd1')).incomplete, INCOMPLETE_REVIEW)
})

test('times are worded for a glance on the server clock, never "now" for something that is not, and the exact time is kept', () => {
  const now = T0
  assert.equal(relativeTime(iso(0), now), 'just now')
  assert.equal(relativeTime(iso(-4), now), 'just now')
  assert.equal(relativeTime(iso(-5), now), 'under a minute ago')
  assert.equal(relativeTime(iso(-59), now), 'under a minute ago')
  assert.equal(relativeTime(iso(-120), now), '2 min ago')
  assert.equal(relativeTime(iso(-3900), now), '1 h 5 min ago')
  assert.equal(relativeTime(iso(-3 * 86_400), now), '3 days ago')
  // A time a little ahead (clock skew) is not a negative age.
  assert.equal(relativeTime(iso(3), now), 'just now')
  // A time that cannot be read is not guessed.
  assert.equal(relativeTime('not a time', now), null)
  assert.equal(exactTime('not a time', now), null)
  assert.match(exactTime(iso(-120), now) ?? '', /\d{1,2}:\d{2}:\d{2}/)
})

test('the server clock is carried forward from when the context arrived, so a wrong local clock does not make an old item look new', () => {
  // Built at T0 by the server, received at local time 1 000 000, now 20 s later on this computer: the server's clock is T0 + 20 s.
  assert.equal(serverNow(iso(0), 1_000_000, 1_020_000), T0 + 20_000)
  // A local clock that goes back does not move the server's clock back.
  assert.equal(serverNow(iso(0), 1_000_000, 990_000), T0)
  // An unreadable server time falls back to this computer's clock.
  assert.equal(serverNow('nope', 1_000_000, 1_020_000), 1_020_000)
})

test('a LIVE device value turns STALE on the screen once older than the device card’s live limit, and nothing is ever made more current', () => {
  const live = item('d1', -10, { kind: 'vital_device', status: 'LIVE', trust: 'measured_unverified', target: 'devices' })
  assert.equal(isLiveDeviceItem(live), true)
  assert.deepEqual(shownStatus(live, T0, 30), { status: 'LIVE', asOfRead: false })
  assert.deepEqual(shownStatus(live, T0 + 20_000, 30), { status: 'LIVE', asOfRead: false })
  assert.deepEqual(shownStatus(live, T0 + 21_000, 30), { status: 'STALE', asOfRead: false })
  // Without the card's limit, it is LIVE only as of the time the context was read, and says so.
  assert.deepEqual(shownStatus(live, T0 + 60_000, null), { status: 'LIVE', asOfRead: true })
  // A simulated LIVE value is aged the same way (its trust mark, not its state, says it is simulated).
  const simulated: EvidenceItem = { ...live, trust: 'simulated' }
  assert.deepEqual(shownStatus(simulated, T0 + 60_000, 30), { status: 'STALE', asOfRead: false })
  // Every other state is shown as the server said it: STALE never becomes LIVE, and a LIVE that is not a device value is not aged.
  const stale = { ...live, status: 'STALE' }
  assert.equal(isLiveDeviceItem(stale), false)
  assert.deepEqual(shownStatus(stale, T0 - 60_000, 30), { status: 'STALE', asOfRead: false })
  assert.deepEqual(shownStatus(item('p1', -600, { kind: 'point', status: 'To review' }), T0, 30), { status: 'To review', asOfRead: false })
  assert.deepEqual(shownStatus(item('t1', -600, { kind: 'transcript', status: 'LIVE' }), T0, 30), { status: 'LIVE', asOfRead: false })
  // Decided by the kind and the state, never by the shape of the id (a device item's id is stable per device and kind: vital_device:<device>:<kind>).
  assert.equal(isLiveDeviceItem(item('vital_device:00000000-0000-4000-8000-000000000009:spo2', -10, { kind: 'vital_device', status: 'LIVE' })), true)
  assert.equal(isLiveDeviceItem(item('vital_device:42', -10, { kind: 'transcript', status: 'LIVE' })), false)
})

test('only a device value is coloured as a device state: a conversation left "Live" is never drawn as a device sending now', () => {
  assert.equal(statusTone('vital_device', 'LIVE'), 'live')
  assert.equal(statusTone('vital_device', ' live '), 'live')
  assert.equal(statusTone('vital_device', 'STALE'), 'stale')
  assert.equal(statusTone('vital_device', 'DISCONNECTED'), 'disconnected')
  // A simulator's states are not a device's: neutral (the SIMULATED mark says what it is).
  assert.equal(statusTone('vital_device', 'SIMULATED'), 'plain')
  assert.equal(statusTone('vital_device', 'SIMULATED · STALE'), 'plain')
  assert.equal(statusTone('vital_device', 'NO DATA'), 'plain')
  // Every other kind, whatever its word: neutral.
  assert.equal(statusTone('transcript', 'Live'), 'plain')
  assert.equal(statusTone('transcript', 'LIVE'), 'plain')
  assert.equal(statusTone('stethoscope', 'STALE'), 'plain')
  assert.equal(statusTone('thermal', 'DISCONNECTED'), 'plain')
  assert.equal(statusTone('point', 'Extracted draft'), 'plain')
})

test('a disagreement leads to the parts that hold its two sides, each once; by its kind when its items are not listed', () => {
  const evidence = [item('vital_staff:1', -300, { target: 'history' }), item('vital_device:2', -20, { kind: 'vital_device', target: 'devices' }), item('vital_device:3', -10, { kind: 'vital_device', target: 'devices' })]
  const conflict = (over: Partial<ContextConflict>): ContextConflict => ({ id: 'c1', kind: 'vital_staff_vs_device', text: 'SpO₂ 97 % entered by staff; 91 % from a device', itemIds: [], rule: 'context-conflicts-v1', ...over })
  assert.deepEqual(conflictTargets(conflict({ itemIds: ['vital_staff:1', 'vital_device:2', 'vital_device:3'] }), evidence), ['history', 'devices'])
  assert.deepEqual(conflictTargets(conflict({ itemIds: ['vital_device:3'] }), evidence), ['devices'])
  // Items not in the evidence (an allergy entry, a record item): where that kind of record is.
  assert.deepEqual(conflictTargets(conflict({ kind: 'allergy_status', itemIds: ['allergy:9'] }), evidence), ['history'])
  assert.deepEqual(conflictTargets(conflict({ kind: 'draft_conflict' }), evidence), ['draft'])
  assert.deepEqual(conflictTargets(conflict({ kind: 'point_vs_record' }), evidence), ['conversation', 'history'])
})

test('every target leads to a part of the consultation page, named as the page names it', () => {
  // Changed with the Doctor HERO workspace (deliberately, not weakened): the tools column became the five-module inputs rail, the AI draft moved
  // to the Mana result and Mana to Ask Mana at its foot, and the stethoscope got a module of its own. The server's targets are unchanged
  // (apps/api/test/consultation-context.test.ts), so the page maps each one to where it now is; every target still leads to exactly one part.
  assert.equal(targetElementId('note'), 'consultation-note')
  assert.equal(targetElementId('draft'), 'mana-result')
  assert.equal(targetElementId('mana'), 'mana-chat')
  for (const t of ['history', 'conversation', 'devices', 'thermal'] as const) assert.equal(targetElementId(t), `tools-${t}`)
  for (const t of EVIDENCE_TARGETS) assert.ok(isPartId(targetElementId(t)), `${t} leads to a part of the page`)
  // A stethoscope recording leads to its own module whatever target the server gave it, and is named so; other kinds go where their target is.
  assert.equal(targetElementId('devices', 'stethoscope'), 'tools-stethoscope')
  assert.equal(targetLabel('devices', 'stethoscope'), 'Stethoscope')
  assert.equal(targetElementId('devices', 'vital_device'), 'tools-devices')
  assert.equal(targetLabel('devices', 'vital_device'), 'Devices')
  assert.equal(targetElementId('draft', 'ai_draft'), 'mana-result')
  assert.equal(targetElementId('note', 'note_insertion'), 'consultation-note')
  assert.deepEqual(Object.keys(TARGET_LABEL).sort(), [...EVIDENCE_TARGETS].sort())
  // Was 'AI draft': the draft is now shown as the Mana result, and the label says where the doctor arrives.
  assert.equal(TARGET_LABEL.draft, 'Mana result')
  for (const t of EVIDENCE_TARGETS) assert.equal(targetLabel(t), TARGET_LABEL[t])
})

test('the newest items are listed first and only the newest eight until "Show all"; a SIMULATED item out of sight is counted', () => {
  // Unreadable times go last; the same time keeps the server's order.
  assert.deepEqual(
    newestFirst([item('a', -60), item('b', 0), item('c', -60), { ...item('d', 0), at: 'unknown' }]).map((i) => i.id),
    ['b', 'a', 'c', 'd'],
  )
  const many = Array.from({ length: 11 }, (_, n) => item(`i${n}`, -n * 60, n >= 9 ? { trust: 'simulated' } : {}))
  const few = visibleEvidence(many, false)
  assert.equal(EVIDENCE_LIMIT, 8)
  assert.deepEqual(few.shown.map((i) => i.id), ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7'])
  assert.equal(few.hidden, 3)
  assert.equal(few.hiddenSimulated, 2)
  const all = visibleEvidence(many, true)
  assert.equal(all.shown.length, 11)
  assert.equal(all.hidden, 0)
  assert.equal(all.hiddenSimulated, 0)
  assert.deepEqual(visibleEvidence([], false), { shown: [], hidden: 0, hiddenSimulated: 0 })
})

test('an answer is read through the contract: one the screen does not understand is refused, not drawn half right', () => {
  const good = {
    encounterId: '00000000-0000-4000-8000-000000000001',
    patientId: '00000000-0000-4000-8000-000000000002',
    generatedAt: iso(0),
    reasonForVisit: null,
    evidence: [item('point:1', -60, { kind: 'point', status: 'To review', trust: 'observed', target: 'conversation' })],
    conflicts: [],
    pending: { points: 1, draftStatements: 0, thermalImages: 0, thermalSummaries: 0, unread: [] },
    missing: ['Vital signs'],
    summary: { composer: 'multimodal-summary-v1', sections: [] },
    rules: { conflicts: 'context-conflicts-v1', summary: 'multimodal-summary-v1' },
  }
  assert.equal(ConsultationContext.safeParse(good).success, true)
  // A trust the screen has no mark for is not shown as if it were a known one.
  assert.equal(ConsultationContext.safeParse({ ...good, evidence: [{ ...good.evidence[0], trust: 'verified' }] }).success, false)
  // Pending counts that do not say which kinds went uncounted (an older server) are refused: a 0 could then be taken for "nothing waits".
  const { unread: _unread, ...olderPending } = good.pending
  assert.equal(ConsultationContext.safeParse({ ...good, pending: olderPending }).success, false)
  assert.equal(ConsultationContext.safeParse({ ...good, pending: { ...good.pending, unread: ['notes'] } }).success, false)
})

test('a failed read is tried again up to twice, but not an answer that does not match the contract, nor a refusal', () => {
  const mismatch = ConsultationContext.safeParse({ encounterId: 'not a uuid' }).error
  assert.ok(mismatch)
  // Client and server of different versions: the same answer would come back on every try.
  assert.equal(retryContextRead(0, mismatch), false)
  for (const status of [400, 403, 404, 409]) assert.equal(retryContextRead(0, new ApiError(status, 'x', 'refused')), false)
  // The server or the network failed: tried again, twice at most.
  for (const e of [new ApiError(500, 'internal', 'failed'), new ApiError(503, 'service_unavailable', 'down'), new ApiError(0, 'network_error', 'offline'), new Error('unknown')]) {
    assert.equal(retryContextRead(0, e), true)
    assert.equal(retryContextRead(1, e), true)
    assert.equal(retryContextRead(2, e), false)
  }
})
