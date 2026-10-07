import { DEMO_ANALYSIS_LABEL, demoThermalAnalysis } from '../src/thermal/demoAnalysis.ts'
import type { ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CONSENT_VERSIONS, demoImageHeatToC, Device, Encounter, PatientDetail, simulateThermalMatrix, THERMAL_DEMO_IMAGE_EXTRACTOR, THERMAL_SIM_SIZE, THERMAL_SIM_VERSION, ThermalCapture, ThermalDatasetExport, ThermalModelStatus, thermalStats, Visit } from '@adaxai/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPatientContext } from '../src/ai/context.ts'
import { hashPassword } from '../src/auth/password.ts'
import { consents, departments, facilities, users } from '../src/db/schema.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import { httpThermalService, type ThermalService } from '../src/thermal/client.ts'
import { FILE_INTO_CLOSED_CONSULTATION } from '../src/thermal/routes.ts'
import { adminQuery, call, closedPort, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, TEST_PASSWORD, testConfig, type TestContext } from './helpers.ts'
import { haveThermal, multipart, SAMPLES, sampleProtocol, startThermalService } from './thermal-support.ts'

// Slice V6: where a thermal image came from (an uploaded file, an imported file, a live capture handed over by the device bridge, or the
// simulator), polygon regions, the model status, and simulated captures kept out of everything real. NO CAMERA is involved anywhere here: a
// "live capture" is this test posting a public FLIR sample file with the fields the device bridge sends, and what it says about the camera is
// test data. The thermal service is the REAL Python service, started here.

const settings = loadAppSettings()
// Every test signs several people in again after the database is emptied: the sign-in limits are not what is under test here.
const generous = { ...settings, security: { rateLimits: { ...settings.security.rateLimits, loginPerIp: { max: 100_000, windowSeconds: 60 }, loginPerAccount: { max: 100_000, windowSeconds: 60 } } } }
let service: ChildProcess | null = null
let serviceUrl = ''
let ctx: TestContext
let fx: Fixture
let admin = ''
let nurse = ''
let doctor = ''
let doctor2 = ''

/**
 * What happens elsewhere while an upload is being processed: when set, it runs after the real thermal service has decoded the file and before the
 * route stores it (a consultation signed or discarded, a consent withdrawn), so the store-time checks are reached deterministically.
 */
let whileProcessing: (() => Promise<void>) | null = null

beforeAll(async () => {
  if (!haveThermal) return
  const s = await startThermalService()
  service = s.proc
  serviceUrl = s.url
  const real = httpThermalService(s.url)
  const thermal: ThermalService = {
    ...real,
    async extract(file, filename) {
      const decoded = await real.extract(file, filename)
      if (whileProcessing) await whileProcessing()
      return decoded
    },
  }
  ctx = createTestApp({ thermal, settings: generous })
}, 60_000)

afterAll(async () => {
  service?.kill()
  await ctx?.close()
})

beforeEach(async () => {
  if (!haveThermal) return
  whileProcessing = null
  await resetDatabase()
  fx = await createFixture(ctx.db)
  admin = await login(ctx.app, 't.admin')
  nurse = await login(ctx.app, 't.nurse')
  doctor = await login(ctx.app, 't.doctor')
  doctor2 = await login(ctx.app, 't.doctor2')
})

const SAMPLE = haveThermal ? fs.readFileSync(path.join(SAMPLES, 'flir_example.jpg')) : Buffer.alloc(0)
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')
const simProtocol = { bodyRegion: 'Hands', bodySite: 'hand', view: 'dorsal' }

let seq = 0
async function patient(types: string[] = ['thermal_imaging'], cookie = nurse, app = ctx.app) {
  seq++
  const p = PatientDetail.parse((await call(app, 'POST', '/api/patients', { cookie, body: samplePatient({ givenName: `Therm${'abcdefghij'[seq % 10]}${'klmnopqrst'[Math.floor(seq / 10) % 10]}`, phone: `98402 ${String(10000 + seq)}` }) })).json())
  for (const type of types) expect((await call(app, 'POST', `/api/patients/${p.id}/consents`, { cookie, body: { type, method: 'verbal' } })).statusCode).toBe(201)
  return p
}

/** A visit and the doctor's consultation for it, in progress. */
async function consultation(patientId: string, o: { cookie?: string; nurseCookie?: string; departmentId?: string } = {}) {
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: o.nurseCookie ?? nurse, body: { patientId, departmentId: o.departmentId ?? fx.departments.gen, chiefComplaint: 'Hand pain' } })).json())
  const res = await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: o.cookie ?? doctor })
  expect(res.statusCode, res.body).toBe(201)
  return Encounter.parse(res.json())
}

/** An upload as the web app or the device bridge sends it: text fields first, then the file. */
function upload(patientId: string, fields: Record<string, string> = {}, cookie = doctor, data: Buffer = SAMPLE) {
  const m = multipart({ protocol: JSON.stringify(sampleProtocol), ...fields }, { name: 'capture.jpg', type: 'image/jpeg', data })
  return ctx.app.inject({ method: 'POST', url: `/api/patients/${patientId}/thermal`, headers: { ...m.headers, cookie, 'x-adaxai-csrf': '1' }, payload: m.payload })
}
const live = (encounterId: string, extra: Record<string, string> = {}) => ({ captureSource: 'live_capture', encounterId, ...extra })

/** What a device bridge reports about a camera: TEST DATA, not a real camera. */
const reported = (serialNumber: string | null) => ({
  model: 'Test thermal camera (fixture)',
  serialNumber,
  programVersion: 'test-1.0',
  articleNumber: null,
  deviceId: 'test-usb-0001',
  interface: 'USB',
  sdk: { name: 'test-sdk', version: '0.0.0', commitHash: null },
  bridge: { name: 'test-bridge', version: '0.0.0' },
})

const simulate = (patientId: string, body: Record<string, unknown>, cookie = doctor, app = ctx.app) => call(app, 'POST', `/api/patients/${patientId}/thermal/simulate`, { cookie, body: { case: 'normal', seed: 42, protocol: simProtocol, ...body } })
const count = async (table: string) => (await adminQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number
const audits = async (action: string) => (await adminQuery('SELECT outcome, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows as { outcome: string; details: Record<string, unknown> }[]
const f32le = (m: Float32Array) => {
  const b = Buffer.alloc(m.length * 4)
  m.forEach((v, i) => b.writeFloatLE(v, i * 4))
  return b
}

async function otherFacility() {
  const [other] = await ctx.db.insert(facilities).values({ code: 'TEST-02', name: 'Other facility' }).returning()
  const [dept] = await ctx.db.insert(departments).values({ facilityId: other!.id, code: 'GEN', name: 'General Medicine' }).returning()
  const passwordHash = await hashPassword(TEST_PASSWORD)
  await ctx.db.insert(users).values([
    { facilityId: other!.id, username: 'o.nurse', fullName: 'Other nurse', role: 'nurse', passwordHash, departmentId: dept!.id },
    { facilityId: other!.id, username: 'o.doctor', fullName: 'Other doctor', role: 'doctor', passwordHash, departmentId: dept!.id },
    { facilityId: other!.id, username: 'o.admin', fullName: 'Other admin', role: 'admin', passwordHash, departmentId: null },
  ])
  return { departmentId: dept!.id, nurse: await login(ctx.app, 'o.nurse'), doctor: await login(ctx.app, 'o.doctor'), admin: await login(ctx.app, 'o.admin') }
}

describe.skipIf(!haveThermal)('V6 thermal capture provenance (API + real thermal service)', () => {
  it('an upload is a file upload by default; its source, the checksum of the original and the image standard deviation are stored and shown', async () => {
    const p = await patient()
    const res = await upload(p.id)
    expect(res.statusCode, res.body).toBe(201)
    const c = ThermalCapture.parse(res.json())
    expect(c).toMatchObject({ captureSource: 'file_upload', simulated: false, capturedAt: null, device: null, deviceReported: null, encounterId: null, rawSha256: sha256(SAMPLE), dataOrigin: 'public_sample' })
    expect(c.stdC).toBeGreaterThan(0)
    const row = (await adminQuery('SELECT capture_source, simulated, std_c::float AS std FROM thermal_captures WHERE id = $1', [c.id])).rows[0]
    expect(row).toEqual({ capture_source: 'file_upload', simulated: false, std: c.stdC })
    const explicit = ThermalCapture.parse((await upload(p.id, { captureSource: 'file_upload', protocol: JSON.stringify({ ...sampleProtocol, bodySite: 'knee' }) })).json())
    expect(explicit).toMatchObject({ captureSource: 'file_upload', protocol: { bodySite: 'knee' } })
    expect((await audits('thermal.upload'))[0]!.details).toMatchObject({ captureSource: 'file_upload', simulated: false, deviceId: null, encounterId: null, sha256: sha256(SAMPLE), dataOrigin: 'public_sample' })
  })

  it('"simulator" is not an upload source, and nothing is stored', async () => {
    const p = await patient()
    const res = await upload(p.id, { captureSource: 'simulator' })
    expect(res.statusCode).toBe(400)
    expect(res.json().issues[0]).toMatchObject({ path: 'captureSource' })
    expect((await upload(p.id, { captureSource: 'camera' })).statusCode).toBe(400)
    expect(await count('files')).toBe(0)
    expect(await count('thermal_captures')).toBe(0)
  })

  it('a non-radiometric file is refused as NON-RADIOMETRIC, audited, and not stored', async () => {
    const p = await patient()
    const res = await upload(p.id, {}, doctor, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]))
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toBe('not_radiometric')
    expect(res.json().message).toMatch(/^NON-RADIOMETRIC: /)
    expect(await count('files')).toBe(0)
    expect((await audits('thermal.capture_refused')).map((a) => [a.outcome, a.details.reason, a.details.captureSource])).toEqual([['failure', 'not_radiometric', 'file_upload']])
  })

  it('a live capture or an import is taken into the doctor’s own consultation in progress, and nowhere else', async () => {
    const p = await patient()
    expect((await upload(p.id, { captureSource: 'live_capture' })).json().issues[0]).toMatchObject({ path: 'encounterId' })
    expect((await upload(p.id, { captureSource: 'gallery_import' })).statusCode).toBe(400)
    const e = await consultation(p.id)
    // Another doctor's consultation, or a nurse (who has no consultation of their own).
    expect((await upload(p.id, live(e.id), doctor2)).statusCode).toBe(403)
    expect((await upload(p.id, live(e.id), nurse)).statusCode).toBe(403)
    // Another patient's consultation.
    const p2 = await patient()
    const e2 = await consultation(p2.id)
    expect((await upload(p.id, live(e2.id))).json().issues[0]).toMatchObject({ path: 'encounterId', message: 'Not a consultation of this patient' })
    // Another facility: its consultation is not one of this patient's, and its doctor cannot reach this patient at all.
    const o = await otherFacility()
    const op = await patient(['thermal_imaging'], o.nurse)
    const oe = await consultation(op.id, { cookie: o.doctor, nurseCookie: o.nurse, departmentId: o.departmentId })
    expect((await upload(p.id, live(oe.id))).statusCode).toBe(400)
    expect((await upload(p.id, live(e.id), o.doctor)).statusCode).toBe(404)
    expect((await upload(op.id, live(oe.id), doctor)).statusCode).toBe(404)
    expect(await count('thermal_captures')).toBe(0)

    const capturedAt = new Date(Date.now() - 60_000).toISOString()
    const ok = ThermalCapture.parse((await upload(p.id, live(e.id, { capturedAt, deviceReported: JSON.stringify(reported('TC-0001')) }))).json())
    expect(ok).toMatchObject({ captureSource: 'live_capture', simulated: false, encounterId: e.id, capturedAt, deviceReported: reported('TC-0001'), device: null })
    const imported = ThermalCapture.parse((await upload(p.id, { captureSource: 'gallery_import', encounterId: e.id })).json())
    expect(imported).toMatchObject({ captureSource: 'gallery_import', encounterId: e.id, capturedAt: null, deviceReported: null })
    expect((await audits('thermal.upload')).map((a) => [a.details.captureSource, a.details.encounterId])).toEqual([
      ['live_capture', e.id],
      ['gallery_import', e.id],
    ])

    // Once signed, the consultation takes no more images.
    const draft = { version: e.version, note: { chiefComplaint: 'Hand pain', history: 'History', pastHistory: '', examination: 'Exam', assessment: 'Assessment', plan: 'Plan', followUp: '' }, diagnoses: [{ description: 'Hand pain', code: null, kind: 'primary' }], prescription: [] }
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    const signed = await upload(p.id, live(e.id))
    expect([signed.statusCode, signed.json().error]).toEqual([409, 'encounter_not_in_progress'])
  })

  it('the capture time and what the bridge reported come with a live capture only, are validated, and are kept as reported', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const now = new Date().toISOString()
    expect((await upload(p.id, { capturedAt: now })).json().issues[0]).toMatchObject({ path: 'capturedAt' })
    expect((await upload(p.id, { captureSource: 'gallery_import', encounterId: e.id, deviceReported: JSON.stringify(reported('X')) })).json().issues[0]).toMatchObject({ path: 'deviceReported' })
    expect((await upload(p.id, live(e.id, { deviceReported: '{not json' }))).statusCode).toBe(400)
    expect((await upload(p.id, live(e.id, { deviceReported: JSON.stringify({ model: 'only a model' }) }))).statusCode).toBe(400)
    expect((await upload(p.id, live(e.id, { capturedAt: 'yesterday' }))).statusCode).toBe(400)
    expect(await count('thermal_captures')).toBe(0)
    const c = ThermalCapture.parse((await upload(p.id, live(e.id, { capturedAt: now, deviceReported: JSON.stringify(reported(null)) }))).json())
    expect(c.deviceReported).toEqual(reported(null))
    expect((await adminQuery('SELECT device_reported FROM thermal_captures WHERE id = $1', [c.id])).rows[0].device_reported).toEqual(reported(null))
  })

  it('a live capture’s time is taken only near when it arrives: more than 5 minutes ahead or more than 24 hours before is a wrong clock, refused and audited', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const at = (ms: number) => new Date(Date.now() + ms).toISOString()
    for (const [capturedAt, message] of [
      [at(6 * 60_000), 'In the future'],
      [at(3_600_000), 'In the future'],
      [at(-25 * 3_600_000), 'More than 24 hours ago'],
      ['2019-01-01T00:00:00Z', 'More than 24 hours ago'],
    ]) {
      const res = await upload(p.id, live(e.id, { capturedAt: capturedAt! }))
      expect([res.statusCode, res.json().error], capturedAt).toEqual([422, 'captured_at_out_of_range'])
      expect(res.json().issues[0]).toEqual({ path: 'capturedAt', message })
      expect(res.json().message).toMatch(/Nothing was stored\.$/)
    }
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect((await audits('thermal.capture_refused')).map((a) => [a.outcome, a.details.reason, a.details.captureSource, a.details.encounterId])).toEqual(Array(4).fill(['failure', 'captured_at_out_of_range', 'live_capture', e.id]))
    // Inside the window it is kept as reported.
    for (const capturedAt of [at(4 * 60_000), at(-23 * 3_600_000)]) {
      const res = await upload(p.id, live(e.id, { capturedAt }))
      expect(res.statusCode, res.body).toBe(201)
      expect(ThermalCapture.parse(res.json()).capturedAt).toBe(capturedAt)
    }
  })

  it('a camera is matched by serial number only to an active thermal camera of this facility that is not a simulator', async () => {
    const register = async (cookie: string, body: object) => {
      const res = await call(ctx.app, 'POST', '/api/admin/devices', { cookie, body })
      expect(res.statusCode, res.body).toBe(201)
      return Device.parse(res.json())
    }
    const camera = await register(admin, { kind: 'thermal_camera', label: 'Thermal camera 1', serialNumber: 'TC-ACTIVE' })
    await register(admin, { kind: 'wearable_band', label: 'Band', serialNumber: 'WB-1' })
    const retired = await register(admin, { kind: 'thermal_camera', label: 'Old camera', serialNumber: 'TC-RETIRED' })
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${retired.id}`, { cookie: admin, body: { status: 'retired' } })).statusCode).toBe(200)
    await register(admin, { kind: 'thermal_camera', label: 'Simulated camera', serialNumber: 'TC-SIM', integration: 'simulator' })
    const o = await otherFacility()
    await register(o.admin, { kind: 'thermal_camera', label: 'Their camera', serialNumber: 'TC-OTHER' })

    const p = await patient()
    const e = await consultation(p.id)
    const take = async (serial: string) => ThermalCapture.parse((await upload(p.id, live(e.id, { deviceReported: JSON.stringify(reported(serial)) }))).json())
    expect((await take('TC-ACTIVE')).device).toEqual({ id: camera.id, label: 'Thermal camera 1' })
    for (const serial of ['WB-1', 'TC-RETIRED', 'TC-SIM', 'TC-OTHER', 'TC-UNKNOWN']) {
      const c = await take(serial)
      expect(c.device, serial).toBeNull()
      expect(c.deviceReported!.serialNumber).toBe(serial)
    }
    expect((await audits('thermal.upload')).map((a) => a.details.deviceId)).toEqual([camera.id, null, null, null, null, null])
  })

  it('a consultation-only consent to thermal imaging covers captures in that consultation, and only there', async () => {
    const p = await patient([])
    const e = await consultation(p.id)
    expect((await upload(p.id, live(e.id))).json().error).toBe('consent_required')
    await ctx.db.insert(consents).values({ patientId: p.id, type: 'thermal_imaging', method: 'verbal', scope: 'encounter', encounterId: e.id, version: CONSENT_VERSIONS.thermal_imaging, recordedBy: fx.users.doctor })
    expect((await upload(p.id, live(e.id))).statusCode).toBe(201)
    expect((await simulate(p.id, { encounterId: e.id })).statusCode).toBe(201)
    // Outside that consultation it does not apply.
    expect((await upload(p.id)).json().error).toBe('consent_required')
  })

  it('where a capture came from cannot be changed in the database', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const c = ThermalCapture.parse((await upload(p.id, live(e.id, { deviceReported: JSON.stringify(reported('TC-1')) }))).json())
    const s = ThermalCapture.parse((await simulate(p.id, { encounterId: e.id })).json())
    for (const sql of [
      "UPDATE thermal_captures SET capture_source = 'file_upload' WHERE id = $1",
      "UPDATE thermal_captures SET device_reported = '{}'::jsonb WHERE id = $1",
      'UPDATE thermal_captures SET captured_at = now() WHERE id = $1',
      "UPDATE thermal_captures SET data_origin = 'clinical' WHERE id = $1",
    ]) {
      await expect(ctx.pool.query(sql, [c.id])).rejects.toMatchObject({ code: '42501' })
    }
    await expect(ctx.pool.query("UPDATE thermal_captures SET simulated = false, capture_source = 'live_capture', data_origin = 'clinical' WHERE id = $1", [s.id])).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query('UPDATE thermal_captures SET simulated = false WHERE id = $1', [s.id])).rejects.toMatchObject({ code: '42501' })
    // A simulated row cannot be written as anything but synthetic and simulator (constraint).
    const row = (await adminQuery('SELECT facility_id, patient_id, raw_file_id, matrix_file_id FROM thermal_captures WHERE id = $1', [s.id])).rows[0]
    await expect(
      ctx.pool.query("INSERT INTO thermal_captures (facility_id, patient_id, raw_file_id, matrix_file_id, width, height, min_c, max_c, mean_c, camera, parameters, extractor, protocol, data_origin, capture_source, simulated) VALUES ($1, $2, $3, $4, 1, 1, 0, 0, 0, '{}', '{}', '{}', '{}', 'clinical', 'simulator', true)", [row.facility_id, row.patient_id, row.raw_file_id, row.matrix_file_id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe.skipIf(!haveThermal)('V6 thermal capture: what changes while the image is being processed', () => {
  /** Every file in the test file store, by its path. */
  const storedFiles = () => {
    const dir = testConfig.storageDir
    if (!fs.existsSync(dir)) return []
    return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort()
  }
  const draft = (e: Encounter) => ({ version: e.version, note: { chiefComplaint: 'Hand pain', history: 'History', pastHistory: '', examination: 'Exam', assessment: 'Assessment', plan: 'Plan', followUp: '' }, diagnoses: [{ description: 'Hand pain', code: null, kind: 'primary' }], prescription: [] })
  async function sign(e: Encounter) {
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: draft(e) })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
    // HERO final (deliberate change): signing no longer closes the visit; completed, the patient's next consultation (next loop turn) can open.
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/complete`, { cookie: doctor, body: {} })).statusCode).toBe(200)
  }
  async function discard(e: Encounter) {
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/discard`, { cookie: doctor, body: { version: e.version, reason: 'Opened for the wrong patient' } })).statusCode).toBe(200)
  }

  it('a consultation signed, or discarded, while a live capture or an import is processed takes nothing: no row, no file, the bytes removed, the refusal audited', async () => {
    const p = await patient()
    for (const [source, close] of [
      ['live_capture', sign],
      ['gallery_import', discard],
    ] as const) {
      const e = await consultation(p.id)
      const before = storedFiles()
      // The pre-check passes (the consultation is open when the upload arrives); the consultation is closed before the image is stored.
      whileProcessing = () => close(e)
      const res = await upload(p.id, { captureSource: source, encounterId: e.id })
      whileProcessing = null
      expect([res.statusCode, res.json().error], source).toEqual([409, 'encounter_not_in_progress'])
      expect(res.json().message).toBe('This consultation was signed or discarded while the image was being processed. Nothing was stored.')
      expect(storedFiles()).toEqual(before)
    }
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect(await audits('thermal.upload')).toEqual([])
    expect((await audits('thermal.capture_refused')).map((a) => [a.outcome, a.details.captureSource, a.details.simulated, a.details.reason, a.details.atStore])).toEqual([
      ['denied', 'live_capture', false, 'encounter_not_in_progress', true],
      ['denied', 'gallery_import', false, 'encounter_not_in_progress', true],
    ])
    // HERO final (deliberate change): a file upload is no longer filed under a signed consultation either: refused (409), nothing stored.
    const signed = (await adminQuery("SELECT id FROM encounters WHERE status = 'signed'")).rows[0].id as string
    const filesBefore = storedFiles()
    const res = await upload(p.id, { captureSource: 'file_upload', encounterId: signed })
    expect([res.statusCode, res.json().error], res.body).toEqual([409, 'encounter_not_in_progress'])
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect(storedFiles()).toEqual(filesBefore)
  })

  it('a file upload is filed only under a consultation in progress: a signed or discarded one is refused (409), also when it closes while the image is processed; nothing is stored, and the refusal is audited', async () => {
    const p = await patient()
    const before = storedFiles()
    // A signed (and completed) consultation.
    const a = await consultation(p.id)
    await sign(a)
    // A consultation in progress takes a file upload from the nurse as well as the doctor, filed under it.
    const c = await consultation(p.id)
    const filed = ThermalCapture.parse((await upload(p.id, { captureSource: 'file_upload', encounterId: c.id }, nurse)).json())
    expect(filed).toMatchObject({ captureSource: 'file_upload', encounterId: c.id, simulated: false })
    // Signed while the image is processed: the store-time look refuses it, and its bytes are removed.
    const afterFiled = storedFiles()
    whileProcessing = () => sign(c)
    const closing = await upload(p.id, { captureSource: 'file_upload', encounterId: c.id }, nurse)
    whileProcessing = null
    expect([closing.statusCode, closing.json().error]).toEqual([409, 'encounter_not_in_progress'])
    expect(closing.json().message).toBe('This consultation was signed or discarded while the image was being processed. Nothing was stored.')
    expect(storedFiles()).toEqual(afterFiled)
    // A discarded draft.
    const b = await consultation(p.id)
    await discard(b)
    // Refused before the image is processed, for the doctor and the nurse, for a file upload and an import.
    for (const [source, encounterId, cookie] of [
      ['file_upload', a.id, doctor],
      ['file_upload', a.id, nurse],
      ['file_upload', b.id, doctor],
      ['gallery_import', a.id, doctor],
      ['gallery_import', b.id, doctor],
    ] as const) {
      const res = await upload(p.id, { captureSource: source, encounterId }, cookie)
      expect([res.statusCode, res.json().error], `${source} ${encounterId === a.id ? 'signed' : 'discarded'}`).toEqual([409, 'encounter_not_in_progress'])
      if (source === 'file_upload') expect(res.json().message).toBe(FILE_INTO_CLOSED_CONSULTATION)
    }
    expect(storedFiles()).toEqual(afterFiled)
    expect((await adminQuery('SELECT encounter_id FROM thermal_captures')).rows).toEqual([{ encounter_id: c.id }])
    expect(before.length).toBeLessThan(afterFiled.length)
    // Without a consultation, a file upload is still the patient's.
    const loose = ThermalCapture.parse((await upload(p.id)).json())
    expect(loose).toMatchObject({ captureSource: 'file_upload', encounterId: null })
    expect((await audits('thermal.upload')).map((x) => [x.details.captureSource, x.details.encounterId])).toEqual([
      ['file_upload', c.id],
      ['file_upload', null],
    ])
    // Every file-upload refusal is audited (ids and reasons only); the import's pre-check refusal is the existing 409 of the consultation rule.
    expect((await audits('thermal.capture_refused')).map((x) => [x.outcome, x.details.captureSource, x.details.encounterId, x.details.reason, x.details.atStore ?? false])).toEqual([
      ['denied', 'file_upload', c.id, 'encounter_not_in_progress', true],
      ['denied', 'file_upload', a.id, 'encounter_not_in_progress', false],
      ['denied', 'file_upload', a.id, 'encounter_not_in_progress', false],
      ['denied', 'file_upload', b.id, 'encounter_not_in_progress', false],
    ])
  })

  it('a consent withdrawn while the image is processed: nothing is stored, the bytes are removed, and consent.blocked is audited at store time', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const consentId = (await adminQuery("SELECT id FROM consents WHERE patient_id = $1 AND type = 'thermal_imaging'", [p.id])).rows[0].id as string
    const before = storedFiles()
    whileProcessing = async () => {
      expect((await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${consentId}/withdraw`, { cookie: nurse, body: { reason: 'Changed mind' } })).statusCode).toBe(200)
    }
    const res = await upload(p.id, live(e.id, { capturedAt: new Date().toISOString() }))
    whileProcessing = null
    expect([res.statusCode, res.json().error]).toEqual([409, 'consent_withdrawn'])
    expect(res.json().message).toMatch(/Nothing was stored\.$/)
    expect(storedFiles()).toEqual(before)
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect(await audits('thermal.upload')).toEqual([])
    // The up-front check passed; the refusal is the one made where the image is stored.
    expect(await audits('consent.blocked')).toEqual([{ outcome: 'denied', details: { type: 'thermal_imaging', purpose: 'thermal image', code: 'consent_withdrawn', atStore: true } }])
  })
})

describe.skipIf(!haveThermal)('V6 thermal simulator: SIMULATED captures', () => {
  it('in a synthetic deployment the doctor makes a simulated capture: stored as simulator, simulated, synthetic, with the generated numbers exactly', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const res = await simulate(p.id, { case: 'missing_data', seed: 7, encounterId: e.id })
    expect(res.statusCode, res.body).toBe(201)
    const c = ThermalCapture.parse(res.json())
    const m = simulateThermalMatrix('missing_data', 7)
    const s = thermalStats(m)
    expect(c).toMatchObject({
      captureSource: 'simulator',
      simulated: true,
      dataOrigin: 'synthetic',
      encounterId: e.id,
      visibleFileId: null,
      device: null,
      deviceReported: null,
      capturedAt: null,
      width: THERMAL_SIM_SIZE.width,
      height: THERMAL_SIM_SIZE.height,
      minC: s.minC,
      maxC: s.maxC,
      meanC: s.meanC,
      stdC: s.stdC,
      extractor: { name: 'thermal-sim', version: THERMAL_SIM_VERSION },
      camera: { make: null, dateTime: null },
      protocol: { bodySite: 'hand', view: 'dorsal' },
    })
    expect(c.camera.model).toMatch(/SIMULATED/)
    expect(Object.values(c.parameters).every((v) => v === null)).toBe(true)
    // The matrix is the generated one, byte for byte, with no reading (NaN) where the case has none.
    const matrix = await call(ctx.app, 'GET', `/api/files/${c.matrixFileId}`, { cookie: doctor })
    expect(matrix.rawPayload.equals(f32le(m))).toBe(true)
    expect(Number.isNaN(matrix.rawPayload.readFloatLE((20 * THERMAL_SIM_SIZE.width + 30) * 4))).toBe(true)
    // Its "original" is what it was generated from.
    const raw = await call(ctx.app, 'GET', `/api/files/${c.rawFileId}`, { cookie: doctor })
    expect(raw.headers['content-type']).toBe('application/json')
    expect(raw.json()).toEqual({ simulator: THERMAL_SIM_VERSION, case: 'missing_data', seed: 7, width: 160, height: 120 })
    expect(c.rawSha256).toBe(sha256(raw.rawPayload))
    // The same case and seed give the same numbers; another seed does not.
    const again = ThermalCapture.parse((await simulate(p.id, { case: 'missing_data', seed: 7, encounterId: e.id })).json())
    expect([again.minC, again.maxC, again.meanC, again.stdC]).toEqual([c.minC, c.maxC, c.meanC, c.stdC])
    const sums = (await adminQuery('SELECT c.id, f.sha256 FROM thermal_captures c JOIN files f ON f.id = c.matrix_file_id ORDER BY c.created_at')).rows
    expect(sums[0].sha256).toBe(sums[1].sha256)
    const other = ThermalCapture.parse((await simulate(p.id, { case: 'missing_data', seed: 8, encounterId: e.id })).json())
    expect(other.meanC === c.meanC && other.stdC === c.stdC && other.maxC === c.maxC).toBe(false)
    expect((await adminQuery('SELECT DISTINCT capture_source, simulated, data_origin FROM thermal_captures')).rows).toEqual([{ capture_source: 'simulator', simulated: true, data_origin: 'synthetic' }])
    expect((await audits('thermal.upload'))[0]!.details).toMatchObject({ captureSource: 'simulator', simulated: true, case: 'missing_data', seed: 7, encounterId: e.id, dataOrigin: 'synthetic', sha256: c.rawSha256 })
    // Experimental flags work on a matrix with missing readings.
    expect((await call(ctx.app, 'GET', `/api/thermal/${c.id}/flags`, { cookie: doctor })).statusCode).toBe(200)
  })

  it('the analysis dashboard’s demo indices are fixed formulas over the stored temperatures, labelled not clinically validated, the same every time, and audited', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const c = ThermalCapture.parse((await simulate(p.id, { case: 'localized_difference', seed: 3, encounterId: e.id })).json())
    const res = await call(ctx.app, 'GET', `/api/thermal/${c.id}/analysis`, { cookie: doctor })
    expect(res.statusCode, res.body).toBe(200)
    const a = res.json()
    expect(a.engine).toEqual({ name: 'adaxai-thermal-demo-indices', version: '1', validated: false, label: DEMO_ANALYSIS_LABEL })
    expect(a.indices.map((i: { key: string }) => i.key)).toEqual(['pain_pattern', 'thermal_asymmetry', 'perfusion_pattern', 'temperature_pattern', 'thermal_stress'])
    for (const i of a.indices) expect(i.score >= 0 && i.score <= 100 && Number.isInteger(i.score), i.key).toBe(true)
    // Exactly the formulas over the generated matrix (what was stored), and the same on a second read.
    expect(a).toEqual(demoThermalAnalysis.analyse({ width: c.width, height: c.height, matrix: simulateThermalMatrix('localized_difference', 3), simulated: true }))
    expect((await call(ctx.app, 'GET', `/api/thermal/${c.id}/analysis`, { cookie: doctor })).json()).toEqual(a)
    expect(a.summary.join(' ')).toMatch(/SIMULATED thermal image/)
    expect(a.summary.join(' ')).toMatch(/do not by themselves establish any clinical finding or diagnosis/)
    expect((await audits('thermal.analysis_read')).map((x) => x.details)).toEqual([
      { engine: 'adaxai-thermal-demo-indices', version: '1', simulated: true },
      { engine: 'adaxai-thermal-demo-indices', version: '1', simulated: true },
    ])
    expect((await call(ctx.app, 'GET', '/api/thermal/00000000-0000-4000-8000-000000000000/analysis', { cookie: doctor })).statusCode).toBe(404)
  })

  it('an ordinary PNG/JPEG is analysed only as a DEMO: simulated values from its colours, stored as simulated with the image kept, labelled, audited; the real upload still refuses it', async () => {
    const p = await patient()
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
    // PATH A is unchanged: the real extraction refuses a file without radiometric data, and nothing is stored.
    expect((await upload(p.id, {}, doctor, png)).statusCode).toBe(422)
    expect(await count('thermal_captures')).toBe(0)
    const width = 16
    const height = 12
    // What the browser sends: the image's colours as "heat" values (contracts demoImageHeat); here a warmer right half.
    const heat = Buffer.from(Array.from({ length: width * height }, (_, i) => (i % width < width / 2 ? 150 : 200)))
    const demo = (fields: Record<string, string>, data = png, cookie = doctor, app = ctx.app) => {
      const m = multipart({ protocol: JSON.stringify(simProtocol), gridWidth: String(width), gridHeight: String(height), grid: heat.toString('base64'), ...fields }, { name: 'photo.png', type: 'image/png', data })
      return app.inject({ method: 'POST', url: `/api/patients/${p.id}/thermal/demo-image`, headers: { ...m.headers, cookie, 'x-adaxai-csrf': '1' }, payload: m.payload })
    }
    // Not a PNG or JPEG, or a grid that does not match its size: refused, nothing stored.
    expect((await demo({}, Buffer.from('not an image at all'))).json().issues[0]).toMatchObject({ path: 'file' })
    expect((await demo({ gridWidth: '15' })).json().issues[0]).toMatchObject({ path: 'grid' })
    expect(await count('thermal_captures')).toBe(0)

    const res = await demo({})
    expect(res.statusCode, res.body).toBe(201)
    const c = ThermalCapture.parse(res.json())
    expect([c.captureSource, c.simulated, c.dataOrigin, c.extractor.name, c.width, c.height, c.encounterId]).toEqual(['simulator', true, 'synthetic', THERMAL_DEMO_IMAGE_EXTRACTOR, width, height, null])
    // The picture itself is the original (the dashboard shows it), with its own type.
    const raw = await call(ctx.app, 'GET', `/api/files/${c.rawFileId}`, { cookie: doctor })
    expect([raw.statusCode, raw.headers['content-type']]).toEqual([200, 'image/png'])
    expect(raw.rawPayload.equals(png)).toBe(true)
    const a = (await call(ctx.app, 'GET', `/api/thermal/${c.id}/analysis`, { cookie: doctor })).json()
    expect(a).toEqual(demoThermalAnalysis.analyse({ width, height, matrix: Float32Array.from(heat, demoImageHeatToC), simulated: true, demoImage: true }))
    expect([a.demoImage, a.engine.label, a.engine.validated]).toEqual([true, DEMO_ANALYSIS_LABEL, false])
    expect(a.summary[0]).toMatch(/has no temperature data, so its values were simulated/)
    // Never called a measured temperature.
    expect(JSON.stringify([a.indices, a.summary])).not.toMatch(/°C/)
    expect((await audits('thermal.upload')).map((x) => x.details)).toEqual([expect.objectContaining({ captureSource: 'simulator', simulated: true, demoImage: true, extractor: THERMAL_DEMO_IMAGE_EXTRACTOR, dataOrigin: 'synthetic', sha256: sha256(png) })])
    expect((await audits('thermal.analysis_read')).map((x) => x.details)).toEqual([{ engine: 'adaxai-thermal-demo-indices', version: '1', simulated: true, demoImage: true }])

    // Filed under this patient's consultation in progress when one is named; never another patient's.
    const e = await consultation(p.id)
    expect(ThermalCapture.parse((await demo({ encounterId: e.id })).json()).encounterId).toBe(e.id)
    const e2 = await consultation((await patient()).id)
    expect((await demo({ encounterId: e2.id })).json().issues[0]).toMatchObject({ path: 'encounterId' })
    // Only where the simulator is: refused where the data is clinical (audited).
    const clinical = createTestApp({ config: { ...testConfig, dataOrigin: 'clinical' }, thermal: httpThermalService(serviceUrl), settings: generous })
    try {
      const r = await demo({}, png, await login(clinical.app, 't.doctor'), clinical.app)
      expect([r.statusCode, r.json().error]).toEqual([403, 'simulator_not_allowed'])
    } finally {
      await clinical.close()
    }
    expect(await count('thermal_captures')).toBe(2)
  })

  it('is refused where the data is clinical (403, audited), and nothing is stored', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const clinical = createTestApp({ config: { ...testConfig, dataOrigin: 'clinical' }, thermal: httpThermalService(serviceUrl), settings: generous })
    try {
      const res = await simulate(p.id, { encounterId: e.id }, await login(clinical.app, 't.doctor'), clinical.app)
      expect([res.statusCode, res.json().error]).toEqual([403, 'simulator_not_allowed'])
    } finally {
      await clinical.close()
    }
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect((await audits('thermal.capture_refused')).map((a) => [a.outcome, a.details.reason])).toEqual([['denied', 'simulator_not_allowed']])
  })

  it('the invalid capture and processing failure cases store nothing, say SIMULATED, and are audited', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const invalid = await simulate(p.id, { case: 'invalid_capture', seed: 1, encounterId: e.id })
    expect([invalid.statusCode, invalid.json().error]).toEqual([422, 'thermal_invalid'])
    expect(invalid.json().message).toMatch(/^Invalid capture \(SIMULATED\): /)
    const failed = await simulate(p.id, { case: 'processing_failure', seed: 1, encounterId: e.id })
    expect([failed.statusCode, failed.json().error]).toEqual([502, 'thermal_processing_failed'])
    expect(failed.json().message).toMatch(/^Processing failed \(SIMULATED\): /)
    expect(await count('thermal_captures')).toBe(0)
    expect(await count('files')).toBe(0)
    expect((await audits('thermal.capture_refused')).map((a) => [a.details.captureSource, a.details.case, a.details.reason])).toEqual([
      ['simulator', 'invalid_capture', 'thermal_invalid'],
      ['simulator', 'processing_failure', 'thermal_processing_failed'],
    ])
    // A camera state is not a capture case.
    expect((await simulate(p.id, { case: 'disconnected', encounterId: e.id })).statusCode).toBe(400)
  })

  it('needs the doctor’s own consultation in progress and the patient’s consent, like a live capture', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    expect((await simulate(p.id, {})).statusCode).toBe(400)
    expect((await simulate(p.id, { encounterId: e.id }, doctor2)).statusCode).toBe(403)
    expect((await simulate(p.id, { encounterId: e.id }, nurse)).statusCode).toBe(403)
    expect((await simulate(p.id, { encounterId: e.id }, admin)).statusCode).toBe(403)
    const unconsented = await patient([])
    const ue = await consultation(unconsented.id)
    expect((await simulate(unconsented.id, { encounterId: ue.id })).json().error).toBe('consent_required')
    expect(await count('thermal_captures')).toBe(0)
  })

  it('a simulated capture can be reviewed, but never reaches the patient portal, the assistant’s record context or a dataset export', async () => {
    const p = await patient(['thermal_imaging', 'research_use', 'portal_access'])
    const e = await consultation(p.id)
    const real = ThermalCapture.parse((await upload(p.id)).json())
    const sim = ThermalCapture.parse((await simulate(p.id, { encounterId: e.id })).json())
    for (const c of [real, sim]) expect((await call(ctx.app, 'POST', `/api/thermal/${c.id}/review`, { cookie: doctor, body: { decision: 'approved' } })).json().status).toBe('approved')
    // A label on the simulated capture is allowed (a demonstration) and counts nowhere.
    expect((await call(ctx.app, 'POST', `/api/thermal/${sim.id}/labels`, { cookie: doctor, body: { scope: 'capture', code: 'no_significant_finding', referenceStandard: 'clinical_impression', certainty: 'certain' } })).statusCode).toBe(201)

    // The patient portal.
    const code = (await call(ctx.app, 'POST', `/api/patients/${p.id}/portal-activation`, { cookie: nurse })).json().activationCode
    const act = await call(ctx.app, 'POST', '/api/auth/activate', { body: { mrn: p.mrn, activationCode: code, password: 'Thermal-passphrase-1' } })
    expect(act.statusCode).toBe(201)
    const portal = `adaxai_session=${act.cookies.find((x) => x.name === 'adaxai_session')!.value}`
    expect((await call(ctx.app, 'GET', '/api/portal/thermal', { cookie: portal })).json().reports.map((r: { id: string }) => r.id)).toEqual([real.id])

    // The older assistant's record context.
    const row = (await ctx.db.query.encounters.findFirst({ where: (t, { eq }) => eq(t.id, e.id) }))!
    const context = await buildPatientContext(ctx.db, row, { priorEncounters: 5, observationDays: 30 })
    expect(context.items.filter((i) => i.sourceType === 'thermal_capture').map((i) => i.sourceId)).toEqual([real.id])

    // The dataset summary and export.
    const summary = (await call(ctx.app, 'GET', '/api/thermal-data/summary', { cookie: admin })).json()
    expect(summary).toMatchObject({ captures: { draft: 0, approved: 1, rejected: 0 }, approvedWithResearchConsent: 1, labelledCaptures: 0, activeLabels: 0, dataOrigins: { public_sample: 1 }, simulatedExcluded: 1 })
    const res = await call(ctx.app, 'POST', '/api/thermal-data/exports', { cookie: admin })
    expect(res.statusCode).toBe(201)
    expect(res.json().summary).toEqual({ captures: 1, subjects: 1, labelledCaptures: 0, dataOrigins: { public_sample: 1 }, excludedNoResearchConsent: 0, simulatedExcluded: 1 })
    const exp = ThermalDatasetExport.parse(res.json())
    expect((await adminQuery('SELECT entity_id FROM dataset_memberships WHERE export_id = $1', [exp.id])).rows.map((r) => r.entity_id)).toEqual([real.id])
  })
})

describe.skipIf(!haveThermal)('V6 polygon regions', () => {
  // An L-shape with corners on whole pixels: no pixel centre lies on an edge, so the mask is exactly columns 10-29 of rows 10-19 and columns
  // 10-19 of rows 20-39 (400 pixels).
  const L = [
    [10, 10],
    [30, 10],
    [30, 20],
    [20, 20],
    [20, 40],
    [10, 40],
  ]
  const lPixels = () => {
    const out: [number, number][] = []
    for (let y = 10; y < 40; y++) for (let x = 10; x < (y < 20 ? 30 : 20); x++) out.push([x, y])
    return out
  }

  it('statistics over a polygon match a mask worked out by hand on a simulated matrix; the box comes from the points', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const c = ThermalCapture.parse((await simulate(p.id, { case: 'localized_difference', seed: 3, encounterId: e.id })).json())
    const m = simulateThermalMatrix('localized_difference', 3)
    const values = lPixels().map(([x, y]) => m[y * THERMAL_SIM_SIZE.width + x]!)
    const mean = values.reduce((a, v) => a + v, 0) / values.length
    const std = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
    const round2 = (v: number) => Math.round(v * 100) / 100

    const rois = [
      // The box sent is wrong on purpose: the server works it out from the points.
      { label: 'Back of hand', shape: 'polygon', x: 0, y: 0, width: 1, height: 1, points: L, note: 'Drawn around the warm area', pairWith: 'Box' },
      { label: 'Box', shape: 'rect', x: 100, y: 50, width: 10, height: 10 },
    ]
    const res = await call(ctx.app, 'PUT', `/api/thermal/${c.id}/rois`, { cookie: doctor, body: { rois } })
    expect(res.statusCode, res.body).toBe(200)
    const saved = ThermalCapture.parse(res.json())
    const poly = saved.rois[0]!
    expect(poly).toMatchObject({ shape: 'polygon', points: L, x: 10, y: 10, width: 20, height: 30, note: 'Drawn around the warm area', createdByName: 'Test t.doctor' })
    expect(poly.stats.pixelCount).toBe(400)
    expect(poly.stats.min).toBe(round2(Math.min(...values)))
    expect(poly.stats.max).toBe(round2(Math.max(...values)))
    expect(Math.abs(poly.stats.mean! - mean)).toBeLessThan(0.006)
    expect(Math.abs(poly.stats.std! - std)).toBeLessThan(0.006)
    expect(saved.rois[1]!.stats.pixelCount).toBe(100)
    expect(saved.pairs[0]).toMatchObject({ a: 'Back of hand', b: 'Box' })
    expect((await adminQuery('SELECT shape, points, note FROM thermal_rois WHERE label = $1', ['Back of hand'])).rows[0]).toEqual({ shape: 'polygon', points: L, note: 'Drawn around the warm area' })

    // Saved again unchanged, a region keeps its id, author and time; a changed one is a new region.
    const again = ThermalCapture.parse((await call(ctx.app, 'PUT', `/api/thermal/${c.id}/rois`, { cookie: nurse, body: { rois } })).json())
    expect(again.rois.map((r) => [r.id, r.createdAt, r.createdByName])).toEqual(saved.rois.map((r) => [r.id, r.createdAt, r.createdByName]))
    const moved = ThermalCapture.parse((await call(ctx.app, 'PUT', `/api/thermal/${c.id}/rois`, { cookie: nurse, body: { rois: [rois[0], { ...rois[1], x: 101 }] } })).json())
    expect(moved.rois[0]!.id).toBe(saved.rois[0]!.id)
    expect(moved.rois[1]!.id).not.toBe(saved.rois[1]!.id)
    expect(moved.rois[1]!.createdByName).toBe('Test t.nurse')

    // A polygon outside the image, one without area, and points on a shape that is not a polygon are refused.
    const put = (r: object) => call(ctx.app, 'PUT', `/api/thermal/${c.id}/rois`, { cookie: doctor, body: { rois: [r] } })
    expect((await put({ label: 'Out', shape: 'polygon', x: 0, y: 0, width: 1, height: 1, points: [[150, 0], [170, 0], [160, 10]] })).statusCode).toBe(400)
    expect((await put({ label: 'Flat', shape: 'polygon', x: 0, y: 0, width: 1, height: 1, points: [[0, 0], [5, 5], [10, 10]] })).statusCode).toBe(400)
    expect((await put({ label: 'Rect', shape: 'rect', x: 0, y: 0, width: 5, height: 5, points: [[0, 0], [5, 0], [5, 5]] })).statusCode).toBe(400)
    expect((await put({ label: 'Poly', shape: 'polygon', x: 0, y: 0, width: 5, height: 5 })).statusCode).toBe(400)
  })

  it('pixels without a reading are left out of a region’s statistics', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    const c = ThermalCapture.parse((await simulate(p.id, { case: 'missing_data', seed: 5, encounterId: e.id })).json())
    // The case has no reading in columns 20-49 of rows 15-39.
    const rois = [
      { label: 'Hole', shape: 'rect', x: 25, y: 20, width: 10, height: 10 },
      { label: 'Edge', shape: 'polygon', x: 0, y: 0, width: 1, height: 1, points: [[15, 10], [25, 10], [25, 20], [15, 20]] },
    ]
    const saved = ThermalCapture.parse((await call(ctx.app, 'PUT', `/api/thermal/${c.id}/rois`, { cookie: doctor, body: { rois } })).json())
    expect(saved.rois[0]!.stats).toEqual({ pixelCount: 0, min: null, max: null, mean: null, std: null })
    expect(saved.rois[1]!.stats.pixelCount).toBe(100 - 25)
  })
})

describe.skipIf(!haveThermal)('V6 model status and the audit log', () => {
  it('says that no thermal model is installed, and says so too when the thermal service cannot be reached', async () => {
    const res = await call(ctx.app, 'GET', '/api/thermal/model-status', { cookie: nurse })
    expect(res.statusCode).toBe(200)
    expect(ThermalModelStatus.parse(res.json())).toEqual({ available: false, kind: null, modelId: null, version: null, artifactSha256: null, intendedUse: null, evaluation: null, reason: 'No trained thermal model is installed.' })
    expect((await call(ctx.app, 'GET', '/api/thermal/model-status', { cookie: admin })).statusCode).toBe(403)
    const down = createTestApp({ thermal: httpThermalService(`http://127.0.0.1:${await closedPort()}`), settings: generous })
    try {
      const status = ThermalModelStatus.parse((await call(down.app, 'GET', '/api/thermal/model-status', { cookie: await login(down.app, 't.doctor') })).json())
      expect(status.available).toBe(false)
      expect(status.modelId).toBeNull()
      expect(status.reason).toMatch(/could not be reached/)
    } finally {
      await down.close()
    }
  })

  it('thermal audit events carry provenance and checksums, never image bytes', async () => {
    const p = await patient()
    const e = await consultation(p.id)
    await upload(p.id, live(e.id, { deviceReported: JSON.stringify(reported('TC-9')) }))
    await simulate(p.id, { encounterId: e.id })
    await simulate(p.id, { case: 'invalid_capture', encounterId: e.id })
    const rows = (await adminQuery("SELECT action, details FROM audit_events WHERE action LIKE 'thermal.%' ORDER BY id")).rows as { action: string; details: object }[]
    expect(rows.map((r) => r.action)).toEqual(['thermal.upload', 'thermal.upload', 'thermal.capture_refused'])
    const text = JSON.stringify(rows)
    expect(text.length).toBeLessThan(3000)
    expect(text).not.toContain(SAMPLE.subarray(0, 60).toString('base64'))
    expect(text).not.toContain(SAMPLE.subarray(1000, 1060).toString('base64'))
    expect(text).not.toContain('TC-9')
  })
})
