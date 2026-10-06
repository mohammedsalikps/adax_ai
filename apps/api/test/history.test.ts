import { Condition, Encounter, Investigation, Medication, PatientDetail, PatientHistory, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { facilities, patients } from '../src/db/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

const ctx = createTestApp()
let fx: Fixture
let doctor = ''
let nurse = ''
let admin = ''

let seq = 0
async function newPatient(): Promise<PatientDetail> {
  seq++
  return PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Hist${seq}`, phone: `92000${String(seq).padStart(5, '0')}` }) })).json())
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const history = async (id: string, cookie = doctor) => PatientHistory.parse((await call(ctx.app, 'GET', `/api/patients/${id}/history`, { cookie })).json())

const addCondition = (id: string, body: Record<string, unknown>, cookie = doctor) => call(ctx.app, 'POST', `/api/patients/${id}/conditions`, { cookie, body })
const addMedication = (id: string, body: Record<string, unknown>, cookie = doctor) => call(ctx.app, 'POST', `/api/patients/${id}/medications`, { cookie, body })
const addResult = (id: string, body: Record<string, unknown>, cookie = doctor) => call(ctx.app, 'POST', `/api/patients/${id}/investigations`, { cookie, body })

const METFORMIN = { drugName: 'Metformin', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Twice daily', startedOn: '2021-03-01', reason: 'Type 2 diabetes' }
const HBA1C = { testName: 'HbA1c', valueText: '7.2', valueNumber: 7.2, unit: '%', refLow: 4, refHigh: 5.6, collectedOn: daysAgo(30), resultedOn: daysAgo(29) }

beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  admin = await login(ctx.app, 't.admin')
})
afterAll(() => ctx.close())

async function signedConsultation(patientId: string, over: { complaint?: string; dx?: string; drug?: string } = {}) {
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId, departmentId: fx.departments.gen, chiefComplaint: over.complaint ?? 'Fever and cough' } })).json())
  await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'ready' } })
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  const saved = await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, {
    cookie: doctor,
    body: {
      version: e.version,
      note: { chiefComplaint: over.complaint ?? 'Fever and cough', history: 'Three days of fever.', pastHistory: '', examination: 'Throat congested.', assessment: 'Viral illness.', plan: 'Fluids.', followUp: 'Review if worse.' },
      diagnoses: [{ description: over.dx ?? 'Acute upper respiratory infection', code: 'J06.9', kind: 'primary' }],
      prescription: [{ drugName: over.drug ?? 'Paracetamol', strength: '500 mg', form: 'Tablet', dose: '1 tablet', route: 'Oral', frequency: 'Three times daily', duration: '3 days', instructions: 'After food' }],
    },
  })
  expect(saved.statusCode).toBe(200)
  const signed = await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.json().version, attestation: true } })
  expect(signed.statusCode).toBe(200)
  // HERO final (deliberate change): signing no longer closes the visit; the doctor completes it, so the patient can come back the same day.
  expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  return { encounterId: e.id, visitId: v.id }
}

describe('who may read and write', () => {
  it('doctors and nurses read a patient’s history; only doctors write; administrators and outsiders are refused', async () => {
    const p = await newPatient()
    const h = await history(p.id, nurse)
    expect(h).toMatchObject({ patientId: p.id, conditions: [], medications: [], investigations: [], consultations: [], allergies: [], latestVitals: [], more: { consultations: 0, investigations: 0 } })
    for (const [url, body] of [
      [`/api/patients/${p.id}/conditions`, { name: 'Hypertension', sinceYear: 2018 }],
      [`/api/patients/${p.id}/medications`, METFORMIN],
      [`/api/patients/${p.id}/investigations`, HBA1C],
    ] as const) {
      expect((await call(ctx.app, 'POST', url, { cookie: nurse, body })).statusCode, `nurse ${url}`).toBe(403)
      expect((await call(ctx.app, 'POST', url, { cookie: admin, body })).statusCode, `admin ${url}`).toBe(403)
      expect((await call(ctx.app, 'POST', url, { body })).statusCode, `anonymous ${url}`).toBe(401)
    }
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/history`, { cookie: admin })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/history`)).statusCode).toBe(401)
    // Nothing was written by the refused calls.
    expect((await adminQuery('SELECT (SELECT count(*) FROM patient_conditions) + (SELECT count(*) FROM patient_medications) + (SELECT count(*) FROM investigation_results) AS n')).rows[0].n).toBe('0')
  })

  it('another facility’s patient is not found, and the attempt is audited with its reason', async () => {
    const [other] = await ctx.db.insert(facilities).values({ code: 'OTHER-01', name: 'Other facility' }).returning()
    const [stranger] = await ctx.db.insert(patients).values({ facilityId: other!.id, givenName: 'Far', familyName: 'Away', dateOfBirth: '1990-01-01', sex: 'female', phone: '+919800000000' }).returning()
    for (const [method, url, body] of [
      ['GET', `/api/patients/${stranger!.id}/history`, undefined],
      ['POST', `/api/patients/${stranger!.id}/conditions`, { name: 'Asthma', sinceYear: 2015 }],
      ['POST', `/api/patients/${stranger!.id}/medications`, METFORMIN],
      ['POST', `/api/patients/${stranger!.id}/investigations`, HBA1C],
    ] as const) {
      expect((await call(ctx.app, method, url, { cookie: doctor, body })).statusCode, url).toBe(404)
    }
    const { rows } = await adminQuery(`SELECT details FROM audit_events WHERE action = 'access.not_found' AND entity_id = '${stranger!.id}'`)
    expect(rows.length).toBe(4)
    expect(rows.every((r) => r.details.reason === 'other_facility')).toBe(true)
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_conditions')).rows[0].n).toBe(0)
  })

  it('an entry that is not this patient’s, or another facility’s patient, is not found on the status routes either, and the attempt is audited', async () => {
    const [other] = await ctx.db.insert(facilities).values({ code: 'OTHER-02', name: 'Other facility' }).returning()
    const [stranger] = await ctx.db.insert(patients).values({ facilityId: other!.id, givenName: 'Far', familyName: 'Away', dateOfBirth: '1990-01-01', sex: 'female', phone: '+919800000001' }).returning()
    const mine = await newPatient()
    const theirs = await newPatient()
    const c = Condition.parse((await addCondition(theirs.id, { name: 'Asthma', sinceYear: 2010 })).json())
    const m = Medication.parse((await addMedication(theirs.id, METFORMIN)).json())
    const r = Investigation.parse((await addResult(theirs.id, HBA1C)).json())
    const body = { status: 'entered_in_error', reason: 'Wrong patient entirely' }
    const before = (await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.not_found'")).rows[0].n as number
    for (const [kind, id] of [['conditions', c.id], ['medications', m.id], ['investigations', r.id]] as const) {
      // Another patient's entry through this patient's address, an entry that does not exist, and a patient of another facility.
      expect((await call(ctx.app, 'POST', `/api/patients/${mine.id}/${kind}/${id}/status`, { cookie: doctor, body })).statusCode, `${kind} idor`).toBe(404)
      expect((await call(ctx.app, 'POST', `/api/patients/${mine.id}/${kind}/00000000-0000-4000-8000-000000000000/status`, { cookie: doctor, body })).statusCode, `${kind} unknown`).toBe(404)
      expect((await call(ctx.app, 'POST', `/api/patients/${stranger!.id}/${kind}/${id}/status`, { cookie: doctor, body })).statusCode, `${kind} other facility`).toBe(404)
    }
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.not_found'")).rows[0].n - before).toBe(9)
    const reasons = (await adminQuery("SELECT DISTINCT details->>'reason' AS reason FROM audit_events WHERE action = 'access.not_found' ORDER BY 1")).rows.map((x) => x.reason)
    expect(reasons).toEqual(['not_found_or_other_patient', 'other_facility'])
    // Nothing of theirs was changed.
    expect((await adminQuery("SELECT count(*)::int AS n FROM patient_history_events WHERE action = 'status_changed'")).rows[0].n).toBe(0)
    expect((await history(theirs.id)).conditions).toHaveLength(1)
  })

  it('entries take their origin from the patient they belong to, not from a setting that could disagree', async () => {
    const p = await newPatient()
    await adminQuery(`UPDATE patients SET data_origin = 'clinical' WHERE id = '${p.id}'`)
    expect(Condition.parse((await addCondition(p.id, { name: 'Asthma', sinceYear: 2010 })).json()).dataOrigin).toBe('clinical')
    expect(Medication.parse((await addMedication(p.id, METFORMIN)).json()).dataOrigin).toBe('clinical')
    expect(Investigation.parse((await addResult(p.id, HBA1C)).json()).dataOrigin).toBe('clinical')
    // A patient whose origin was never stated takes the deployment's.
    const q = await newPatient()
    await adminQuery(`UPDATE patients SET data_origin = 'unspecified' WHERE id = '${q.id}'`)
    expect(Condition.parse((await addCondition(q.id, { name: 'Asthma', sinceYear: 2010 })).json()).dataOrigin).toBe('synthetic')
  })

  it('patients registered through the API are marked with the deployment’s data origin', async () => {
    const p = await newPatient()
    expect(p.dataOrigin).toBe('synthetic')
    expect((await adminQuery('SELECT data_origin FROM patients WHERE id = $1', [p.id])).rows[0].data_origin).toBe('synthetic')
  })
})

describe('conditions', () => {
  it('records a condition with who entered it, its origin and a change event, and shows it in the history', async () => {
    const p = await newPatient()
    const res = await addCondition(p.id, { name: '  Type 2 diabetes mellitus ', code: 'e11.9', sinceYear: 2019, sinceMonth: 3, note: 'On metformin' })
    expect(res.statusCode).toBe(201)
    const c = Condition.parse(res.json())
    expect(c).toMatchObject({ name: 'Type 2 diabetes mellitus', code: 'E11.9', sinceYear: 2019, sinceMonth: 3, status: 'active', enteredByName: 'Test t.doctor', dataOrigin: 'synthetic' })
    expect((await history(p.id)).conditions.map((x) => x.id)).toEqual([c.id])
    const events = (await adminQuery('SELECT entity_type, action, to_status, actor_user_id FROM patient_history_events WHERE patient_id = $1', [p.id])).rows
    expect(events).toEqual([{ entity_type: 'condition', action: 'created', to_status: 'active', actor_user_id: fx.users.doctor }])
    // The audit trail names the entry and its status, never the clinical text.
    const audit = (await adminQuery("SELECT details, entity_id, patient_id FROM audit_events WHERE action = 'history.condition_add'")).rows
    expect(audit).toEqual([{ details: { status: 'active' }, entity_id: c.id, patient_id: p.id }])
  })

  it('validates input on the server', async () => {
    const p = await newPatient()
    const future = new Date().getUTCFullYear() + 1
    for (const [body, path] of [
      [{ name: '', sinceYear: 2019 }, 'name'],
      [{ name: 'x'.repeat(121), sinceYear: 2019 }, 'name'],
      [{ name: 'Asthma', sinceYear: 1800 }, 'sinceYear'],
      [{ name: 'Asthma', sinceYear: future }, 'sinceYear'],
      [{ name: 'Asthma', sinceYear: 2019, sinceMonth: 13 }, 'sinceMonth'],
      [{ name: 'Asthma', sinceYear: 2019, code: 'not-icd' }, 'code'],
      [{ name: 'Asthma', sinceYear: 2019, status: 'entered_in_error' }, 'status'],
      // PostgreSQL cannot store a NUL character in text; it is refused here with a message, not a server error.
      [{ name: 'Asth\u0000ma', sinceYear: 2019 }, 'name'],
      [{ name: 'Asthma', sinceYear: 2019, note: 'a\u0000b' }, 'note'],
    ] as const) {
      const res = await addCondition(p.id, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
      expect(res.json().issues.map((i: { path: string }) => i.path)).toContain(path)
    }
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_conditions')).rows[0].n).toBe(0)
  })

  it('does not list the same open condition twice, but allows it again once it is resolved', async () => {
    const p = await newPatient()
    const first = Condition.parse((await addCondition(p.id, { name: 'Asthma', sinceYear: 2010 })).json())
    const dup = await addCondition(p.id, { name: 'ASTHMA', sinceYear: 2012 })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('already_recorded')
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/conditions/${first.id}/status`, { cookie: doctor, body: { status: 'resolved' } })).statusCode).toBe(200)
    expect((await addCondition(p.id, { name: 'Asthma', sinceYear: 2022 })).statusCode).toBe(201)
    expect((await history(p.id)).conditions.map((c) => `${c.sinceYear}:${c.status}`).sort()).toEqual(['2010:resolved', '2022:active'])
    // Re-opening the old one while a newer one is open would list it twice: a conflict with a message, not a server error.
    const reopen = await call(ctx.app, 'POST', `/api/patients/${p.id}/conditions/${first.id}/status`, { cookie: doctor, body: { status: 'active' } })
    expect(reopen.statusCode).toBe(409)
    expect(reopen.json().error).toBe('already_recorded')
    expect((await history(p.id)).conditions.map((c) => `${c.sinceYear}:${c.status}`).sort()).toEqual(['2010:resolved', '2022:active'])
  })

  it('changes status with history; marking an error needs a reason, hides the entry and is final', async () => {
    const p = await newPatient()
    const c = Condition.parse((await addCondition(p.id, { name: 'Hypertension', sinceYear: 2016 })).json())
    const status = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/api/patients/${p.id}/conditions/${c.id}/status`, { cookie: doctor, body })
    expect(Condition.parse((await status({ status: 'controlled' })).json()).status).toBe('controlled')
    expect((await status({ status: 'controlled' })).json().error).toBe('no_change')
    expect((await status({ status: 'entered_in_error' })).statusCode).toBe(400)
    expect((await status({ status: 'entered_in_error', reason: 'ab' })).statusCode).toBe(400)
    // A NUL character in the reason is a message, not a server error.
    expect((await status({ status: 'entered_in_error', reason: 'Wrong  patient' })).statusCode).toBe(400)
    expect((await status({ status: 'controlled', reason: 'a b' })).statusCode).toBe(400)
    expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/conditions/${c.id}/status`, { cookie: nurse, body: { status: 'resolved' } })).statusCode).toBe(403)
    expect((await status({ status: 'entered_in_error', reason: 'Entered on the wrong patient' })).statusCode).toBe(200)
    expect((await history(p.id)).conditions).toEqual([])
    const locked = await status({ status: 'active' })
    expect(locked.statusCode).toBe(409)
    expect(locked.json().error).toBe('history_entry_locked')
    const events = (await adminQuery('SELECT action, from_status, to_status, reason FROM patient_history_events WHERE entity_id = $1 ORDER BY id', [c.id])).rows
    expect(events).toEqual([
      { action: 'created', from_status: null, to_status: 'active', reason: null },
      { action: 'status_changed', from_status: 'active', to_status: 'controlled', reason: null },
      { action: 'status_changed', from_status: 'controlled', to_status: 'entered_in_error', reason: 'Entered on the wrong patient' },
    ])
    // The entry itself is kept.
    expect((await adminQuery('SELECT status, status_reason FROM patient_conditions WHERE id = $1', [c.id])).rows[0]).toEqual({ status: 'entered_in_error', status_reason: 'Entered on the wrong patient' })
    // A condition of another patient cannot be reached through this patient's address.
    const other = await newPatient()
    expect((await call(ctx.app, 'POST', `/api/patients/${other.id}/conditions/${c.id}/status`, { cookie: doctor, body: { status: 'resolved' } })).statusCode).toBe(404)
  })
})

describe('medicines', () => {
  it('records a medicine, stops it with a reason and a date, and lists current ones first', async () => {
    const p = await newPatient()
    const stopped = Medication.parse((await addMedication(p.id, { drugName: 'Amlodipine', dose: '5 mg', frequency: 'Once daily', startedOn: '2020-01-10' })).json())
    const current = Medication.parse((await addMedication(p.id, METFORMIN)).json())
    expect(current).toMatchObject({ status: 'current', drugName: 'Metformin', strength: '500 mg', dose: '1 tablet', route: 'Oral', startedOn: '2021-03-01', stoppedOn: null, dataOrigin: 'synthetic' })
    const res = await call(ctx.app, 'POST', `/api/patients/${p.id}/medications/${stopped.id}/status`, { cookie: doctor, body: { status: 'stopped', stoppedOn: '2023-06-01', reason: 'Ankle swelling' } })
    expect(Medication.parse(res.json())).toMatchObject({ status: 'stopped', stoppedOn: '2023-06-01', statusReason: 'Ankle swelling' })
    expect((await history(p.id)).medications.map((m) => `${m.drugName}:${m.status}`)).toEqual(['Metformin:current', 'Amlodipine:stopped'])
    // Stopping needs a reason; a stop date cannot precede the start or be in the future; a stopped medicine is not stopped twice.
    const again = (body: Record<string, unknown>, id = current.id) => call(ctx.app, 'POST', `/api/patients/${p.id}/medications/${id}/status`, { cookie: doctor, body })
    expect((await again({ status: 'stopped' })).statusCode).toBe(400)
    expect((await again({ status: 'stopped', reason: 'Switched', stoppedOn: '2020-01-01' })).statusCode).toBe(400)
    expect((await again({ status: 'stopped', reason: 'Switched', stoppedOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) })).statusCode).toBe(400)
    expect((await again({ status: 'stopped', reason: 'Again' }, stopped.id)).json().error).toBe('no_change')
    expect((await again({ status: 'current', reason: 'Restart' }, stopped.id)).statusCode).toBe(400)
  })

  it('does not list the same current medicine twice, and validates dates', async () => {
    const p = await newPatient()
    expect((await addMedication(p.id, METFORMIN)).statusCode).toBe(201)
    const dup = await addMedication(p.id, { ...METFORMIN, drugName: 'METFORMIN', strength: '500 MG', reason: 'again' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('already_recorded')
    // The same medicine at a different dose or frequency is a different entry (for example a morning and an evening dose).
    expect((await addMedication(p.id, { ...METFORMIN, dose: '2 tablets' })).statusCode).toBe(201)
    for (const body of [{ ...METFORMIN, drugName: '' }, { ...METFORMIN, dose: '' }, { ...METFORMIN, frequency: '' }, { ...METFORMIN, startedOn: '2999-01-01' }, { ...METFORMIN, startedOn: 'yesterday' }]) {
      expect((await addMedication(p.id, body)).statusCode, JSON.stringify(body)).toBe(400)
    }
  })

  it('marks a medicine as an error: needs a reason, hides it, is final, and is recorded', async () => {
    const p = await newPatient()
    const m = Medication.parse((await addMedication(p.id, METFORMIN)).json())
    const status = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/api/patients/${p.id}/medications/${m.id}/status`, { cookie: doctor, body })
    expect((await status({ status: 'entered_in_error', reason: 'x' })).statusCode).toBe(400)
    expect((await status({ status: 'entered_in_error', reason: 'Wrong patient', stoppedOn: '2023-01-01' })).statusCode).toBe(400)
    expect((await status({ status: 'entered_in_error', reason: 'Wrong patient' })).statusCode).toBe(200)
    expect((await history(p.id)).medications).toEqual([])
    expect((await status({ status: 'stopped', reason: 'Late' })).json().error).toBe('history_entry_locked')
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'history.medication_status' AND details = '{\"from\": \"current\", \"to\": \"entered_in_error\"}'")).rows[0].n).toBe(1)
  })
})

describe('investigation results', () => {
  it('computes the flag from the numbers, or takes the clinician’s reading, or says unknown', async () => {
    const p = await newPatient()
    let day = 40
    const flag = async (over: Record<string, unknown>) => Investigation.parse((await addResult(p.id, { ...HBA1C, collectedOn: daysAgo(day++), ...over })).json()).flag
    expect(await flag({ valueNumber: 7.2 })).toBe('high')
    expect(await flag({ valueNumber: 5.0, valueText: '5.0' })).toBe('normal')
    expect(await flag({ valueNumber: 3.1, valueText: '3.1' })).toBe('low')
    expect(await flag({ valueNumber: 9, valueText: '9', refLow: null, refHigh: 5.6 })).toBe('high')
    expect(await flag({ valueText: 'Positive', valueNumber: null, refLow: null, refHigh: null, unit: null, testName: 'Dengue NS1', interpretation: 'abnormal' })).toBe('abnormal')
    expect(await flag({ valueText: 'Seen', valueNumber: null, refLow: null, refHigh: null, unit: null, testName: 'Smear' })).toBe('unknown')
    // A numeric result is flagged from its numbers even if the clinician's reading disagrees.
    expect(await flag({ valueNumber: 7.2, valueText: '7.2', interpretation: 'normal' })).toBe('high')
  })

  it('takes the number from a result that is only a number, and refuses a number that disagrees with the result as it reads', async () => {
    const p = await newPatient()
    // Left out, the number is read from the text, so the flag cannot be missed.
    const derived = Investigation.parse((await addResult(p.id, { ...HBA1C, valueText: '9.1', valueNumber: undefined, collectedOn: daysAgo(50) })).json())
    expect(derived).toMatchObject({ valueText: '9.1', valueNumber: 9.1, flag: 'high' })
    // A number that disagrees with what the result reads is refused (96 shown with a flag for 960 would mislead).
    const clash = await addResult(p.id, { ...HBA1C, valueText: '96', valueNumber: 960, collectedOn: daysAgo(51) })
    expect(clash.statusCode).toBe(400)
    expect(clash.json().issues.map((i: { path: string }) => i.path)).toContain('valueNumber')
    // Text that is not plain (a unit, a comparator) is not compared, so the entered number stands.
    expect(Investigation.parse((await addResult(p.id, { ...HBA1C, valueText: '7.2 %', valueNumber: 7.2, collectedOn: daysAgo(52) })).json()).flag).toBe('high')
    expect(Investigation.parse((await addResult(p.id, { ...HBA1C, valueText: '<5', valueNumber: undefined, collectedOn: daysAgo(53) })).json())).toMatchObject({ valueNumber: null, flag: 'unknown' })
    expect((await adminQuery('SELECT count(*)::int AS n FROM investigation_results')).rows[0].n).toBe(3)
  })

  it('lists the most recent results first, with the entry’s source, and counts what is not returned', async () => {
    const p = await newPatient()
    for (let i = 0; i < 32; i++) expect((await addResult(p.id, { ...HBA1C, collectedOn: daysAgo(40 + i), valueText: `7.${i % 10}`, valueNumber: 7 + (i % 10) / 10 })).statusCode).toBe(201)
    const h = await history(p.id)
    expect(h.investigations).toHaveLength(30)
    expect(h.more.investigations).toBe(2)
    expect(h.investigations[0]!.collectedOn).toBe(daysAgo(40))
    expect(h.investigations[0]).toMatchObject({ enteredByName: 'Test t.doctor', dataOrigin: 'synthetic', status: 'final' })
  })

  it('keeps the newest result of every test on the list, however many results one test has', async () => {
    const p = await newPatient()
    await addResult(p.id, { testName: 'Creatinine', valueText: '1.9', valueNumber: 1.9, unit: 'mg/dL', refLow: 0.6, refHigh: 1.3, collectedOn: daysAgo(400) })
    for (let i = 0; i < 35; i++) expect((await addResult(p.id, { ...HBA1C, collectedOn: daysAgo(40 + i), valueText: `7.${i % 10}`, valueNumber: 7 + (i % 10) / 10 })).statusCode).toBe(201)
    const h = await history(p.id)
    // 30 most recent HbA1c results, plus the one Creatinine that would otherwise fall off the list; the rest are counted.
    expect(h.investigations).toHaveLength(31)
    expect(h.investigations.map((r) => r.testName)).toContain('Creatinine')
    expect(h.investigations.find((r) => r.testName === 'Creatinine')).toMatchObject({ flag: 'high' })
    expect(h.more.investigations).toBe(5)
    const dates = h.investigations.map((r) => r.collectedOn)
    expect(dates).toEqual([...dates].sort().reverse())
  })

  it('validates input, refuses duplicates, and marks an error with a reason', async () => {
    const p = await newPatient()
    for (const body of [
      { ...HBA1C, testName: '' },
      { ...HBA1C, testName: 'Hb\u0000A1c' },
      { ...HBA1C, collectedOn: '0000-01-01' },
      { ...HBA1C, valueText: '' },
      { ...HBA1C, collectedOn: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) },
      { ...HBA1C, resultedOn: daysAgo(31) },
      { ...HBA1C, refLow: 9, refHigh: 5 },
      { ...HBA1C, collectedOn: '12/03/2024' },
    ]) {
      expect((await addResult(p.id, body)).statusCode, JSON.stringify(body)).toBe(400)
    }
    const first = Investigation.parse((await addResult(p.id, HBA1C)).json())
    const dup = await addResult(p.id, { ...HBA1C, testName: 'hba1c' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error).toBe('already_recorded')
    const status = (body: Record<string, unknown>) => call(ctx.app, 'POST', `/api/patients/${p.id}/investigations/${first.id}/status`, { cookie: doctor, body })
    expect((await status({ status: 'entered_in_error' })).statusCode).toBe(400)
    expect((await status({ status: 'resolved', reason: 'no' })).statusCode).toBe(400)
    expect((await status({ status: 'entered_in_error', reason: 'Wrong test' })).statusCode).toBe(200)
    expect((await status({ status: 'entered_in_error', reason: 'Again' })).json().error).toBe('history_entry_locked')
    expect((await history(p.id)).investigations).toEqual([])
    // Once marked as an error, the same result can be entered again correctly.
    expect((await addResult(p.id, { ...HBA1C, valueText: '7.1', valueNumber: 7.1 })).statusCode).toBe(201)
  })
})

describe('the history read model', () => {
  it('shows signed consultations (not drafts or discarded ones), allergies, latest vital signs with time and source, and the audit says what was read', async () => {
    const p = await newPatient()
    await call(ctx.app, 'POST', `/api/patients/${p.id}/allergies`, { cookie: nurse, body: { substance: 'Penicillin', reaction: 'Rash', severity: 'moderate' } })
    const dead = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Old visit' } })).json())
    await call(ctx.app, 'POST', `/api/visits/${dead.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 37.0 }, { kind: 'heart_rate', value: 70 }] } })
    await call(ctx.app, 'POST', `/api/visits/${dead.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Left before being seen' } })
    const signed = await signedConsultation(p.id)
    // A draft in progress and a vital sign marked as an error are not part of it.
    const draftVisit = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Today' } })).json())
    await call(ctx.app, 'POST', `/api/visits/${draftVisit.id}/status`, { cookie: nurse, body: { status: 'ready' } })
    const draftEncounter = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${draftVisit.id}/encounter`, { cookie: doctor })).json())
    await call(ctx.app, 'POST', `/api/visits/${draftVisit.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 38.6 }, { kind: 'spo2', value: 97 }] } })

    const h = await history(p.id)
    expect(h.allergies).toMatchObject([{ substance: 'Penicillin', reaction: 'Rash', severity: 'moderate', status: 'active' }])
    expect(h.consultations).toHaveLength(1)
    expect(h.consultations[0]).toMatchObject({
      encounterId: signed.encounterId,
      doctorName: 'Test t.doctor',
      departmentName: 'General Medicine',
      chiefComplaint: 'Fever and cough',
      diagnoses: [{ description: 'Acute upper respiratory infection', code: 'J06.9', kind: 'primary' }],
      prescription: [{ drugName: 'Paracetamol', strength: '500 mg', dose: '1 tablet', frequency: 'Three times daily', duration: '3 days' }],
      amendmentCount: 0,
    })
    // One value per kind, the newest, each with its time and where it came from.
    const byKind = Object.fromEntries(h.latestVitals.map((o) => [o.kind, o]))
    expect(Object.keys(byKind).sort()).toEqual(['heart_rate', 'spo2', 'temperature'])
    expect(byKind.temperature).toMatchObject({ value: 38.6, source: 'manual', validationStatus: 'manual_entry', unit: '°C' })
    expect(Date.parse(byKind.temperature!.measuredAt)).toBeGreaterThan(Date.parse(byKind.heart_rate!.measuredAt) - 1)
    // A discarded draft is not history either.
    const discarded = await call(ctx.app, 'POST', `/api/encounters/${draftEncounter.id}/discard`, { cookie: doctor, body: { version: draftEncounter.version, reason: 'Opened by mistake' } })
    expect(discarded.statusCode).toBe(200)
    expect((await history(p.id)).consultations).toHaveLength(1)

    const audit = (await adminQuery("SELECT details FROM audit_events WHERE action = 'patient.history_read' AND patient_id = $1 ORDER BY id", [p.id])).rows
    expect(audit.at(-1)!.details).toEqual({ conditions: 0, medications: 0, investigations: 0, consultations: 1 })
  })

  it('latest vital signs leave out readings marked as entered in error, and the newest of equal time wins', async () => {
    const p = await newPatient()
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Check' } })).json())
    const at = new Date(Date.now() - 600_000).toISOString()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 37.0 }], measuredAt: at } })
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'temperature', value: 39.9 }], measuredAt: new Date(Date.now() - 300_000).toISOString() } })
    expect((await history(p.id)).latestVitals.find((o) => o.kind === 'temperature')!.value).toBe(39.9)
    const wrong = (await adminQuery("SELECT id FROM observations WHERE kind = 'temperature' AND value = 39.9")).rows[0].id as string
    expect((await call(ctx.app, 'POST', `/api/observations/${wrong}/entered-in-error`, { cookie: nurse, body: { reason: 'Thermometer was in the sun' } })).statusCode).toBe(200)
    // The mistaken reading is not shown as the latest; the previous one is.
    expect((await history(p.id)).latestVitals.find((o) => o.kind === 'temperature')!.value).toBe(37)
  })

  it('the nurse reads the same history and the entries of the other lists are in it', async () => {
    const p = await newPatient()
    await addCondition(p.id, { name: 'Hypertension', sinceYear: 2016 })
    await addMedication(p.id, METFORMIN)
    await addResult(p.id, HBA1C)
    const asNurse = await history(p.id, nurse)
    expect([asNurse.conditions.length, asNurse.medications.length, asNurse.investigations.length]).toEqual([1, 1, 1])
    expect(asNurse.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('what the database enforces, whoever asks', () => {
  async function seeded() {
    const p = await newPatient()
    const c = Condition.parse((await addCondition(p.id, { name: 'Asthma', sinceYear: 2010 })).json())
    const m = Medication.parse((await addMedication(p.id, METFORMIN)).json())
    const r = Investigation.parse((await addResult(p.id, HBA1C)).json())
    return { p, c, m, r }
  }

  it('refuses deleting any entry, and changing the content of one', async () => {
    const { c, m, r } = await seeded()
    for (const [table, id, set] of [
      ['patient_conditions', c.id, "name = 'Something else'"],
      ['patient_conditions', c.id, 'since_year = 2000'],
      ['patient_medications', m.id, "dose = '10 tablets'"],
      ['patient_medications', m.id, "drug_name = 'Other'"],
      ['investigation_results', r.id, "value_text = '5.0', flag = 'normal'"],
      ['investigation_results', r.id, 'collected_on = collected_on - 1'],
    ] as const) {
      await expect(adminQuery(`UPDATE ${table} SET ${set} WHERE id = '${id}'`), `${table} ${set}`).rejects.toMatchObject({ code: 'AX008' })
      await expect(adminQuery(`DELETE FROM ${table} WHERE id = '${id}'`), `delete ${table}`).rejects.toMatchObject({ code: 'AX008' })
    }
    // The same through the application's own connection.
    await expect(ctx.pool.query("UPDATE patient_conditions SET name = 'x' WHERE id = $1", [c.id])).rejects.toMatchObject({ code: 'AX008' })
    await expect(ctx.pool.query('DELETE FROM investigation_results WHERE id = $1', [r.id])).rejects.toMatchObject({ code: 'AX008' })
    // Status and its explanation are what may change, and an error entry is final.
    await adminQuery(`UPDATE patient_conditions SET status = 'controlled', updated_at = now() WHERE id = '${c.id}'`)
    await adminQuery(`UPDATE patient_conditions SET status = 'entered_in_error', status_reason = 'Mistake' WHERE id = '${c.id}'`)
    await expect(adminQuery(`UPDATE patient_conditions SET status = 'active', status_reason = null WHERE id = '${c.id}'`)).rejects.toMatchObject({ code: 'AX008' })
    // An error needs a reason even when the API is bypassed.
    await expect(adminQuery(`UPDATE investigation_results SET status = 'entered_in_error' WHERE id = '${r.id}'`)).rejects.toMatchObject({ code: '23514' })
  })

  it('does not let a stopped medicine be restarted or have its stop details rewritten', async () => {
    const { m } = await seeded()
    await adminQuery(`UPDATE patient_medications SET status = 'stopped', stopped_on = '2024-01-01', status_reason = 'Switched' WHERE id = '${m.id}'`)
    await expect(adminQuery(`UPDATE patient_medications SET status = 'current', stopped_on = null, status_reason = null WHERE id = '${m.id}'`)).rejects.toMatchObject({ code: 'AX008' })
    await expect(adminQuery(`UPDATE patient_medications SET stopped_on = '2024-02-02' WHERE id = '${m.id}'`)).rejects.toMatchObject({ code: 'AX008' })
    await adminQuery(`UPDATE patient_medications SET status = 'entered_in_error', status_reason = 'Wrong patient' WHERE id = '${m.id}'`)
  })

  it('does not let a stop date appear or change on the way to "entered in error"', async () => {
    const { p, m } = await seeded()
    // A medicine that was never stopped cannot gain a stop date by being marked as an error.
    await expect(adminQuery(`UPDATE patient_medications SET status = 'entered_in_error', status_reason = 'Wrong patient', stopped_on = '2024-01-01' WHERE id = '${m.id}'`)).rejects.toMatchObject({ code: 'AX008' })
    // One that was stopped keeps the date it was recorded with.
    const second = Medication.parse((await addMedication(p.id, { ...METFORMIN, dose: '2 tablets' })).json())
    await adminQuery(`UPDATE patient_medications SET status = 'stopped', stopped_on = '2024-01-01', status_reason = 'Switched' WHERE id = '${second.id}'`)
    await expect(adminQuery(`UPDATE patient_medications SET status = 'entered_in_error', status_reason = 'Wrong patient', stopped_on = '2024-03-03' WHERE id = '${second.id}'`)).rejects.toMatchObject({ code: 'AX008' })
    await adminQuery(`UPDATE patient_medications SET status = 'entered_in_error', status_reason = 'Wrong patient' WHERE id = '${second.id}'`)
    expect((await adminQuery(`SELECT stopped_on::text AS d FROM patient_medications WHERE id = '${second.id}'`)).rows[0].d).toBe('2024-01-01')
  })

  it('cannot be emptied: "never deleted" covers TRUNCATE for the superuser as well', async () => {
    await seeded()
    for (const table of ['patient_conditions', 'patient_medications', 'investigation_results']) {
      await expect(adminQuery(`TRUNCATE ${table}`), table).rejects.toThrow()
      await expect(ctx.pool.query(`TRUNCATE ${table}`), `${table} (application role)`).rejects.toThrow()
    }
    expect((await adminQuery('SELECT (SELECT count(*) FROM patient_conditions) + (SELECT count(*) FROM patient_medications) + (SELECT count(*) FROM investigation_results) AS n')).rows[0].n).toBe('3')
  })

  it('keeps the change history append-only, for the application and for the superuser', async () => {
    await seeded()
    await expect(ctx.pool.query("UPDATE patient_history_events SET reason = 'x'")).rejects.toThrow()
    await expect(ctx.pool.query('DELETE FROM patient_history_events')).rejects.toThrow()
    await expect(adminQuery("UPDATE patient_history_events SET reason = 'x'")).rejects.toThrow()
    await expect(adminQuery('DELETE FROM patient_history_events')).rejects.toThrow()
    await expect(adminQuery('TRUNCATE patient_history_events')).rejects.toThrow()
    expect((await adminQuery('SELECT count(*)::int AS n FROM patient_history_events')).rows[0].n).toBe(3)
    expect((await adminQuery("SELECT table_name FROM meta.append_only_tables WHERE table_name = 'patient_history_events'")).rows).toHaveLength(1)
  })

  it('refuses a duplicate open entry even when the API is bypassed', async () => {
    const { p } = await seeded()
    await expect(adminQuery(`INSERT INTO patient_conditions (patient_id, name, since_year, data_origin, entered_by) VALUES ('${p.id}', 'asthma', 2011, 'synthetic', '${fx.users.doctor}')`)).rejects.toMatchObject({ code: '23505' })
    await expect(adminQuery(`INSERT INTO patient_conditions (patient_id, name, since_year, data_origin, entered_by) VALUES ('${p.id}', 'Eczema', 2011, 'made-up', '${fx.users.doctor}')`)).rejects.toMatchObject({ code: '23514' })
  })
})
