import { Device, PatientDetail, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient } from './helpers.ts'

// Device integration BOUNDARY tests. No physical device is involved: the
// readings below are test payloads exercising the gateway API contract.
const ctx = createTestApp()
let fx: Fixture
let admin = ''
let nurse = ''
afterAll(() => ctx.close())
beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  admin = await login(ctx.app, 't.admin')
  nurse = await login(ctx.app, 't.nurse')
})

const ingest = (token: string | null, body: unknown) =>
  ctx.app.inject({ method: 'POST', url: '/api/device-ingest/readings', headers: { 'x-adaxai-csrf': '1', ...(token && { authorization: `Bearer ${token}` }) }, payload: body as object })
const reading = (over: object = {}) => ({ measuredAt: new Date().toISOString(), readings: [{ kind: 'heart_rate', value: 72 }, { kind: 'spo2', value: 97 }], ...over })

async function band(integration = 'gateway_api') {
  const res = await call(ctx.app, 'POST', '/api/admin/devices', { cookie: admin, body: { kind: 'wearable_band', label: 'Band 1', manufacturer: 'Unknown (not tested)', serialNumber: `SN-${crypto.randomUUID().slice(0, 8)}`, integration } })
  expect(res.statusCode).toBe(201)
  return Device.parse(res.json())
}
let seq = 0
async function patient(consents: string[] = ['device_monitoring']) {
  seq++
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ givenName: `Device${'abcdefghij'[seq % 10]}`, phone: `98400 3333${seq % 10}` }) })).json())
  for (const type of consents) await call(ctx.app, 'POST', `/api/patients/${p.id}/consents`, { cookie: nurse, body: { type, method: 'verbal' } })
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
  return { p, v }
}

describe('device registry and assignment', () => {
  it('admins register devices; staff assign them to consenting patients, one patient at a time', async () => {
    expect((await call(ctx.app, 'POST', '/api/admin/devices', { cookie: nurse, body: { kind: 'wearable_band', label: 'x', serialNumber: 'y' } })).statusCode).toBe(403)
    const d = await band()
    expect(d).toMatchObject({ status: 'active', integration: 'gateway_api', hasToken: false, assignment: null })
    expect((await call(ctx.app, 'POST', '/api/admin/devices', { cookie: admin, body: { kind: 'wearable_band', label: 'dup', serialNumber: d.serialNumber } })).json().error).toBe('serial_taken')

    const none = await patient([])
    expect((await call(ctx.app, 'POST', `/api/devices/${d.id}/assignments`, { cookie: nurse, body: { patientId: none.p.id } })).json().error).toBe('consent_required')
    const { p, v } = await patient()
    const assigned = Device.parse((await call(ctx.app, 'POST', `/api/devices/${d.id}/assignments`, { cookie: nurse, body: { patientId: p.id, visitId: v.id } })).json())
    expect(assigned.assignment).toMatchObject({ patientId: p.id, assignedByName: 'Test t.nurse' })
    const other = await patient()
    expect((await call(ctx.app, 'POST', `/api/devices/${d.id}/assignments`, { cookie: nurse, body: { patientId: other.p.id } })).json().error).toBe('device_assigned')
    expect((await call(ctx.app, 'PATCH', `/api/admin/devices/${d.id}`, { cookie: admin, body: { status: 'retired' } })).json().error).toBe('device_assigned')

    const ended = await call(ctx.app, 'POST', `/api/device-assignments/${assigned.assignment!.id}/end`, { cookie: nurse, body: { reason: 'Discharged' } })
    expect(Device.parse(ended.json()).assignment).toBeNull()
    await expect(ctx.pool.query('UPDATE device_assignments SET patient_id = $1', [other.p.id])).rejects.toMatchObject({ code: '42501' })
    await expect(ctx.pool.query('DELETE FROM device_assignments')).rejects.toMatchObject({ code: '42501' })
    expect((await call(ctx.app, 'GET', '/api/devices', { cookie: admin })).statusCode).toBe(200)
  })
})

describe('gateway ingestion boundary', () => {
  it('stores readings only from an active, assigned, token-holding device, as unverified device data', async () => {
    const d = await band()
    const manual = await band('manual_upload')
    expect((await call(ctx.app, 'POST', `/api/admin/devices/${manual.id}/token`, { cookie: admin })).json().error).toBe('device_not_gateway')
    const { token } = (await call(ctx.app, 'POST', `/api/admin/devices/${d.id}/token`, { cookie: admin })).json()
    expect(token).toMatch(/^adxdev_/)
    expect(JSON.stringify((await adminQuery('SELECT ingest_token_hash FROM devices WHERE id = $1', [d.id])).rows)).not.toContain(token)

    expect((await ingest(null, reading())).statusCode).toBe(401)
    expect((await ingest('adxdev_wrong', reading())).statusCode).toBe(401)
    expect((await ingest(token, reading())).json().error).toBe('outside_assignment')

    const { p, v } = await patient()
    await call(ctx.app, 'POST', `/api/devices/${d.id}/assignments`, { cookie: nurse, body: { patientId: p.id, visitId: v.id } })
    expect((await ingest(token, reading({ readings: [{ kind: 'heart_rate', value: 900 }] }))).statusCode).toBe(400)
    expect((await ingest(token, reading({ measuredAt: new Date(Date.now() + 3_600_000).toISOString() }))).statusCode).toBe(400)
    const ok = await ingest(token, reading())
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ stored: 2, duplicate: false, validationStatus: 'device_unverified' })

    const obs = (await call(ctx.app, 'GET', `/api/patients/${p.id}/observations`, { cookie: nurse })).json()
    const list = (obs.observations ?? obs) as { source: string; validationStatus: string; kind: string }[]
    expect(list.filter((o) => o.source === 'device').map((o) => [o.kind, o.validationStatus]).sort()).toEqual([
      ['heart_rate', 'device_unverified'],
      ['spo2', 'device_unverified'],
    ])
    const { rows } = await adminQuery("SELECT actor_role, outcome FROM audit_events WHERE action = 'device.ingest' ORDER BY occurred_at")
    expect(rows).toContainEqual({ actor_role: 'device', outcome: 'success' })
    expect(rows).toContainEqual({ actor_role: 'device', outcome: 'denied' })

    // Admins manage devices but do not see who wears them; staff do. Device list reads are audited.
    const adminView = (await call(ctx.app, 'GET', '/api/devices', { cookie: admin })).json().devices.find((x: { id: string }) => x.id === d.id)
    expect(adminView.assignment).toMatchObject({ patientId: null, patientName: null, mrn: null })
    const staffView = (await call(ctx.app, 'GET', '/api/devices', { cookie: nurse })).json().devices.find((x: { id: string }) => x.id === d.id)
    expect(staffView.assignment).toMatchObject({ patientId: p.id, mrn: p.mrn })
    const listReads = (await adminQuery("SELECT details FROM audit_events WHERE action = 'device.list_read' ORDER BY id")).rows
    expect(listReads.at(-1).details.patientIds).toEqual([p.id])

    // Consent withdrawn: the assignment ends at once and nothing more is stored.
    const c = PatientDetail.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}`, { cookie: nurse })).json()).consents.find((x) => x.type === 'device_monitoring')!
    await call(ctx.app, 'POST', `/api/patients/${p.id}/consents/${c.id}/withdraw`, { cookie: nurse, body: { reason: 'Patient changed mind' } })
    expect((await adminQuery('SELECT end_reason FROM device_assignments WHERE ended_at IS NOT NULL')).rows).toEqual([{ end_reason: 'Consent to device readings withdrawn' }])
    expect((await ingest(token, reading())).json().error).toBe('outside_assignment')

    // Revoked token, and retired devices, cannot post.
    await call(ctx.app, 'DELETE', `/api/admin/devices/${d.id}/token`, { cookie: admin })
    expect((await ingest(token, reading())).statusCode).toBe(401)
  })
})

describe('stethoscope recordings (file upload)', () => {
  const WAV = Buffer.from('RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x40\x1f\0\0\x80\x3e\0\0\x02\0\x10\0data\0\0\0\0', 'binary')
  const upload = (patientId: string, cookie: string, file: { name: string; type: string; data: Buffer }, fields: Record<string, string> = { site: 'mitral' }) => {
    const boundary = '----steth'
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
    const payload = Buffer.concat([...parts, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`)])
    return ctx.app.inject({ method: 'POST', url: `/api/patients/${patientId}/auscultations`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie, 'x-adaxai-csrf': '1' }, payload })
  }

  it('needs consent; stores and plays back audio files with the auscultation site; others cannot reach them', async () => {
    const none = await patient([])
    expect((await upload(none.p.id, nurse, { name: 'a.wav', type: 'audio/wav', data: WAV })).json().error).toBe('consent_required')
    const { p } = await patient()
    const res = await upload(p.id, nurse, { name: 'heart.wav', type: 'audio/wav', data: WAV }, { site: 'mitral', note: 'Recorded with phone app export (synthetic test file)' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ site: 'mitral', mimeType: 'audio/wav', device: null, dataOrigin: 'synthetic' })
    const doctor = await login(ctx.app, 't.doctor')
    const play = await call(ctx.app, 'GET', `/api/files/${res.json().fileId}`, { cookie: doctor })
    expect(play.statusCode).toBe(200)
    expect(play.headers['content-type']).toBe('audio/wav')
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/auscultations`, { cookie: doctor })).json().recordings).toHaveLength(1)
    expect((await upload(p.id, nurse, { name: 'x.txt', type: 'text/plain', data: Buffer.from('hello') })).statusCode).toBe(400)
    expect((await upload(p.id, nurse, { name: 'a.wav', type: 'audio/wav', data: WAV }, { site: 'knee' })).statusCode).toBe(400)
    expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/auscultations`, { cookie: admin })).statusCode).toBe(403)
    await expect(ctx.pool.query('DELETE FROM auscultation_recordings')).rejects.toMatchObject({ code: '42501' })
  })
})
