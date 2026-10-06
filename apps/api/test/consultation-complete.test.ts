import crypto from 'node:crypto'
import { Appointment, CheckInResult, CompleteEncounterResult, Encounter, PatientDetail, StatusHistory, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { addDays } from '../src/appointments/schedule.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

/**
 * HERO final: signing and completing are two acts. Signing freezes the record and leaves the patient with the doctor; the signing doctor's
 * explicit Complete closes the visit (and its appointment), is recorded in the status history and the audit log, and tells the doctor whether
 * the patient can see the prescription. Also the structured course of a medicine (days and first day) saved with the draft.
 */
const ctx = createTestApp()
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
afterAll(() => ctx.close())

let n = 0
async function newPatient() {
  n++
  return PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Done${n}`, phone: `96100${String(n).padStart(5, '0')}` }) })).json())
}
/** A checked-in visit, ready for the doctor (from today's appointment when `appointment`). */
async function readyVisit(opts: { appointment?: boolean } = {}) {
  const p = await newPatient()
  let visitId: string
  let appointmentId: string | null = null
  if (opts.appointment) {
    const today = (await call(ctx.app, 'GET', '/api/appointments/options', { cookie: nurse })).json().today as string
    const a = Appointment.parse((await call(ctx.app, 'POST', '/api/appointments', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, doctorId: fx.users.doctor, date: addDays(today, 3), time: '10:00', durationMinutes: 15, reason: null, idempotencyKey: crypto.randomUUID() } })).json())
    // Today's appointment (moved as the appointments tests do; booking for an earlier time today is refused by the rules).
    await adminQuery(`SET session_replication_role = replica; UPDATE appointments SET scheduled_at = ('${today}'::date + '00:05'::time)::timestamp AT TIME ZONE 'Asia/Kolkata' WHERE id = '${a.id}'`)
    visitId = CheckInResult.parse((await call(ctx.app, 'POST', `/api/appointments/${a.id}/check-in`, { cookie: nurse, body: {} })).json()).visit.id
    appointmentId = a.id
  } else {
    visitId = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Cough' } })).json()).id
  }
  await call(ctx.app, 'POST', `/api/visits/${visitId}/status`, { cookie: nurse, body: { status: 'ready' } })
  return { p, visitId, appointmentId }
}
const draft = (version: number, prescription: Record<string, unknown>[] = [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'TDS', duration: '5 days', durationDays: 5, instructions: 'After food' }]) => ({
  version,
  note: { chiefComplaint: 'Cough for 3 days', history: 'Dry cough.', pastHistory: '', examination: 'Chest clear.', assessment: 'Viral URTI.', plan: 'Fluids, rest.', followUp: 'Review in 5 days.' },
  diagnoses: [{ description: 'Acute upper respiratory infection', code: 'J06.9', kind: 'primary' }],
  prescription,
})
async function signed(opts: { appointment?: boolean } = {}) {
  const v = await readyVisit(opts)
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.visitId}/encounter`, { cookie: doctor })).json())
  const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(e.version) })).json())
  const s = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })
  expect(s.statusCode).toBe(200)
  return { ...v, e: Encounter.parse(s.json()) }
}
const complete = (id: string, cookie = doctor, body: Record<string, unknown> = {}) => call(ctx.app, 'POST', `/api/encounters/${id}/complete`, { cookie, body })
const getVisit = async (id: string) => Visit.parse((await call(ctx.app, 'GET', `/api/visits/${id}`, { cookie: nurse })).json())
const audits = async (action: string) => (await adminQuery('SELECT outcome, actor_user_id, entity_id, patient_id, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows

describe('completing a consultation', () => {
  it('signing leaves the patient with the doctor; the signing doctor completes it once: visit and appointment completed, history and audit say so', async () => {
    const s = await signed({ appointment: true })
    expect(s.e).toMatchObject({ status: 'signed', visit: { status: 'in_consultation' }, canComplete: true, completedAt: null })
    expect((await getVisit(s.visitId)).status).toBe('in_consultation')
    expect((await call(ctx.app, 'GET', `/api/appointments/${s.appointmentId}`, { cookie: nurse })).json().appointment.status).toBe('checked_in')
    // Signing changed no visit status: the last visit event is still the start of the consultation.
    expect((await adminQuery("SELECT count(*)::int AS n FROM visit_status_events WHERE visit_id = $1 AND to_status = 'completed'", [s.visitId])).rows[0].n).toBe(0)

    const res = await complete(s.e.id)
    expect(res.statusCode).toBe(200)
    const out = CompleteEncounterResult.parse(res.json())
    expect(out).toMatchObject({ encounterId: s.e.id, visitId: s.visitId, patientPortalAccess: false })
    expect(Date.parse(out.completedAt)).toBeGreaterThan(Date.parse(s.e.signedAt!) - 1)
    expect((await getVisit(s.visitId)).status).toBe('completed')
    const appt = (await call(ctx.app, 'GET', `/api/appointments/${s.appointmentId}`, { cookie: nurse })).json()
    expect(appt.appointment.status).toBe('completed')
    expect(appt.history.at(-1)).toMatchObject({ from: 'checked_in', to: 'completed', source: 'visit_status', actorName: 'Test t.doctor' })
    const h = StatusHistory.parse((await call(ctx.app, 'GET', `/api/encounters/${s.e.id}/history`, { cookie: doctor })).json())
    expect(h.events.at(-1)).toMatchObject({ subject: 'visit', from: 'in_consultation', to: 'completed', source: 'consultation_completed', actorName: 'Test t.doctor' })

    // The read model: completed, when (the time in the status history), and nothing more to complete.
    const after = Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${s.e.id}`, { cookie: doctor })).json())
    expect(after).toMatchObject({ status: 'signed', visit: { status: 'completed' }, canComplete: false, completedAt: out.completedAt })
    // The signed record itself is unchanged, and still verifies.
    expect(after.contentHash).toBe(s.e.contentHash)
    expect((await call(ctx.app, 'GET', `/api/encounters/${s.e.id}/verification`, { cookie: doctor })).json().status).toBe('valid')

    // Audited once, with ids only.
    const [ev, ...more] = await audits('encounter.complete')
    expect(more).toEqual([])
    expect(ev).toMatchObject({ outcome: 'success', actor_user_id: fx.users.doctor, entity_id: s.e.id, patient_id: s.p.id, details: { visitId: s.visitId, appointmentId: s.appointmentId } })
    expect(Object.keys(ev!.details).sort()).toEqual(['appointmentId', 'visitId'])

    // A second request changes nothing and says why.
    const again = await complete(s.e.id)
    expect([again.statusCode, again.json().error]).toEqual([409, 'already_completed'])
    expect((await audits('encounter.complete')).filter((a) => a.outcome === 'success')).toHaveLength(1)
    expect((await adminQuery("SELECT count(*)::int AS n FROM visit_status_events WHERE visit_id = $1 AND to_status = 'completed'", [s.visitId])).rows[0].n).toBe(1)
  })

  it('is for the doctor who signed it only: not nurses, admins, another doctor or patients', async () => {
    const s = await signed()
    expect(s.e.canComplete).toBe(true)
    // Another doctor reads it, but may not complete it.
    expect(Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${s.e.id}`, { cookie: doctor2 })).json()).canComplete).toBe(false)
    expect(Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${s.e.id}`, { cookie: nurse })).json()).canComplete).toBe(false)
    const other = await complete(s.e.id, doctor2)
    expect(other.statusCode).toBe(403)
    expect((await complete(s.e.id, nurse)).statusCode).toBe(403)
    expect((await complete(s.e.id, await login(ctx.app, 't.admin'))).statusCode).toBe(403)
    expect((await call(ctx.app, 'POST', `/api/encounters/${s.e.id}/complete`, { body: {} })).statusCode).toBe(401)
    expect((await getVisit(s.visitId)).status).toBe('in_consultation')
    expect((await audits('encounter.complete')).filter((a) => a.outcome === 'success')).toEqual([])
    // An unknown or malformed id.
    expect((await complete(crypto.randomUUID())).statusCode).toBe(404)
    expect((await complete('not-a-uuid')).statusCode).toBe(400)
    // A stale version (when given) is refused.
    expect((await complete(s.e.id, doctor, { version: s.e.version + 1 })).json().error).toBe('version_conflict')
    expect((await complete(s.e.id, doctor, { version: s.e.version })).statusCode).toBe(200)
  })

  it('needs a signed record: a draft or a discarded draft cannot be completed, and the database refuses it too', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.visitId}/encounter`, { cookie: doctor })).json())
    expect(e.canComplete).toBe(false)
    const res = await complete(e.id)
    expect([res.statusCode, res.json().error]).toEqual([409, 'not_signed'])
    expect((await getVisit(v.visitId)).status).toBe('in_consultation')
    // Even acting directly as the application role, an unsigned consultation's visit cannot be completed (migration 0019/0033 guard).
    const client = await ctx.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('adaxai.actor_id', $1, true), set_config('adaxai.source', 'consultation_completed', true)", [fx.users.doctor])
      await expect(client.query("UPDATE visits SET status = 'completed' WHERE id = $1", [v.visitId])).rejects.toMatchObject({ code: 'AX003' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    const d = await call(ctx.app, 'POST', `/api/encounters/${e.id}/discard`, { cookie: doctor, body: { version: e.version, reason: 'Wrong patient' } })
    expect(d.statusCode).toBe(200)
    expect((await complete(e.id)).json().error).toBe('encounter_discarded')
    expect((await getVisit(v.visitId)).status).toBe('ready')
  })

  it('a signed consultation’s visit cannot go back to the queue, and blocks a second visit that day until it is completed', async () => {
    const s = await signed()
    // The queue offers no move away from the doctor, and a same-day visit for the same patient waits for this one to close.
    expect((await call(ctx.app, 'POST', `/api/visits/${s.visitId}/status`, { cookie: nurse, body: { status: 'ready' } })).json().error).toBe('invalid_transition')
    expect((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: s.p.id, departmentId: fx.departments.gen } })).statusCode).toBe(409)
    // Starting it again opens the signed record (read-only) and changes nothing.
    const reopened = await call(ctx.app, 'POST', `/api/visits/${s.visitId}/encounter`, { cookie: doctor })
    expect([reopened.statusCode, reopened.json().id, reopened.json().status]).toEqual([200, s.e.id, 'signed'])
    expect((await complete(s.e.id)).statusCode).toBe(200)
    expect((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: s.p.id, departmentId: fx.departments.gen } })).statusCode).toBe(201)
  })

  it('concurrent completions: exactly one succeeds, one status change, one audit entry', async () => {
    const s = await signed()
    const results = await Promise.all(Array.from({ length: 4 }, () => complete(s.e.id)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409, 409])
    expect(results.filter((r) => r.statusCode === 409).map((r) => r.json().error)).toEqual(['already_completed', 'already_completed', 'already_completed'])
    expect((await adminQuery("SELECT count(*)::int AS n FROM visit_status_events WHERE visit_id = $1 AND to_status = 'completed'", [s.visitId])).rows[0].n).toBe(1)
    expect((await audits('encounter.complete')).filter((a) => a.outcome === 'success')).toHaveLength(1)
  })

  it('tells the doctor whether the patient can see it: an active portal account with portal consent', async () => {
    const s = await signed()
    await call(ctx.app, 'POST', `/api/patients/${s.p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(ctx.app, 'POST', `/api/patients/${s.p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    expect((await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: s.p.mrn, activationCode: code, password: 'Done-passphrase-1' } })).statusCode).toBe(201)
    expect(CompleteEncounterResult.parse((await complete(s.e.id)).json()).patientPortalAccess).toBe(true)

    // An account whose portal consent has ended does not count, even if the account is still switched on.
    const t = await signed()
    await call(ctx.app, 'POST', `/api/patients/${t.p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code2 = (await call(ctx.app, 'POST', `/api/patients/${t.p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    expect((await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: t.p.mrn, activationCode: code2, password: 'Done-passphrase-2' } })).statusCode).toBe(201)
    await adminQuery(`SET session_replication_role = replica; UPDATE consents SET status = 'withdrawn', withdrawn_at = now() WHERE patient_id = '${t.p.id}' AND type = 'portal_access';`)
    expect(CompleteEncounterResult.parse((await complete(t.e.id)).json()).patientPortalAccess).toBe(false)
  })
})

describe('a medicine’s structured course in the draft', () => {
  it('saves days and a first day with each medicine; a course in days without a first day starts on the consultation’s date', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.visitId}/encounter`, { cookie: doctor })).json())
    const visitDate = e.visit.visitDate
    const rx = [
      { drugName: 'Amoxicillin', dose: '500 mg', frequency: 'TDS', duration: '7 days', durationDays: 7, startDate: addDays(visitDate, 1) },
      { drugName: 'Paracetamol', dose: '500 mg', frequency: 'SOS', duration: '5 days', durationDays: 5 },
      { drugName: 'Salbutamol inhaler', dose: '2 puffs', frequency: 'When needed (SOS)', duration: 'Until review' },
    ]
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(e.version, rx) })).json())
    expect(saved.prescription.map((p) => [p.drugName, p.duration, p.durationDays, p.startDate])).toEqual([
      ['Amoxicillin', '7 days', 7, addDays(visitDate, 1)],
      ['Paracetamol', '5 days', 5, visitDate],
      // Missing is not none: no structured course is stored as no course (null), never as 0 days.
      ['Salbutamol inhaler', 'Until review', null, null],
    ])
    expect((await adminQuery('SELECT duration_days, start_date::text AS start FROM prescription_items WHERE encounter_id = $1 ORDER BY sort_order', [e.id])).rows).toEqual([
      { duration_days: 7, start: addDays(visitDate, 1) },
      { duration_days: 5, start: visitDate },
      { duration_days: null, start: null },
    ])
    // Read back the same, and the next save may send them back unchanged.
    const again = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(saved.version, saved.prescription) })).json())
    expect(again.prescription).toEqual(saved.prescription)
    // The written duration stays required to sign (the structured one is optional, e.g. "Until review").
    const missing = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(again.version, [{ drugName: 'Amoxicillin', dose: '500 mg', frequency: 'TDS', durationDays: 5 }]) })
    expect(missing.statusCode).toBe(200)
    const sign = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: missing.json().version, attestation: true } })
    expect([sign.statusCode, sign.json().issues.map((i: { path: string }) => i.path)]).toEqual([400, ['prescription.0.duration']])
  })

  it('refuses a course outside 1 to 3650 days or a first day that is not a date, and changes nothing', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${(Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.visitId}/encounter`, { cookie: doctor })).json())).id}/draft`, { cookie: doctor, body: draft(1) })).json())
    const base = { drugName: 'Amoxicillin', dose: '500 mg', frequency: 'TDS', duration: '5 days' }
    for (const [over, path] of [
      [{ durationDays: 0 }, 'prescription.0.durationDays'],
      [{ durationDays: 3651 }, 'prescription.0.durationDays'],
      [{ durationDays: 2.5 }, 'prescription.0.durationDays'],
      [{ durationDays: '5' }, 'prescription.0.durationDays'],
      [{ durationDays: 5, startDate: '06-10-2026' }, 'prescription.0.startDate'],
      [{ durationDays: 5, startDate: '2026-02-30' }, 'prescription.0.startDate'],
    ] as const) {
      const res = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(e.version, [{ ...base, ...over }]) })
      expect([res.statusCode, res.json().issues?.[0]?.path], JSON.stringify(over)).toEqual([400, path])
    }
    expect(Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())).toMatchObject({ version: e.version, prescription: e.prescription })
    // The database holds the same bounds for anything that reaches it another way.
    await expect(ctx.pool.query('UPDATE prescription_items SET duration_days = 0 WHERE encounter_id = $1', [e.id])).rejects.toMatchObject({ code: '23514' })
  })
})
