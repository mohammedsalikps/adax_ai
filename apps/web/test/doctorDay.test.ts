// Unit tests (node --test) of the doctor's day on the client (Home and My consultations, DESIGN §5.1-5.2): which rows a filter keeps, the one
// action of a row, the words beside a status, who just became ready (the patient-ready cue is a diff of two polls), how the trend is scaled
// (never padded, never a fake 100 %), which numbers a period's tiles show (never another period's), the greeting on the facility's clock, when
// a start may arm recording, and the triage note's draft rules. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DoctorDay, DoctorDayTimelineRow } from '@adaxai/contracts'
import {
  ageOnDay,
  completedFrom,
  DOCTOR_DAY_POLL_MS,
  filterCounts,
  filterTimeline,
  firstName,
  greetingAt,
  isNewConsultationStart,
  periodFrom,
  readyArrivals,
  readyMessage,
  readySnapshot,
  rowDetail,
  rowPill,
  stageNote,
  tilesFor,
  TODAY_ACTION_LABELS,
  todayAction,
  todayActionHref,
  trendBars,
  trendDayLabel,
  trendGridColumns,
  trendMinWidthRem,
} from '../src/lib/doctorDay.ts'
import { triageNoteDraft } from '../src/lib/triageNote.ts'

let n = 0
/** A timeline row as the server sends it; only what a test says differs. */
function row(over: Partial<DoctorDayTimelineRow> = {}): DoctorDayTimelineRow {
  n++
  return {
    key: `visit:${n}`,
    status: 'waiting',
    signedToComplete: false,
    time: '09:30',
    scheduledAt: null,
    checkedInAt: '2026-10-06T04:00:00.000Z',
    overdue: false,
    priority: 'normal',
    reason: 'Fever',
    patient: { id: `p${n}`, mrn: `MRN${n}`, fullName: `Patient ${n}`, sex: 'female', dateOfBirth: '1990-10-07', noKnownAllergies: false, activeAllergies: [] },
    visitId: `v${n}`,
    visitStatus: 'waiting',
    encounterId: null,
    encounterStatus: null,
    encounterMine: false,
    appointmentId: null,
    appointmentStatus: null,
    ...over,
  }
}

const counts = { seen: 6, waiting: 4, inConsultation: 2, yetToSee: 8, total: 20, consultations: 30, completed: 27, patients: 25 }

test('the filter keeps All, or exactly the rows whose pill says Waiting or Completed, in the order given, and counts each', () => {
  const rows = [row({ status: 'yet_to_see', visitId: null, visitStatus: null }), row({ visitStatus: 'ready' }), row({ status: 'in_consultation', visitStatus: 'in_consultation' }), row({ status: 'completed', visitStatus: 'completed' }), row({ visitStatus: 'in_triage' })]
  assert.deepEqual(filterTimeline(rows, 'all'), rows)
  assert.deepEqual(filterTimeline(rows, 'waiting').map((r) => r.key), [rows[1]!.key, rows[4]!.key])
  assert.deepEqual(filterTimeline(rows, 'completed').map((r) => r.key), [rows[3]!.key])
  assert.deepEqual(filterCounts(rows), { all: 5, waiting: 2, completed: 1 })
  assert.deepEqual(filterCounts([]), { all: 0, waiting: 0, completed: 0 })
  // A new array: filtering never re-orders or mutates the server's time order.
  assert.notEqual(filterTimeline(rows, 'all'), rows)
})

test('each row offers exactly one action: start a new consultation, continue mine, complete my signed one, open a record, or nothing', () => {
  assert.equal(todayAction(row()), 'start')
  assert.equal(todayAction(row({ visitStatus: 'ready' })), 'start')
  // My draft paused back in the queue is resumed; someone else's is only opened.
  assert.equal(todayAction(row({ encounterId: 'e1', encounterStatus: 'in_progress', encounterMine: true })), 'resume')
  assert.equal(todayAction(row({ encounterId: 'e1', encounterStatus: 'in_progress', encounterMine: false })), 'open')
  assert.equal(todayAction(row({ status: 'in_consultation', visitStatus: 'in_consultation', encounterId: 'e1', encounterStatus: 'in_progress', encounterMine: true })), 'continue')
  assert.equal(todayAction(row({ status: 'in_consultation', visitStatus: 'in_consultation', encounterId: 'e1', encounterStatus: 'signed', encounterMine: true, signedToComplete: true })), 'complete')
  assert.equal(todayAction(row({ status: 'in_consultation', visitStatus: 'in_consultation', encounterId: 'e1', encounterStatus: 'in_progress', encounterMine: false })), null)
  assert.equal(todayAction(row({ status: 'completed', visitStatus: 'completed', encounterId: 'e1', encounterStatus: 'signed' })), 'open')
  assert.equal(todayAction(row({ status: 'completed', visitStatus: 'completed' })), null)
  // Not arrived: no action (check-in is the nurse's).
  assert.equal(todayAction(row({ status: 'yet_to_see', visitId: null, visitStatus: null, appointmentStatus: 'booked' })), null)
  assert.equal(todayAction(row({ status: 'cancelled', visitStatus: 'cancelled' })), null)
  assert.deepEqual(TODAY_ACTION_LABELS, { start: 'Start consultation', resume: 'Continue consultation', continue: 'Continue consultation', complete: 'Complete', open: 'Open' })
  assert.equal(todayActionHref('open', 'e1'), '/doctor/encounters/e1')
  assert.equal(todayActionHref('continue', 'e1'), '/doctor/encounters/e1')
  assert.equal(todayActionHref('complete', 'e1'), '/doctor/encounters/e1/prescription')
})

test('the pill is the queue status, or Signed — to complete; beside it, where the patient is (the visit status’s own words), never colour alone', () => {
  assert.equal(rowPill(row({ visitStatus: 'in_consultation', encounterStatus: 'signed' })), 'signed_to_complete')
  assert.equal(rowPill(row({ visitStatus: 'in_consultation', encounterStatus: 'in_progress' })), 'in_consultation')
  assert.equal(rowPill(row({ visitStatus: 'ready' })), 'waiting')
  assert.equal(rowPill(row({ visitId: null, visitStatus: null, appointmentStatus: 'booked' })), 'yet_to_see')
  assert.equal(stageNote(row({ visitStatus: 'ready' })), 'Ready for doctor')
  assert.equal(stageNote(row({ visitStatus: 'waiting' })), 'With the nurse')
  assert.equal(stageNote(row({ visitStatus: 'in_triage' })), 'With the nurse')
  assert.equal(stageNote(row({ status: 'yet_to_see', visitStatus: null, overdue: true })), 'Overdue')
  assert.equal(stageNote(row({ status: 'yet_to_see', visitStatus: null, overdue: false })), null)
  assert.equal(stageNote(row({ status: 'completed', visitStatus: 'completed' })), null)
})

test('the line under the name is age on the facility’s day · sex · MRN', () => {
  assert.equal(ageOnDay('1990-10-07', '2026-10-06'), 35)
  assert.equal(ageOnDay('1990-10-06', '2026-10-06'), 36)
  assert.equal(ageOnDay('not-a-date', '2026-10-06'), null)
  assert.equal(rowDetail({ dateOfBirth: '1990-10-07', sex: 'female', mrn: 'ADX-000123' }, '2026-10-06'), '35 y · Female · ADX-000123')
  assert.equal(rowDetail({ dateOfBirth: '', sex: 'unknown', mrn: 'ADX-9' }, '2026-10-06'), 'Unknown · ADX-9')
})

test('the patient-ready cue: only patients who became ready since the last poll, nothing on the first answer, each patient once', () => {
  const a = row({ key: 'visit:a', visitStatus: 'in_triage', patient: { ...row().patient, fullName: 'Anaya Demo-Synthetic' } })
  const b = row({ key: 'visit:b', visitStatus: 'ready' })
  const first = [a, b]
  assert.deepEqual(readyArrivals(null, first), [])
  const snap1 = readySnapshot(first)
  assert.deepEqual([...snap1], [['visit:a', 'in_triage'], ['visit:b', 'ready']])
  const second = [{ ...a, visitStatus: 'ready' as const }, b]
  assert.deepEqual(readyArrivals(snap1, second).map((r) => r.key), ['visit:a'])
  // Already announced: the next poll says nothing about it.
  assert.deepEqual(readyArrivals(readySnapshot(second), second), [])
  // A patient who appears already ready (checked in and handed over between two polls) is news too.
  const c = row({ key: 'visit:c', visitStatus: 'ready' })
  assert.deepEqual(readyArrivals(readySnapshot(second), [...second, c]).map((r) => r.key), ['visit:c'])
  // Leaving ready (taken into the consultation) is not.
  assert.deepEqual(readyArrivals(readySnapshot(second), [{ ...a, visitStatus: 'in_consultation' }, b]), [])
  assert.equal(readyMessage(['Anaya Demo-Synthetic']), 'Anaya Demo-Synthetic is ready for you')
  assert.equal(readyMessage(['A B', 'C D']), 'A B and C D are ready for you')
  assert.equal(readyMessage(['A', 'B', 'C']), 'A, B and C are ready for you')
})

test('the trend scales to the tallest day; zeros stay zero (counted, not padded) and an all-zero period draws no bar', () => {
  const points = [
    { date: '2026-10-05', seen: 1, consultations: 4 },
    { date: '2026-10-06', seen: 0, consultations: 0 },
    { date: '2026-10-07', seen: 2, consultations: 3 },
  ]
  assert.deepEqual(trendBars(points, 'consultations'), [
    { date: '2026-10-05', value: 4, percent: 100 },
    { date: '2026-10-06', value: 0, percent: 0 },
    { date: '2026-10-07', value: 3, percent: 75 },
  ])
  assert.deepEqual(trendBars(points, 'seen').map((b) => b.percent), [50, 0, 100])
  assert.deepEqual(trendBars([{ date: '2026-10-01', seen: 0, consultations: 0 }], 'consultations'), [{ date: '2026-10-01', value: 0, percent: 0 }])
  assert.deepEqual(trendBars([], 'consultations'), [])
  // Calendar days, not instants: the label never shifts with the browser's timezone.
  assert.equal(trendDayLabel('2026-10-05', 'week'), 'Mon')
  assert.equal(trendDayLabel('2026-10-05', 'month'), '5')
})

test('a period’s tiles show that period’s numbers only, and "not available" (null) otherwise, never 0 or another period’s', () => {
  const today = tilesFor('today', { period: 'today', counts })
  assert.deepEqual(today.map((t) => [t.label, t.value]), [['Patients seen', 6], ['Waiting', 4], ['Yet to see', 8], ['Total', 20]])
  assert.equal(today[3]!.hint, '2 in consultation')
  assert.equal(tilesFor('today', { period: 'today', counts: { ...counts, inConsultation: 0 } })[3]!.hint, undefined)
  // Changed deliberately (review fix): Week/Month "Patients seen" is counts.seen (completed visits, DESIGN §3), as on Today — was counts.patients.
  const week = tilesFor('week', { period: 'week', counts })
  assert.deepEqual(week.map((t) => [t.label, t.value]), [['Patients seen', 6], ['Consultations', 30], ['Completed', 27], ['Remaining today', 14]])
  assert.equal(week[0]!.hint, 'Completed this week')
  const month = tilesFor('month', { period: 'month', counts })
  assert.deepEqual(month.map((t) => [t.label, t.value]), [['Patients seen', 6], ['Consultations', 30], ['Completed', 27]])
  assert.equal(month[0]!.hint, 'Completed this month')
  // While the week loads, the placeholder is today's answer: its numbers are not shown as the week's.
  assert.deepEqual(tilesFor('week', { period: 'today', counts }).map((t) => t.value), [null, null, null, null])
  assert.deepEqual(tilesFor('today', undefined).map((t) => t.value), [null, null, null, null])
  // Every tile of a period has its own test id, and "Patients seen" (one definition) has the same one on every period.
  for (const tiles of [today, week, month]) assert.equal(new Set(tiles.map((t) => t.testId)).size, tiles.length)
  assert.deepEqual([today[0]!.testId, week[0]!.testId, month[0]!.testId], ['day-seen', 'day-seen', 'day-seen'])
})

test('"Patients seen" means completed on every period: a consultation still in progress never makes it larger than "Completed"', () => {
  // A Monday: one consultation completed, one in progress (two different patients) — Today and Week both say 1 seen.
  const monday = { seen: 1, waiting: 0, inConsultation: 1, yetToSee: 0, total: 2, consultations: 2, completed: 1, patients: 2 }
  assert.equal(tilesFor('today', { period: 'today', counts: monday })[0]!.value, 1)
  assert.equal(tilesFor('week', { period: 'week', counts: monday })[0]!.value, 1)
  // The API's week fixture (seen 2, completed 2, patients 3): "Patients seen 2" beside "Completed 2", never 3.
  const week = tilesFor('week', { period: 'week', counts: { seen: 2, waiting: 0, inConsultation: 0, yetToSee: 0, total: 0, consultations: 3, completed: 2, patients: 3 } })
  assert.deepEqual(week.slice(0, 3).map((t) => t.value), [2, 3, 2])
  for (const period of ['week', 'month'] as const) assert.ok(!tilesFor(period, { period, counts }).some((t) => t.value === counts.patients))
})

test('the trend fits its panel without scrolling from a 1024px screen up, and a week fits a 390px phone; only a phone’s month scrolls', () => {
  // The trend's box: viewport − sidebar (16rem from 1024px) − page padding − the panel's border and padding.
  const panelAt1024 = 1024 - 256 - 2 * 32 - 2 - 2 * 16
  const panelAt390 = 390 - 2 * 16 - 2 - 2 * 16
  const px = (rem: number) => rem * 16
  assert.ok(px(trendMinWidthRem('month', 31)) <= panelAt1024, 'a 31-day month fits at 1024 × 768')
  assert.ok(px(trendMinWidthRem('week', 7)) <= panelAt390, 'a whole week fits at 390')
  // A 31-day month on a phone is wider than its panel: DayTrend then makes the scroller a named, focusable region (keyboard can reach today).
  assert.ok(px(trendMinWidthRem('month', 31)) > panelAt390)
  // Columns never narrower than two printed digits (12px text) need, never wider than the old calm width.
  assert.equal(trendGridColumns('month', 31), 'repeat(31, minmax(1.125rem, 2.25rem))')
  assert.equal(trendGridColumns('week', 2), 'repeat(2, minmax(2.5rem, 4.5rem))')
  assert.equal(trendMinWidthRem('week', 1), 2.5)
  assert.equal(trendMinWidthRem('month', 0), 0)
})

test('the period comes from the URL (anything else is Today); the page polls every 30 s', () => {
  assert.equal(periodFrom('week'), 'week')
  assert.equal(periodFrom('month'), 'month')
  assert.equal(periodFrom('year'), 'today')
  assert.equal(periodFrom(null), 'today')
  assert.equal(DOCTOR_DAY_POLL_MS, 30_000)
})

test('coming back from Complete, the consultation’s row is found by the encounter id in the router state', () => {
  assert.equal(completedFrom({ completedEncounterId: 'e1' }), 'e1')
  assert.equal(completedFrom({ completed: 'e2' }), 'e2')
  assert.equal(completedFrom({ completed: '' }), null)
  assert.equal(completedFrom({ completed: 3 }), null)
  assert.equal(completedFrom(null), null)
  assert.equal(completedFrom('e1'), null)
})

test('the greeting is on the facility’s clock when its timezone is known', () => {
  const at = new Date('2026-10-06T05:30:00Z') // 11:00 in Kolkata, 01:30 in New York, 18:30 in Auckland
  assert.equal(greetingAt(at, 'Asia/Kolkata'), 'Good morning')
  assert.equal(greetingAt(new Date('2026-10-06T08:30:00Z'), 'Asia/Kolkata'), 'Good afternoon')
  assert.equal(greetingAt(at, 'Pacific/Auckland'), 'Good evening')
  assert.match(greetingAt(at, 'Not/AZone'), /^Good (morning|afternoon|evening)$/)
  assert.equal(firstName('Dr. Meera Iyer (synthetic)'), 'Meera')
  assert.equal(firstName(undefined), '')
})

test('only a new start arms recording: the row showed no consultation and the server answered with a fresh draft the doctor can edit', () => {
  const fresh = { status: 'in_progress' as const, canEdit: true, version: 1 }
  assert.equal(isNewConsultationStart({ visitId: 'v1', encounterId: null }, fresh), true)
  // A resume (the row showed a consultation), an unknown caller (a bare visit id or no encounterId), a saved draft, a read-only answer: never.
  assert.equal(isNewConsultationStart({ visitId: 'v1', encounterId: 'e1' }, fresh), false)
  assert.equal(isNewConsultationStart('v1', fresh), false)
  assert.equal(isNewConsultationStart({ visitId: 'v1' }, fresh), false)
  assert.equal(isNewConsultationStart({ visitId: 'v1', encounterId: null }, { ...fresh, version: 3 }), false)
  assert.equal(isNewConsultationStart({ visitId: 'v1', encounterId: null }, { ...fresh, canEdit: false }), false)
  assert.equal(isNewConsultationStart({ visitId: 'v1', encounterId: null }, { ...fresh, status: 'signed' }), false)
})

test('the triage note draft: spaces around it do not count, emptying a saved note is a change (it clears), and 1000 characters is the limit', () => {
  assert.deepEqual(triageNoteDraft(null, ''), { changed: false, tooLong: false, length: 0 })
  assert.deepEqual(triageNoteDraft(null, '   '), { changed: false, tooLong: false, length: 0 })
  assert.deepEqual(triageNoteDraft('Febrile', ' Febrile '), { changed: false, tooLong: false, length: 7 })
  assert.deepEqual(triageNoteDraft('Febrile', ''), { changed: true, tooLong: false, length: 0 })
  assert.equal(triageNoteDraft(undefined, 'x'.repeat(1000)).tooLong, false)
  assert.equal(triageNoteDraft(undefined, 'x'.repeat(1001)).tooLong, true)
})

// Keeps the DoctorDay type honest with the fixture above (a compile-time check only).
const _shape: Pick<DoctorDay, 'timeline'> = { timeline: [row()] }
void _shape
