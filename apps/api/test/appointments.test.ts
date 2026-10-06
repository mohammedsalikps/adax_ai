import crypto from 'node:crypto'
import { Appointment, AppointmentDetail, AppointmentList, AppointmentOptions, CheckInResult, Encounter, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password.ts'
import { addDays, localInstant } from '../src/appointments/schedule.ts'
import { departments, facilities, users } from '../src/db/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD } from './helpers.ts'

/**
 * Slice 4: appointments, booking, rescheduling, check-in and the visit link.
 * Times are on the facility's clock (Asia/Kolkata unless a test changes it).
 */
const ctx = createTestApp()
let fx: Fixture
let nurse = ''
let doctor = ''
let doctor2 = ''
let admin = ''
let today = ''

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  doctor2 = await login(ctx.app, 't.doctor2')
  admin = await login(ctx.app, 't.admin')
  today = AppointmentOptions.parse((await call(ctx.app, 'GET', '/api/appointments/options', { cookie: nurse })).json()).today
})
afterAll(() => ctx.close())

let n = 0
async function newPatient(over: Record<string, unknown> = {}) {
  n++
  return PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Appt${n}`, phone: `95000${String(n).padStart(5, '0')}`, ...over }) })).json())
}
const body = (patientId: string, over: Record<string, unknown> = {}) => ({
  patientId,
  departmentId: fx.departments.gen,
  doctorId: null,
  date: addDays(today, 3),
  time: '10:00',
  durationMinutes: 15,
  reason: null,
  idempotencyKey: crypto.randomUUID(),
  ...over,
})
const book = (b: Record<string, unknown>, cookie = nurse) => call(ctx.app, 'POST', '/api/appointments', { cookie, body: b })
const booked = async (patientId: string, over: Record<string, unknown> = {}) => Appointment.parse((await book(body(patientId, over))).json())
const act = (id: string, action: string, b: Record<string, unknown> = {}, cookie = nurse) => call(ctx.app, 'POST', `/api/appointments/${id}/${action}`, { cookie, body: b })
const detail = async (id: string, cookie = nurse) => AppointmentDetail.parse((await call(ctx.app, 'GET', `/api/appointments/${id}`, { cookie })).json())
const list = async (query: Record<string, string> = {}, cookie = nurse) => AppointmentList.parse((await call(ctx.app, 'GET', '/api/appointments', { cookie, query })).json())
const cancelBody = (a: Appointment, reason = 'Patient asked to cancel') => ({ version: a.version, reason })
const rescheduleBody = (a: Appointment, over: Record<string, unknown> = {}) => ({ version: a.version, date: addDays(today, 5), time: '11:00', reason: 'Patient asked to move it', idempotencyKey: crypto.randomUUID(), ...over })

/** Moves an appointment to a local day and time, as an old or tampered database could hold it (the rules refuse this). */
const moveTo = (id: string, date: string, time: string, tz = 'Asia/Kolkata') =>
  adminQuery(`SET session_replication_role = replica; UPDATE appointments SET scheduled_at = ('${date}'::date + '${time}'::time)::timestamp AT TIME ZONE '${tz}' WHERE id = '${id}'`)
const rows = async (sql: string, params: unknown[] = []) => (await adminQuery(sql, params)).rows as Record<string, any>[]
const audits = async (action: string) => rows('SELECT outcome, patient_id, entity_id, details FROM audit_events WHERE action = $1 ORDER BY id', [action])
const visitCount = async () => (await rows('SELECT count(*)::int AS n FROM visits'))[0]!.n as number

describe('booking', () => {
  it('books a slot on the facility’s clock, with its history, an audit event without free text, and a queued message', async () => {
    const p = await newPatient()
    const res = await book(body(p.id, { doctorId: fx.users.doctor, time: '23:30', reason: 'Chest pain since morning' }))
    expect(res.statusCode).toBe(201)
    const a = Appointment.parse(res.json())
    // 23:30 in Asia/Kolkata (+05:30) is 18:00 UTC the same day.
    expect(a).toMatchObject({ status: 'booked', version: 1, localDate: addDays(today, 3), localTime: '23:30', endsLocalTime: '23:45', durationMinutes: 15, doctorName: 'Test t.doctor', departmentName: 'General Medicine', visit: null, overdue: false, createdByName: 'Test t.nurse', patient: { id: p.id, mrn: p.mrn } })
    expect(a.scheduledAt).toBe(`${addDays(today, 3)}T18:00:00.000Z`)
    expect(a.actions).toEqual({ checkIn: false, reschedule: true, cancel: true, noShow: false })
    const d = await detail(a.id)
    expect(d.history).toEqual([{ from: null, to: 'booked', source: 'booking', reason: null, actorName: 'Test t.nurse', at: expect.any(String) }])
    expect(d.notifications).toEqual([expect.objectContaining({ kind: 'appointment.booked', status: 'undeliverable', failureCode: 'no_active_portal_account', attempts: 1 })])
    const [ev] = await audits('appointment.create')
    expect(ev).toMatchObject({ outcome: 'success', patient_id: p.id, entity_id: a.id })
    expect(JSON.stringify(ev!.details)).not.toMatch(/Chest pain/)
  })

  it('refuses what is not a valid booking, field by field', async () => {
    const p = await newPatient()
    const issue = async (over: Record<string, unknown>, status = 400) => {
      const res = await book(body(p.id, over))
      expect(res.statusCode, JSON.stringify(over)).toBe(status)
      return res.json().issues as { path: string; message: string }[]
    }
    expect((await issue({ date: addDays(today, -1) })).map((i) => i.path)).toEqual(['date'])
    expect((await issue({ date: addDays(today, 181) })).map((i) => i.path)).toEqual(['date'])
    expect((await issue({ time: '10:02' })).map((i) => i.path)).toEqual(['time'])
    expect((await issue({ time: '25:00' })).map((i) => i.path)).toEqual(['time'])
    expect((await issue({ durationMinutes: 17 })).map((i) => i.path)).toEqual(['durationMinutes'])
    expect((await issue({ departmentId: crypto.randomUUID() })).map((i) => i.path)).toEqual(['departmentId'])
    expect((await issue({ doctorId: fx.users.nurse })).map((i) => i.path)).toEqual(['doctorId'])
    // A doctor of another department cannot be booked into this one.
    expect((await issue({ doctorId: fx.users.doctor2 })).map((i) => i.path)).toEqual(['doctorId'])
    expect((await issue({ idempotencyKey: undefined })).map((i) => i.path)).toEqual(['idempotencyKey'])
    expect((await issue({ reason: 'x'.repeat(301) })).map((i) => i.path)).toEqual(['reason'])
    // An inactive doctor, an inactive department.
    await adminQuery("UPDATE users SET is_active = false WHERE username = 't.doctor'")
    expect((await issue({ doctorId: fx.users.doctor })).map((i) => i.path)).toEqual(['doctorId'])
    await adminQuery("UPDATE departments SET is_active = false WHERE code = 'GEN'")
    expect((await issue({})).map((i) => i.path)).toEqual(['departmentId'])
    expect((await rows('SELECT count(*)::int AS n FROM appointments'))[0]!.n).toBe(0)
  })

  it('two bookings cannot hold the same clinician or the same patient at overlapping times, and the refusal names no one', async () => {
    const [a, b] = [await newPatient({ givenName: 'Alpha' }), await newPatient({ givenName: 'Bravo' })]
    await booked(a.id, { doctorId: fx.users.doctor, time: '10:00', durationMinutes: 30 })
    const clash = await book(body(b.id, { doctorId: fx.users.doctor, time: '10:15' }))
    expect([clash.statusCode, clash.json().error]).toEqual([409, 'slot_taken'])
    expect(clash.body).not.toMatch(/Alpha/)
    // The patient cannot be in two places: another clinician does not help; a slot back to back is fine.
    await adminQuery("UPDATE users SET department_id = NULL WHERE username = 't.doctor2'")
    const twice = await book(body(a.id, { doctorId: fx.users.doctor2, time: '10:20' }))
    expect([twice.statusCode, twice.json().error]).toEqual([409, 'patient_double_booked'])
    expect((await book(body(b.id, { doctorId: fx.users.doctor, time: '10:30' }))).statusCode).toBe(201)
    expect((await book(body(b.id, { doctorId: fx.users.doctor, time: '09:45' }))).statusCode).toBe(201)
    // No clinician: no clinician slot is held.
    expect((await book(body((await newPatient()).id, { time: '10:00' }))).statusCode).toBe(201)
    // Cancelling frees the slot.
    const first = list({ scope: 'date', date: addDays(today, 3), status: 'booked' })
    const a1 = (await first).items.find((x) => x.patient?.id === a.id && x.doctorId === fx.users.doctor)!
    await act(a1.id, 'cancel', cancelBody(a1))
    expect((await book(body((await newPatient()).id, { doctorId: fx.users.doctor, time: '10:00' }))).statusCode).toBe(201)
  })

  it('a retried request returns the same appointment; the same key for another booking is refused; twins at once make one', async () => {
    const p = await newPatient()
    const b = body(p.id, { doctorId: fx.users.doctor })
    const first = await book(b)
    const again = await book(b)
    expect([first.statusCode, again.statusCode]).toEqual([201, 200])
    expect(again.json().id).toBe(first.json().id)
    const other = await book({ ...b, time: '10:30' })
    expect([other.statusCode, other.json().error]).toEqual([409, 'idempotency_key_reused'])
    expect((await book({ ...b, patientId: (await newPatient()).id })).json().error).toBe('idempotency_key_reused')
    // Six identical requests at once.
    const q = await newPatient()
    const twin = body(q.id, { time: '14:00' })
    const results = await Promise.all(Array.from({ length: 6 }, () => book(twin)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201])
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1)
    expect((await rows('SELECT count(*)::int AS n FROM appointments'))[0]!.n).toBe(2)
    expect((await rows('SELECT count(*)::int AS n FROM notifications'))[0]!.n).toBe(2)
  })

  it('staff of another facility cannot book your patient, and a patient cannot book at all', async () => {
    const p = await newPatient()
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [d2] = await ctx.db.insert(departments).values({ facilityId: f2!.id, code: 'GEN', name: 'General' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'o.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash: await hashPassword(TEST_PASSWORD), departmentId: d2!.id })
    const other = await login(ctx.app, 'o.nurse')
    const res = await book(body(p.id, { departmentId: d2!.id }), other)
    expect(res.statusCode).toBe(404)
    expect((await rows('SELECT count(*)::int AS n FROM appointments'))[0]!.n).toBe(0)
  })
})

describe('time zones and dates', () => {
  it('the facility’s clock decides the day: an evening booking in a western timezone is next day in UTC but the same local day', async () => {
    await adminQuery("UPDATE facilities SET timezone = 'America/Los_Angeles'")
    const o = AppointmentOptions.parse((await call(ctx.app, 'GET', '/api/appointments/options', { cookie: nurse })).json())
    expect(o.timezone).toBe('America/Los_Angeles')
    const p = await newPatient()
    const day = addDays(o.today, 4)
    const a = Appointment.parse((await book(body(p.id, { date: day, time: '17:30' }))).json())
    expect(a.localDate).toBe(day)
    expect(a.localTime).toBe('17:30')
    // 17:30 Pacific is already the next UTC day.
    expect(a.scheduledAt.slice(0, 10)).toBe(addDays(day, 1))
    expect((await list({ scope: 'date', date: day })).items.map((i) => i.id)).toEqual([a.id])
    expect((await list({ scope: 'date', date: addDays(day, 1) })).items).toEqual([])
    expect((await list({ scope: 'upcoming' })).items.map((i) => i.id)).toEqual([a.id])
  })

  it('a clock time that does not exist is refused, a repeated one resolves to the later occurrence, and India has neither', async () => {
    // Pure conversion, so it does not depend on today's date.
    const ny = 'America/New_York'
    expect(await localInstant(ctx.db, ny, '2027-03-14', '02:30')).toMatchObject({ exists: false })
    expect(await localInstant(ctx.db, ny, '2027-03-14', '03:00')).toMatchObject({ exists: true })
    const repeated = await localInstant(ctx.db, ny, '2026-11-01', '01:30')
    expect(repeated.exists).toBe(true)
    // 01:30 happens twice that night; PostgreSQL takes the later one (standard time, UTC-5).
    expect(repeated.instant.toISOString()).toBe('2026-11-01T06:30:00.000Z')
    const india = await localInstant(ctx.db, 'Asia/Kolkata', '2027-03-14', '02:30')
    expect([india.exists, india.instant.toISOString()]).toEqual([true, '2027-03-13T21:00:00.000Z'])
    // Calendar arithmetic is independent of the timezone.
    expect([addDays('2026-12-31', 1), addDays('2028-03-01', -1), addDays('2026-10-03', 180)]).toEqual(['2027-01-01', '2028-02-29', '2027-04-01'])
  })

  it('a booking at the date boundary lists on its own local day', async () => {
    const p = await newPatient()
    const late = Appointment.parse((await book(body(p.id, { time: '23:55' }))).json())
    const early = Appointment.parse((await book(body((await newPatient()).id, { time: '00:00', date: addDays(today, 4) }))).json())
    expect(late.localDate).toBe(addDays(today, 3))
    expect(early.localDate).toBe(addDays(today, 4))
    expect((await list({ scope: 'date', date: addDays(today, 3) })).items.map((i) => i.id)).toEqual([late.id])
    expect((await list({ scope: 'date', date: addDays(today, 4) })).items.map((i) => i.id)).toEqual([early.id])
  })
})

describe('the schedule', () => {
  it('lists today, upcoming and past by the facility’s days with counts, filters and per-role views', async () => {
    const [a, b, c, d] = [await newPatient(), await newPatient(), await newPatient(), await newPatient()]
    const upcoming = await booked(a.id, { doctorId: fx.users.doctor, time: '09:00', reason: 'Fever' })
    const todays = await booked(b.id, { time: '10:00', reason: 'Cough' })
    const earlier = await booked(c.id, { time: '11:00' })
    const cancelled = await booked(d.id, { time: '12:00' })
    await moveTo(todays.id, today, '23:50')
    await moveTo(earlier.id, addDays(today, -2), '11:00')
    await act(cancelled.id, 'cancel', cancelBody(cancelled))

    const all = (l: AppointmentList) => l.items.map((i) => i.id)
    const t = await list({ scope: 'today' })
    expect([t.today, t.from, t.to, all(t)]).toEqual([today, today, today, [todays.id]])
    expect(all(await list({ scope: 'upcoming' }))).toEqual([upcoming.id, cancelled.id])
    const past = await list({ scope: 'past' })
    expect(all(past)).toEqual([earlier.id])
    expect(past.items[0]).toMatchObject({ overdue: true, actions: { checkIn: false, reschedule: true, cancel: true, noShow: true } })
    expect(all(await list({ scope: 'upcoming', status: 'cancelled' }))).toEqual([cancelled.id])
    expect((await list({ scope: 'upcoming' })).counts).toEqual({ booked: 1, cancelled: 1 })
    expect((await list({ scope: 'upcoming', status: 'booked' })).counts).toEqual({ booked: 1, cancelled: 1 })
    expect((await call(ctx.app, 'GET', '/api/appointments', { cookie: nurse, query: { scope: 'date' } })).statusCode).toBe(400)
    // A doctor's own schedule: assigned to them, or unassigned in their department.
    expect(all(await list({ scope: 'upcoming', mine: 'true' }, doctor))).toEqual([upcoming.id, cancelled.id])
    expect(all(await list({ scope: 'upcoming', mine: 'true' }, doctor2))).toEqual([])
    expect(all(await list({ scope: 'upcoming' }, doctor2))).toEqual([upcoming.id, cancelled.id])
    expect(all(await list({ scope: 'upcoming', doctorId: fx.users.doctor }))).toEqual([upcoming.id])
    // Each read lists the patients it disclosed.
    const [ev] = (await audits('appointment.list')).filter((e) => e.details.scope === 'today')
    expect(ev!.details).toEqual({ scope: 'today', count: 1, patientIds: [b.id] })
  })

  it('administrators see the facility’s schedule without patient identity or free text, and cannot change it', async () => {
    const p = await newPatient()
    const a = await booked(p.id, { doctorId: fx.users.doctor, reason: 'Chest pain' })
    await act(a.id, 'cancel', cancelBody(a, 'Patient is in hospital'))
    const seen = (await list({ scope: 'upcoming' }, admin)).items[0]!
    expect(seen).toMatchObject({ id: a.id, status: 'cancelled', patient: null, reason: null, statusReason: null, doctorName: 'Test t.doctor', actions: { checkIn: false, reschedule: false, cancel: false, noShow: false } })
    const raw = (await call(ctx.app, 'GET', '/api/appointments', { cookie: admin, query: { scope: 'upcoming' } })).body
    expect(raw).not.toMatch(/Chest pain|hospital|Appt\d|mrn/i)
    const [ev] = await audits('appointment.list')
    expect(ev!.details).not.toHaveProperty('patientIds')
    for (const [method, url] of [['GET', `/api/appointments/${a.id}`], ['POST', '/api/appointments'], ['POST', `/api/appointments/${a.id}/cancel`], ['POST', `/api/appointments/${a.id}/check-in`], ['GET', '/api/appointments/options'], ['GET', `/api/patients/${p.id}/appointments`]] as const) {
      expect((await call(ctx.app, method, url, { cookie: admin, ...(method === 'POST' && { body: {} }) })).statusCode, url).toBe(403)
    }
  })

  it('nothing crosses facilities: another facility sees none of it, and probing an id is refused and audited', async () => {
    const p = await newPatient()
    const a = await booked(p.id)
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'o.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash: await hashPassword(TEST_PASSWORD) })
    const other = await login(ctx.app, 'o.nurse')
    expect((await list({ scope: 'upcoming' }, other)).items).toEqual([])
    for (const [method, url, b] of [['GET', `/api/appointments/${a.id}`, undefined], ['POST', `/api/appointments/${a.id}/cancel`, { version: 1, reason: 'probe' }], ['POST', `/api/appointments/${a.id}/check-in`, {}], ['POST', `/api/appointments/${a.id}/reschedule`, rescheduleBody(a)], ['GET', `/api/patients/${p.id}/appointments`, undefined]] as const) {
      expect((await call(ctx.app, method, url, { cookie: other, ...(b && { body: b }) })).statusCode, url).toBe(404)
    }
    expect((await rows("SELECT details FROM audit_events WHERE action = 'access.not_found' AND details->>'reason' = 'other_facility'")).length).toBeGreaterThanOrEqual(4)
    expect((await detail(a.id)).appointment.status).toBe('booked')
  })
})

describe('rescheduling', () => {
  it('books the new time, closes the old one as rescheduled with its reason, and keeps both in the history', async () => {
    const p = await newPatient()
    const old = await booked(p.id, { doctorId: fx.users.doctor, time: '10:00', reason: 'Fever' })
    const res = await act(old.id, 'reschedule', rescheduleBody(old, { time: '10:10' }))
    expect(res.statusCode).toBe(201)
    const next = Appointment.parse(res.json())
    // Moving ten minutes inside the old slot works: the old one is released first.
    expect(next).toMatchObject({ status: 'booked', localTime: '10:10', doctorId: fx.users.doctor, reason: 'Fever', version: 1 })
    const od = await detail(old.id)
    expect(od.appointment).toMatchObject({ status: 'rescheduled', statusReason: 'Patient asked to move it', actions: { reschedule: false, cancel: false } })
    expect(od.history.map((h) => `${h.from ?? '-'}>${h.to}:${h.source}:${h.reason ?? ''}`)).toEqual(['->booked:booking:', 'booked>rescheduled:reschedule:Patient asked to move it'])
    expect(od.next).toMatchObject({ id: next.id, localTime: '10:10' })
    const nd = await detail(next.id)
    expect(nd.previous).toMatchObject({ id: old.id, status: 'rescheduled' })
    expect(nd.history.map((h) => `${h.to}:${h.source}`)).toEqual(['booked:reschedule'])
    expect(nd.notifications.map((x) => x.kind)).toEqual(['appointment.rescheduled'])
    // The schedule shows the replacement, not the closed one.
    expect((await list({ scope: 'upcoming' })).items.map((i) => i.id)).toEqual([next.id])
    expect((await list({ scope: 'upcoming', status: 'rescheduled' })).items.map((i) => i.id)).toEqual([old.id])
    const [ev] = await audits('appointment.reschedule')
    expect(ev!.details).toMatchObject({ replaces: old.id })
    expect(JSON.stringify(ev!.details)).not.toMatch(/moved|Fever/)
  })

  it('a taken slot, the same slot, a stale screen and a closed appointment change nothing and are refused clearly', async () => {
    const [a, b] = [await newPatient(), await newPatient()]
    const one = await booked(a.id, { doctorId: fx.users.doctor, time: '10:00' })
    await booked(b.id, { doctorId: fx.users.doctor, time: '11:00' })
    const clash = await act(one.id, 'reschedule', rescheduleBody(one, { date: addDays(today, 3), time: '11:05' }))
    expect([clash.statusCode, clash.json().error]).toEqual([409, 'slot_taken'])
    expect((await detail(one.id)).appointment).toMatchObject({ status: 'booked', version: 1, localTime: '10:00' })
    expect((await rows('SELECT count(*)::int AS n FROM appointments'))[0]!.n).toBe(2)
    // Nothing was queued for the failed attempt.
    expect((await rows("SELECT count(*)::int AS n FROM notifications WHERE kind = 'appointment.rescheduled'"))[0]!.n).toBe(0)
    const same = await act(one.id, 'reschedule', rescheduleBody(one, { date: addDays(today, 3), time: '10:00' }))
    expect([same.statusCode, same.json().issues[0].path]).toEqual([400, 'time'])
    const stale = await act(one.id, 'reschedule', rescheduleBody(one, { version: 7 }))
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'stale_appointment'])
    expect((await act(one.id, 'reschedule', rescheduleBody(one, { reason: 'x' }))).statusCode).toBe(400)
    const done = await act(one.id, 'reschedule', rescheduleBody(one))
    expect(done.statusCode).toBe(201)
    const closed = await act(one.id, 'reschedule', rescheduleBody(one))
    expect([closed.statusCode, closed.json().error]).toEqual([409, 'appointment_closed'])
    const failures = (await audits('appointment.reschedule')).filter((e) => e.outcome === 'failure').map((e) => e.details.code)
    expect(failures).toEqual(['slot_taken', 'stale_appointment', 'appointment_closed'])
  })

  it('a retried reschedule returns the replacement it made, and a different change under the same key is refused', async () => {
    const p = await newPatient()
    const old = await booked(p.id, { time: '10:00' })
    const b = rescheduleBody(old)
    const first = await act(old.id, 'reschedule', b)
    const again = await act(old.id, 'reschedule', b)
    expect([first.statusCode, again.statusCode, again.json().id]).toEqual([201, 200, first.json().id])
    expect((await act(old.id, 'reschedule', { ...b, time: '11:30' })).json().error).toBe('idempotency_key_reused')
    expect((await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'booked'"))[0]!.n).toBe(1)
  })

  it('two reschedules of one appointment at once: exactly one wins, and a reschedule racing a cancel does too', async () => {
    const p = await newPatient()
    const a = await booked(p.id, { time: '10:00' })
    const results = await Promise.all([act(a.id, 'reschedule', rescheduleBody(a, { time: '12:00' })), act(a.id, 'reschedule', rescheduleBody(a, { time: '13:00' }))])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect((await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'booked'"))[0]!.n).toBe(1)
    expect((await rows("SELECT count(*)::int AS n FROM appointments WHERE rescheduled_from = $1", [a.id]))[0]!.n).toBe(1)

    const q = await newPatient()
    const b = await booked(q.id, { time: '15:00' })
    const race = await Promise.all([act(b.id, 'cancel', cancelBody(b)), act(b.id, 'reschedule', rescheduleBody(b, { time: '16:00' }))])
    expect(race.map((r) => r.statusCode).sort()).toEqual(race.some((r) => r.statusCode === 201) ? [201, 409] : [200, 409])
    const final = await rows('SELECT status FROM appointments WHERE id = $1', [b.id])
    expect(['cancelled', 'rescheduled']).toContain(final[0]!.status)
    expect((await rows("SELECT count(*)::int AS n FROM appointments WHERE status = 'booked' AND patient_id = $1", [q.id]))[0]!.n).toBe(final[0]!.status === 'rescheduled' ? 1 : 0)
  })
})

describe('cancelling and not attending', () => {
  it('cancelling needs a reason and the current version, keeps the reason on the appointment only, and a second cancel is refused and audited', async () => {
    const p = await newPatient()
    const a = await booked(p.id, { time: '10:00' })
    expect((await act(a.id, 'cancel', { version: a.version, reason: 'no' })).statusCode).toBe(400)
    expect((await act(a.id, 'cancel', { version: 9, reason: 'Patient asked to cancel' })).json().error).toBe('stale_appointment')
    const res = await act(a.id, 'cancel', cancelBody(a, 'Patient is in hospital'))
    expect(res.statusCode).toBe(200)
    expect(Appointment.parse(res.json())).toMatchObject({ status: 'cancelled', statusReason: 'Patient is in hospital', version: 2, actions: { checkIn: false, reschedule: false, cancel: false, noShow: false } })
    const second = await act(a.id, 'cancel', cancelBody(a))
    expect([second.statusCode, second.json().error]).toEqual([409, 'appointment_closed'])
    const events = await audits('appointment.cancel')
    // The stale screen, the cancellation, the second attempt: refusals are audited as failures.
    expect(events.map((e) => `${e.outcome}${e.details.code ? `:${e.details.code}` : ''}`)).toEqual(['failure:stale_appointment', 'success', 'failure:appointment_closed'])
    expect(events[1]!.details).toEqual({ scheduledAt: a.scheduledAt })
    expect(JSON.stringify(events)).not.toMatch(/hospital/)
    expect((await detail(a.id)).notifications.map((x) => x.kind)).toEqual(['appointment.booked', 'appointment.cancelled'])
  })

  it('did-not-attend only after the start time, and a closed appointment stays closed', async () => {
    const p = await newPatient()
    const a = await booked(p.id, { time: '10:00' })
    const early = await act(a.id, 'no-show', { version: a.version })
    expect([early.statusCode, early.json().error]).toEqual([409, 'appointment_not_started'])
    await moveTo(a.id, addDays(today, -1), '10:00')
    const now = Appointment.parse((await call(ctx.app, 'GET', `/api/appointments/${a.id}`, { cookie: nurse })).json().appointment)
    expect(now.actions.noShow).toBe(true)
    const res = await act(a.id, 'no-show', { version: now.version, reason: 'Did not come' })
    expect(Appointment.parse(res.json())).toMatchObject({ status: 'no_show', statusReason: 'Did not come' })
    expect((await detail(a.id)).history.at(-1)).toMatchObject({ from: 'booked', to: 'no_show', source: 'no_show', reason: 'Did not come', actorName: 'Test t.nurse' })
    for (const action of ['cancel', 'reschedule', 'no-show', 'check-in']) {
      const r = await act(a.id, action, action === 'cancel' ? cancelBody(a) : action === 'reschedule' ? rescheduleBody(a) : { version: a.version })
      expect(r.statusCode, action).toBe(409)
    }
  })
})

describe('check-in and the visit', () => {
  const todaysAppointment = async (patientId: string, over: Record<string, unknown> = {}, at = '23:00') => {
    const a = await booked(patientId, { doctorId: fx.users.doctor, reason: 'Sore throat', ...over })
    await moveTo(a.id, today, at)
    return a
  }

  it('creates one visit in today’s queue from the appointment, links it, starts no consultation, and records it everywhere', async () => {
    const p = await newPatient()
    const a = await todaysAppointment(p.id)
    expect((await call(ctx.app, 'GET', `/api/appointments/${a.id}`, { cookie: nurse })).json().appointment.actions.checkIn).toBe(true)
    const res = await act(a.id, 'check-in')
    expect(res.statusCode).toBe(200)
    const out = CheckInResult.parse(res.json())
    expect(out.outcome).toBe('created_visit')
    expect(out.appointment).toMatchObject({ status: 'checked_in', visit: { id: out.visit.id, status: 'waiting', tokenNumber: 1 }, actions: { checkIn: false, reschedule: false, cancel: false, noShow: false } })
    const visit = Visit.parse((await call(ctx.app, 'GET', `/api/visits/${out.visit.id}`, { cookie: nurse })).json())
    expect(visit).toMatchObject({ status: 'waiting', departmentId: fx.departments.gen, assignedDoctorId: fx.users.doctor, chiefComplaint: 'Sore throat', encounterId: null, appointment: { id: a.id, localTime: '23:00' } })
    // Nothing else started: no consultation, the patient is not "with doctor".
    expect((await rows('SELECT count(*)::int AS n FROM encounters'))[0]!.n).toBe(0)
    expect(await visitCount()).toBe(1)
    const d = await detail(a.id)
    expect(d.history.at(-1)).toMatchObject({ from: 'booked', to: 'checked_in', source: 'appointment_check_in', actorName: 'Test t.nurse' })
    expect((await rows('SELECT source FROM visit_status_events WHERE visit_id = $1', [out.visit.id])).map((r) => r.source)).toEqual(['appointment_check_in'])
    expect((await audits('visit.create'))[0]!.details).toMatchObject({ appointmentId: a.id, token: 1 })
    expect((await audits('appointment.check_in'))[0]).toMatchObject({ outcome: 'success', entity_id: a.id, details: { visitId: out.visit.id, outcome: 'created_visit' } })
  })

  it('a repeated or simultaneous check-in is the same check-in: one visit, one token', async () => {
    const p = await newPatient()
    const a = await todaysAppointment(p.id)
    const first = CheckInResult.parse((await act(a.id, 'check-in', { version: a.version })).json())
    const again = CheckInResult.parse((await act(a.id, 'check-in')).json())
    expect([first.outcome, again.outcome, again.visit.id]).toEqual(['created_visit', 'already_checked_in', first.visit.id])
    const q = await newPatient()
    const b = await todaysAppointment(q.id, { time: '10:30' }, '22:00')
    const results = await Promise.all(Array.from({ length: 6 }, () => act(b.id, 'check-in')))
    expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200))
    expect(results.map((r) => r.json().outcome).sort()).toEqual(['already_checked_in', 'already_checked_in', 'already_checked_in', 'already_checked_in', 'already_checked_in', 'created_visit'])
    expect(new Set(results.map((r) => r.json().visit.id)).size).toBe(1)
    expect(await visitCount()).toBe(2)
    expect((await rows('SELECT last_token FROM daily_token_counters'))[0]!.last_token).toBe(2)
    // Every check-in request leaves its trace, the repeated ones too (they show who the patient is): one creation, six repeats for the second appointment, one for the first.
    const events = await audits('appointment.check_in')
    const trace = events.map((e) => e.details.outcome)
    expect(trace.filter((o) => o === 'created_visit')).toHaveLength(2)
    expect(trace.filter((o) => o === 'already_checked_in')).toHaveLength(1 + 5)
    // Each repeat names the visit it found, also when it was one of several simultaneous requests.
    const repeats = events.filter((e) => e.details.outcome === 'already_checked_in')
    expect(repeats.map((e) => e.details.visitId).sort()).toEqual([first.visit.id, ...Array(5).fill(results[0]!.json().visit.id)].sort())
  })

  it('joins the patient’s open visit instead of making a second, but not one that belongs to another appointment', async () => {
    const p = await newPatient()
    // A walk-in came first.
    const walkIn = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    const a = await todaysAppointment(p.id)
    const out = CheckInResult.parse((await act(a.id, 'check-in')).json())
    expect([out.outcome, out.visit.id]).toEqual(['linked_open_visit', walkIn.id])
    expect(await visitCount()).toBe(1)
    // A second appointment the same day cannot take the same open visit.
    const b = await todaysAppointment(p.id, { time: '10:30' }, '21:00')
    const clash = await act(b.id, 'check-in')
    expect([clash.statusCode, clash.json().error]).toEqual([409, 'visit_linked_elsewhere'])
    expect((await detail(b.id)).appointment.status).toBe('booked')
    expect((await audits('appointment.check_in')).at(-1)).toMatchObject({ outcome: 'failure', details: { code: 'visit_linked_elsewhere' } })
    // Once the first visit is closed, the second appointment gets its own visit.
    await call(ctx.app, 'POST', `/api/visits/${walkIn.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Patient left' } })
    const next = CheckInResult.parse((await act(b.id, 'check-in')).json())
    expect([next.outcome, next.visit.id === walkIn.id]).toEqual(['created_visit', false])
    expect((await detail(a.id)).appointment.status).toBe('cancelled')
  })

  it('a walk-in check-in and an appointment check-in for the same patient at once leave exactly one open visit', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDatabase()
      fx = await createFixture(ctx.db)
      nurse = await login(ctx.app, 't.nurse')
      const p = await newPatient()
      const a = await todaysAppointment(p.id)
      const [walk, appt] = await Promise.all([call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } }), act(a.id, 'check-in')])
      expect(appt.statusCode, appt.body).toBe(200)
      expect([201, 409]).toContain(walk.statusCode)
      expect((await rows("SELECT count(*)::int AS n FROM visits WHERE status = 'waiting'"))[0]!.n).toBe(1)
      const link = (await rows('SELECT status, visit_id FROM appointments WHERE id = $1', [a.id]))[0]!
      expect(link.status).toBe('checked_in')
      expect(link.visit_id).toBe((await rows('SELECT id FROM visits'))[0]!.id)
    }
  })

  it('only on the appointment’s own day, and never for a closed appointment', async () => {
    const p = await newPatient()
    const future = await booked(p.id, { time: '10:00' })
    const early = await act(future.id, 'check-in')
    expect([early.statusCode, early.json().error]).toEqual([409, 'appointment_wrong_day'])
    const q = await newPatient()
    const old = await booked(q.id, { time: '10:00' })
    await moveTo(old.id, addDays(today, -1), '10:00')
    const late = await act(old.id, 'check-in')
    expect([late.statusCode, late.json().error, late.json().message]).toEqual([409, 'appointment_wrong_day', expect.stringContaining('earlier day')])
    const r = await newPatient()
    const gone = await todaysAppointment(r.id)
    await act(gone.id, 'cancel', cancelBody(gone))
    expect((await act(gone.id, 'check-in')).json().error).toBe('appointment_closed')
    expect(await visitCount()).toBe(0)
    expect((await audits('appointment.check_in')).map((e) => e.details.code)).toEqual(['appointment_wrong_day', 'appointment_wrong_day', 'appointment_closed'])
  })

  it('a checked-in appointment follows its visit: completed when the consultation is completed, cancelled or no-show with the visit; never changed by hand', async () => {
    const [a, b, c] = [await newPatient(), await newPatient(), await newPatient()]
    const [ia, ib, ic] = [await todaysAppointment(a.id, { time: '10:00' }, '09:00'), await todaysAppointment(b.id, { time: '10:15' }, '09:15'), await todaysAppointment(c.id, { time: '10:30' }, '09:30')]
    const visits = await Promise.all([ia, ib, ic].map(async (x) => CheckInResult.parse((await act(x.id, 'check-in')).json()).visit.id))
    // By hand: cancelling, no-show and rescheduling a checked-in appointment are refused.
    for (const action of ['cancel', 'no-show', 'reschedule']) {
      const r = await act(ia.id, action, action === 'cancel' ? cancelBody(ia) : action === 'reschedule' ? rescheduleBody(ia) : { version: 2 })
      expect([r.statusCode, r.json().error], action).toEqual([409, 'appointment_checked_in'])
    }
    // The queue closes two visits.
    await call(ctx.app, 'POST', `/api/visits/${visits[1]}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Patient left' } })
    await call(ctx.app, 'POST', `/api/visits/${visits[2]}/status`, { cookie: nurse, body: { status: 'no_show' } })
    expect(Appointment.parse((await detail(ib.id)).appointment)).toMatchObject({ status: 'cancelled', statusReason: 'Patient left' })
    expect((await detail(ic.id)).appointment.status).toBe('no_show')
    expect((await detail(ib.id)).history.at(-1)).toMatchObject({ from: 'checked_in', to: 'cancelled', source: 'visit_status', reason: 'Patient left' })
    // The queue sent the patient no cancellation message, and the old booking message says nothing about them now: no “patient not told” flag.
    expect((await detail(ib.id)).appointment.patientMessage).toBeNull()
    // The doctor starts and signs the first one.
    await call(ctx.app, 'POST', `/api/visits/${visits[0]}/status`, { cookie: nurse, body: { status: 'ready' } })
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${visits[0]}/encounter`, { cookie: doctor })).json())
    expect((await detail(ia.id)).appointment.status).toBe('checked_in')
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Sore throat', assessment: 'Viral', plan: 'Fluids' }, diagnoses: [{ description: 'Viral pharyngitis', kind: 'provisional' }], prescription: [] } })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    // HERO final (deliberate change): signing leaves the visit, and so the appointment, open; the doctor's Complete closes both.
    expect((await detail(ia.id)).appointment).toMatchObject({ status: 'checked_in', visit: { status: 'in_consultation' } })
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
    const done = await detail(ia.id)
    expect(done.appointment).toMatchObject({ status: 'completed', visit: { status: 'completed' } })
    expect(done.history.at(-1)).toMatchObject({ from: 'checked_in', to: 'completed', source: 'visit_status', actorName: 'Test t.doctor' })
    expect((await act(ia.id, 'check-in')).json().outcome).toBe('already_checked_in')
  })

  it('shows the appointment next to its visit in the queue, and an appointment-less visit stays as it was', async () => {
    const [a, b] = [await newPatient(), await newPatient()]
    const x = await todaysAppointment(a.id, { time: '10:00' }, '09:30')
    await act(x.id, 'check-in')
    await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: b.id, departmentId: fx.departments.gen } })
    const queue = (await call(ctx.app, 'GET', '/api/visits', { cookie: nurse })).json().visits as Visit[]
    expect(queue.map((v) => v.appointment?.localTime ?? 'none').sort()).toEqual(['09:30', 'none'])
    expect(queue.every((v) => Visit.safeParse(v).success)).toBe(true)
  })
})

describe('a patient’s appointments', () => {
  it('lists one patient’s appointments newest first, scoped to the facility and audited', async () => {
    const p = await newPatient()
    const [a, b] = [await booked(p.id, { time: '10:00' }), await booked(p.id, { time: '11:00', date: addDays(today, 4) })]
    const res = await call(ctx.app, 'GET', `/api/patients/${p.id}/appointments`, { cookie: doctor })
    expect(res.statusCode).toBe(200)
    expect(res.json().items.map((i: Appointment) => i.id)).toEqual([b.id, a.id])
    expect((await audits('appointment.patient_list'))[0]).toMatchObject({ patient_id: p.id, details: { count: 2 } })
    expect((await call(ctx.app, 'GET', `/api/patients/${crypto.randomUUID()}/appointments`, { cookie: doctor })).statusCode).toBe(404)
  })
})
