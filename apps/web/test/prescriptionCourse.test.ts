// Unit tests (node --test) of how a medicine's structured course is written on the printout and in the patient app (HERO final): "5 days from
// 6 Oct 2026" only when both the days and the first day are recorded, the written duration otherwise (and kept when it says more); the
// patient's course line from the course the API computed on the clinic's day; and missing is not none ("Duration not recorded", never
// "Completed"). No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import { medicineCourse } from '@adaxai/contracts'
import { fmtDate } from '../src/lib/format.ts'
import { courseLine, courseTone, durationLines, structuredDuration } from '../src/lib/prescriptionCourse.ts'

test('a structured course reads "n days from <date>"; without days or a first day there is none', () => {
  assert.equal(structuredDuration({ durationDays: 5, startDate: '2026-10-06' }), `5 days from ${fmtDate('2026-10-06')}`)
  assert.equal(structuredDuration({ durationDays: 1, startDate: '2026-10-06' }), `1 day from ${fmtDate('2026-10-06')}`)
  assert.equal(structuredDuration({ durationDays: 5, startDate: null }), null)
  assert.equal(structuredDuration({ durationDays: null, startDate: '2026-10-06' }), null)
  assert.equal(structuredDuration({}), null)
  assert.equal(structuredDuration({ durationDays: 0, startDate: '2026-10-06' }), null)
})

test('the duration cell: the structured course, else the words as written; written words that say more are kept beside it', () => {
  assert.deepEqual(durationLines({ duration: '5 days', durationDays: 5, startDate: '2026-10-06' }), { main: `5 days from ${fmtDate('2026-10-06')}`, written: null })
  assert.deepEqual(durationLines({ duration: '1 Day', durationDays: 1, startDate: '2026-10-06' }), { main: `1 day from ${fmtDate('2026-10-06')}`, written: null })
  assert.deepEqual(durationLines({ duration: '1 week', durationDays: 7, startDate: '2026-10-06' }), { main: `7 days from ${fmtDate('2026-10-06')}`, written: '1 week' })
  // Legacy medicines (signed before the structured course) and courses without a fixed length: as written, nothing invented.
  assert.deepEqual(durationLines({ duration: '3 days' }), { main: '3 days', written: null })
  assert.deepEqual(durationLines({ duration: 'Until review', durationDays: null, startDate: null }), { main: 'Until review', written: null })
})

test('the course line follows the clinic day the API used: day N of M, the last day, after it, before it, and not recorded', () => {
  const item = { durationDays: 7, startDate: '2026-10-04' }
  assert.equal(courseLine(medicineCourse(item, '2026-10-06'), '2026-10-06'), 'Day 3 of 7 · 4 days left')
  assert.equal(courseLine(medicineCourse(item, '2026-10-09'), '2026-10-09'), 'Day 6 of 7 · 1 day left')
  assert.equal(courseLine(medicineCourse(item, '2026-10-10'), '2026-10-10'), 'Day 7 of 7 · Completed')
  assert.equal(courseLine(medicineCourse(item, '2026-10-20'), '2026-10-20'), 'Completed')
  assert.equal(courseLine(medicineCourse(item, '2026-10-03'), '2026-10-03'), `Starts ${fmtDate('2026-10-04')}`)
  // A month and a year boundary on the calendar (no clock, no time zone).
  assert.equal(courseLine(medicineCourse({ durationDays: 21, startDate: '2026-12-25' }, '2027-01-14'), '2027-01-14'), 'Day 21 of 21 · Completed')
  assert.equal(courseLine(medicineCourse({ durationDays: 21, startDate: '2026-12-25' }, '2026-12-25'), '2026-12-25'), 'Day 1 of 21 · 20 days left')
  // Missing is not none.
  for (const legacy of [{}, { durationDays: 5 }, { startDate: '2026-10-04' }, { durationDays: null, startDate: null }]) {
    const c = medicineCourse(legacy, '2026-10-06')
    assert.equal(courseLine(c, '2026-10-06'), 'Duration not recorded')
    assert.equal(courseTone(c), 'muted')
  }
  assert.equal(courseTone(medicineCourse(item, '2026-10-06')), 'active')
  assert.equal(courseTone(medicineCourse(item, '2026-10-03')), 'active')
  assert.equal(courseTone(medicineCourse(item, '2026-10-20')), 'muted')
})
