import { Encounter, EncounterAi, medicineCourse, medicineCourseLabel, PatientDetail, PortalCurrentPrescriptionResponse, PortalHome, PortalRecord, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

const ctx = createTestApp()
let fx: Fixture
let nurse = ''
let doctor = ''
afterAll(() => ctx.close())

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
})

const fullDraft = (version: number, cc: string) => ({
  version,
  note: { chiefComplaint: cc, history: 'History text', pastHistory: '', examination: 'Exam text', assessment: 'Assessment text', plan: 'Plan text', followUp: 'Review in one week' },
  diagnoses: [{ description: `Diagnosis for ${cc}`, code: 'J06.9', kind: 'primary' }],
  prescription: [{ drugName: 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'TDS', duration: '3 days', instructions: '' }],
})

/** A patient with a portal account, one signed consultation, vitals and consultation audio. */
async function patientWithRecords(givenName: string, phone: string) {
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName, phone }) })).json())
  for (const type of ['portal_access', 'ai_recording']) await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type, method: 'verbal' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: `${givenName} reason` } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 37.9 }] } })
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  await call(ctx.app, 'POST', `/api/encounters/${e.id}/transcripts`, { cookie: doctor, body: { text: `Patient: ${givenName} private words` } })
  const ai = EncounterAi.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}/ai`, { cookie: doctor })).json())
  const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: fullDraft(e.version, `${givenName} complaint`) })).json())
  expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
  // HERO final (deliberate change): the portal shows a record once the doctor completes the consultation (signing no longer does it).
  expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  // A second, unsigned (draft) consultation that must never be visible in the portal.
  const v2 = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
  const draft = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v2.id}/encounter`, { cookie: doctor })).json())
  await call(ctx.app, 'PUT', `/api/encounters/${draft.id}/draft`, { cookie: doctor, body: fullDraft(draft.version, `${givenName} unsigned draft`) })
  const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
  const act = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: `${givenName}-passphrase-1` } })
  expect(act.statusCode).toBe(201)
  const cookie = `adaxai_session=${act.cookies.find((c) => c.name === 'adaxai_session')!.value}`
  return { p, encounterId: e.id, draftId: draft.id, visitId: v.id, transcriptId: ai.transcripts[0]!.id, cookie }
}

describe('patient portal', () => {
  it('shows the patient their own signed records, visits, vitals, consents and profile, and nothing else', async () => {
    const a = await patientWithRecords('Anita', '98400 11111')
    const b = await patientWithRecords('Bharat', '98400 22222')
    const get = (url: string, cookie = a.cookie) => call(ctx.app, 'GET', url, { cookie })

    const home = PortalHome.parse((await get('/api/portal/home')).json())
    expect(home).toMatchObject({ profile: { fullName: 'Anita Narayanan', mrn: a.p.mrn }, counts: { records: 1, visits: 2 } })
    expect(home.upcoming[0]).toMatchObject({ recordId: a.encounterId, followUp: 'Review in one week' })

    const records = (await get('/api/portal/records')).json().records
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: a.encounterId, chiefComplaint: 'Anita complaint', prescriptionCount: 1, doctorName: 'Test t.doctor' })
    const record = PortalRecord.parse((await get(`/api/portal/records/${a.encounterId}`)).json())
    expect(record.prescription[0]).toMatchObject({ drugName: 'Paracetamol', dose: '1 tablet' })
    expect(record.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const visits = (await get('/api/portal/visits')).json().visits
    expect(visits.map((v: { recordId: string | null }) => v.recordId).sort()).toEqual([a.encounterId, null].sort())
    expect((await get('/api/portal/vitals')).json().vitals).toEqual([expect.objectContaining({ kind: 'temperature', value: 37.9, source: 'manual' })])
    expect((await get('/api/portal/consents')).json().consents.map((c: { type: string }) => c.type).sort()).toEqual(['ai_recording', 'portal_access'])
    expect((await get('/api/portal/profile')).json()).toMatchObject({ mrn: a.p.mrn, fullName: 'Anita Narayanan', facilityName: 'Test facility' })

    // Nothing of patient B, no draft, no transcript anywhere in A's portal data.
    const all = JSON.stringify(await Promise.all(['/api/portal/home', '/api/portal/records', '/api/portal/visits', '/api/portal/vitals', '/api/portal/consents', '/api/portal/profile', '/api/portal/thermal'].map(async (u) => (await get(u)).json())))
    for (const s of ['Bharat', b.p.mrn, b.encounterId, 'unsigned draft', 'private words']) expect(all).not.toContain(s)
  })

  it('patient A cannot reach patient B’s data through any patient, encounter, prescription, report, file or AI endpoint', async () => {
    const a = await patientWithRecords('Anita', '98400 11111')
    const b = await patientWithRecords('Bharat', '98400 22222')
    // Portal: B's record and A's own unsigned draft are not found.
    expect((await call(ctx.app, 'GET', `/api/portal/records/${b.encounterId}`, { cookie: a.cookie })).statusCode).toBe(404)
    expect((await call(ctx.app, 'GET', `/api/portal/records/${a.draftId}`, { cookie: a.cookie })).statusCode).toBe(404)
    // Staff and AI endpoints are closed to patients, whichever patient's ids are used.
    const fileId = (await adminQuery('SELECT id FROM files LIMIT 1')).rows[0]?.id ?? crypto.randomUUID()
    const factId = crypto.randomUUID()
    const probes: [string, string][] = []
    for (const t of [a, b]) {
      probes.push(
        ['GET', `/api/patients/${t.p.id}`],
        ['GET', `/api/patients/${t.p.id}/timeline`],
        ['GET', `/api/patients/${t.p.id}/visits`],
        ['GET', `/api/patients/${t.p.id}/observations`],
        ['GET', `/api/patients/${t.p.id}/images`],
        ['GET', `/api/patients/${t.p.id}/thermal`],
        ['GET', `/api/encounters/${t.encounterId}`],
        ['GET', `/api/encounters/${t.encounterId}/ai`],
        ['POST', `/api/encounters/${t.encounterId}/recommendations`],
        ['POST', `/api/transcripts/${t.transcriptId}/extract`],
        ['GET', `/api/visits/${t.visitId}`],
        ['GET', `/api/visits/${t.visitId}/routing-suggestion`],
      )
    }
    probes.push(
      ['GET', '/api/patients'],
      ['GET', '/api/visits'],
      ['GET', `/api/files/${fileId}`],
      ['POST', `/api/ai-review/fact/${factId}`],
      ['POST', `/api/ai-jobs/${factId}/retry`],
      ['GET', '/api/ai/review-outcomes'],
      ['GET', '/api/ai/status'],
      ['GET', '/api/thermal'],
      ['GET', '/api/thermal-data/summary'],
      ['GET', '/api/ai-oversight/overview'],
      ['GET', '/api/admin/audit-events'],
    )
    for (const [method, url] of probes) {
      const res = await call(ctx.app, method as 'GET', url, { cookie: a.cookie, body: method === 'POST' ? {} : undefined })
      expect([url, res.statusCode]).toEqual([url, 403])
    }
    // Every refused attempt is audited: the staff/AI probes and the two portal record probes.
    const { rows } = await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE outcome = 'denied' AND actor_role = 'patient'")
    expect(rows[0].n).toBe(probes.length + 2)
    const { rows: recordProbes } = await adminQuery("SELECT entity_id FROM audit_events WHERE action = 'portal.read' AND outcome = 'denied' ORDER BY id")
    expect(recordProbes.map((r) => r.entity_id)).toEqual([b.encounterId, a.draftId])
  })

  it('shows a consultation only once the doctor has completed it, and today’s prescription is the newest completed one; earlier ones stay', async () => {
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Chitra', phone: '98400 33333' }) })).json())
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const act = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'Chitra-passphrase-1' } })
    const cookie = `adaxai_session=${act.cookies.find((c) => c.name === 'adaxai_session')!.value}`
    const get = async (url: string) => call(ctx.app, 'GET', url, { cookie })
    const current = async () => PortalCurrentPrescriptionResponse.parse((await get('/api/portal/prescriptions/current')).json())
    const consult = async (cc: string, drug: string) => {
      const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
      const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
      const base = fullDraft(e.version, cc)
      const body = { ...base, prescription: [{ ...base.prescription[0]!, drugName: drug, duration: '5 days', durationDays: 5 }] }
      const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body })).json())
      expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
      return { v, e }
    }

    // Signed, not completed: nothing of it in the portal, and opening it directly is "not found" (and audited).
    const first = await consult('First complaint', 'Amoxicillin')
    expect(await current()).toMatchObject({ prescription: null })
    expect((await get('/api/portal/records')).json().records).toEqual([])
    expect((await get(`/api/portal/records/${first.e.id}`)).statusCode).toBe(404)
    expect(PortalHome.parse((await get('/api/portal/home')).json())).toMatchObject({ counts: { records: 0, visits: 1 }, upcoming: [] })
    expect((await get('/api/portal/visits')).json().visits).toEqual([expect.objectContaining({ id: first.v.id, status: 'in_consultation', recordId: null })])
    expect(JSON.stringify((await get('/api/portal/home')).json())).not.toContain('First complaint')

    // Completed: the record, and today's prescription from the same signed rows.
    expect((await call(ctx.app, 'POST', `/api/encounters/${first.e.id}/complete`, { cookie: doctor, body: {} })).json().patientPortalAccess).toBe(true)
    expect((await get('/api/portal/records')).json().records.map((r: { id: string }) => r.id)).toEqual([first.e.id])
    expect((await get('/api/portal/visits')).json().visits).toEqual([expect.objectContaining({ id: first.v.id, status: 'completed', recordId: first.e.id })])
    const one = await current()
    expect(one.prescription).toMatchObject({
      recordId: first.e.id,
      date: first.v.visitDate,
      doctorName: 'Test t.doctor',
      departmentName: 'General Medicine',
      diagnoses: [{ description: 'Diagnosis for First complaint', code: 'J06.9' }],
      items: [{ drugName: 'Amoxicillin', dose: '1 tablet', frequency: 'TDS', duration: '5 days', durationDays: 5, startDate: first.v.visitDate, course: { state: 'active', day: 1, totalDays: 5, daysLeft: 4 } }],
      advice: 'Plan text',
      followUp: 'Review in one week',
    })
    expect(one.today).toBe(first.v.visitDate)
    expect(one.prescription!.completedAt >= one.prescription!.signedAt).toBe(true)

    // A later consultation (same day): signed but not completed changes nothing; completed, it becomes today's prescription, and the first stays.
    const second = await consult('Second complaint', 'Cetirizine')
    expect((await current()).prescription!.recordId).toBe(first.e.id)
    expect((await call(ctx.app, 'POST', `/api/encounters/${second.e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
    expect((await current()).prescription).toMatchObject({ recordId: second.e.id, items: [expect.objectContaining({ drugName: 'Cetirizine' })] })
    expect((await get('/api/portal/records')).json().records.map((r: { id: string }) => r.id)).toEqual([second.e.id, first.e.id])
    expect(PortalRecord.parse((await get(`/api/portal/records/${first.e.id}`)).json()).prescription.map((x) => x.drugName)).toEqual(['Amoxicillin'])

    // Read as the patient's own data only, and audited (ids, no clinical text).
    const { rows } = await adminQuery("SELECT entity_type, entity_id, patient_id, details FROM audit_events WHERE action = 'portal.read' AND entity_type = 'current_prescription' ORDER BY id")
    expect(rows.at(-1)).toEqual({ entity_type: 'current_prescription', entity_id: second.e.id, patient_id: p.id, details: { what: 'current_prescription' } })
    expect(rows[0]).toMatchObject({ entity_id: p.id })
    expect((await call(ctx.app, 'GET', '/api/portal/prescriptions/current', { cookie: doctor })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/portal/prescriptions/current')).statusCode).toBe(401)
  })

  it('says where each medicine’s course is on the clinic’s calendar day, across time zones; a medicine without a structured duration says so', async () => {
    const tz = async (zone: string) => {
      await adminQuery('UPDATE facilities SET timezone = $2 WHERE id = $1', [fx.facilityId, zone])
      return (await adminQuery('SELECT (now() at time zone $1)::date::text AS d', [zone])).rows[0].d as string
    }
    const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
    // A clinic 14 hours ahead of UTC: its day is not the UTC day for ten hours of every day.
    const todayA = await tz('Pacific/Kiritimati')
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Devi', phone: '98400 44444' }) })).json())
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const act = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'Devi-passphrase-1' } })
    const cookie = `adaxai_session=${act.cookies.find((c) => c.name === 'adaxai_session')!.value}`
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    expect(v.visitDate).toBe(todayA)
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const item = (drugName: string, duration: string, durationDays?: number, startDate?: string) => ({ drugName, strength: '', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'OD', duration, instructions: '', ...(durationDays && { durationDays }), ...(startDate && { startDate }) })
    const body = {
      ...fullDraft(e.version, 'Courses'),
      prescription: [
        item('Started two days ago', '5 days', 5, plus(todayA, -2)),
        item('Last day today', '5 days', 5, plus(todayA, -4)),
        item('Finished last week', '3 days', 3, plus(todayA, -10)),
        item('Starts tomorrow', '3 days', 3, plus(todayA, 1)),
        item('Starts today by default', '7 days', 7),
        item('No fixed length', 'Until review'),
      ],
    }
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
    const read = async () => PortalCurrentPrescriptionResponse.parse((await call(ctx.app, 'GET', '/api/portal/prescriptions/current', { cookie })).json())
    const lines = (r: PortalCurrentPrescriptionResponse) => r.prescription!.items.map((x) => `${x.drugName}: ${medicineCourseLabel(x.course, r.today)}`)

    const a = await read()
    expect(a.today).toBe(todayA)
    expect(lines(a)).toEqual([
      'Started two days ago: Day 3 of 5 · 2 days left',
      'Last day today: Day 5 of 5 · Completed',
      'Finished last week: Completed',
      `Starts tomorrow: Starts ${plus(todayA, 1)}`,
      'Starts today by default: Day 1 of 7 · 6 days left',
      // Missing is not none: never "Completed" or "0 days" for a medicine without a structured duration.
      'No fixed length: Duration not recorded',
    ])
    expect(a.prescription!.items.map((x) => x.course.endDate)).toEqual([plus(todayA, 2), todayA, plus(todayA, -8), plus(todayA, 3), plus(todayA, 6), null])
    expect(a.prescription!.items[5]).toMatchObject({ duration: 'Until review', durationDays: null, startDate: null, course: { state: 'duration_not_recorded', day: null, daysLeft: null } })

    // The same clinic moved 25 hours west (UTC-11): its day is one or two days earlier, and the courses follow its calendar, not the server's.
    const todayB = await tz('Pacific/Pago_Pago')
    const back = (Date.parse(`${todayA}T00:00:00Z`) - Date.parse(`${todayB}T00:00:00Z`)) / 86_400_000
    expect([1, 2]).toContain(back)
    const b = await read()
    expect(b.today).toBe(todayB)
    expect(b.prescription!.items.map((x) => x.course)).toEqual(b.prescription!.items.map((x) => medicineCourse(x, todayB)))
    expect(lines(b)[0]).toBe(`Started two days ago: Day ${3 - back} of 5 · ${2 + back} days left`)
    expect(lines(b)[4]).toBe(`Starts today by default: Starts ${todayA}`)
    expect(lines(b)[5]).toBe('No fixed length: Duration not recorded')
    // The record itself shows the same course per medicine.
    const record = PortalRecord.parse((await call(ctx.app, 'GET', `/api/portal/records/${e.id}`, { cookie })).json())
    expect(record.today).toBe(todayB)
    expect(record.prescription.map((x) => x.course)).toEqual(b.prescription!.items.map((x) => x.course))
  })

  it('staff accounts cannot use the portal; portal responses are not cacheable and reads are audited', async () => {
    const a = await patientWithRecords('Anita', '98400 11111')
    expect((await call(ctx.app, 'GET', '/api/portal/home', { cookie: doctor })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/portal/records', { cookie: nurse })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', '/api/portal/records')).statusCode).toBe(401)
    const res = await call(ctx.app, 'GET', `/api/portal/records/${a.encounterId}`, { cookie: a.cookie })
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    const { rows } = await adminQuery("SELECT entity_type FROM audit_events WHERE action = 'portal.read' ORDER BY occurred_at")
    expect(rows).toEqual([{ entity_type: 'record' }])
  })
})
