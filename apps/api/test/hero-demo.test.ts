import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PatientHistory } from '@adaxai/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HERO_BAND, HERO_PAST, HERO_TODAY_COMPLAINT, seedHeroDemo, type HeroDemoResult } from '../src/db/hero-demo.ts'
import { seed } from '../src/db/seed.ts'
import { adminQuery, call, createTestApp, login, resetDatabase, TEST_PASSWORD, testConfig } from './helpers.ts'

// The synthetic hero demo (npm run demo:hero): that it is what it says it is, made through the real API, consistent with the demo audio's script,
// idempotent for the patient and her history, a new visit for today on every run, a simulator band that is never a device, and refused where it
// does not belong.

const ctx = createTestApp()
const simDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaxai-hero-demo-'))
const run = (over: Partial<Parameters<typeof seedHeroDemo>[0]> = {}) => seedHeroDemo({ config: testConfig, password: TEST_PASSWORD, log: () => undefined, simDir, ...over })
let doctor = ''
let first: HeroDemoResult

beforeAll(async () => {
  await resetDatabase()
  await seed(ctx.db, TEST_PASSWORD)
  first = await run()
  doctor = await login(ctx.app, 'dr.meera')
}, 120_000)
afterAll(async () => {
  await ctx.close()
  fs.rmSync(simDir, { recursive: true, force: true })
})

const history = async (id: string) => PatientHistory.parse((await call(ctx.app, 'GET', `/api/patients/${id}/history`, { cookie: doctor })).json())
const visits = async (id: string) => (await call(ctx.app, 'GET', `/api/patients/${id}/visits`, { cookie: doctor })).json().visits as { id: string; visitDate: string; status: string; statusReason?: string | null; chiefComplaint: string | null; assignedDoctorName: string | null }[]

describe('the synthetic hero demo', () => {
  it('creates a synthetic child with the consents, the allergy, the medicine and one signed earlier consultation', async () => {
    expect(first.createdPatient).toBe(true)
    expect(first.historyAdded).toBe(5 + 1 + 1 + 1)
    const p = (await call(ctx.app, 'GET', `/api/patients/${first.patientId}`, { cookie: doctor })).json()
    expect(p).toMatchObject({ fullName: 'Anaya Demo-Synthetic', sex: 'female', dateOfBirth: '2020-05-14', dataOrigin: 'synthetic' })
    expect((p.consents as { type: string; status: string }[]).filter((c) => c.status === 'granted').map((c) => c.type).sort()).toEqual(['ai_record_assistant', 'ai_recording', 'data_processing', 'device_monitoring', 'thermal_imaging'])
    const h = await history(first.patientId)
    expect(h.noKnownAllergies).toBe(false)
    expect(h.allergies.map((a) => [a.substance, a.reaction, a.severity])).toEqual([['Amoxicillin', 'Rash', 'moderate']])
    expect(h.medications.map((m) => [m.drugName, m.status])).toEqual([['Salbutamol inhaler', 'current']])
    expect(h.consultations).toHaveLength(1)
    const c = h.consultations[0]!
    expect(c.chiefComplaint).toBe(HERO_PAST.complaint)
    expect(c.prescription.map((r) => r.drugName)).toEqual(['Salbutamol inhaler', 'Paracetamol'])
    // About two months ago, on the facility's calendar, and the signed record still verifies as untouched.
    const days = (Date.parse(`${(await call(ctx.app, 'GET', '/api/appointments/options', { cookie: await login(ctx.app, 'nurse.anil') })).json().today}T00:00:00Z`) - Date.parse(`${c.date}T00:00:00Z`)) / 86_400_000
    expect(days).toBe(60)
    expect(String(c.signedAt).slice(0, 10)).toBe(c.date)
    expect((await call(ctx.app, 'GET', `/api/encounters/${c.encounterId}/verification`, { cookie: doctor })).json().status).toBe('valid')
    // The medicine was started at that consultation.
    expect(h.medications[0]!.startedOn).toBe(c.date)
  })

  it('prescribes nothing she is allergic to: no penicillin in her record', async () => {
    const h = await history(first.patientId)
    const drugs = [...h.medications.map((m) => m.drugName), ...h.consultations.flatMap((c) => c.prescription.map((r) => r.drugName))].map((d) => d.toLowerCase())
    for (const d of drugs) expect(['amoxicillin', 'penicillin', 'ampicillin', 'co-amoxiclav'].some((s) => d.includes(s)), d).toBe(false)
  })

  it('makes today’s visit ready for Dr. Meera, with the nurse’s vital signs', async () => {
    const today = (await visits(first.patientId)).find((v) => v.id === first.visit.id)!
    expect(today).toMatchObject({ status: 'ready', chiefComplaint: HERO_TODAY_COMPLAINT })
    expect(today.assignedDoctorName).toMatch(/Meera/)
    const rows = (await adminQuery('SELECT kind::text AS kind, value::float AS value, source FROM observations WHERE visit_id = $1 ORDER BY kind::text', [first.visit.id])).rows
    expect(rows.map((r) => r.kind)).toEqual(['heart_rate', 'respiratory_rate', 'spo2', 'temperature', 'weight'])
    expect(new Set(rows.map((r) => r.source))).not.toContain('device')
  })

  it('registers a SIMULATOR band, attaches it to her, and writes a token that the gateway accepts as a simulator', async () => {
    expect(first.band).toMatchObject({ registered: true, attachment: 'attached' })
    const admin = await login(ctx.app, 'admin')
    const band = ((await call(ctx.app, 'GET', '/api/devices', { cookie: admin })).json().devices as { id: string; serialNumber: string; simulated: boolean; integration: string }[]).find((d) => d.serialNumber === HERO_BAND.serialNumber)!
    expect(band).toMatchObject({ id: first.band.id, simulated: true, integration: 'simulator' })
    const nurse = await login(ctx.app, 'nurse.anil')
    const seen = ((await call(ctx.app, 'GET', '/api/devices', { cookie: nurse })).json().devices as { id: string; assignment: { patientId: string; visitId: string } | null }[]).find((d) => d.id === band.id)!
    expect(seen.assignment).toMatchObject({ patientId: first.patientId, visitId: first.visit.id })
    expect(first.band.tokenWritten).toBe(path.join(simDir, `${HERO_BAND.serialNumber}.token`))
    const token = fs.readFileSync(first.band.tokenFile, 'utf8')
    const hello = await ctx.app.inject({ method: 'POST', url: '/api/device-ingest/heartbeat', headers: { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1' }, payload: {} })
    expect(hello.statusCode).toBe(200)
    expect(hello.json()).toMatchObject({ simulator: true, assigned: true })
  })

  it('on a second run adds nothing to her history and makes a new visit for today, cancelling the unused one', async () => {
    const count = 'SELECT (SELECT count(*) FROM patients) AS p, (SELECT count(*) FROM consents) AS c, (SELECT count(*) FROM allergies) AS a, (SELECT count(*) FROM patient_medications) AS m, (SELECT count(*) FROM encounters) AS e, (SELECT count(*) FROM devices) AS d'
    const before = (await adminQuery(count)).rows[0]
    const token = fs.readFileSync(first.band.tokenFile, 'utf8')
    const again = await run()
    expect(again).toMatchObject({ patientId: first.patientId, createdPatient: false, historyAdded: 0, replacedVisit: { id: first.visit.id }, band: { id: first.band.id, registered: false, attachment: 'reattached', tokenWritten: null } })
    expect(again.visit.id).not.toBe(first.visit.id)
    expect((await adminQuery(count)).rows[0]).toEqual(before)
    // The token on disk is kept (a new one would cut off a simulator that is running).
    expect(fs.readFileSync(first.band.tokenFile, 'utf8')).toBe(token)
    const list = await visits(first.patientId)
    expect(list.find((v) => v.id === first.visit.id)).toMatchObject({ status: 'cancelled' })
    expect(list.find((v) => v.id === again.visit.id)).toMatchObject({ status: 'ready' })
    expect((await history(first.patientId)).consultations).toHaveLength(1)
    first = again
  })

  it('leaves a visit alone once the doctor has started its consultation, and says what to do', async () => {
    const started = await call(ctx.app, 'POST', `/api/visits/${first.visit.id}/encounter`, { cookie: doctor })
    expect(started.statusCode).toBeLessThan(300)
    await expect(run()).rejects.toThrow(/not signed yet. Sign or discard it/)
    expect((await visits(first.patientId)).find((v) => v.id === first.visit.id)).toMatchObject({ status: 'in_consultation' })
    // Discarded by the doctor: the next run makes a new visit again.
    const e = started.json()
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/discard`, { cookie: doctor, body: { version: e.version, reason: 'Demo reset (synthetic)' } })).statusCode).toBe(200)
    const after = await run()
    expect(after.replacedVisit).toMatchObject({ id: first.visit.id })
  })

  it('refuses a deployment that is not synthetic, production, records marked as clinical, or a facility not marked synthetic', async () => {
    await expect(run({ config: { ...testConfig, dataOrigin: 'clinical' } })).rejects.toThrow(/synthetic/)
    await expect(run({ config: { ...testConfig, env: 'production' } })).rejects.toThrow(/production/)
    await adminQuery(`UPDATE patients SET data_origin = 'clinical' WHERE id = $1`, [first.patientId])
    try {
      await expect(run()).rejects.toThrow(/clinical/)
    } finally {
      await adminQuery(`UPDATE patients SET data_origin = 'synthetic' WHERE id = $1`, [first.patientId])
    }
    await adminQuery("UPDATE facilities SET name = replace(name, ' (synthetic)', '') WHERE code = 'DEMO-OPD-01'")
    try {
      await expect(run()).rejects.toThrow(/synthetic/)
    } finally {
      await adminQuery("UPDATE facilities SET name = name || ' (synthetic)' WHERE code = 'DEMO-OPD-01' AND name NOT LIKE '%(synthetic)'")
    }
  })
})
