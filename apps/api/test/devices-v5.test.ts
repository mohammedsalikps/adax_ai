import { AuscultationRecording, Device, DeviceIngestResponse, DeviceList, DeviceReadingsRequest, Encounter, PatientDetail, PatientDeviceReadings, readingState, Visit } from '@adaxai/contracts'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sniffAudio } from '../src/ai/audio-sniff.ts'
import { buildPatientContext } from '../src/ai/context.ts'
import type { SessionUser } from '../src/auth/sessions.ts'
import { buildConsultationInputs } from '../src/consult/inputs.ts'
import { departments, facilities, users } from '../src/db/schema.ts'
import { hashPassword } from '../src/auth/password.ts'
import { SIM_SCENARIOS, type SimScenario, simBatchKey, simulatedBatch, simulatedTick, simulatedToneWav } from '../src/devices/simulator.ts'
import { answerFromRecord, recordChecks } from '../src/mana/answers.ts'
import { loadPatientRecord } from '../src/mana/record.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD, testConfig } from './helpers.ts'

// Slice V5: the device layer. NO PHYSICAL DEVICE is involved anywhere here. A "gateway" is this test posting to the gateway API with a device's
// token, exactly as a gateway program would; a "simulator" is a device record registered as one, whose values the server stores as simulated.
// Time is the device boundary's own clock, which the tests move forward (never back: consents and visits are stamped by the database's clock).

let ahead = 0
const clock = () => Date.now() + ahead
const settings = loadAppSettings()
// Every test signs three people in again after the database is emptied: the sign-in limits are not what is under test here.
const generous = { ...settings, security: { rateLimits: { ...settings.security.rateLimits, loginPerIp: { max: 100_000, windowSeconds: 60 }, loginPerAccount: { max: 100_000, windowSeconds: 60 } } } }
const ctx = createTestApp({ clock, settings: generous })
let fx: Fixture
let admin = ''
let nurse = ''
let doctor = ''
afterAll(() => ctx.close())
beforeEach(async () => {
  ahead = 0
  await resetDatabase()
  fx = await createFixture(ctx.db)
  admin = await login(ctx.app, 't.admin')
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
})

type App = typeof ctx.app
const gatewayPost = (app: App, url: string, token: string | null, body: unknown) => app.inject({ method: 'POST', url, headers: { 'x-adaxai-csrf': '1', ...(token && { authorization: `Bearer ${token}` }) }, payload: body as object })
const ingest = (token: string | null, body: unknown, app: App = ctx.app) => gatewayPost(app, '/api/device-ingest/readings', token, body)
const heartbeat = (token: string, app: App = ctx.app) => gatewayPost(app, '/api/device-ingest/heartbeat', token, {})
const at = (offsetMs = 0) => new Date(clock() + offsetMs).toISOString()
const batch = (over: object = {}) => ({ measuredAt: at(), readings: [{ kind: 'heart_rate', value: 72 }, { kind: 'spo2', value: 97 }], ...over })

async function device(o: { kind?: string; integration?: string; label?: string } = {}) {
  const res = await call(ctx.app, 'POST', '/api/admin/devices', { cookie: admin, body: { kind: o.kind ?? 'wearable_band', label: o.label ?? 'Band', serialNumber: `SN-${crypto.randomUUID().slice(0, 8)}`, integration: o.integration ?? 'gateway_api' } })
  expect(res.statusCode, res.body).toBe(201)
  return Device.parse(res.json())
}
const tokenFor = async (d: Device) => (await call(ctx.app, 'POST', `/api/admin/devices/${d.id}/token`, { cookie: admin })).json().token as string
let seq = 0
async function patient(consents: string[] = ['device_monitoring']) {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Dev${'abcdefghij'[seq % 10]}${'klmnopqrst'[Math.floor(seq / 10) % 10]}`, phone: `98401 ${String(10000 + seq)}` }) })).json())
  for (const type of consents) await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type, method: 'verbal' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Palpitations' } })).json())
  return { p, v }
}
const assign = (d: Device, body: object, cookie = nurse) => call(ctx.app, 'POST', `/api/devices/${d.id}/assignments`, { cookie, body })
const readings = async (patientId: string, cookie = doctor) => PatientDeviceReadings.parse((await call(ctx.app, 'GET', `/api/patients/${patientId}/device-readings`, { cookie })).json())
const stored = async (patientId: string) => (await adminQuery('SELECT kind, value::float AS value, source, validation_status, visit_id, device_batch_id FROM observations WHERE patient_id = $1 AND source = $2 ORDER BY measured_at, kind', [patientId, 'device'])).rows
/** How many files the test file store holds: what was written and not discarded. */
const filesStored = () => (fs.existsSync(testConfig.storageDir) ? (fs.readdirSync(testConfig.storageDir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(testConfig.storageDir, f)).isFile()).length : 0)
const audits = async (action: string) => (await adminQuery('SELECT outcome, actor_role, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows as { outcome: string; actor_role: string; details: Record<string, unknown> }[]

/** A band with a token, attached to a consenting patient with an open visit. */
async function attached(o: { integration?: string } = {}) {
  const d = await device(o)
  const token = await tokenFor(d)
  const { p, v } = await patient()
  expect((await assign(d, { patientId: p.id })).statusCode).toBe(201)
  return { d, token, p, v }
}

describe('reading states: one function decides how current a device value is', () => {
  const t = { liveSeconds: 30, disconnectedSeconds: 120 }
  const now = 1_000_000_000
  const s = (measuredAgo: number | null, seenAgo: number | null, available = true) => readingState({ now, measuredAt: measuredAgo === null ? null : now - measuredAgo * 1000, lastSeenAt: seenAgo === null ? null : now - seenAgo * 1000, available }, t)

  it('live within the limit, stale after it, disconnected when the gateway is silent, no data without a reading, unavailable when nothing can arrive', () => {
    expect(s(0, 0)).toBe('live')
    expect(s(30, 5)).toBe('live')
    expect(s(31, 5)).toBe('stale')
    expect(s(3600, 119)).toBe('stale')
    // The gateway is what makes a device "connected": an old reading with the gateway in contact is stale, not disconnected.
    expect(s(31, 121)).toBe('disconnected')
    expect(s(5, 121)).toBe('disconnected')
    expect(s(null, null)).toBe('disconnected')
    expect(s(5, null)).toBe('disconnected')
    expect(s(null, 3)).toBe('no_data')
    expect(s(1, 1, false)).toBe('unavailable')
    expect(s(null, null, false)).toBe('unavailable')
  })

  it('the function takes a time ahead of the clock as just measured (the server never stores one: see the gateway)', () => {
    expect(readingState({ now, measuredAt: now + 90_000, lastSeenAt: now, available: true }, t)).toBe('live')
  })

  it('the configured limits are sane: a device is disconnected only after its readings would be stale', () => {
    expect(settings.devices.disconnectedSeconds).toBeGreaterThan(settings.devices.liveSeconds)
  })
})

describe('the gate: which kinds a device may send', () => {
  it('refuses blood pressure from a device, stores nothing of the batch, says why, and audits the refusal', async () => {
    const { token, p } = await attached()
    const res = await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 70 }, { kind: 'systolic_bp', value: 128 }, { kind: 'diastolic_bp', value: 82 }] }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('kind_not_allowed')
    expect(res.json().message).toMatch(/Systolic BP, Diastolic BP/)
    expect(res.json().message).toMatch(/Blood pressure is entered by staff/)
    // Not even the allowed reading of that batch: a gateway that sends what it may not is noticed, not half-accepted.
    expect(await stored(p.id)).toEqual([])
    expect((await adminQuery('SELECT count(*)::int AS n FROM device_batches')).rows[0].n).toBe(0)
    expect((await audits('device.ingest')).at(-1)).toMatchObject({ outcome: 'denied', actor_role: 'device', details: { reason: 'kind_not_allowed:systolic_bp,diastolic_bp' } })
  })

  it('a wearable band may send heart rate, oxygen saturation, temperature and respiratory rate, and nothing else', async () => {
    const { token, p } = await attached()
    const ok = await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 70 }, { kind: 'spo2', value: 98 }, { kind: 'temperature', value: 36.9 }, { kind: 'respiratory_rate', value: 15 }] }))
    expect(ok.statusCode).toBe(201)
    expect((await stored(p.id)).map((r) => r.kind).sort()).toEqual(['heart_rate', 'respiratory_rate', 'spo2', 'temperature'])
    for (const kind of ['weight', 'height', 'blood_glucose', 'pain_score']) {
      const value = { weight: 70, height: 170, blood_glucose: 110, pain_score: 3 }[kind]
      expect((await ingest(token, batch({ measuredAt: at(1), readings: [{ kind, value }] }))).json().error).toBe('kind_not_allowed')
    }
  })

  it('a stethoscope, a thermal camera and an "other" device may send no readings at all', async () => {
    for (const kind of ['smart_stethoscope', 'thermal_camera', 'other']) {
      const d = await device({ kind })
      const token = await tokenFor(d)
      const { p } = await patient()
      await assign(d, { patientId: p.id })
      expect((await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 70 }] }))).json().error).toBe('kind_not_allowed')
    }
  })

  it('a kind may appear once in a batch', async () => {
    const { token } = await attached()
    expect((await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 70 }, { kind: 'heart_rate', value: 90 }] }))).statusCode).toBe(400)
  })
})

describe('idempotent readings: a batch is stored once', () => {
  it('the same batch sent again stores nothing more and answers with the first batch; the same key with other content is refused', async () => {
    const { token, p } = await attached()
    const body = batch({ idempotencyKey: 'gw-0001-abcdef' })
    const first = await ingest(token, body)
    expect(first.statusCode).toBe(201)
    const one = DeviceIngestResponse.parse(first.json())
    expect(one).toMatchObject({ stored: 2, duplicate: false, validationStatus: 'device_unverified' })
    const again = await ingest(token, body)
    expect(again.statusCode).toBe(200)
    expect(DeviceIngestResponse.parse(again.json())).toEqual({ stored: 0, duplicate: true, validationStatus: 'device_unverified', batchId: one.batchId })
    expect(await stored(p.id)).toHaveLength(2)
    expect((await stored(p.id)).every((r) => r.device_batch_id === one.batchId)).toBe(true)

    const other = await ingest(token, { ...body, readings: [{ kind: 'heart_rate', value: 140 }] })
    expect(other.statusCode).toBe(409)
    expect(other.json().error).toBe('idempotency_conflict')
    expect(await stored(p.id)).toHaveLength(2)
    const log = await audits('device.ingest')
    expect(log.map((e) => [e.outcome, e.details.duplicate ?? e.details.reason ?? 'stored'])).toEqual([['success', 'stored'], ['success', true], ['denied', 'idempotency_conflict']])
  })

  it('without a key an exact repeat is still stored once, and a different batch is a different batch', async () => {
    const { token, p } = await attached()
    const body = batch()
    expect((await ingest(token, body)).statusCode).toBe(201)
    expect((await ingest(token, body)).json()).toMatchObject({ stored: 0, duplicate: true })
    // The same values in another order are the same batch.
    expect((await ingest(token, { ...body, readings: [...body.readings].reverse() })).json()).toMatchObject({ duplicate: true })
    expect((await ingest(token, { ...body, measuredAt: at(1000) })).statusCode).toBe(201)
    expect(await stored(p.id)).toHaveLength(4)
  })

  it('ten copies of one batch arriving together are stored once', async () => {
    const { token, p } = await attached()
    const body = batch({ idempotencyKey: 'gw-burst-000001' })
    const results = await Promise.all(Array.from({ length: 10 }, () => ingest(token, body)))
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201])
    expect(await stored(p.id)).toHaveLength(2)
  })

  it('a key belongs to one device: another device may use the same key', async () => {
    const a = await attached()
    const b = await attached()
    expect((await ingest(a.token, batch({ idempotencyKey: 'shared-key-0001' }))).statusCode).toBe(201)
    expect((await ingest(b.token, batch({ idempotencyKey: 'shared-key-0001' }))).statusCode).toBe(201)
  })

  it('the record of a batch is append-only for the application', async () => {
    const { token } = await attached()
    await ingest(token, batch())
    await expect(ctx.pool.query("UPDATE device_batches SET payload_sha256 = 'x'")).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query('DELETE FROM device_batches')).rejects.toMatchObject({ code: '42501' })
    expect((await adminQuery("SELECT 1 FROM meta.append_only_tables WHERE table_name = 'device_batches'")).rowCount).toBe(1)
  })

  it('rejects a malformed key', async () => {
    const { token } = await attached()
    expect((await ingest(token, batch({ idempotencyKey: 'short' }))).statusCode).toBe(400)
    expect((await ingest(token, batch({ idempotencyKey: 'has spaces in it' }))).statusCode).toBe(400)
  })
})

describe('the simulator: generated values, never presented or stored as a device’s', () => {
  it('what a simulator record sends is stored as simulated, whatever the sender claims, and the list says which records are simulators', async () => {
    const { d, token, p } = await attached({ integration: 'simulator' })
    expect(d).toMatchObject({ integration: 'simulator', simulated: true })
    // A sender cannot say what its data is: unknown fields are ignored and the device record decides.
    const res = await ingest(token, { ...batch(), validationStatus: 'device_unverified', simulated: false })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ validationStatus: 'simulated' })
    expect((await stored(p.id)).map((r) => r.validation_status)).toEqual(['simulated', 'simulated'])
    expect((await adminQuery('SELECT simulated FROM device_batches')).rows).toEqual([{ simulated: true }])
    const list = DeviceList.parse((await call(ctx.app, 'GET', '/api/devices', { cookie: nurse })).json())
    expect(list.simulatorAllowed).toBe(true)
    expect(list.devices.find((x) => x.id === d.id)).toMatchObject({ simulated: true })
    expect((await heartbeat(token)).json()).toMatchObject({ ok: true, simulator: true, assigned: true })
    const real = await attached()
    expect((await heartbeat(real.token)).json()).toMatchObject({ simulator: false })
    expect((await audits('device.register')).map((e) => e.details.simulated)).toEqual([true, false])
  })

  it('a record is a simulator from the start or never: the API and the database both refuse to change it', async () => {
    const sim = await device({ integration: 'simulator' })
    const real = await device()
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${sim.id}`, { cookie: admin, body: { integration: 'gateway_api' } })).json().error).toBe('simulator_fixed')
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${real.id}`, { cookie: admin, body: { integration: 'simulator' } })).json().error).toBe('simulator_fixed')
    // Other changes are still allowed.
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${sim.id}`, { cookie: admin, body: { label: 'Renamed simulator' } })).statusCode).toBe(200)
    await expect(adminQuery("UPDATE devices SET integration = 'gateway_api' WHERE id = $1", [sim.id])).rejects.toMatchObject({ code: '42501' })
    await expect(adminQuery("UPDATE devices SET integration = 'simulator' WHERE id = $1", [real.id])).rejects.toMatchObject({ code: '42501' })
  })

  it('the database itself keeps simulated and device data apart, even for someone writing rows directly', async () => {
    const sim = await attached({ integration: 'simulator' })
    const real = await attached()
    const row = (patientId: string, deviceId: string | null, status: string) => adminQuery("INSERT INTO observations (patient_id, kind, value, unit, source, validation_status, device_id) VALUES ($1, 'heart_rate', 70, 'bpm', $2, $3, $4)", [patientId, deviceId ? 'device' : 'manual', status, deviceId])
    // A simulator's value stored as a device reading, and a device's as simulated: both refused.
    await expect(row(sim.p.id, sim.d.id, 'device_unverified')).rejects.toMatchObject({ code: '23514' })
    await expect(row(real.p.id, real.d.id, 'simulated')).rejects.toMatchObject({ code: '23514' })
    // "Simulated" with no device, and an unknown status.
    await expect(row(real.p.id, null, 'simulated')).rejects.toMatchObject({ code: '23514' })
    await expect(row(real.p.id, real.d.id, 'validated')).rejects.toMatchObject({ code: '23514' })
    // The honest rows are accepted.
    await row(sim.p.id, sim.d.id, 'simulated')
    await row(real.p.id, real.d.id, 'device_unverified')
    await row(real.p.id, null, 'manual_entry')
    // A simulated reading cannot be relabelled afterwards, in any combination: not by changing its status alone, not by also giving it a real
    // device, not by taking its device away and calling it a staff measurement. Nor can a device reading or a staff measurement be made simulated.
    const refused = (sql: string, params: unknown[]) => expect(adminQuery(sql, params)).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) })
    await refused("UPDATE observations SET validation_status = 'device_unverified' WHERE device_id = $1", [sim.d.id])
    await refused("UPDATE observations SET device_id = $2, validation_status = 'device_unverified' WHERE device_id = $1", [sim.d.id, real.d.id])
    await refused("UPDATE observations SET device_id = NULL, validation_status = 'manual_entry', source = 'manual' WHERE device_id = $1", [sim.d.id])
    await refused("UPDATE observations SET device_id = NULL, validation_status = 'manual_entry' WHERE device_id = $1", [sim.d.id])
    await refused("UPDATE observations SET device_id = $2, validation_status = 'simulated' WHERE device_id = $1", [real.d.id, sim.d.id])
    await refused("UPDATE observations SET device_batch_id = NULL, source = 'manual' WHERE device_id = $1", [real.d.id])
    expect((await adminQuery('SELECT validation_status, count(*)::int AS n FROM observations GROUP BY 1 ORDER BY 1')).rows).toEqual([{ validation_status: 'device_unverified', n: 1 }, { validation_status: 'manual_entry', n: 1 }, { validation_status: 'simulated', n: 1 }])
    // What the application does change on a reading still works: marking it entered in error.
    await adminQuery("UPDATE observations SET entered_in_error = true, entered_in_error_reason = 'test' WHERE device_id = $1", [real.d.id])
    // A session cannot stand in its own "devices" table to mislead the guard.
    await expect(ctx.pool.query(`DO $$ BEGIN CREATE TEMP TABLE devices (id uuid, integration text) ON COMMIT DROP; INSERT INTO devices VALUES ('${sim.d.id}', 'gateway_api'); INSERT INTO observations (patient_id, kind, value, unit, source, validation_status, device_id) VALUES ('${sim.p.id}', 'heart_rate', 70, 'bpm', 'device', 'device_unverified', '${sim.d.id}'); END $$`)).rejects.toMatchObject({ code: '23514' })
  })

  it('cannot be registered, hold a token or post where the data is clinical', async () => {
    const sim = await attached({ integration: 'simulator' })
    const clinical = createTestApp({ config: { ...testConfig, dataOrigin: 'clinical' }, clock, settings: generous })
    try {
      const a = await login(clinical.app, 't.admin')
      expect((await call(clinical.app, 'POST', '/api/admin/devices', { cookie: a, body: { kind: 'wearable_band', label: 'Sim', serialNumber: 'SIM-CLIN', integration: 'simulator' } })).json().error).toBe('simulator_not_allowed')
      expect((await call(clinical.app, 'POST', `/api/admin/devices/${sim.d.id}/token`, { cookie: a })).json().error).toBe('simulator_not_allowed')
      // A simulator registered before the deployment became clinical: its token is refused, nothing is stored, and the screen says why.
      const res = await ingest(sim.token, batch(), clinical.app)
      expect(res.statusCode).toBe(403)
      expect(await stored(sim.p.id)).toEqual([])
      expect((await heartbeat(sim.token, clinical.app)).statusCode).toBe(403)
      const view = PatientDeviceReadings.parse((await call(clinical.app, 'GET', `/api/patients/${sim.p.id}/device-readings`, { cookie: await login(clinical.app, 't.doctor') })).json())
      expect(view.devices[0]).toMatchObject({ state: 'unavailable', reason: 'A simulator may not post in this deployment.' })
      expect(DeviceList.parse((await call(clinical.app, 'GET', '/api/devices', { cookie: a })).json()).simulatorAllowed).toBe(false)
    } finally {
      await clinical.close()
    }
  })

  it('simulated values are shown to staff as simulated, and are never given to the patient, a model or the record rules', async () => {
    const { token, p, v } = await attached({ integration: 'simulator' })
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 88 }] } })
    expect((await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 131 }, { kind: 'spo2', value: 90 }] }))).statusCode).toBe(201)

    // Staff are shown the values in ONE place, the device readings card, marked simulated and with no range flag (131 would be "high").
    expect((await readings(p.id)).devices[0]).toMatchObject({ simulated: true, readings: expect.arrayContaining([expect.objectContaining({ kind: 'heart_rate', value: 131, validationStatus: 'simulated', flag: null }), expect.objectContaining({ kind: 'spo2', value: 90, flag: null })]) })
    // The record's vitals history (the table on the patient record) does not list them at all: only what the nurse measured.
    const list = (await call(ctx.app, 'GET', `/api/patients/${p.id}/observations`, { cookie: nurse })).json().observations as { kind: string; value: number; source: string; validationStatus: string }[]
    expect(list.map((o) => [o.kind, o.value, o.source, o.validationStatus])).toEqual([['heart_rate', 88, 'manual', 'manual_entry']])

    // The queue, the consultation's vital signs and the history summary: the nurse's measurement only. A simulator's output is in none of them.
    const queue = (await call(ctx.app, 'GET', '/api/visits', { cookie: nurse })).json().visits as Visit[]
    expect(queue.find((x) => x.id === v.id)!.latestVitals.map((o) => [o.kind, o.value, o.validationStatus])).toEqual([['heart_rate', 88, 'manual_entry']])
    expect(queue.find((x) => x.id === v.id)!.abnormalVitalCount).toBe(0)
    const history = (await call(ctx.app, 'GET', `/api/patients/${p.id}/history`, { cookie: doctor })).json()
    expect((history.latestVitals as { value: number }[]).map((o) => o.value)).toEqual([88])

    // The record the consultation draft (V3) and Mana (V4) read from: the nurse's measurement only.
    const me = sessionOf('doctor')
    const record = await loadPatientRecord(ctx.db, me, p.id, { maxEncounters: 10, observationDays: 365 })
    const obs = record.items.filter((i) => i.sourceType === 'observation')
    expect(obs.map((i) => i.excerpt)).toEqual(['Heart rate 88 bpm, measured by staff, this visit'])
    // (Excerpts only: an id or a timestamp may contain any digits.)
    expect(record.items.map((i) => i.excerpt).join(' | ')).not.toMatch(/131|simulat/i)
    // The older assistant's context likewise.
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    expect(e.vitals.map((o) => [o.kind, o.value, o.validationStatus])).toEqual([['heart_rate', 88, 'manual_entry']])
    const context = await buildPatientContext(ctx.db, (await ctx.db.query.encounters.findFirst({ where: (t, { eq }) => eq(t.id, e.id) }))!, { priorEncounters: 5, observationDays: 30 })
    expect(context.items.map((i) => i.text).join(' | ')).not.toMatch(/131|simulat/i)
    expect(context.items.filter((i) => i.sourceType === 'observation').map((i) => i.text)).toEqual(['Heart rate 88 bpm measured at this visit'])

    // The nurse's routing suggestion (fixed rules over the visit's vital signs): a simulated saturation of 90 %, or any simulated value, raises no
    // red flag, makes nothing urgent and does not count as the intake's vital signs.
    await ingest(token, batch({ measuredAt: at(1), readings: [{ kind: 'spo2', value: 80 }, { kind: 'temperature', value: 41.5 }] }))
    await call(ctx.app, 'POST', `/api/encounters/${e.id}/discard`, { cookie: doctor, body: { version: e.version, reason: 'Opened to read its vital signs' } })
    const routed = await call(ctx.app, 'POST', `/api/visits/${v.id}/routing-suggestion`, { cookie: nurse })
    expect(routed.statusCode, routed.body).toBe(201)
    const advice = routed.json().suggestion.suggestion as { redFlags: { source: string }[]; priority: string; missingIntake: string[] }
    expect(advice.redFlags.filter((f) => f.source === 'vitals')).toEqual([])
    expect(advice.priority).toBe('normal')
    expect(advice.missingIntake).toEqual(expect.arrayContaining(['Temperature']))

    // The patient: activates the portal and sees the nurse's measurement, not the simulator's output.
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'portal_access', method: 'verbal' } })
    const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const act = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'Patient-passphrase-1' } })
    const portal = `adaxai_session=${act.cookies.find((c) => c.name === 'adaxai_session')!.value}`
    const vitals = (await call(ctx.app, 'GET', '/api/portal/vitals', { cookie: portal })).json().vitals as { value: number }[]
    expect(vitals.map((x) => Number(x.value))).toEqual([88])
  })
})

/** A signed-in member of the test facility, as the services see one. */
function sessionOf(who: 'doctor' | 'nurse'): SessionUser {
  return { id: fx.users[who], sessionId: 'test', username: `t.${who}`, fullName: `Test t.${who}`, role: who, facilityId: fx.facilityId, departmentId: fx.departments.gen, patientId: null, mustChangePassword: false }
}

describe('assignment: to a patient, for a visit and a consultation, for a time', () => {
  it('attaching in a consultation records the consultation and its visit; staff see them, an administrator does not', async () => {
    const d = await device()
    const { p, v } = await patient()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const res = await assign(d, { patientId: p.id, encounterId: e.id }, doctor)
    expect(res.statusCode).toBe(201)
    expect(Device.parse(res.json()).assignment).toMatchObject({ patientId: p.id, visitId: v.id, encounterId: e.id, validUntil: null })
    const adminView = DeviceList.parse((await call(ctx.app, 'GET', '/api/devices', { cookie: admin })).json()).devices.find((x) => x.id === d.id)!
    expect(adminView.assignment).toMatchObject({ patientId: null, patientName: null, mrn: null, visitId: null, encounterId: null })
    expect((await audits('device.assign')).at(-1)!.details).toMatchObject({ deviceId: d.id, visitId: v.id, encounterId: e.id, simulated: false })
  })

  it('refuses a consultation of another patient, one that is not in progress, and a visit that is not that consultation’s', async () => {
    const d = await device()
    const a = await patient()
    const b = await patient()
    const eb = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${b.v.id}/encounter`, { cookie: doctor })).json())
    expect((await assign(d, { patientId: a.p.id, encounterId: eb.id })).statusCode).toBe(400)
    expect((await assign(d, { patientId: b.p.id, encounterId: eb.id, visitId: a.v.id })).statusCode).toBe(400)
    await call(ctx.app, 'POST', `/api/encounters/${eb.id}/discard`, { cookie: doctor, body: { version: eb.version, reason: 'Opened by mistake' } })
    const refused = await assign(d, { patientId: b.p.id, encounterId: eb.id })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().issues[0]).toMatchObject({ path: 'encounterId', message: 'This consultation is not in progress' })
  })

  it('with no visit named, the patient’s open visit of today is recorded, so that readings reach the queue and the consultation', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const { p, v } = await patient()
    expect(Device.parse((await assign(d, { patientId: p.id })).json()).assignment).toMatchObject({ visitId: v.id, encounterId: null })
    await ingest(token, batch())
    expect((await stored(p.id)).map((r) => r.visit_id)).toEqual([v.id, v.id])
    const queue = (await call(ctx.app, 'GET', '/api/visits', { cookie: nurse })).json().visits as Visit[]
    const row = queue.find((x) => x.id === v.id)!
    expect(row.latestVitals.map((o) => [o.kind, o.source, o.validationStatus]).sort()).toEqual([['heart_rate', 'device', 'device_unverified'], ['spo2', 'device', 'device_unverified']])
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    expect(e.vitals.map((o) => o.validationStatus)).toEqual(['device_unverified', 'device_unverified'])
  })

  it('a reading measured after the visit was closed is the patient’s, but is not added to that visit', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const { p, v } = await patient()
    await assign(d, { patientId: p.id, visitId: v.id })
    await ingest(token, batch())
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Left before being seen' } })
    ahead += 5000
    expect((await ingest(token, batch())).statusCode).toBe(201)
    expect((await stored(p.id)).map((r) => r.visit_id)).toEqual([v.id, v.id, null, null])
  })

  it('an assignment may be for a time: readings measured at or after it are refused, and the screen says the time is over', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const { p } = await patient()
    expect((await assign(d, { patientId: p.id, validUntil: at(-1000) })).statusCode).toBe(400)
    expect((await assign(d, { patientId: p.id, validUntil: at(40 * 86_400_000) })).statusCode).toBe(400)
    const until = at(10 * 60_000)
    expect(Device.parse((await assign(d, { patientId: p.id, validUntil: until })).json()).assignment).toMatchObject({ validUntil: until })
    expect((await ingest(token, batch())).statusCode).toBe(201)
    ahead += 11 * 60_000
    const late = await ingest(token, batch())
    expect(late.json().error).toBe('outside_assignment')
    // A reading measured while it was valid, sent late, is still accepted and filed to that patient.
    expect((await ingest(token, batch({ measuredAt: at(-5 * 60_000) }))).statusCode).toBe(201)
    expect((await readings(p.id)).devices[0]).toMatchObject({ state: 'unavailable', validUntil: until, reason: 'The time this device was attached for is over. End the assignment; it can then be attached again.' })
    // The assignment is still open until someone ends it, and cannot be rewritten.
    await expect(adminQuery("UPDATE device_assignments SET valid_until = now() + interval '1 day'")).rejects.toMatchObject({ code: '42501' })
  })

  it('readings measured before the device was attached, or after the assignment ended, are refused; a late batch goes to the patient it was measured on', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const first = await patient()
    const second = await patient()
    const a1 = Device.parse((await assign(d, { patientId: first.p.id })).json()).assignment!
    expect((await ingest(token, batch({ measuredAt: at(-60_000) }))).json().error).toBe('outside_assignment')
    ahead += 60_000
    const measuredOnFirst = at()
    ahead += 60_000
    await call(ctx.app, 'POST', `/api/device-assignments/${a1.id}/end`, { cookie: nurse, body: { reason: 'Moved to the next patient' } })
    await assign(d, { patientId: second.p.id })
    ahead += 60_000
    // Buffered by the gateway and sent after the band was given to someone else.
    expect((await ingest(token, batch({ measuredAt: measuredOnFirst }))).statusCode).toBe(201)
    expect(await stored(first.p.id)).toHaveLength(2)
    expect(await stored(second.p.id)).toHaveLength(0)
  })

  it('consent withdrawn ends the assignment at once: nothing more is stored, and the screen says the consent is missing', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const { p } = await patient()
    await assign(d, { patientId: p.id })
    const c = PatientDetail.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json()).consents.find((x) => x.type === 'device_monitoring')!
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${c.id}/withdraw`, { cookie: nurse, body: { reason: 'Changed their mind' } })
    expect((await ingest(token, batch())).json().error).toBe('outside_assignment')
    expect((await readings(p.id)).consent).toBe('missing')
    expect((await readings(p.id)).devices).toEqual([])
  })
})

describe('live readings in the Doctor App: the states a doctor is shown', () => {
  it('goes from disconnected (never heard from) to no data, live, stale and disconnected again as time passes, without inventing a value', async () => {
    const { d, token, p } = await attached()
    const t = settings.devices
    let view = await readings(p.id)
    expect(view).toMatchObject({ consent: 'granted', thresholds: { liveSeconds: t.liveSeconds, disconnectedSeconds: t.disconnectedSeconds } })
    expect(view.devices).toHaveLength(1)
    expect(view.devices[0]).toMatchObject({ deviceId: d.id, simulated: false, state: 'disconnected', lastSeenAt: null, readings: [], readingsStored: 0, kinds: ['heart_rate', 'spo2', 'temperature', 'respiratory_rate'], reason: 'This device’s gateway has not been in contact since it was registered.' })

    expect((await heartbeat(token)).statusCode).toBe(200)
    view = await readings(p.id)
    expect(view.devices[0]).toMatchObject({ state: 'no_data', readings: [], reason: 'The gateway is in contact but has sent no reading since the device was attached.' })
    expect(view.devices[0]!.lastSeenAt).not.toBeNull()

    await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 118 }, { kind: 'spo2', value: 97 }] }))
    view = await readings(p.id)
    expect(view.devices[0]).toMatchObject({ state: 'live', reason: null, readingsStored: 2 })
    // An adult's heart rate of 118 is flagged against the reference range, as a typed-in value would be.
    expect(view.devices[0]!.readings.map((r) => [r.kind, r.value, r.state, r.validationStatus, r.flag])).toEqual([['heart_rate', 118, 'live', 'device_unverified', 'high'], ['spo2', 97, 'live', 'device_unverified', 'normal']])

    // Only heart rate keeps coming: oxygen saturation goes stale on its own, the device stays live.
    ahead += (t.liveSeconds + 1) * 1000
    await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 96 }] }))
    view = await readings(p.id)
    expect(view.devices[0]!.state).toBe('live')
    expect(view.devices[0]!.readings.map((r) => [r.kind, r.value, r.state])).toEqual([['heart_rate', 96, 'live'], ['spo2', 97, 'stale']])

    // The gateway stays in contact but sends nothing: stale, with the last values and their times unchanged.
    ahead += (t.liveSeconds + 1) * 1000
    await heartbeat(token)
    view = await readings(p.id)
    expect(view.devices[0]).toMatchObject({ state: 'stale', reason: `The newest reading is more than ${t.liveSeconds} seconds old.` })
    expect(view.devices[0]!.readings.map((r) => [r.kind, r.value, r.state])).toEqual([['heart_rate', 96, 'stale'], ['spo2', 97, 'stale']])

    // Silence: disconnected. The values shown are the last ones received, and say so.
    ahead += (t.disconnectedSeconds + 1) * 1000
    view = await readings(p.id)
    expect(view.devices[0]).toMatchObject({ state: 'disconnected', reason: `Nothing has been heard from this device’s gateway for more than ${t.disconnectedSeconds} seconds. Any value shown is the last one received.`, readingsStored: 3 })
    expect(view.devices[0]!.readings.every((r) => r.state === 'disconnected')).toBe(true)
    expect(new Date(view.serverTime).getTime()).toBeGreaterThan(Date.now() + ahead - 5000)
  })

  it('says unavailable, with the reason, when nothing can arrive: a registry-only device, a retired one', async () => {
    const reg = await device({ integration: 'not_integrated', label: 'Registry-only band' })
    const up = await device({ integration: 'manual_upload', kind: 'smart_stethoscope', label: 'Upload stethoscope' })
    const { p } = await patient()
    await assign(reg, { patientId: p.id })
    await assign(up, { patientId: p.id })
    const view = await readings(p.id)
    expect(view.devices.map((x) => [x.label, x.state, x.reason]).sort()).toEqual([
      ['Registry-only band', 'unavailable', 'This device is in the registry only: no gateway is connected to it, so no readings can arrive.'],
      ['Upload stethoscope', 'unavailable', 'This device has no gateway: its files are uploaded by staff, so no readings arrive from it.'],
    ])
  })

  it('a patient with no device attached has none listed, and nothing is made up', async () => {
    const { p } = await patient([])
    expect(await readings(p.id)).toMatchObject({ consent: 'missing', devices: [] })
    const consenting = await patient()
    expect(await readings(consenting.p.id)).toMatchObject({ consent: 'granted', devices: [] })
  })

  it('readings from before this assignment are not shown as this assignment’s', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const { p } = await patient()
    const a1 = Device.parse((await assign(d, { patientId: p.id })).json()).assignment!
    await ingest(token, batch())
    ahead += 1000
    await call(ctx.app, 'POST', `/api/device-assignments/${a1.id}/end`, { cookie: nurse, body: { reason: 'Taken off' } })
    ahead += 1000
    await assign(d, { patientId: p.id })
    const view = await readings(p.id)
    expect(view.devices).toHaveLength(1)
    expect(view.devices[0]).toMatchObject({ readings: [], readingsStored: 0 })
  })

  it('only doctors and nurses of the patient’s facility read them; watching is audited once per window, not once per read', async () => {
    const { p } = await attached()
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/device-readings`, { cookie: admin })).statusCode).toBe(403)
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/device-readings`, {})).statusCode).toBe(401)
    for (let i = 0; i < 6; i++) await readings(p.id, doctor)
    await readings(p.id, nurse)
    const log = (await adminQuery("SELECT actor_user_id, patient_id, details FROM audit_events WHERE action = 'device.readings_read' ORDER BY id")).rows
    expect(log.map((e) => e.actor_user_id)).toEqual([fx.users.doctor, fx.users.nurse])
    expect(log[0]).toMatchObject({ patient_id: p.id, details: { devices: 1, simulated: 0, repeatsNotLoggedForSeconds: 300 } })
  })
})

describe('facility isolation', () => {
  it('another facility’s staff reach none of this facility’s devices, assignments or readings, and its devices cannot be attached to this facility’s patients', async () => {
    const [other] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
    const [dept] = await ctx.db.insert(departments).values({ facilityId: other!.id, code: 'GEN', name: 'General Medicine' }).returning()
    const passwordHash = await hashPassword(TEST_PASSWORD)
    await ctx.db.insert(users).values([
      { facilityId: other!.id, username: 'o.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash, departmentId: dept!.id },
      { facilityId: other!.id, username: 'o.admin', fullName: 'Other admin', role: 'admin', passwordHash, departmentId: null },
    ])
    const oNurse = await login(ctx.app, 'o.nurse')
    const oAdmin = await login(ctx.app, 'o.admin')
    const mine = await attached()
    const a = Device.parse((await call(ctx.app, 'GET', '/api/devices', { cookie: nurse })).json().devices[0]).assignment!

    expect(DeviceList.parse((await call(ctx.app, 'GET', '/api/devices', { cookie: oNurse })).json()).devices).toEqual([])
    expect((await call(ctx.app, 'GET', `/api/patients/${mine.p.id}/device-readings`, { cookie: oNurse })).statusCode).toBe(404)
    expect((await call(ctx.app, 'POST', `/api/devices/${mine.d.id}/assignments`, { cookie: oNurse, body: { patientId: mine.p.id } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'POST', `/api/device-assignments/${a.id}/end`, { cookie: oNurse, body: { reason: 'x' } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${mine.d.id}`, { cookie: oAdmin, body: { label: 'Taken' } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'POST', `/api/admin/devices/${mine.d.id}/token`, { cookie: oAdmin })).statusCode).toBe(404)

    // The other facility's own device cannot be attached to a patient of this one.
    const theirs = Device.parse((await call(ctx.app, 'POST', '/api/admin/devices', { cookie: oAdmin, body: { kind: 'wearable_band', label: 'Their band', serialNumber: 'O-1', integration: 'gateway_api' } })).json())
    expect((await call(ctx.app, 'POST', `/api/devices/${theirs.id}/assignments`, { cookie: oNurse, body: { patientId: mine.p.id } })).statusCode).toBe(404)
    expect((await call(ctx.app, 'POST', `/api/devices/${theirs.id}/assignments`, { cookie: nurse, body: { patientId: mine.p.id } })).statusCode).toBe(404)
    // A device token never names a patient: an unassigned device's readings go nowhere.
    const theirToken = (await call(ctx.app, 'POST', `/api/admin/devices/${theirs.id}/token`, { cookie: oAdmin })).json().token
    expect((await ingest(theirToken, batch())).json().error).toBe('outside_assignment')
    expect(await stored(mine.p.id)).toEqual([])
  })
})

describe('what a device token cannot do', () => {
  it('a time ahead of the server’s clock is stored as the time of arrival: nothing is "measured" after it was received, and it does not stay live for the length of the skew', async () => {
    const { token, p } = await attached()
    const t = settings.devices
    expect((await ingest(token, batch({ measuredAt: at(6 * 60_000) }))).statusCode).toBe(400)
    const before = clock()
    const res = await ingest(token, batch({ measuredAt: at(4 * 60_000), readings: [{ kind: 'heart_rate', value: 77 }] }))
    expect(res.statusCode).toBe(201)
    const [row] = (await adminQuery('SELECT measured_at, created_at FROM observations WHERE patient_id = $1', [p.id])).rows
    expect(new Date(row.measured_at).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(new Date(row.measured_at).getTime()).toBeLessThanOrEqual(clock() + 1000)
    expect((await readings(p.id)).devices[0]!.readings.map((r) => r.state)).toEqual(['live'])
    // With the gateway still in contact, the value is stale a little over the limit after it ARRIVED, not four minutes later.
    ahead += (t.liveSeconds + 2) * 1000
    await heartbeat(token)
    expect((await readings(p.id)).devices[0]!.readings.map((r) => r.state)).toEqual(['stale'])
    // The same batch sent again is still the same batch.
    expect((await ingest(token, batch({ measuredAt: new Date(before + 4 * 60_000).toISOString(), readings: [{ kind: 'heart_rate', value: 77 }] }))).statusCode).toBeLessThan(500)
  })

  it('a band handed to the next patient cannot file its last, future-stamped readings under them', async () => {
    const d = await device()
    const token = await tokenFor(d)
    const first = await patient()
    const second = await patient()
    const a1 = Device.parse((await assign(d, { patientId: first.p.id })).json()).assignment!
    // Its clock runs four minutes fast. Measured on the first patient:
    expect((await ingest(token, batch({ measuredAt: at(4 * 60_000) }))).statusCode).toBe(201)
    ahead += 30_000
    await call(ctx.app, 'POST', `/api/device-assignments/${a1.id}/end`, { cookie: nurse, body: { reason: 'Next patient' } })
    await assign(d, { patientId: second.p.id })
    expect(await stored(first.p.id)).toHaveLength(2)
    expect(await stored(second.p.id)).toHaveLength(0)
  })

  it('cannot write into the past without limit: a reading measured longer ago than the configured hours is refused and audited', async () => {
    const { token, p } = await attached()
    const res = await ingest(token, batch({ measuredAt: at(-(settings.devices.maxLateHours * 3_600_000 + 60_000)) }))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('too_late')
    expect(await stored(p.id)).toEqual([])
    expect((await audits('device.ingest')).at(-1)).toMatchObject({ outcome: 'denied', details: { reason: 'measured_too_long_ago' } })
  })

  it('guessing tokens is slowed per address and reaches the audit log once, not once per guess', async () => {
    const own = createTestApp({ clock, settings: generous })
    try {
      const codes: number[] = []
      for (let i = 0; i < 34; i++) codes.push((await heartbeat(`adxdev_guess_${i}`, own.app)).statusCode)
      expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true)
      expect(codes.slice(30)).toEqual([429, 429, 429, 429])
      expect((await audits('device.ingest')).map((e) => e.details.reason)).toEqual(['unknown_token'])
      // A real device's token is not affected by someone else's guesses from the same address.
      const { token } = await attached()
      expect((await heartbeat(token, own.app)).statusCode).toBe(200)
    } finally {
      await own.close()
    }
  })

  it('recordings have their own, much lower limit per token than readings', async () => {
    expect(settings.security.rateLimits.deviceRecordingPerToken.max).toBeLessThan(settings.security.rateLimits.deviceIngestPerToken.max / 10)
    const limited = createTestApp({ clock, settings: { ...generous, security: { rateLimits: { ...generous.security.rateLimits, deviceRecordingPerToken: { max: 2, windowSeconds: 60 } } } } })
    try {
      const steth = await device({ kind: 'smart_stethoscope' })
      const token = await tokenFor(steth)
      // Not attached to anyone: refused before the file is read, and still counted.
      const post = () => limited.app.inject({ method: 'POST', url: '/api/device-ingest/auscultations', headers: { authorization: `Bearer ${token}`, 'x-adaxai-csrf': '1', 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' })
      expect([(await post()).statusCode, (await post()).statusCode, (await post()).statusCode]).toEqual([409, 409, 429])
      // The limit for readings is a different one: a heartbeat still gets through.
      expect((await heartbeat(token, limited.app)).statusCode).toBe(200)
    } finally {
      await limited.close()
    }
  })
})

describe('the gateway: who may post', () => {
  it('needs a known token of an active gateway device; every refusal is audited with no patient; contact is recorded', async () => {
    const { d, token } = await attached()
    expect((await heartbeat('adxdev_unknown')).statusCode).toBe(401)
    expect((await gatewayPost(ctx.app, '/api/device-ingest/heartbeat', null, {})).statusCode).toBe(401)
    expect((await adminQuery('SELECT last_seen_at FROM devices WHERE id = $1', [d.id])).rows[0].last_seen_at).toBeNull()
    expect((await heartbeat(token)).json()).toMatchObject({ ok: true, simulator: false, assigned: true })
    expect((await adminQuery('SELECT last_seen_at FROM devices WHERE id = $1', [d.id])).rows[0].last_seen_at).not.toBeNull()
    const a = Device.parse((await call(ctx.app, 'GET', '/api/devices', { cookie: nurse })).json().devices.find((x: Device) => x.id === d.id)).assignment!
    await call(ctx.app, 'POST', `/api/device-assignments/${a.id}/end`, { cookie: nurse, body: { reason: 'Done' } })
    expect((await heartbeat(token)).json()).toMatchObject({ assigned: false })
    await call(ctx.app, 'PATCH', `/api/admin/devices/${d.id}`, { cookie: admin, body: { status: 'retired' } })
    expect((await heartbeat(token)).statusCode).toBe(401)
    const denied = (await audits('device.ingest')).filter((e) => e.outcome === 'denied')
    // An unknown token is audited once per address and window, however many are tried (here: the made-up one, then the revoked one).
    expect(denied.map((e) => e.details.reason)).toEqual(['unknown_token'])
    // Heartbeats that succeed are not audit events (one every few seconds per device); the device's last contact is on its record.
    expect((await audits('device.ingest')).filter((e) => e.outcome === 'success')).toEqual([])
  })

  it('is rate limited per token', async () => {
    const limited = createTestApp({ clock, settings: { ...generous, security: { rateLimits: { ...generous.security.rateLimits, deviceIngestPerToken: { max: 3, windowSeconds: 60 } } } } })
    try {
      const { token } = await attached()
      const codes = []
      for (let i = 0; i < 5; i++) codes.push((await heartbeat(token, limited.app)).statusCode)
      expect(codes).toEqual([200, 200, 200, 429, 429])
    } finally {
      await limited.close()
    }
  })
})

describe('stethoscope recordings: uploaded, recorded in the browser, or sent by a gateway', () => {
  const WAV = simulatedToneWav(7, 1)
  const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('synthetic webm bytes for a test')])
  function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
    const boundary = '----steth'
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
    const payload = Buffer.concat([...parts, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`)])
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-adaxai-csrf': '1' } }
  }
  const upload = (patientId: string, cookie: string, file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = { site: 'mitral' }) => {
    const m = multipart(fields, file)
    return ctx.app.inject({ method: 'POST', url: `/api/patients/${patientId}/auscultations`, headers: { ...m.headers, cookie }, payload: m.payload })
  }
  const gatewayUpload = (token: string, file: { name: string; type: string; data: Buffer }, fields: Record<string, string>) => {
    const m = multipart(fields, file)
    return ctx.app.inject({ method: 'POST', url: '/api/device-ingest/auscultations', headers: { ...m.headers, authorization: `Bearer ${token}` }, payload: m.payload })
  }
  const recordings = async (patientId: string) => ((await call(ctx.app, 'GET', `/api/patients/${patientId}/auscultations`, { cookie: doctor })).json().recordings as unknown[]).map((r) => AuscultationRecording.parse(r))

  it('a file must be the audio format it says it is: the first bytes decide, not the name or the declared type', async () => {
    const { p } = await patient()
    expect((await upload(p.id, nurse, { name: 'heart.wav', type: 'audio/wav', data: Buffer.from('#!/bin/sh\necho not audio') })).statusCode).toBe(400)
    expect((await upload(p.id, nurse, { name: 'heart.wav', type: 'audio/wav', data: WEBM })).statusCode).toBe(400)
    expect((await upload(p.id, nurse, { name: 'heart.webm', type: 'audio/webm', data: WAV })).json().issues[0].message).toBe('The file is not the audio format it says it is')
    expect((await upload(p.id, nurse, { name: 'heart.wav', type: 'audio/wav', data: WAV })).statusCode).toBe(201)
    expect(await recordings(p.id)).toHaveLength(1)
  })

  it('a recording made in the browser is stored as that, with its length and the input the browser named; an uploaded file is not given an input', async () => {
    const { p, v } = await patient()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const rec = await upload(p.id, doctor, { name: 'recording.webm', type: 'audio/webm;codecs=opus', data: WEBM }, { site: 'aortic', captureMethod: 'browser_recording', durationMs: '8200', inputLabel: 'USB Audio Device (synthetic)', encounterId: e.id })
    expect(rec.statusCode, rec.body).toBe(201)
    expect(AuscultationRecording.parse(rec.json())).toMatchObject({ site: 'aortic', captureMethod: 'browser_recording', durationMs: 8200, inputLabel: 'USB Audio Device (synthetic)', simulated: false, device: null, encounterId: e.id, mimeType: 'audio/webm' })
    const file = await upload(p.id, nurse, { name: 'export.wav', type: 'audio/wav', data: WAV }, { site: 'mitral', inputLabel: 'ignored for a file' })
    expect(AuscultationRecording.parse(file.json())).toMatchObject({ captureMethod: 'file_upload', inputLabel: null, simulated: false })
    expect((await upload(p.id, nurse, { name: 'x.wav', type: 'audio/wav', data: WAV }, { site: 'mitral', captureMethod: 'gateway' })).statusCode).toBe(400)
    expect((await audits('auscultation.upload')).map((a) => a.details.captureMethod)).toEqual(['browser_recording', 'file_upload'])
  })

  it('a gateway posts a recording with the stethoscope’s token: filed to the patient it was assigned to, once, with consent; a band may not', async () => {
    const steth = await device({ kind: 'smart_stethoscope', label: 'Stethoscope (gateway under test)' })
    const token = await tokenFor(steth)
    const storedBefore = filesStored()
    const { p, v } = await patient()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const fields = { recordedAt: at(), site: 'pulmonic', durationMs: '1000', idempotencyKey: 'steth-rec-000001' }
    expect((await gatewayUpload(token, { name: 'r.wav', type: 'audio/wav', data: WAV }, fields)).json().error).toBe('outside_assignment')
    await assign(steth, { patientId: p.id, encounterId: e.id }, doctor)
    const fields2 = { ...fields, recordedAt: at() }
    const first = await gatewayUpload(token, { name: 'r.wav', type: 'audio/wav', data: WAV }, fields2)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ stored: 1, duplicate: false, simulated: false })
    const again = await gatewayUpload(token, { name: 'r.wav', type: 'audio/wav', data: WAV }, fields2)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ stored: 0, duplicate: true, recordingId: first.json().recordingId })
    expect((await gatewayUpload(token, { name: 'r.wav', type: 'audio/wav', data: simulatedToneWav(8, 1) }, fields2)).json().error).toBe('idempotency_conflict')
    expect((await gatewayUpload(token, { name: 'r.txt', type: 'audio/wav', data: Buffer.from('not audio') }, { ...fields2, idempotencyKey: 'steth-rec-000002' })).statusCode).toBe(400)
    const list = await recordings(p.id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ captureMethod: 'gateway', simulated: false, site: 'pulmonic', durationMs: 1000, encounterId: e.id, device: { id: steth.id }, createdByName: null })
    // Playback through the same audited file route as any other recording.
    const play = await call(ctx.app, 'GET', `/api/files/${list[0]!.fileId}`, { cookie: doctor })
    expect(play.statusCode).toBe(200)
    expect(sniffAudio(play.rawPayload)).toBe('wav')
    // One file is kept for the one recording: what was written for the repeat, for the different batch under the same key and for the file that was
    // not audio was removed from the store again (the refused request before the device was attached wrote nothing).
    expect((await adminQuery("SELECT count(*)::int AS n FROM files WHERE kind = 'stethoscope_audio'")).rows[0].n).toBe(1)
    expect(filesStored() - storedBefore).toBe(1)

    const band = await attached()
    const refused = await gatewayUpload(band.token, { name: 'r.wav', type: 'audio/wav', data: WAV }, { recordedAt: at(), site: 'mitral' })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error).toBe('kind_not_allowed')
  })

  it('a simulator stethoscope’s recording is stored as simulated, and staff recordings cannot be filed under a simulator', async () => {
    const sim = await device({ kind: 'smart_stethoscope', integration: 'simulator', label: 'Stethoscope simulator' })
    const token = await tokenFor(sim)
    const { p } = await patient()
    await assign(sim, { patientId: p.id })
    const res = await gatewayUpload(token, { name: 'tones.wav', type: 'audio/wav', data: WAV }, { recordedAt: at(), site: 'mitral' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ simulated: true })
    expect((await recordings(p.id))[0]).toMatchObject({ captureMethod: 'gateway', simulated: true, device: { label: 'Stethoscope simulator' } })
    const refused = await upload(p.id, nurse, { name: 'a.wav', type: 'audio/wav', data: WAV }, { site: 'mitral', deviceId: sim.id })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().issues[0].message).toMatch(/A simulator is not a stethoscope/)
    // The database agrees: a recording is simulated exactly when its device record is a simulator.
    const [f] = (await adminQuery('SELECT id, facility_id FROM files LIMIT 1')).rows
    await expect(adminQuery("INSERT INTO auscultation_recordings (facility_id, patient_id, file_id, device_id, site, data_origin, simulated) VALUES ($1, $2, $3, $4, 'mitral', 'synthetic', false)", [f.facility_id, p.id, f.id, sim.id])).rejects.toMatchObject({ code: '23514' })
    await expect(adminQuery("INSERT INTO auscultation_recordings (facility_id, patient_id, file_id, site, data_origin, simulated) VALUES ($1, $2, $3, 'mitral', 'synthetic', true)", [f.facility_id, p.id, f.id])).rejects.toMatchObject({ code: '23514' })
  })
})

describe('readings and the visit', () => {
  it('a device attached before the patient checked in files its readings under the visit of the day once there is one, while that visit is open', async () => {
    const d = await device()
    const token = await tokenFor(d)
    seq++
    const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: 'Earlyband', phone: `98402 ${String(20000 + seq)}` }) })).json())
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type: 'device_monitoring', method: 'verbal' } })
    const a = Device.parse((await assign(d, { patientId: p.id })).json()).assignment!
    expect(a).toMatchObject({ visitId: null })
    expect((await ingest(token, batch())).statusCode).toBe(201)
    const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
    ahead += 5000
    expect((await ingest(token, batch())).statusCode).toBe(201)
    // A late batch measured just after the device was attached, before the check-in: the patient's, not the visit's.
    expect((await ingest(token, batch({ measuredAt: new Date(Date.parse(a.assignedAt) + 1).toISOString() }))).statusCode).toBe(201)
    await call(ctx.app, 'POST', `/api/visits/${v.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Left' } })
    ahead += 5000
    expect((await ingest(token, batch())).statusCode).toBe(201)
    const rows = (await adminQuery('SELECT visit_id FROM observations WHERE patient_id = $1 ORDER BY created_at, kind', [p.id])).rows.map((r) => r.visit_id)
    expect(rows).toEqual([null, null, v.id, v.id, null, null, null, null])
  })

  it('the record’s vitals history keeps what staff measured and only the newest few of what a device sent', async () => {
    const { token, p, v } = await attached()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 88 }] } })
    for (let i = 0; i < 9; i++) {
      ahead += 5000
      await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 100 + i }] }))
    }
    const list = (await call(ctx.app, 'GET', `/api/patients/${p.id}/observations`, { cookie: nurse })).json().observations as { value: number; source: string }[]
    expect(list.filter((o) => o.source === 'device').map((o) => o.value)).toEqual([108, 107, 106, 105, 104])
    expect(list.filter((o) => o.source === 'manual').map((o) => o.value)).toEqual([88])
    // The consultation's vital signs: the staff measurement and the device's newest value only.
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    expect(e.vitals.map((o) => [o.value, o.source])).toEqual([[108, 'device'], [88, 'manual']])
  })

  it('the routing rules use what staff measured: a device’s unverified value counts only where staff measured nothing of that kind', async () => {
    const { token, v } = await attached()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 80 }, { kind: 'temperature', value: 37 }] } })
    ahead += 5000
    // The band reports a heart rate far above the critical limit, and a saturation below it.
    await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 190 }, { kind: 'spo2', value: 85 }] }))
    const routed = (await call(ctx.app, 'POST', `/api/visits/${v.id}/routing-suggestion`, { cookie: nurse })).json()
    // Heart rate: the nurse's 80 stands, so no flag. Saturation: nobody measured it, so the device's value is what there is.
    expect((routed.suggestion.suggestion.redFlags as { id: string; source: string }[]).filter((f) => f.source === 'vitals').map((f) => f.id)).toEqual(['critical-spo2'])
  })

  it('the older assistant’s context keeps what staff measured however long a device has been sending, and puts it first for the rules', async () => {
    const { token, p, v } = await attached()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'systolic_bp', value: 190 }, { kind: 'diastolic_bp', value: 125 }, { kind: 'heart_rate', value: 88 }] } })
    for (let i = 0; i < 30; i++) {
      ahead += 5000
      await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 60 + i }, { kind: 'spo2', value: 97 }, { kind: 'temperature', value: 36.8 }, { kind: 'respiratory_rate', value: 16 }] }))
    }
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const context = await buildPatientContext(ctx.db, (await ctx.db.query.encounters.findFirst({ where: (t, { eq }) => eq(t.id, e.id) }))!, { priorEncounters: 5, observationDays: 30 })
    const first = (kind: string) => context.visitObservations.find((o) => o.kind === kind)!
    expect([first('systolic_bp').value, first('diastolic_bp').value]).toEqual([190, 125])
    expect([first('heart_rate').value, first('heart_rate').source]).toEqual([88, 'manual'])
    expect(first('spo2').source).toBe('device')
    expect(context.items.filter((i) => i.sourceType === 'observation').some((i) => i.text.startsWith('Systolic BP 190'))).toBe(true)
    expect(p.id).toBeTruthy()
  })
})

describe('V3 and V4 read device observations; they never write, and never see a simulator’s output', () => {
  const rules = { safety: settings.safety, outdatedDays: settings.mana.outdatedDays }
  const snapshot = async () => (await adminQuery("SELECT (SELECT count(*) FROM observations) AS o, (SELECT count(*) FROM device_batches) AS b, (SELECT count(*) FROM device_assignments) AS a, (SELECT coalesce(max(updated_at)::text, '') FROM devices) AS d")).rows[0]

  it('a device’s readings reach the record as unverified device readings; what staff measured still stands for the visit and is never pushed out', async () => {
    const { token, p, v } = await attached()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 88 }, { kind: 'temperature', value: 37.1 }] } })
    // A stream of readings from the device: more of them than the window keeps per kind, with values that vary as a pulse does.
    for (let i = 0; i < 8; i++) {
      ahead += 5000
      expect((await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 96 + i * 4 }, { kind: 'spo2', value: 97 }] }))).statusCode).toBe(201)
    }
    // The queue: what the nurse measured stands, however many readings the device has sent since; the device's value stands only where staff measured none.
    const row = ((await call(ctx.app, 'GET', '/api/visits', { cookie: nurse })).json().visits as Visit[]).find((x) => x.id === v.id)!
    expect(row.latestVitals.map((o) => [o.kind, o.value, o.source]).sort()).toEqual([['heart_rate', 88, 'manual'], ['spo2', 97, 'device'], ['temperature', 37.1, 'manual']])
    const before = await snapshot()
    const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
    const me = sessionOf('doctor')
    const record = await loadPatientRecord(ctx.db, me, p.id, { encounterId: e.id, maxEncounters: 10, observationDays: 365, includeHistory: true })
    const obs = record.items.filter((i) => i.sourceType === 'observation')
    // The nurse's two measurements are there, and the newest five of each kind the device sent.
    expect(obs.filter((i) => i.provenance === 'staff_measured').map((i) => i.excerpt).sort()).toEqual(['Heart rate 88 bpm, measured by staff, this visit', 'Temperature 37.1 °C, measured by staff, this visit'])
    const device = obs.filter((i) => i.provenance === 'device_measured')
    expect(device).toHaveLength(10)
    expect(device.find((i) => i.field === 'Heart rate')!.excerpt).toBe('Heart rate 124 bpm, device reading (device unverified), this visit')
    expect(device.every((i) => /device reading \(device unverified\)/.test(i.excerpt))).toBe(true)

    // Mana's vital-signs answer (the tool behind "her vital signs?"): the staff measurement stands, the device's latest is reported as a device reading.
    const text = answerFromRecord('vitals_compare', record, '', rules).flatMap((s) => s.statements).map((s) => `${s.kind}: ${s.text}`)
    expect(text).toContain('documented: Heart rate 88 bpm at this visit (measured by staff); no earlier reading in the last 365 days.')
    expect(text).toContain('documented: A device also sent heart rate at this visit: latest 124 bpm (device reading, device unverified).')
    expect(text).toContain('documented: SpO₂ 97 % at this visit (device reading, device unverified); no earlier reading in the last 365 days.')
    // A pulse that moves is not "recorded twice with different values": no conflict from the device's stream, nor between it and the nurse's value.
    expect(text.filter((s) => s.startsWith('conflict'))).toEqual([])
    expect(recordChecks(record, rules).conflicts).toEqual([])

    // The consultation draft's inputs (V3): the same items, this visit's first, each a source the draft can cite and the doctor can open.
    const inputs = await buildConsultationInputs(ctx.db, me, (await ctx.db.query.encounters.findFirst({ where: (t, { eq }) => eq(t.id, e.id) }))!, { maxContextChars: 14_000, maxEncounters: 10, observationDays: 365, settings: rules })
    const shown = inputs.items.filter((i) => i.sourceType === 'observation')
    expect(shown.filter((i) => i.provenance === 'device_measured').length).toBe(10)
    expect(shown.every((i) => i.priority === 0)).toBe(true)
    expect(inputs.recordCheck.rulesVersion).toBe('record-check-v2')
    expect(inputs.recordCheck.conflicts).toEqual([])

    // Reading changed nothing.
    expect(await snapshot()).toEqual(before)
  })

  it('two staff measurements that disagree are still a conflict; a device reading beside them is not part of it', async () => {
    const { token, p, v } = await attached()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 70 }] } })
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 110 }], measuredAt: new Date(Date.now() + 1000).toISOString() } })
    ahead += 5000
    await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 150 }] }))
    const record = await loadPatientRecord(ctx.db, sessionOf('doctor'), p.id, { maxEncounters: 10, observationDays: 365 })
    const found = recordChecks(record, rules).conflicts
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toBe('Heart rate was recorded more than once at this visit with different values: 110 bpm and 70 bpm. Check which is correct.')
    expect(found[0]!.refs).toHaveLength(2)
  })

  it('with only a device reading at the visit, the answer says that is what it is', async () => {
    const { token, p } = await attached()
    await ingest(token, batch({ readings: [{ kind: 'heart_rate', value: 101 }] }))
    const record = await loadPatientRecord(ctx.db, sessionOf('doctor'), p.id, { maxEncounters: 10, observationDays: 365 })
    const text = answerFromRecord('vitals_compare', record, '', rules).flatMap((s) => s.statements).map((s) => s.text)
    expect(text).toContain('Heart rate 101 bpm at this visit (device reading, device unverified); no earlier reading in the last 365 days.')
  })
})

describe('the simulator program: deterministic, and only what a band may send', () => {
  it('the same seed and tick give the same values; another seed gives others', () => {
    const run = { scenario: 'steady' as const, seed: 42, startMs: Date.parse('2026-10-05T04:00:00Z'), intervalMs: 5000 }
    const a = Array.from({ length: 50 }, (_, i) => simulatedBatch(run, i))
    const b = Array.from({ length: 50 }, (_, i) => simulatedBatch(run, i))
    expect(a).toEqual(b)
    expect(simulatedBatch({ ...run, seed: 43 }, 3)).not.toEqual(simulatedBatch(run, 3))
    expect(a[2]).toEqual({ measuredAt: '2026-10-05T04:00:10.000Z', idempotencyKey: simBatchKey(run, 2), readings: a[2]!.readings })
    expect(new Set(a.map((x) => x!.idempotencyKey)).size).toBe(50)
  })

  it('every scenario produces only allowed kinds and plausible values, and never blood pressure', () => {
    for (const scenario of Object.keys(SIM_SCENARIOS) as SimScenario[]) {
      for (let i = 0; i < 80; i++) {
        const b = simulatedBatch({ scenario, seed: 7, startMs: 0, intervalMs: 5000 }, i)
        if (!b) continue
        expect(DeviceReadingsRequest.safeParse(b).success, `${scenario} tick ${i}`).toBe(true)
        expect(b.readings.map((r) => r.kind)).toEqual(['heart_rate', 'spo2', 'temperature', 'respiratory_rate'])
      }
    }
  })

  it('the scenarios do what they say: a climbing heart rate, a falling saturation, a fever, a quiet gateway, a silent one', () => {
    const hr = (i: number) => (simulatedTick('rising_heart_rate', 1, i) as { readings: { value: number }[] }).readings[0]!.value
    expect(hr(0)).toBeLessThan(80)
    expect(hr(40)).toBeGreaterThan(125)
    const spo2 = (i: number) => (simulatedTick('low_spo2', 1, i) as { readings: { value: number }[] }).readings[1]!.value
    expect([spo2(0), spo2(30)]).toEqual([97, 89])
    const temp = (i: number) => (simulatedTick('fever', 1, i) as { readings: { value: number }[] }).readings[2]!.value
    expect([temp(0), temp(40)]).toEqual([37.2, 39.4])
    expect(simulatedTick('no_readings', 1, 5).send).toBe('readings')
    expect(simulatedTick('no_readings', 1, 6).send).toBe('heartbeat')
    expect(simulatedTick('dropout', 1, 20).send).toBe('nothing')
    expect(simulatedTick('dropout', 1, 36).send).toBe('readings')
  })

  it('the generated tones are a WAV file, the same for the same seed', () => {
    const a = simulatedToneWav(5, 2)
    expect(sniffAudio(a)).toBe('wav')
    expect(a.length).toBe(44 + 2 * 4000 * 2)
    expect(a.equals(simulatedToneWav(5, 2))).toBe(true)
    expect(a.equals(simulatedToneWav(6, 2))).toBe(false)
  })
})
