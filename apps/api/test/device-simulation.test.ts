import { AuscultationRecording, Device, Encounter, PatientDetail, PatientDeviceReadings, SimulationAttachResult, SimulationBandTickResult, SimulationScenario, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sniffAudio } from '../src/ai/audio-sniff.ts'
import { type SimulatorUse, simulatorReclaimable } from '../src/devices/simulation.ts'
import { SIM_SCENARIOS, simulatedToneWav } from '../src/devices/simulator.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, testConfig } from './helpers.ts'

// HERO final: the device simulator run from the consultation. NO PHYSICAL DEVICE is involved anywhere here: a "band" or a "stethoscope" is a
// device record REGISTERED AS A SIMULATOR, and what the routes generate is stored as simulated by the server and the database. The routes are
// session-authenticated (no device token reaches the browser) and refused unless simulators are allowed, the consultation is the caller's own
// and in progress, and the patient consented to device readings.

let ahead = 0
const clock = () => Date.now() + ahead
const settings = loadAppSettings()
// Every test signs people in again after the database is emptied: the sign-in limits are not what is under test here.
const generous = { ...settings, security: { rateLimits: { ...settings.security.rateLimits, loginPerIp: { max: 100_000, windowSeconds: 60 }, loginPerAccount: { max: 100_000, windowSeconds: 60 } } } }
const ctx = createTestApp({ clock, settings: generous })
let fx: Fixture
let admin = ''
let nurse = ''
let doctor = ''
let doctor2 = ''
afterAll(() => ctx.close())
beforeEach(async () => {
  ahead = 0
  await resetDatabase()
  fx = await createFixture(ctx.db)
  admin = await login(ctx.app, 't.admin')
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  doctor2 = await login(ctx.app, 't.doctor2')
})

type App = typeof ctx.app
let seq = 0
async function register(o: { kind?: 'wearable_band' | 'smart_stethoscope'; integration?: string; label?: string } = {}) {
  const res = await call(ctx.app, 'POST', '/api/admin/devices', { cookie: admin, body: { kind: o.kind ?? 'wearable_band', label: o.label ?? 'Simulator band (not a device)', serialNumber: `SIM-${crypto.randomUUID().slice(0, 8)}`, integration: o.integration ?? 'simulator' } })
  expect(res.statusCode, res.body).toBe(201)
  return Device.parse(res.json())
}
/** A patient (with the given consents) checked in today and waiting: no consultation yet. */
async function waitingPatient(consents: string[] = ['device_monitoring']) {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Sim${'abcdefghij'[seq % 10]}${'klmnopqrst'[Math.floor(seq / 10) % 10]}`, phone: `98402 ${String(10000 + seq)}` }) })).json())
  for (const type of consents) await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type, method: 'verbal' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen, chiefComplaint: 'Fever' } })).json())
  return { p, v }
}
/** A patient (with the given consents) checked in today, and the doctor's consultation for that visit, in progress. */
async function consultation(consents: string[] = ['device_monitoring']) {
  const { p, v } = await waitingPatient(consents)
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  return { p, v, e }
}
const sim = (e: { id: string }, what: 'attach' | 'band-tick' | 'stethoscope', body: object = {}, cookie = doctor, app: App = ctx.app) => call(app, 'POST', `/api/encounters/${e.id}/simulation/${what}`, { cookie, body })
const audits = async (action: string) => (await adminQuery('SELECT outcome, actor_role, actor_user_id, patient_id, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows as { outcome: string; actor_role: string | null; actor_user_id: string | null; patient_id: string | null; details: Record<string, unknown> }[]
const count = async (table: string) => (await adminQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number

describe('the scenarios the consultation may ask for are the simulator program’s', () => {
  it('the contract lists exactly the generator’s scenarios', () => {
    expect([...SimulationScenario.options].sort()).toEqual(Object.keys(SIM_SCENARIOS).sort())
  })
})

describe('attach: a free SIMULATOR record, never a device, for this consultation', () => {
  it('attaches a free simulator band to the patient for this consultation, once; asking again keeps it', async () => {
    const band = await register()
    const { p, v, e } = await consultation()
    const first = await sim(e, 'attach', { kind: 'band' })
    expect(first.statusCode, first.body).toBe(201)
    const att = SimulationAttachResult.parse(first.json())
    expect(att).toMatchObject({ kind: 'band', deviceId: band.id, alreadyAttached: false, simulated: true })
    expect((await adminQuery('SELECT patient_id, visit_id, encounter_id, assigned_by, ended_at FROM device_assignments WHERE id = $1', [att.assignmentId])).rows[0]).toMatchObject({ patient_id: p.id, visit_id: v.id, encounter_id: e.id, assigned_by: fx.users.doctor, ended_at: null })
    const again = await sim(e, 'attach', { kind: 'band' })
    expect(again.statusCode).toBe(200)
    expect(SimulationAttachResult.parse(again.json())).toMatchObject({ assignmentId: att.assignmentId, alreadyAttached: true })
    expect(await count('device_assignments')).toBe(1)
    // Audited as the doctor's assignment of a simulator: ids and flags only.
    const [assigned] = await audits('device.assign')
    expect(assigned).toMatchObject({ outcome: 'success', actor_role: 'doctor', patient_id: p.id, details: { deviceId: band.id, visitId: v.id, encounterId: e.id, simulated: true, via: 'simulation' } })
  })

  it('never attaches a device record that is not a simulator, says when none is registered, and when every one is in use', async () => {
    // A real (gateway) band is free: it is not a simulator, so it is not attached.
    await register({ integration: 'gateway_api', label: 'Band under test' })
    const { p, e } = await consultation()
    const none = await sim(e, 'attach', { kind: 'band' })
    expect(none.statusCode).toBe(409)
    expect(none.json().error).toBe('no_simulator_registered')
    expect(none.json().message).toMatch(/No simulator band is registered/)
    // A simulator stethoscope does not stand in for a band either.
    await register({ kind: 'smart_stethoscope', label: 'Simulator stethoscope (not a device)' })
    expect((await sim(e, 'attach', { kind: 'band' })).json().error).toBe('no_simulator_registered')
    // The only simulator band is attached to another patient.
    const band = await register()
    const other = await consultation()
    expect((await sim(other.e, 'attach', { kind: 'band' })).statusCode).toBe(201)
    const busy = await sim(e, 'attach', { kind: 'band' })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error).toBe('no_free_simulator')
    expect((await adminQuery('SELECT count(*)::int AS n FROM device_assignments WHERE patient_id = $1', [p.id])).rows[0].n).toBe(0)
    expect((await adminQuery('SELECT patient_id FROM device_assignments WHERE device_id = $1', [band.id])).rows).toEqual([{ patient_id: other.p.id }])
    // Every refusal is audited with a reason and ids, nothing else.
    const refused = await audits('device.simulation_refused')
    expect(refused.map((r) => r.details.reason)).toEqual(['no_simulator_registered', 'no_simulator_registered', 'no_free_simulator'])
    for (const r of refused) {
      expect(r.outcome).toBe('denied')
      expect(Object.keys(r.details).sort()).toEqual(['kind', 'reason', 'route'])
    }
  })

  it('a simulator left attached in a consultation that is over is moved to the next one: the old assignment is ended and audited; a device record never moves', async () => {
    const gateway = await register({ integration: 'gateway_api', label: 'Band under test' })
    const band = await register()
    const a = await consultation()
    const first = SimulationAttachResult.parse((await sim(a.e, 'attach', { kind: 'band' })).json())
    // A real (gateway) band attached in the same consultation: never moved by the simulator, whatever happens to the consultation.
    expect((await call(ctx.app, 'POST', `/api/devices/${gateway.id}/assignments`, { cookie: nurse, body: { patientId: a.p.id, encounterId: a.e.id } })).statusCode).toBe(201)
    const b = await consultation()
    // A's consultation is in progress: the simulator stays with A.
    const busy = await sim(b.e, 'attach', { kind: 'band' })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error).toBe('no_free_simulator')
    expect(busy.json().message).toMatch(/End one of those assignments from the device list first/)
    expect((await call(ctx.app, 'POST', `/api/encounters/${a.e.id}/discard`, { cookie: doctor, body: { version: a.e.version, reason: 'Opened by mistake' } })).statusCode).toBe(200)

    const moved = await sim(b.e, 'attach', { kind: 'band' })
    expect(moved.statusCode, moved.body).toBe(201)
    const att = SimulationAttachResult.parse(moved.json())
    expect(att).toMatchObject({ kind: 'band', deviceId: band.id, alreadyAttached: false, simulated: true })
    const rows = (await adminQuery('SELECT id, patient_id, encounter_id, ended_at, ended_by, end_reason FROM device_assignments WHERE device_id = $1 ORDER BY assigned_at', [band.id])).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: first.assignmentId, patient_id: a.p.id, encounter_id: a.e.id, ended_by: fx.users.doctor, end_reason: 'Simulator moved to another consultation' })
    expect(rows[0].ended_at).not.toBeNull()
    expect(rows[1]).toMatchObject({ id: att.assignmentId, patient_id: b.p.id, encounter_id: b.e.id, ended_at: null })
    // The gateway band is still attached to A.
    expect((await adminQuery('SELECT patient_id, ended_at FROM device_assignments WHERE device_id = $1', [gateway.id])).rows).toEqual([{ patient_id: a.p.id, ended_at: null }])
    // Audited as the doctor's act on A's assignment: ids and a reason, nothing else.
    const unassigned = await audits('device.unassign')
    expect(unassigned).toHaveLength(1)
    expect(unassigned[0]).toMatchObject({ outcome: 'success', actor_role: 'doctor', actor_user_id: fx.users.doctor, patient_id: a.p.id, details: { deviceId: band.id, reason: 'simulator_reclaimed', simulated: true } })
    expect(Object.keys(unassigned[0]!.details).sort()).toEqual(['deviceId', 'reason', 'simulated'])
    expect((await adminQuery("SELECT entity_id FROM audit_events WHERE action = 'device.unassign'")).rows).toEqual([{ entity_id: first.assignmentId }])
    expect((await audits('device.assign')).filter((x) => x.details.deviceId === band.id).map((x) => x.patient_id)).toEqual([a.p.id, b.p.id])
    // The band now ticks for B.
    const tick = await sim(b.e, 'band-tick')
    expect(tick.statusCode, tick.body).toBe(201)
    expect((await adminQuery("SELECT DISTINCT patient_id FROM observations WHERE device_id = $1", [band.id])).rows).toEqual([{ patient_id: b.p.id }])
  })

  it('a simulator staff attached to a patient whose visit is open today stays there; once that visit is closed it can be moved', async () => {
    const band = await register()
    const c = await waitingPatient()
    expect((await call(ctx.app, 'POST', `/api/devices/${band.id}/assignments`, { cookie: nurse, body: { patientId: c.p.id, visitId: c.v.id } })).statusCode).toBe(201)
    const b = await consultation()
    const busy = await sim(b.e, 'attach', { kind: 'band' })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error).toBe('no_free_simulator')
    expect((await adminQuery('SELECT patient_id, ended_at FROM device_assignments WHERE device_id = $1', [band.id])).rows).toEqual([{ patient_id: c.p.id, ended_at: null }])
    expect(await audits('device.unassign')).toEqual([])
    // The patient left: the visit is closed, and nobody is using the simulator.
    expect((await call(ctx.app, 'POST', `/api/visits/${c.v.id}/status`, { cookie: nurse, body: { status: 'cancelled', reason: 'Left before the consultation' } })).statusCode).toBe(200)
    const moved = await sim(b.e, 'attach', { kind: 'band' })
    expect(moved.statusCode, moved.body).toBe(201)
    expect((await adminQuery('SELECT patient_id, end_reason FROM device_assignments WHERE device_id = $1 ORDER BY assigned_at', [band.id])).rows).toEqual([
      { patient_id: c.p.id, end_reason: 'Simulator moved to another consultation' },
      { patient_id: b.p.id, end_reason: null },
    ])
    expect((await audits('device.unassign')).map((x) => [x.patient_id, x.details.reason])).toEqual([[c.p.id, 'simulator_reclaimed']])
  })
})

describe('which simulator assignment nobody is using now (simulatorReclaimable)', () => {
  const NOW = Date.UTC(2026, 9, 6, 10, 0, 0)
  const TODAY = '2026-10-06'
  const use = (o: Partial<SimulatorUse> = {}): SimulatorUse => ({ validUntil: null, encounterId: null, encounterStatus: null, visitId: null, visitStatus: null, visitDate: null, ...o })
  it('keeps one in a consultation in progress, or with a patient whose visit is open today; moves the rest', () => {
    // In a consultation: only its status decides.
    expect(simulatorReclaimable(use({ encounterId: 'e', encounterStatus: 'in_progress', visitId: 'v', visitStatus: 'in_consultation', visitDate: TODAY }), NOW, TODAY)).toBe(false)
    for (const s of ['signed', 'discarded']) expect(simulatorReclaimable(use({ encounterId: 'e', encounterStatus: s, visitId: 'v', visitStatus: 'ready', visitDate: TODAY }), NOW, TODAY), s).toBe(true)
    // Outside a consultation: the visit decides (open today: kept).
    for (const s of ['waiting', 'in_triage', 'ready', 'in_consultation']) expect(simulatorReclaimable(use({ visitId: 'v', visitStatus: s, visitDate: TODAY }), NOW, TODAY), s).toBe(false)
    for (const s of ['completed', 'cancelled', 'no_show']) expect(simulatorReclaimable(use({ visitId: 'v', visitStatus: s, visitDate: TODAY }), NOW, TODAY), s).toBe(true)
    expect(simulatorReclaimable(use({ visitId: 'v', visitStatus: 'waiting', visitDate: '2026-10-05' }), NOW, TODAY)).toBe(true)
    expect(simulatorReclaimable(use(), NOW, TODAY)).toBe(true)
    // Its attached time is over: it sends nothing more, whatever it was attached for.
    expect(simulatorReclaimable(use({ validUntil: new Date(NOW), encounterId: 'e', encounterStatus: 'in_progress' }), NOW, TODAY)).toBe(true)
    expect(simulatorReclaimable(use({ validUntil: new Date(NOW + 1), encounterId: 'e', encounterStatus: 'in_progress' }), NOW, TODAY)).toBe(false)
  })
})

describe('the gates: simulators allowed, consent, the caller’s own consultation in progress', () => {
  it('refuses every simulation route where simulators are not allowed (clinical data), audits it, and stores nothing', async () => {
    await register()
    await register({ kind: 'smart_stethoscope' })
    const { e } = await consultation()
    const clinical = createTestApp({ config: { ...testConfig, dataOrigin: 'clinical' }, clock, settings: generous })
    try {
      const d = await login(clinical.app, 't.doctor')
      for (const [what, body] of [
        ['attach', { kind: 'band' }],
        ['band-tick', {}],
        ['stethoscope', { site: 'mitral' }],
      ] as const) {
        const res = await sim(e, what, body, d, clinical.app)
        expect(res.statusCode, what).toBe(403)
        expect(res.json().error).toBe('simulator_not_allowed')
      }
    } finally {
      await clinical.close()
    }
    expect(await count('device_assignments')).toBe(0)
    expect(await count('observations')).toBe(0)
    expect(await count('auscultation_recordings')).toBe(0)
    const refused = await audits('device.simulation_refused')
    expect(refused.map((r) => [r.outcome, r.details.kind, r.details.reason])).toEqual([
      ['denied', 'band', 'simulator_not_allowed'],
      ['denied', 'band', 'simulator_not_allowed'],
      ['denied', 'stethoscope', 'simulator_not_allowed'],
    ])
    // Audited once, where it happened: the error handler adds no second "access.denied" for these.
    expect(await audits('access.denied')).toEqual([])
  })

  it('refuses without the patient’s consent to device readings: nothing is attached or stored', async () => {
    await register()
    const { p, e } = await consultation([])
    const attach = await sim(e, 'attach', { kind: 'band' })
    expect(attach.statusCode).toBe(409)
    expect(attach.json().error).toBe('consent_required')
    const tick = await sim(e, 'band-tick')
    expect(tick.statusCode).toBe(409)
    expect(tick.json().error).toBe('consent_required')
    expect(await count('device_assignments')).toBe(0)
    expect(await count('observations')).toBe(0)
    expect((await audits('consent.blocked')).map((a) => [a.patient_id, a.details.type])).toEqual([
      [p.id, 'device_monitoring'],
      [p.id, 'device_monitoring'],
    ])
  })

  it('refuses another doctor, a nurse, and a consultation that is not in progress', async () => {
    await register()
    const { p, e } = await consultation()
    const other = await sim(e, 'attach', { kind: 'band' }, doctor2)
    expect(other.statusCode).toBe(403)
    expect(other.json().error).toBe('forbidden')
    const [refusal] = await audits('device.simulation_refused')
    expect(refusal).toMatchObject({ outcome: 'denied', actor_user_id: fx.users.doctor2, patient_id: p.id, details: { kind: 'band', reason: 'not_own_consultation' } })
    // A nurse has no permission to write a consultation at all (refused, and audited, by the permission hook).
    expect((await sim(e, 'band-tick', {}, nurse)).statusCode).toBe(403)
    // An unknown consultation is not found (and the lookup is audited as a denial).
    expect((await call(ctx.app, 'POST', `/api/encounters/${crypto.randomUUID()}/simulation/attach`, { cookie: doctor, body: { kind: 'band' } })).statusCode).toBe(404)
    await call(ctx.app, 'POST', `/api/encounters/${e.id}/discard`, { cookie: doctor, body: { version: e.version, reason: 'Opened by mistake' } })
    const closed = await sim(e, 'attach', { kind: 'band' })
    expect(closed.statusCode).toBe(409)
    expect(closed.json().error).toBe('encounter_not_in_progress')
    expect(await count('device_assignments')).toBe(0)
  })

  it('a tick or a recording needs the simulator attached first', async () => {
    await register()
    await register({ kind: 'smart_stethoscope' })
    const { e } = await consultation()
    const tick = await sim(e, 'band-tick')
    expect(tick.statusCode).toBe(409)
    expect(tick.json().error).toBe('simulator_not_attached')
    const rec = await sim(e, 'stethoscope', { site: 'mitral' })
    expect(rec.statusCode).toBe(409)
    expect(rec.json().error).toBe('simulator_not_attached')
    expect(await count('observations')).toBe(0)
    expect(await count('auscultation_recordings')).toBe(0)
  })

  it('the band ticks of one consultation are rate limited', async () => {
    await register()
    const { e } = await consultation()
    await sim(e, 'attach', { kind: 'band' })
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await sim(e, 'band-tick')).statusCode)
    expect(codes.slice(0, 30).every((c) => c === 200 || c === 201)).toBe(true)
    expect(codes[30]).toBe(429)
  })
})

describe('band ticks: generated values through the gateway’s store path, stored and shown as SIMULATED', () => {
  it('stores one batch per tick, marked simulated by the server, never in the visit’s vital signs; a repeat within the tick stores nothing twice', async () => {
    const band = await register()
    const { p, v, e } = await consultation()
    await call(ctx.app, 'POST', `/api/visits/${v.id}/observations`, { cookie: nurse, body: { items: [{ kind: 'heart_rate', value: 92 }] } })
    expect((await sim(e, 'attach', { kind: 'band' })).statusCode).toBe(201)

    const first = await sim(e, 'band-tick')
    expect(first.statusCode, first.body).toBe(201)
    const t1 = SimulationBandTickResult.parse(first.json())
    expect(t1).toMatchObject({ sent: 'readings', stored: 4, duplicate: false, validationStatus: 'simulated', scenario: 'steady' })
    expect([...t1.kinds].sort()).toEqual(['heart_rate', 'respiratory_rate', 'spo2', 'temperature'])
    // Asked again within the same five seconds (another tab): the same batch, stored once.
    const repeat = SimulationBandTickResult.parse((await sim(e, 'band-tick')).json())
    expect(repeat).toMatchObject({ sent: 'readings', stored: 0, duplicate: true })
    ahead += 5000
    expect(SimulationBandTickResult.parse((await sim(e, 'band-tick')).json())).toMatchObject({ stored: 4, duplicate: false })

    // The database holds them as simulated, through the simulator record, filed under the visit, each batch keyed by the simulator.
    const rows = (await adminQuery("SELECT validation_status, source, device_id, visit_id, device_batch_id FROM observations WHERE patient_id = $1 AND source = 'device'", [p.id])).rows
    expect(rows).toHaveLength(8)
    for (const r of rows) expect(r).toMatchObject({ validation_status: 'simulated', source: 'device', device_id: band.id, visit_id: v.id })
    const batches = (await adminQuery('SELECT simulated, idempotency_key FROM device_batches ORDER BY measured_at')).rows
    expect(batches.map((b) => b.simulated)).toEqual([true, true])
    expect(batches.every((b) => String(b.idempotency_key).startsWith('sim:device-sim-v1:steady:'))).toBe(true)

    // Staff see them on the device card, as simulated, live, with no reference flag.
    const view = PatientDeviceReadings.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}/device-readings`, { cookie: doctor })).json())
    expect(view.devices).toHaveLength(1)
    expect(view.devices[0]).toMatchObject({ deviceId: band.id, simulated: true, state: 'live' })
    for (const r of view.devices[0]!.readings) expect(r).toMatchObject({ validationStatus: 'simulated', flag: null })
    // The consultation's vital signs (what the header and every model read) hold the nurse's measurement only.
    const enc = Encounter.parse((await call(ctx.app, 'GET', `/api/encounters/${e.id}`, { cookie: doctor })).json())
    expect(enc.vitals.map((o) => [o.kind, o.value, o.validationStatus])).toEqual([['heart_rate', 92, 'manual_entry']])

    // Audited as the doctor, once per window (the batch table records each one), with kinds and ids, never a value.
    const ingests = (await audits('device.ingest')).filter((a) => a.details.via === 'simulation')
    expect(ingests).toHaveLength(1)
    expect(ingests[0]).toMatchObject({ outcome: 'success', actor_role: 'doctor', actor_user_id: fx.users.doctor, patient_id: p.id, details: { simulated: true, visitId: v.id } })
    expect(Object.keys(ingests[0]!.details).sort()).toEqual(['assignmentId', 'batchId', 'readings', 'repeatsNotLoggedForSeconds', 'simulated', 'via', 'visitId'])
    expect([...(ingests[0]!.details.readings as string[])].sort()).toEqual(['heart_rate', 'respiratory_rate', 'spo2', 'temperature'])
  })

  it('a scenario can go quiet: silence (nothing heard) or contact without readings, as the simulator program does', async () => {
    const band = await register()
    const { e } = await consultation()
    await sim(e, 'attach', { kind: 'band' })
    const lastSeen = async () => (await adminQuery('SELECT last_seen_at FROM devices WHERE id = $1', [band.id])).rows[0].last_seen_at as Date | null
    expect(await lastSeen()).toBeNull()
    // Tick 6 is in the quiet part of both scenarios.
    ahead += 6 * 5000
    expect(SimulationBandTickResult.parse((await sim(e, 'band-tick', { scenario: 'dropout' })).json())).toMatchObject({ sent: 'nothing', stored: 0 })
    expect(await lastSeen()).toBeNull()
    expect(SimulationBandTickResult.parse((await sim(e, 'band-tick', { scenario: 'no_readings' })).json())).toMatchObject({ sent: 'heartbeat', stored: 0 })
    expect(await lastSeen()).not.toBeNull()
    expect(await count('observations')).toBe(0)
    expect((await sim(e, 'band-tick', { scenario: 'not_a_scenario' })).statusCode).toBe(400)
  })
})

describe('the simulated stethoscope: generated tones, stored as SIMULATED AUDIO', () => {
  it('stores one generated-tones recording under the simulator stethoscope, in this consultation, simulated; audited without audio', async () => {
    const steth = await register({ kind: 'smart_stethoscope', label: 'Simulator stethoscope (not a device)' })
    const { p, e } = await consultation()
    expect((await sim(e, 'attach', { kind: 'stethoscope' })).statusCode).toBe(201)
    const res = await sim(e, 'stethoscope', { site: 'mitral' })
    expect(res.statusCode, res.body).toBe(201)
    const rec = AuscultationRecording.parse(res.json())
    expect(rec).toMatchObject({ patientId: p.id, encounterId: e.id, site: 'mitral', captureMethod: 'gateway', simulated: true, device: { id: steth.id }, durationMs: 4000, mimeType: 'audio/wav' })
    // The list says the same (what the panel shows as SIMULATED AUDIO).
    const list = ((await call(ctx.app, 'GET', `/api/patients/${p.id}/auscultations`, { cookie: doctor })).json().recordings as unknown[]).map((r) => AuscultationRecording.parse(r))
    expect(list.map((r) => [r.id, r.simulated])).toEqual([[rec.id, true]])
    // It plays as a WAV file through the same audited file route as any recording.
    const play = await call(ctx.app, 'GET', `/api/files/${rec.fileId}`, { cookie: doctor })
    expect(play.statusCode).toBe(200)
    expect(sniffAudio(play.rawPayload)).toBe('wav')
    expect((await adminQuery('SELECT simulated, kind FROM device_batches')).rows).toEqual([{ simulated: true, kind: 'auscultation' }])
    const [ingest] = (await audits('device.ingest')).filter((a) => a.details.via === 'simulation')
    expect(ingest).toMatchObject({ actor_role: 'doctor', patient_id: p.id, details: { recording: true, site: 'mitral', simulated: true, encounterId: e.id } })
    expect(Object.keys(ingest!.details).sort()).toEqual(['assignmentId', 'batchId', 'encounterId', 'recording', 'simulated', 'site', 'sizeBytes', 'via'])
    // An unknown site is refused before anything is generated.
    expect((await sim(e, 'stethoscope', { site: 'elbow' })).statusCode).toBe(400)
    expect(await count('auscultation_recordings')).toBe(1)
  })

  it('a staff recording still cannot be filed under the simulator (the staff route is unchanged)', async () => {
    const steth = await register({ kind: 'smart_stethoscope' })
    const { p, e } = await consultation()
    await sim(e, 'attach', { kind: 'stethoscope' })
    const boundary = '----sim'
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="site"\r\n\r\nmitral\r\n--${boundary}\r\nContent-Disposition: form-data; name="deviceId"\r\n\r\n${steth.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), simulatedToneWav(3, 1), Buffer.from(`\r\n--${boundary}--\r\n`)])
    const res = await ctx.app.inject({ method: 'POST', url: `/api/patients/${p.id}/auscultations`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-adaxai-csrf': '1', cookie: doctor }, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json().issues[0].message).toMatch(/A simulator is not a stethoscope/)
    expect(await count('auscultation_recordings')).toBe(0)
  })
})
