import { Encounter, MyConsultationsResponse, PatientDetail, StatusHistory, type TimelineEntry, Visit, VISIT_TRANSITIONS, type VisitStatus, VisitStatus as VisitStatusEnum } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { facilities, users } from '../src/db/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD } from './helpers.ts'
import { hashPassword } from '../src/auth/password.ts'

/**
 * Slice 3: the visit and consultation lifecycles, enforced by the API and by
 * the database, with status history; the doctor's draft worklist; discarding.
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
async function readyVisit(): Promise<Visit> {
  n++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Life${n}`, phone: `92000${String(n).padStart(5, '0')}` }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Headache' } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 37.2 }] } })
  return Visit.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready', reason: 'Vitals done' } })).json())
}
const start = (visitId: string, cookie = doctor) => call(ctx.app, 'POST', `/api/visits/${visitId}/encounter`, { cookie })
const getEnc = async (id: string, cookie = doctor) => Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${id}`, { cookie })).json())
const getVisit = async (id: string) => Visit.parse((await call(ctx.app, 'GET', `/api/visits/${id}`, { cookie: nurse })).json())
const draft = (version: number, over: Record<string, unknown> = {}) => ({
  version,
  note: { chiefComplaint: 'Headache for 2 days', history: 'Frontal, no vomiting.', pastHistory: '', examination: 'Normal neuro exam.', assessment: 'Tension headache.', plan: 'Rest, fluids.', followUp: '' },
  diagnoses: [{ description: 'Tension-type headache', code: 'G44.2', kind: 'primary' }],
  prescription: [],
  ...over,
})
const save = (id: string, version: number, cookie = doctor) => call(ctx.app, 'PUT', `/api/encounters/${id}/draft`, { cookie, body: draft(version) })
const sign = (id: string, version: number, cookie = doctor) => call(ctx.app, 'POST', `/api/encounters/${id}/sign`, { cookie, body: { version, attestation: true } })
const discard = (id: string, version: number, reason = 'Started on the wrong patient', cookie = doctor) => call(ctx.app, 'POST', `/api/encounters/${id}/discard`, { cookie, body: { version, reason } })
const mine = async (status: 'in_progress' | 'signed', cookie = doctor) => MyConsultationsResponse.parse((await call(ctx.app, 'GET', '/api/encounters/mine', { cookie, query: { status } })).json())

/** Forces a state that the application can no longer produce (data from before slice 3), as the test superuser. */
const legacy = (sql: string) => adminQuery(`SET session_replication_role = replica; ${sql}`)

describe('the doctor’s unsigned drafts', () => {
  it('lists only the doctor’s own drafts in their facility, from any day, never signed or discarded ones, and audits the patients shown', async () => {
    const [a, b, c, d] = [await readyVisit(), await readyVisit(), await readyVisit(), await readyVisit()]
    const ea = Encounter.parse((await start(a.id)).json())
    const eb = Encounter.parse((await start(b.id)).json())
    const ec = Encounter.parse((await start(c.id)).json())
    Encounter.parse((await start(d.id, doctor2)).json())
    await save(eb.id, eb.version)
    expect((await sign(eb.id, eb.version + 1)).statusCode).toBe(200)
    expect((await discard(ec.id, ec.version)).statusCode).toBe(200)
    // A draft from an earlier day stays on the list (the queue shows today only).
    await legacy(`UPDATE visits SET visit_date = visit_date - 3 WHERE id = '${a.id}'`)

    const list = await mine('in_progress')
    expect(list.items.map((i) => i.encounterId)).toEqual([ea.id])
    expect(list.items[0]).toMatchObject({ status: 'in_progress', patient: { id: a.patient.id, mrn: a.patient.mrn }, visit: { id: a.id, status: 'in_consultation', departmentName: 'General Medicine' }, progress: { sectionsWithText: 1, diagnoses: 0, medicines: 0 } })
    expect(list.items[0]!.visit.visitDate < list.today).toBe(true)
    expect((await mine('in_progress', doctor2)).items).toHaveLength(1)
    const signed = await mine('signed')
    expect(signed.items.map((i) => i.encounterId)).toEqual([eb.id])
    expect(signed.items[0]).toMatchObject({ progress: { diagnoses: 1 }, amendmentCount: 0 })

    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.list' ORDER BY id")
    expect(rows[0].details).toEqual({ status: 'in_progress', count: 1, patientIds: [a.patient.id] })
  })

  it('is for doctors only, and another facility’s doctor sees none of them', async () => {
    const v = await readyVisit()
    await start(v.id)
    expect((await call(ctx.app, 'GET', '/api/encounters/mine', { cookie: nurse })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/encounters/mine', { cookie: await login(ctx.app, 't.admin') })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/encounters/mine', { cookie: doctor, query: { status: 'discarded' } })).statusCode).toBe(400)
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'o.doctor', fullName: 'Other doctor', role: 'doctor', passwordHash: await hashPassword(TEST_PASSWORD) })
    expect((await mine('in_progress', await login(ctx.app, 'o.doctor'))).items).toEqual([])
  })
})

describe('starting and continuing a consultation', () => {
  it('concurrent starts create one consultation; the others open it', async () => {
    const v = await readyVisit()
    const results = await Promise.all(Array.from({ length: 6 }, () => start(v.id)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201])
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1)
    expect((await adminQuery('SELECT count(*)::int AS n FROM encounters')).rows[0].n).toBe(1)
    expect((await adminQuery("SELECT count(*)::int AS n FROM encounter_status_events WHERE source = 'consultation_start'")).rows[0].n).toBe(1)
    // Every request that received the record without creating it left an audited read.
    const reads = (await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'encounter.read' AND details->>'visitId' = $1", [v.id])).rows[0].n
    expect(reads).toBe(5)
  })

  it('a closed visit cannot get a consultation', async () => {
    const v = await readyVisit()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'no_show' } })
    expect((await start(v.id)).json().error).toBe('visit_closed')
  })

  it('a draft whose visit is back in the queue is paused: no edits or signing until its author continues it', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    // Data from before slice 3: the visit was moved back to the queue while the draft was open.
    await legacy(`UPDATE visits SET status = 'ready' WHERE id = '${v.id}'`)
    expect((await save(e.id, e.version)).json().error).toBe('visit_not_in_consultation')
    expect((await sign(e.id, e.version)).json().error).toBe('visit_not_in_consultation')
    expect(await getEnc(e.id)).toMatchObject({ canEdit: false, canResume: true, canDiscard: true, visit: { status: 'ready' } })

    // Another doctor opening it changes nothing.
    const other = await start(v.id, doctor2)
    expect([other.statusCode, other.json().canEdit]).toEqual([200, false])
    expect((await getVisit(v.id)).status).toBe('ready')

    // The author continues it: the visit is with the doctor again, recorded in the history and the audit log.
    const resumed = Encounter.parse((await start(v.id)).json())
    expect(resumed).toMatchObject({ id: e.id, canEdit: true, visit: { status: 'in_consultation' } })
    expect((await save(e.id, e.version)).statusCode).toBe(200)
    const h = StatusHistory.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}/history`, { cookie: doctor })).json())
    expect(h.events.at(-1)).toMatchObject({ subject: 'visit', from: 'ready', to: 'in_consultation', source: 'consultation_resume', actorName: 'Test t.doctor' })
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.resume'")).rows).toEqual([{ details: { visitId: v.id, fromStatus: 'ready' } }])
  })
})

describe('visit status changes', () => {
  it('cannot cancel or mark as no-show a visit with an unsigned consultation; the refusal is audited', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    // The queue offers no manual move away from the doctor.
    expect(VISIT_TRANSITIONS.in_consultation).toEqual([])
    const res = await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })
    expect(res.json().error).toBe('invalid_transition')
    // Legacy state: back in the queue with the draft still open.
    await legacy(`UPDATE visits SET status = 'ready' WHERE id = '${v.id}'`)
    for (const status of ['cancelled', 'no_show']) {
      const r = await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status, reason: 'Patient left' } })
      expect([r.statusCode, r.json().error]).toEqual([409, 'consultation_in_progress'])
    }
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'visit.status' AND outcome = 'failure' ORDER BY id")
    expect(rows.map((r) => r.details.code)).toEqual(['invalid_transition', 'consultation_in_progress', 'consultation_in_progress'])
    // The database refuses it too, even for the application role acting directly.
    const client = await ctx.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('adaxai.actor_id', $1, true)", [fx.users.nurse])
      await expect(client.query("UPDATE visits SET status = 'cancelled', status_reason = 'x' WHERE id = $1", [v.id])).rejects.toMatchObject({ code: 'AX004' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await getEnc(e.id)).status).toBe('in_progress')
  })

  it('while the patient is with the doctor, routing, editing and direct writes cannot change the doctor or department', async () => {
    const v = await readyVisit()
    const s = (await call(ctx.app, 'POST', `/api/visits/${v.id}/routing-suggestion`, { cookie: nurse })).json().suggestion
    await start(v.id)
    const applied = await call(ctx.app, 'POST', `/api/routing-suggestions/${s.id}/apply`, { cookie: nurse })
    expect([applied.statusCode, applied.json().error]).toEqual([409, 'visit_in_consultation'])
    expect((await call(ctx.app, 'POST', `/api/visits/${v.id}/routing-suggestion`, { cookie: nurse })).json().error).toBe('visit_in_consultation')
    expect((await call(ctx.app, 'PATCH', `/api/visits/${v.id}`, { cookie: nurse, body: { assignedDoctorId: fx.users.doctor2 } })).json().error).toBe('visit_in_consultation')
    // The database refuses it too.
    const client = await ctx.pool.connect()
    try {
      await client.query('BEGIN')
      await expect(client.query('UPDATE visits SET assigned_doctor_id = $2 WHERE id = $1', [v.id, fx.users.doctor2])).rejects.toMatchObject({ code: 'AX005' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(await getVisit(v.id)).toMatchObject({ status: 'in_consultation', assignedDoctorId: fx.users.doctor, departmentId: fx.departments.gen })
    // Other edits (priority, reason) are still allowed.
    expect((await call(ctx.app, 'PATCH', `/api/visits/${v.id}`, { cookie: nurse, body: { priority: 'urgent' } })).json().priority).toBe('urgent')
  })

  it('lookups of another facility’s visit are refused as not found and audited, also through routing', async () => {
    const v = await readyVisit()
    const [f2] = await ctx.db.insert(facilities).values({ code: 'TEST-03', name: 'Third facility' }).returning()
    await ctx.db.insert(users).values({ facilityId: f2!.id, username: 'x.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash: await hashPassword(TEST_PASSWORD) })
    const other = await login(ctx.app, 'x.nurse')
    for (const [method, url] of [['GET', `/api/visits/${v.id}`], ['GET', `/api/visits/${v.id}/routing-suggestion`], ['POST', `/api/visits/${v.id}/routing-suggestion`], ['POST', `/api/visits/${v.id}/status`]] as const) {
      expect((await call(ctx.app, method, url, { cookie: other, ...(method === 'POST' && { body: { status: 'cancelled', reason: 'x' } }) })).statusCode, url).toBe(404)
    }
    const { rows } = await adminQuery("SELECT details FROM audit_events WHERE action = 'access.not_found' AND entity_id = $1 ORDER BY id", [v.id])
    expect(rows.map((r) => r.details.reason)).toEqual(['other_facility', 'other_facility', 'other_facility', 'other_facility'])
    expect((await getVisit(v.id)).status).toBe('ready')
  })

  it('refuses a change based on a status the user no longer sees', async () => {
    const v = await readyVisit()
    const res = await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'in_triage', from: 'waiting' } })
    expect([res.statusCode, res.json().error]).toEqual([409, 'stale_status'])
    expect((await getVisit(v.id)).status).toBe('ready')
  })

  it('the database allows exactly the transitions in VISIT_TRANSITIONS (plus the consultation’s own moves)', async () => {
    const v = await readyVisit()
    const all = VisitStatusEnum.options
    const client = await ctx.pool.connect()
    const refused: string[] = []
    const allowed: string[] = []
    try {
      for (const from of all) {
        for (const to of all) {
          if (from === to) continue
          await legacy(`UPDATE visits SET status = '${from}', status_reason = NULL WHERE id = '${v.id}'`)
          await client.query('BEGIN')
          await client.query("SELECT set_config('adaxai.actor_id', $1, true)", [fx.users.nurse])
          try {
            await client.query('UPDATE visits SET status = $2, status_reason = $3 WHERE id = $1', [v.id, to, to === 'cancelled' ? 'Reason given' : null])
            allowed.push(`${from}>${to}`)
          } catch (e) {
            expect((e as { code: string }).code).toBe('AX003')
            refused.push(`${from}>${to}`)
          } finally {
            await client.query('ROLLBACK')
          }
        }
      }
    } finally {
      client.release()
    }
    // Without a consultation: the manual moves, and in_consultation -> ready (what discarding does).
    const expected = all.flatMap((from) => VISIT_TRANSITIONS[from as VisitStatus].map((to) => `${from}>${to}`)).concat('in_consultation>ready')
    expect(allowed.sort()).toEqual(expected.sort())
  })

  it('every change records who, how and why in the status history, which nobody can rewrite', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    await save(e.id, e.version)
    await sign(e.id, e.version + 1)
    // HERO final (deliberate change): signing leaves the visit with the doctor; the doctor's Complete closes it, recorded as its own source.
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
    const h = StatusHistory.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}/history`, { cookie: nurse })).json())
    expect(h.events.map((x) => `${x.subject}:${x.from ?? '-'}>${x.to}:${x.source}:${x.actorName}${x.reason ? `:${x.reason}` : ''}`)).toEqual([
      'visit:->waiting:check_in:Test t.nurse',
      'visit:waiting>in_triage:vitals:Test t.nurse',
      'visit:in_triage>ready:queue:Test t.nurse:Vitals done',
      'consultation:->in_progress:consultation_start:Test t.doctor',
      'visit:ready>in_consultation:consultation_start:Test t.doctor',
      'consultation:in_progress>signed:consultation_signed:Test t.doctor',
      'visit:in_consultation>completed:consultation_completed:Test t.doctor',
    ])
    await expect(ctx.pool.query('UPDATE visit_status_events SET reason = $1', ['rewritten'])).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query('DELETE FROM encounter_status_events')).rejects.toMatchObject({ code: '42501' })
    // A status change by the application role must name the acting user.
    await expect(ctx.pool.query("UPDATE visits SET status = 'cancelled', status_reason = 'x' WHERE id = $1", [(await readyVisit()).id])).rejects.toMatchObject({ code: 'AX002' })
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'encounter.history_read'")).rows[0].n).toBe(1)
  })
})

describe('discarding an unsigned draft', () => {
  it('needs a reason and the author, keeps the draft read-only, returns the visit to the queue and allows a new start', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    const saved = Encounter.parse((await save(e.id, e.version)).json())
    expect((await discard(e.id, saved.version, ' ')).statusCode).toBe(400)
    expect((await discard(e.id, saved.version, 'Not mine', doctor2)).statusCode).toBe(403)
    expect((await discard(e.id, e.version)).json().error).toBe('version_conflict')

    const d = Encounter.parse((await discard(e.id, saved.version)).json())
    expect(d).toMatchObject({ status: 'discarded', canEdit: false, canDiscard: false, discarded: { byName: 'Test t.doctor', reason: 'Started on the wrong patient' }, visit: { status: 'ready' } })
    const queued = await getVisit(v.id)
    expect([queued.status, queued.encounterId]).toEqual(['ready', null])
    // Nothing more can happen to it.
    expect((await save(e.id, d.version)).json().error).toBe('encounter_discarded')
    expect((await sign(e.id, d.version)).json().error).toBe('encounter_discarded')
    expect((await discard(e.id, d.version)).json().error).toBe('encounter_discarded')
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/amendments`, { cookie: doctor, body: { reason: 'x', content: 'y' } })).json().error).toBe('not_signed')
    await expect(ctx.pool.query("UPDATE encounters SET plan = 'changed' WHERE id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query("UPDATE diagnoses SET description = 'changed' WHERE encounter_id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    // It is not part of the patient's record.
    const timeline = (await call(ctx.app, 'GET', `/api/patients/${v.patient.id}/timeline`, { cookie: doctor })).json().entries as TimelineEntry[]
    expect(timeline.map((t) => t.encounterId)).toEqual([null])

    // A new consultation can start on the same visit.
    const again = await start(v.id, doctor2)
    expect(again.statusCode).toBe(201)
    expect(again.json().id).not.toBe(e.id)
    // The discard reason stays with the consultation, not in the audit log.
    expect((await adminQuery("SELECT details FROM audit_events WHERE action = 'encounter.discard'")).rows).toEqual([{ details: { visitId: v.id, visitReturnedToQueue: true, version: d.version } }])
    const h = StatusHistory.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}/history`, { cookie: doctor })).json())
    expect(h.events.filter((x) => x.source === 'consultation_discarded').map((x) => `${x.subject}:${x.to}:${x.reason ?? ''}`)).toEqual(['consultation:discarded:Started on the wrong patient', 'visit:ready:Started on the wrong patient'])
  })

  it('a concurrent sign and discard of the same version: exactly one wins', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    const s = Encounter.parse((await save(e.id, e.version)).json())
    const [a, b] = await Promise.all([sign(e.id, s.version), discard(e.id, s.version)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    const final = await getEnc(e.id)
    expect(final.status).toBe(a.statusCode === 200 ? 'signed' : 'discarded')
    // HERO final (deliberate change): a signed record leaves its visit with the doctor (completing is a separate step); a discard returns it to the queue.
    expect((await getVisit(v.id)).status).toBe(a.statusCode === 200 ? 'in_consultation' : 'ready')
  })
})

describe('database guards on consultations', () => {
  it('the application role cannot insert a signed record, re-point a draft, sign without a scheme, or delete a consultation', async () => {
    const v = await readyVisit()
    const e = Encounter.parse((await start(v.id)).json())
    const other = await readyVisit()
    // Each attempt in its own transaction, naming the acting user as the application does.
    const attempt = async (sql: string, params: unknown[]) => {
      const client = await ctx.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('adaxai.actor_id', $1, true)", [fx.users.doctor])
        return await client.query(sql, params)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    }
    await expect(attempt("INSERT INTO encounters (facility_id, patient_id, visit_id, doctor_id, status, signed_at, signed_snapshot, content_hash, hash_scheme) VALUES ($1, $2, $3, $4, 'signed', now(), '{}', 'x', 'adaxai.encounter.v2')", [fx.facilityId, other.patient.id, other.id, fx.users.doctor])).rejects.toMatchObject({ code: '42501' })
    // A visit of another patient cannot hold this patient's consultation.
    await expect(attempt('INSERT INTO encounters (facility_id, patient_id, visit_id, doctor_id) VALUES ($1, $2, $3, $4)', [fx.facilityId, v.patient.id, other.id, fx.users.doctor])).rejects.toMatchObject({ code: '42501' })
    await expect(attempt('UPDATE encounters SET patient_id = $2 WHERE id = $1', [e.id, other.patient.id])).rejects.toMatchObject({ code: '42501' })
    await expect(attempt("UPDATE encounters SET status = 'signed', signed_at = now(), signed_snapshot = '{}', content_hash = 'x' WHERE id = $1", [e.id])).rejects.toMatchObject({ code: '42501' })
    await expect(attempt('DELETE FROM encounters WHERE id = $1', [e.id])).rejects.toMatchObject({ code: '42501' })
    // A discard needs who, when and why: a missing (NULL) or blank reason is refused.
    for (const reason of [null, '  ']) {
      await expect(attempt("UPDATE encounters SET status = 'discarded', discarded_at = now(), discarded_by = $2, discard_reason = $3 WHERE id = $1", [e.id, fx.users.doctor, reason])).rejects.toMatchObject({ code: '23514' })
    }
    // Without naming the acting user, no consultation starts at all.
    await expect(ctx.pool.query('INSERT INTO encounters (facility_id, patient_id, visit_id, doctor_id) VALUES ($1, $2, $3, $4)', [fx.facilityId, other.patient.id, other.id, fx.users.doctor])).rejects.toMatchObject({ code: 'AX002' })
    expect((await getEnc(e.id)).status).toBe('in_progress')
  })
})
