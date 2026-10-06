import { PatientDetail, TRIAGE_NOTE_MAX, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

/**
 * Doctor HERO final: the nurse's triage note on a visit (PUT /api/visits/:id/triage-note, migration 0033). Nurses and doctors write it, an
 * empty note clears it, who and when are kept with it, only an open visit takes one, and the audit trail never holds its text.
 */
const ctx = createTestApp()
let fx: Fixture
let nurse = ''
let doctor = ''

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
})
afterAll(() => ctx.close())

let seq = 0
async function openVisit(): Promise<Visit> {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Triage${seq}`, phone: `94000${String(seq).padStart(5, '0')}` }) })).json())
  return Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Cough' } })).json())
}
const put = (visitId: string, note: unknown, cookie = nurse) => call(ctx.app, 'PUT', `/api/visits/${visitId}/triage-note`, { cookie, body: { note } })
const NOTE = 'Febrile since morning, took paracetamol 500 mg at 8am. Looks tired, no breathlessness.'

describe('the triage note', () => {
  it('is written by the nurse, with who and when, and shows on the visit and in the queue', async () => {
    const v = await openVisit()
    const before = Date.now()
    const res = await put(v.id, `  ${NOTE}  `)
    expect(res.statusCode).toBe(200)
    const saved = Visit.parse(res.json())
    expect(saved).toMatchObject({ id: v.id, status: 'waiting', triageNote: NOTE, triageNoteBy: { id: fx.users.nurse, fullName: 'Test t.nurse', role: 'nurse' } })
    expect(Date.parse(saved.triageNoteAt!)).toBeGreaterThanOrEqual(before - 5_000)
    // Writing a note is not a status change.
    expect(saved.status).toBe(v.status)
    const queue = (await call(ctx.app, 'GET', '/api/visits', { cookie: doctor, query: { mine: 'true' } })).json().visits as Visit[]
    expect(queue.find((x) => x.id === v.id)).toMatchObject({ triageNote: NOTE, triageNoteBy: { id: fx.users.nurse, role: 'nurse' } })
    expect(Visit.parse((await call(ctx.app, 'GET', `/api/visits/${v.id}`, { cookie: doctor })).json()).triageNote).toBe(NOTE)
  })

  it('can be changed by a doctor too (the last writer is recorded), and an empty or blank note clears it, keeping who cleared it and when', async () => {
    const v = await openVisit()
    await put(v.id, NOTE)
    const byDoctor = Visit.parse((await put(v.id, 'Seen at triage by the doctor: wheeze on the left.', doctor)).json())
    expect(byDoctor).toMatchObject({ triageNote: 'Seen at triage by the doctor: wheeze on the left.', triageNoteBy: { id: fx.users.doctor, role: 'doctor' } })
    const cleared = Visit.parse((await put(v.id, '')).json())
    expect(cleared).toMatchObject({ triageNote: null, triageNoteBy: { id: fx.users.nurse, role: 'nurse' } })
    expect(cleared.triageNoteAt).not.toBeNull()
    await put(v.id, NOTE)
    expect(Visit.parse((await put(v.id, '   \n  ')).json()).triageNote).toBeNull()
  })

  it('holds at most 1000 characters, and refuses a body without a note, a NUL character, a closed visit and a visit that does not exist', async () => {
    const v = await openVisit()
    const longest = 'a'.repeat(TRIAGE_NOTE_MAX)
    expect(TRIAGE_NOTE_MAX).toBe(1000)
    expect(Visit.parse((await put(v.id, longest)).json()).triageNote).toBe(longest)
    const tooLong = await put(v.id, `${longest}b`)
    expect(tooLong.statusCode).toBe(400)
    expect(tooLong.json().issues[0]).toMatchObject({ path: 'note', message: 'At most 1000 characters' })
    // Refused writes change nothing.
    expect(Visit.parse((await call(ctx.app, 'GET', `/api/visits/${v.id}`, { cookie: nurse })).json()).triageNote).toBe(longest)
    expect((await call(ctx.app, 'PUT', `/api/visits/${v.id}/triage-note`, { cookie: nurse, body: {} })).statusCode).toBe(400)
    expect((await put(v.id, 42)).statusCode).toBe(400)
    expect((await put(v.id, 'bad\u0000note')).statusCode).toBe(400)

    expect((await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Left' } })).statusCode).toBe(200)
    const closed = await put(v.id, NOTE)
    expect(closed.statusCode).toBe(409)
    expect(closed.json().error).toBe('visit_closed')
    expect((await put('00000000-0000-4000-8000-000000000000', NOTE)).statusCode).toBe(404)
  })

  it('is written by nurses and doctors only', async () => {
    const v = await openVisit()
    const admin = await login(ctx.app, 't.admin')
    expect((await put(v.id, NOTE, admin)).statusCode).toBe(403)
    expect((await put(v.id, NOTE, doctor)).statusCode).toBe(200)
  })

  it('is audited as set or cleared with its length, never with its text', async () => {
    const v = await openVisit()
    await put(v.id, NOTE)
    await put(v.id, '', doctor)
    const { rows } = await adminQuery("SELECT actor_user_id, entity_type, entity_id, patient_id, details FROM audit_events WHERE action = 'visit.triage_note' ORDER BY id")
    expect(rows.map((r) => [r.actor_user_id, r.entity_type, r.entity_id, r.patient_id, r.details])).toEqual([
      [fx.users.nurse, 'visit', v.id, v.patient.id, { cleared: false, length: NOTE.length, hadNote: false }],
      [fx.users.doctor, 'visit', v.id, v.patient.id, { cleared: true, length: 0, hadNote: true }],
    ])
    const all = await adminQuery('SELECT details::text AS d FROM audit_events')
    for (const r of all.rows) expect(r.d).not.toContain('paracetamol')
  })
})
