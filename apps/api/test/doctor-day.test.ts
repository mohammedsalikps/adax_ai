import crypto from 'node:crypto'
import { type AppointmentList, DoctorDay, doctorQueueSortKey, PatientDetail, type Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

/**
 * Doctor HERO final: GET /api/doctor/day (DESIGN §3, contracts doctorDay.ts). The counts, the trend and today's patients of the signed-in
 * doctor, in the one status vocabulary, with the same "mine" as the visits and appointments routes, on the facility's calendar (its timezone,
 * never the server's or the browser's), audited with counts and patient ids only.
 */
const ctx = createTestApp()
/** The same application on a clock the test sets (the route reads "now" from its clock; the database keeps its own). */
let fixedNow = Date.now()
const at = createTestApp({ clock: () => fixedNow })
let fx: Fixture
let nurse = ''
let doctor = ''
let doctor2 = ''

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  doctor2 = await login(ctx.app, 't.doctor2')
})
afterAll(async () => {
  await ctx.close()
  await at.close()
})

let seq = 0
async function newPatient(givenName: string) {
  seq++
  const res = await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName, phone: `93000${String(seq).padStart(5, '0')}` }) })
  return PatientDetail.parse(res.json())
}
async function checkIn(patientId: string, over: Record<string, unknown> = {}): Promise<Visit> {
  const res = await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId, departmentId: fx.departments.gen, chiefComplaint: 'Fever for two days', ...over } })
  expect(res.statusCode).toBe(201)
  return res.json()
}
const setStatus = (visitId: string, status: string, reason?: string) => call(ctx.app, 'POST', `/api/visits/${visitId}/status`, { cookie: nurse, body: { status, reason } })
const startConsultation = async (visitId: string, cookie = doctor) => (await call(ctx.app, 'POST', `/api/visits/${visitId}/encounter`, { cookie })).json() as { id: string }
const getDay = async (app: typeof ctx.app, cookie: string, period?: string) => {
  const res = await call(app, 'GET', '/api/doctor/day', { cookie, query: period ? { period } : undefined })
  expect(res.statusCode).toBe(200)
  return DoctorDay.parse(res.json())
}

/** A state the application only reaches through other units (or no longer produces), forced as the test superuser without triggers. */
const legacy = (sql: string) => adminQuery(`SET session_replication_role = replica; ${sql}`)
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`)

let token = 100
async function insertVisit(o: { patientId: string; date: string; status: string; dept?: string; doctorId?: string | null; checkedInAt?: string }): Promise<string> {
  const id = crypto.randomUUID()
  const checkedInAt = o.checkedInAt ?? `${o.date}T05:00:00Z`
  await legacy(
    `INSERT INTO visits (id, facility_id, patient_id, department_id, assigned_doctor_id, visit_date, token_number, status, checked_in_at, status_changed_at)
     VALUES ('${id}', '${fx.facilityId}', '${o.patientId}', '${o.dept ?? fx.departments.gen}', ${q(o.doctorId ?? null)}, '${o.date}', ${token++}, '${o.status}', '${checkedInAt}', '${checkedInAt}')`,
  )
  return id
}
async function insertEncounter(o: { visitId: string; patientId: string; status: 'in_progress' | 'signed' | 'discarded'; doctorId?: string; startedAt: string }): Promise<string> {
  const id = crypto.randomUUID()
  const doctorId = o.doctorId ?? fx.users.doctor
  const signed = o.status === 'signed' ? `'${o.startedAt}', '{}'::jsonb, 'x'` : 'NULL, NULL, NULL'
  const discarded = o.status === 'discarded' ? `'${o.startedAt}', '${doctorId}', 'Started on the wrong patient'` : 'NULL, NULL, NULL'
  await legacy(
    `INSERT INTO encounters (id, facility_id, patient_id, visit_id, doctor_id, status, started_at, signed_at, signed_snapshot, content_hash, discarded_at, discarded_by, discard_reason)
     VALUES ('${id}', '${fx.facilityId}', '${o.patientId}', '${o.visitId}', '${doctorId}', '${o.status}', '${o.startedAt}', ${signed}, ${discarded})`,
  )
  return id
}
/** An appointment at an instant given as SQL (so a test can say "today 23:55 at the clinic"). */
async function insertAppointment(o: { patientId: string; atSql: string; status?: string; dept?: string; doctorId?: string | null; reason?: string }): Promise<string> {
  const id = crypto.randomUUID()
  const status = o.status ?? 'booked'
  await legacy(
    `INSERT INTO appointments (id, facility_id, patient_id, department_id, doctor_id, scheduled_at, duration_minutes, status, status_reason, reason, created_by)
     VALUES ('${id}', '${fx.facilityId}', '${o.patientId}', '${o.dept ?? fx.departments.gen}', ${q(o.doctorId ?? null)}, ${o.atSql}, 15, '${status}', ${status === 'cancelled' ? "'Patient called'" : 'NULL'}, ${q(o.reason ?? null)}, '${fx.users.nurse}')`,
  )
  return id
}
/** "Today at HH:MM at the clinic" (Asia/Kolkata, the fixture facility's timezone), as SQL, on the database's own clock. */
const clinicToday = (hhmm: string, plusDays = 0) => `(((now() at time zone 'Asia/Kolkata')::date + ${plusDays}) + time '${hhmm}') at time zone 'Asia/Kolkata'`

describe('today: one vocabulary and the same "mine" as the visits and appointments routes', () => {
  it('counts and lists today’s patients of the doctor as Completed, In consultation, Waiting and Yet to see, in time order', async () => {
    const pA = await newPatient('Waits')
    const pB = await newPatient('Ready')
    const pC = await newPatient('Withme')
    const pD = await newPatient('Done')
    const pE = await newPatient('Signed')
    const pF = await newPatient('Mineped')
    const pG = await newPatient('Otherdept')
    const pH = await newPatient('Otherdoc')
    const pI = await newPatient('Cancelled')
    const pJ = await newPatient('Later')
    const pK = await newPatient('Apptother')
    const pL = await newPatient('Apptcancel')
    const pM = await newPatient('Tomorrow')
    const pN = await newPatient('Earlybird')

    const vA = await checkIn(pA.id) // unassigned in my department: mine, waiting
    const vB = await checkIn(pB.id)
    await call(ctx.app, 'POST', `/api/visits/${vB.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 38.1 }] } })
    expect((await setStatus(vB.id, 'ready')).statusCode).toBe(200)
    const vC = await checkIn(pC.id)
    const eC = await startConsultation(vC.id)
    const vD = await checkIn(pD.id)
    const eD = await startConsultation(vD.id)
    // Completed (whether signing or the explicit Complete step got it there is the Encounters unit's business).
    await legacy(`UPDATE encounters SET status = 'signed', signed_at = now(), signed_snapshot = '{}'::jsonb, content_hash = 'x' WHERE id = '${eD.id}'; UPDATE visits SET status = 'completed' WHERE id = '${vD.id}'`)
    const vE = await checkIn(pE.id)
    const eE = await startConsultation(vE.id)
    // Signed, not completed yet: still in consultation, "Signed — to complete".
    await legacy(`UPDATE encounters SET status = 'signed', signed_at = now(), signed_snapshot = '{}'::jsonb, content_hash = 'x' WHERE id = '${eE.id}'`)
    const vF = await checkIn(pF.id, { departmentId: fx.departments.ped, assignedDoctorId: fx.users.doctor }) // another department, assigned to me
    await checkIn(pG.id, { departmentId: fx.departments.ped }) // unassigned in another department: not mine
    await checkIn(pH.id, { assignedDoctorId: fx.users.doctor2 }) // my department, another doctor's: not mine
    const vI = await checkIn(pI.id)
    expect((await setStatus(vI.id, 'cancelled', 'Left before being seen')).statusCode).toBe(200)

    const aJ = await insertAppointment({ patientId: pJ.id, atSql: clinicToday('23:55'), reason: 'Follow-up of asthma' }) // later today
    await insertAppointment({ patientId: pK.id, atSql: clinicToday('11:00'), dept: fx.departments.ped, doctorId: fx.users.doctor2 }) // not mine
    await insertAppointment({ patientId: pL.id, atSql: clinicToday('12:00'), status: 'cancelled' })
    await insertAppointment({ patientId: pM.id, atSql: clinicToday('10:00', 1) }) // tomorrow
    const aN = await insertAppointment({ patientId: pN.id, atSql: clinicToday('00:00'), dept: fx.departments.ped, doctorId: fx.users.doctor }) // mine, already overdue

    const day = await getDay(ctx.app, doctor)
    expect(day.period).toBe('today')
    expect(day.timezone).toBe('Asia/Kolkata')
    expect([day.from, day.to]).toEqual([day.today, day.today])
    expect(day.counts).toMatchObject({ seen: 1, waiting: 3, inConsultation: 2, yetToSee: 2, total: 8 })
    expect(day.trend).toEqual([{ date: day.today, seen: 1, consultations: 3 }])
    expect(day.counts).toMatchObject({ consultations: 3, completed: 1, patients: 3 })

    const byPatient = new Map(day.timeline.map((r) => [r.patient.id, r]))
    expect(day.timeline).toHaveLength(8)
    expect(byPatient.get(pA.id)).toMatchObject({ key: `visit:${vA.id}`, status: 'waiting', visitStatus: 'waiting', encounterId: null, signedToComplete: false })
    expect(byPatient.get(pB.id)).toMatchObject({ status: 'waiting', visitStatus: 'ready', reason: 'Fever for two days' })
    expect(byPatient.get(pC.id)).toMatchObject({ status: 'in_consultation', encounterId: eC.id, encounterStatus: 'in_progress', encounterMine: true, signedToComplete: false })
    expect(byPatient.get(pD.id)).toMatchObject({ status: 'completed', encounterId: eD.id, encounterStatus: 'signed' })
    expect(byPatient.get(pE.id)).toMatchObject({ status: 'in_consultation', encounterStatus: 'signed', signedToComplete: true })
    expect(byPatient.get(pF.id)).toMatchObject({ key: `visit:${vF.id}`, status: 'waiting' })
    expect(byPatient.get(pJ.id)).toMatchObject({ key: `appointment:${aJ}`, status: 'yet_to_see', visitId: null, appointmentStatus: 'booked', time: '23:55', checkedInAt: null, reason: 'Follow-up of asthma' })
    expect(byPatient.get(pN.id)).toMatchObject({ key: `appointment:${aN}`, status: 'yet_to_see', time: '00:00', overdue: true })
    // Overdue is decided on the same "now" as the rest of the answer (a booked appointment whose time has passed).
    expect(byPatient.get(pJ.id)!.overdue).toBe(Date.parse(byPatient.get(pJ.id)!.scheduledAt!) <= Date.parse(day.generatedAt))
    for (const p of [pG, pH, pI, pK, pL, pM]) expect(byPatient.has(p.id), p.givenName).toBe(false)
    // The patient's identity and allergy status travel with the row (no second request per row).
    expect(byPatient.get(pA.id)!.patient).toMatchObject({ mrn: pA.mrn, fullName: 'Waits Narayanan', sex: 'female', dateOfBirth: '1985-04-12', noKnownAllergies: false, activeAllergies: [] })

    // Time order: the appointment's time, else the check-in time (urgent patients are not moved).
    const keys = day.timeline.map(doctorQueueSortKey)
    expect([...keys].sort((x, y) => x - y)).toEqual(keys)
    expect(day.timeline[0]!.patient.id).toBe(pN.id)

    // The same "mine" as GET /api/visits?mine=true (cancelled visits are not the doctor's day) …
    const visits = (await call(ctx.app, 'GET', '/api/visits', { cookie: doctor, query: { mine: 'true' } })).json().visits as Visit[]
    expect(day.timeline.flatMap((r) => (r.visitId ? [r.visitId] : [])).sort()).toEqual(visits.filter((v) => v.status !== 'cancelled' && v.status !== 'no_show').map((v) => v.id).sort())
    // … and as GET /api/appointments?scope=today&mine=true (booked, not arrived).
    const appts = (await call(ctx.app, 'GET', '/api/appointments', { cookie: doctor, query: { scope: 'today', mine: 'true' } })).json() as AppointmentList
    expect(day.timeline.flatMap((r) => (r.appointmentId && !r.visitId ? [r.appointmentId] : [])).sort()).toEqual(appts.items.filter((a) => a.status === 'booked' && !a.visit).map((a) => a.id).sort())

    // The visit list carries the consultation's status, so My consultations can say "Signed — to complete" there too.
    const vById = new Map(visits.map((v) => [v.id, v]))
    expect(vById.get(vE.id)).toMatchObject({ status: 'in_consultation', encounterId: eE.id, encounterStatus: 'signed' })
    expect(vById.get(vC.id)).toMatchObject({ encounterStatus: 'in_progress' })
    expect(vById.get(vA.id)).toMatchObject({ encounterId: null, encounterStatus: null, triageNote: null, triageNoteBy: null, triageNoteAt: null })

    // Another doctor's day is theirs: doctor2 (Paediatrics) has the unassigned Paediatrics visit, their own visit and their own appointment.
    const other = await getDay(ctx.app, doctor2)
    expect(other.timeline.map((r) => r.patient.id).sort()).toEqual([pG.id, pH.id, pK.id].sort())
    expect(other.counts).toMatchObject({ seen: 0, waiting: 2, inConsultation: 0, yetToSee: 1, total: 3, consultations: 0 })
  })

  it('is the doctor’s alone: nurses and administrators are refused, and an unknown period is a validation error', async () => {
    expect((await call(ctx.app, 'GET', '/api/doctor/day', { cookie: nurse })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/doctor/day', { cookie: await login(ctx.app, 't.admin') })).statusCode).toBe(403)
    const bad = await call(ctx.app, 'GET', '/api/doctor/day', { cookie: doctor, query: { period: 'year' } })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('validation_error')
    const empty = await getDay(ctx.app, doctor)
    // Nothing today is a counted zero (the server never pads, never leaves a count out).
    expect(empty.counts).toEqual({ seen: 0, waiting: 0, inConsultation: 0, yetToSee: 0, total: 0, consultations: 0, completed: 0, patients: 0 })
    expect(empty.timeline).toEqual([])
  })
})

describe('the facility’s calendar', () => {
  it('decides "today" and its boundaries in the facility’s timezone, whatever the server’s clock says the UTC date is', async () => {
    const atDoctor = await login(at.app, 't.doctor')
    const [p1, p2, p3, p4, p5, p6] = [await newPatient('Oct6visit'), await newPatient('Oct5visit'), await newPatient('Justafter'), await newPatient('Justbefore'), await newPatient('Lateoct6'), await newPatient('Midnight')]
    // 2026-10-05 19:00 UTC is 00:30 on 6 October in Kolkata, and 15:00 on 5 October in New York.
    fixedNow = Date.parse('2026-10-05T19:00:00Z')
    await insertVisit({ patientId: p1.id, date: '2026-10-06', status: 'waiting', checkedInAt: '2026-10-05T18:50:00Z' })
    await insertVisit({ patientId: p2.id, date: '2026-10-05', status: 'completed', doctorId: fx.users.doctor, checkedInAt: '2026-10-05T08:00:00Z' })
    await insertAppointment({ patientId: p3.id, atSql: `'2026-10-05T18:45:00Z'` }) // 00:15 on the 6th in Kolkata; 14:45 on the 5th in New York
    await insertAppointment({ patientId: p4.id, atSql: `'2026-10-05T18:25:00Z'` }) // 23:55 on the 5th in Kolkata; 14:25 on the 5th in New York
    await insertAppointment({ patientId: p5.id, atSql: `'2026-10-06T18:25:00Z'` }) // 23:55 on the 6th in Kolkata
    await insertAppointment({ patientId: p6.id, atSql: `'2026-10-06T18:30:00Z'` }) // 00:00 on the 7th in Kolkata

    const kolkata = await getDay(at.app, atDoctor)
    expect(kolkata.today).toBe('2026-10-06')
    expect(kolkata.generatedAt).toBe('2026-10-05T19:00:00.000Z')
    expect(kolkata.timeline.map((r) => [r.patient.id, r.status, r.time, r.overdue])).toEqual([
      [p3.id, 'yet_to_see', '00:15', true],
      [p1.id, 'waiting', '00:20', false],
      [p5.id, 'yet_to_see', '23:55', false],
    ])
    expect(kolkata.counts).toMatchObject({ seen: 0, waiting: 1, yetToSee: 2, total: 3 })

    await adminQuery(`UPDATE facilities SET timezone = 'America/New_York' WHERE id = '${fx.facilityId}'`)
    const newYork = await getDay(at.app, atDoctor)
    expect([newYork.timezone, newYork.today]).toEqual(['America/New_York', '2026-10-05'])
    expect(newYork.timeline.map((r) => [r.patient.id, r.status, r.time])).toEqual([
      [p2.id, 'completed', '04:00'],
      [p4.id, 'yet_to_see', '14:25'],
      [p3.id, 'yet_to_see', '14:45'],
    ])
    expect(newYork.counts).toMatchObject({ seen: 1, waiting: 0, yetToSee: 2, total: 3 })
  })

  it('counts the week from Monday and the month from the 1st up to today, with one counted point per day and nothing of another doctor’s', async () => {
    const atDoctor = await login(at.app, 't.doctor')
    // Wednesday 7 October 2026, noon in Kolkata.
    fixedNow = Date.parse('2026-10-07T06:30:00Z')
    const [pX, pY, pZ, pW, pO] = [await newPatient('Xavier'), await newPatient('Yamini'), await newPatient('Zubair'), await newPatient('Wasim'), await newPatient('Otto')]
    const completed = async (patientId: string, date: string, doctorId = fx.users.doctor) => {
      const v = await insertVisit({ patientId, date, status: 'completed', doctorId })
      await insertEncounter({ visitId: v, patientId, status: 'signed', doctorId, startedAt: `${date}T05:30:00Z` })
    }
    await completed(pX.id, '2026-09-30') // the month before
    await completed(pX.id, '2026-10-04') // Sunday: this month, last week
    await completed(pY.id, '2026-10-04')
    await completed(pX.id, '2026-10-05') // Monday
    const vZ = await insertVisit({ patientId: pZ.id, date: '2026-10-05', status: 'in_consultation', doctorId: fx.users.doctor })
    await insertEncounter({ visitId: vZ, patientId: pZ.id, status: 'in_progress', startedAt: '2026-10-05T06:00:00Z' })
    const vW = await insertVisit({ patientId: pW.id, date: '2026-10-05', status: 'ready', doctorId: null })
    await insertEncounter({ visitId: vW, patientId: pW.id, status: 'discarded', startedAt: '2026-10-05T06:10:00Z' }) // discarded: not a consultation
    await completed(pO.id, '2026-10-06', fx.users.doctor2) // another doctor's
    await completed(pY.id, '2026-10-07') // today

    const week = await getDay(at.app, atDoctor, 'week')
    expect([week.period, week.today, week.from, week.to]).toEqual(['week', '2026-10-07', '2026-10-05', '2026-10-07'])
    expect(week.counts).toMatchObject({ seen: 2, consultations: 3, completed: 2, patients: 3 })
    expect(week.trend).toEqual([
      { date: '2026-10-05', seen: 1, consultations: 2 },
      { date: '2026-10-06', seen: 0, consultations: 0 },
      { date: '2026-10-07', seen: 1, consultations: 1 },
    ])

    const month = await getDay(at.app, atDoctor, 'month')
    expect([month.from, month.to]).toEqual(['2026-10-01', '2026-10-07'])
    expect(month.counts).toMatchObject({ seen: 4, consultations: 5, completed: 4, patients: 3 })
    expect(month.trend.map((t) => t.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'])
    expect(month.trend.map((t) => t.consultations)).toEqual([0, 0, 0, 2, 2, 0, 1])
    expect(month.trend.map((t) => t.seen)).toEqual([0, 0, 0, 2, 1, 0, 1])

    // Waiting, in consultation and yet to see are today's whatever the period (the Monday consultation still open is not today's).
    const today = await getDay(at.app, atDoctor, 'today')
    expect(today.counts).toEqual({ seen: 1, waiting: 0, inConsultation: 0, yetToSee: 0, total: 1, consultations: 1, completed: 1, patients: 1 })
    expect(week.counts).toMatchObject({ waiting: 0, inConsultation: 0, yetToSee: 0, total: 1 })
    expect(week.timeline).toEqual(today.timeline)

    // A Monday is its own week's first day.
    fixedNow = Date.parse('2026-10-05T06:30:00Z')
    const monday = await getDay(at.app, atDoctor, 'week')
    expect([monday.from, monday.to, monday.trend.length]).toEqual(['2026-10-05', '2026-10-05', 1])
  })
})

describe('audit', () => {
  it('records each read with the period, the counts and the patients listed, and no names, reasons or other free text', async () => {
    const p = await newPatient('Auditee')
    await checkIn(p.id, { chiefComplaint: 'Chest pain on exertion' })
    const appt = await newPatient('Booked')
    await insertAppointment({ patientId: appt.id, atSql: clinicToday('23:55'), reason: 'Review of thyroid results' })
    const day = await getDay(ctx.app, doctor, 'week')
    const { rows } = await adminQuery("SELECT actor_user_id, actor_role, outcome, patient_id, details FROM audit_events WHERE action = 'doctor_day.read'")
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r).toMatchObject({ actor_user_id: fx.users.doctor, actor_role: 'doctor', outcome: 'success', patient_id: null })
    expect(Object.keys(r.details).sort()).toEqual(['counts', 'patientIds', 'period'])
    expect(r.details.period).toBe('week')
    expect(r.details.counts).toEqual(day.counts)
    expect([...r.details.patientIds].sort()).toEqual([p.id, appt.id].sort())
    const text = JSON.stringify(r.details)
    for (const secret of ['Auditee', 'Booked', 'Narayanan', 'Chest pain', 'thyroid', p.mrn]) expect(text).not.toContain(secret)
  })
})
