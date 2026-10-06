import crypto from 'node:crypto'
import { Encounter, PatientDetail, ServiceCatalogue, ServiceOrder, ServiceOrderList, SIMULATED_LAB_REPORT_TEXT, SIMULATED_REPORT_TEXT, Visit } from '@adaxai/contracts'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../src/auth/password.ts'
import { facilities, users } from '../src/db/schema.ts'
import { SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS } from '../src/service-orders/routes.ts'
import { loadAppSettings } from '../src/settings/load.ts'
import type { AppSettings } from '../src/settings/schema.ts'
import { adminQuery, call, createFixture, createTestApp, type Fixture, login, resetDatabase, samplePatient, testConfig } from './helpers.ts'

/**
 * Service orders (Doctor HERO final, DESIGN §5.4/§5.6/§6, spec 17C-17E): the consultation's own doctor orders from the configured catalogue;
 * doctors and nurses read; only the doctor who placed an order cancels it while it is open. No laboratory is connected: the simulated
 * provider moves every order on a fixed schedule from its request, applied when the orders are read, each step stored once at the time the
 * schedule gives (never the time of the read), and it never writes an investigation result. Time is the routes' injected clock.
 */

const T0 = Date.parse('2026-10-06T04:00:00.000Z')
let nowMs = T0
const at = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

const settings: AppSettings = {
  ...loadAppSettings(),
  serviceOrders: {
    provider: 'simulated',
    inProgressAfterMinutes: 1,
    catalogue: [
      { code: 'CBC', name: 'Complete blood count (CBC)', category: 'lab', turnaroundMinutes: 30 },
      { code: 'XRAY-CHEST', name: 'Chest X-ray (PA view)', category: 'imaging', turnaroundMinutes: 45 },
      { code: 'ECG', name: '12-lead ECG', category: 'other', turnaroundMinutes: 15 },
    ],
  },
}

const ctx = createTestApp({ settings, clock: () => nowMs })
let fx: Fixture
let doctor: string
let doctor2: string
let nurse: string
let admin: string
beforeEach(async () => {
  await resetDatabase()
  fx = await createFixture(ctx.db)
  nowMs = T0
  ;[doctor, doctor2, nurse, admin] = await Promise.all([login(ctx.app, 't.doctor'), login(ctx.app, 't.doctor2'), login(ctx.app, 't.nurse'), login(ctx.app, 't.admin')])
})
afterAll(() => ctx.close())

/** A patient with a visit and the doctor's consultation in progress. */
async function consultation() {
  const p = PatientDetail.parse((await call(ctx.app, 'POST', '/api/patients', { cookie: nurse, body: samplePatient({ phone: `98${crypto.randomInt(10_000_000, 99_999_999)}`, confirmNotDuplicate: true }) })).json())
  const v = Visit.parse((await call(ctx.app, 'POST', '/api/visits', { cookie: nurse, body: { patientId: p.id, departmentId: fx.departments.gen } })).json())
  const e = Encounter.parse((await call(ctx.app, 'POST', `/api/visits/${v.id}/encounter`, { cookie: doctor })).json())
  const sign = async () => {
    const saved = Encounter.parse((await call(ctx.app, 'PUT', `/api/encounters/${e.id}/draft`, { cookie: doctor, body: { version: e.version, note: { ...e.note, chiefComplaint: 'Fever', assessment: 'Viral fever', plan: 'Fluids' }, diagnoses: [{ description: 'Viral fever', kind: 'provisional' }], prescription: [] } })).json())
    expect((await call(ctx.app, 'POST', `/api/encounters/${e.id}/sign`, { cookie: doctor, body: { version: saved.version, attestation: true } })).statusCode).toBe(200)
  }
  return { p, v, e, sign }
}

const order = (encounterId: string, body: Record<string, unknown>, cookie = doctor) => call(ctx.app, 'POST', `/api/encounters/${encounterId}/service-orders`, { cookie, body })
const place = async (encounterId: string, serviceCode: string, extra: Record<string, unknown> = {}) => {
  const res = await order(encounterId, { serviceCode, ...extra })
  expect([serviceCode, res.statusCode]).toEqual([serviceCode, 201])
  return ServiceOrder.parse(res.json())
}
const listFor = async (encounterId: string, cookie = doctor) => {
  const res = await call(ctx.app, 'GET', `/api/encounters/${encounterId}/service-orders`, { cookie })
  expect(res.statusCode).toBe(200)
  return ServiceOrderList.parse(res.json()).orders
}
const statusOf = async (encounterId: string) => Object.fromEntries((await listFor(encounterId)).map((o) => [o.serviceCode, o.status]))
const cancel = (orderId: string, cookie = doctor, body: Record<string, unknown> = {}) => call(ctx.app, 'POST', `/api/service-orders/${orderId}/cancel`, { cookie, body })
const events = async (orderId: string) =>
  (await adminQuery('SELECT from_status, to_status, source, actor_user_id, at FROM service_order_events WHERE order_id = $1 ORDER BY id', [orderId])).rows.map(
    (r) => `${r.from_status ?? '-'}>${r.to_status}:${r.source}:${r.actor_user_id ? 'actor' : '-'}@${new Date(r.at as Date).toISOString()}`,
  )
const audits = async (action: string) => (await adminQuery('SELECT outcome, entity_type, entity_id, patient_id, details FROM audit_events WHERE action = $1 ORDER BY id', [action])).rows as { outcome: string; entity_type: string; entity_id: string; patient_id: string; details: Record<string, unknown> }[]

describe('the service catalogue', () => {
  it('doctors and nurses read the configured services, every one going to the simulated provider; others are refused', async () => {
    for (const cookie of [doctor, nurse]) {
      const res = await call(ctx.app, 'GET', '/api/service-catalogue', { cookie })
      expect(res.statusCode).toBe(200)
      const c = ServiceCatalogue.parse(res.json())
      expect(c).toMatchObject({ provider: 'simulated', simulated: true })
      expect(c.services.map((s) => [s.code, s.category, s.turnaroundMinutes, s.simulated])).toEqual([
        ['CBC', 'lab', 30, true],
        ['XRAY-CHEST', 'imaging', 45, true],
        ['ECG', 'other', 15, true],
      ])
    }
    expect((await call(ctx.app, 'GET', '/api/service-catalogue', { cookie: admin })).statusCode).toBe(403)
  })
})

describe('ordering a service', () => {
  it('the consultation’s own doctor orders from the catalogue: requested now, simulated, turnaround copied, part of the consultation', async () => {
    const { p, v, e } = await consultation()
    const res = await order(e.id, { serviceCode: 'CBC', note: '  Evaluate persistent fever  ' })
    expect(res.statusCode).toBe(201)
    const o = ServiceOrder.parse(res.json())
    expect(o).toMatchObject({
      patientId: p.id,
      encounterId: e.id,
      visitId: v.id,
      serviceCode: 'CBC',
      serviceName: 'Complete blood count (CBC)',
      category: 'lab',
      note: 'Evaluate persistent fever',
      status: 'requested',
      provider: 'simulated',
      simulated: true,
      requestedAt: at(T0),
      statusChangedAt: at(T0),
      completedAt: null,
      cancelledAt: null,
      reportText: null,
      orderedByName: 'Test t.doctor',
      canCancel: true,
    })
    const [row] = (await adminQuery('SELECT ordered_by, turnaround_minutes, data_origin, idempotency_key FROM service_orders WHERE id = $1', [o.id])).rows
    expect(row).toEqual({ ordered_by: fx.users.doctor, turnaround_minutes: 30, data_origin: p.dataOrigin === 'clinical' || p.dataOrigin === 'synthetic' ? p.dataOrigin : testConfig.dataOrigin, idempotency_key: null })
    expect(await events(o.id)).toEqual([`->requested:doctor:actor@${at(T0)}`])
    // The order is part of the consultation and of the patient's orders, for the doctor and the nurse.
    expect((await listFor(e.id)).map((x) => x.id)).toEqual([o.id])
    const nurseView = await listFor(e.id, nurse)
    expect(nurseView.map((x) => [x.id, x.canCancel])).toEqual([[o.id, false]])
    const byPatient = ServiceOrderList.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}/service-orders`, { cookie: nurse })).json()).orders
    expect(byPatient.map((x) => x.id)).toEqual([o.id])
  })

  it('refuses what is not in the catalogue, a long note, other doctors, nurses, and a consultation that is not in progress', async () => {
    const { e, sign } = await consultation()
    for (const body of [{ serviceCode: 'MRI-SPINE' }, { serviceCode: 'cbc' }, {}, { serviceCode: 'CBC', note: 'x'.repeat(501) }, { serviceCode: 'CBC', idempotencyKey: 'not-a-uuid' }]) {
      const res = await order(e.id, body)
      expect([body, res.statusCode]).toEqual([body, 400])
    }
    expect((await order(e.id, { serviceCode: 'MRI-SPINE' })).json().issues).toEqual([{ path: 'serviceCode', message: 'Choose a service from the list' }])
    expect((await order(e.id, { serviceCode: 'CBC' }, doctor2)).statusCode).toBe(403)
    expect((await order(e.id, { serviceCode: 'CBC' }, nurse)).statusCode).toBe(403)
    expect((await order(crypto.randomUUID(), { serviceCode: 'CBC' })).statusCode).toBe(404)
    await sign()
    const signed = await order(e.id, { serviceCode: 'CBC' })
    expect([signed.statusCode, signed.json().error]).toEqual([409, 'encounter_not_in_progress'])
    expect((await adminQuery('SELECT count(*)::int AS n FROM service_orders')).rows[0].n).toBe(0)
    // The other doctor's attempt is on the record as a refusal.
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action = 'access.denied' AND actor_user_id = $1", [fx.users.doctor2])).rows[0].n).toBe(1)
  })

  it('a paused draft (its visit back in the queue) and a discarded consultation take no orders, with or without a key', async () => {
    const paused = await consultation()
    // Data from before slice 3: the visit was moved back to the queue while the draft was open (as lifecycle.test does).
    await adminQuery(`SET session_replication_role = replica; UPDATE visits SET status = 'ready' WHERE id = '${paused.v.id}'`)
    for (const body of [{ serviceCode: 'CBC' }, { serviceCode: 'CBC', idempotencyKey: crypto.randomUUID() }]) {
      const res = await order(paused.e.id, body)
      expect([res.statusCode, res.json().error]).toEqual([409, 'visit_not_in_consultation'])
    }

    const discarded = await consultation()
    expect((await call(ctx.app, 'POST', `/api/encounters/${discarded.e.id}/discard`, { cookie: doctor, body: { version: discarded.e.version, reason: 'Opened by mistake' } })).statusCode).toBe(200)
    for (const body of [{ serviceCode: 'ECG' }, { serviceCode: 'ECG', idempotencyKey: crypto.randomUUID() }]) {
      const res = await order(discarded.e.id, body)
      expect([res.statusCode, res.json().error]).toEqual([409, 'encounter_not_in_progress'])
    }
    expect((await adminQuery('SELECT count(*)::int AS n FROM service_orders')).rows[0].n).toBe(0)
    expect(await audits('service_order.create')).toEqual([])
  })

  it('a repeated Send order with the same key gets the same order, also when both arrive at once; a key reused for another service is refused', async () => {
    const { e } = await consultation()
    const key = crypto.randomUUID()
    const first = await order(e.id, { serviceCode: 'CBC', idempotencyKey: key })
    const again = await order(e.id, { serviceCode: 'CBC', idempotencyKey: key })
    expect([first.statusCode, again.statusCode]).toEqual([201, 200])
    expect(again.json().id).toBe(first.json().id)
    const reused = await order(e.id, { serviceCode: 'ECG', idempotencyKey: key })
    expect([reused.statusCode, reused.json().error]).toEqual([409, 'idempotency_key_reused'])

    const together = crypto.randomUUID()
    const both = await Promise.all([order(e.id, { serviceCode: 'XRAY-CHEST', idempotencyKey: together }), order(e.id, { serviceCode: 'XRAY-CHEST', idempotencyKey: together })])
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(both[0]!.json().id).toBe(both[1]!.json().id)

    expect((await adminQuery('SELECT service_code, count(*)::int AS n FROM service_orders GROUP BY 1 ORDER BY 1')).rows).toEqual([
      { service_code: 'CBC', n: 1 },
      { service_code: 'XRAY-CHEST', n: 1 },
    ])
    expect((await audits('service_order.create')).length).toBe(2)
    expect((await audits('service_order.create_repeat')).length).toBe(2)
  })
})

describe('the simulated laboratory', () => {
  it('moves each order on its fixed schedule when read, storing each step once at the time the schedule gives, never the time of the read', async () => {
    const { p, e } = await consultation()
    const cbc = await place(e.id, 'CBC')
    const ecg = await place(e.id, 'ECG')
    nowMs = T0 + 5 * MIN
    const xray = await place(e.id, 'XRAY-CHEST')

    // Before a minute has passed for X-ray: requested; the others are in progress since exactly one minute after their request.
    nowMs = T0 + 6 * MIN - 1
    expect(await statusOf(e.id)).toEqual({ CBC: 'in_progress', ECG: 'in_progress', 'XRAY-CHEST': 'requested' })
    nowMs = T0 + 6 * MIN
    expect(await statusOf(e.id)).toEqual({ CBC: 'in_progress', ECG: 'in_progress', 'XRAY-CHEST': 'in_progress' })
    // Reading again at the same time changes nothing.
    const once = await events(cbc.id)
    expect((await listFor(e.id)).length).toBe(3)
    expect(await events(cbc.id)).toEqual(once)

    // ECG completes at exactly 15 minutes; the patient-wide read applies the step too.
    nowMs = T0 + 15 * MIN - 1
    expect(await statusOf(e.id)).toMatchObject({ ECG: 'in_progress' })
    nowMs = T0 + 15 * MIN
    const patientView = ServiceOrderList.parse((await call(ctx.app, 'GET', `/api/patients/${p.id}/service-orders`, { cookie: nurse })).json()).orders
    const ecgDone = patientView.find((o) => o.id === ecg.id)!
    expect(ecgDone).toMatchObject({ status: 'completed', completedAt: at(T0 + 15 * MIN), statusChangedAt: at(T0 + 15 * MIN), reportText: SIMULATED_REPORT_TEXT.other, canCancel: false })

    // Long after (no read in between): CBC and X-ray complete at their own times, not at the time of this read.
    nowMs = T0 + 10 * 60 * MIN
    const later = await listFor(e.id)
    // Newest first: X-ray (placed at five minutes), then the two placed at the start.
    expect(later[0]!.serviceCode).toBe('XRAY-CHEST')
    expect(Object.fromEntries(later.map((o) => [o.serviceCode, [o.status, o.completedAt, o.reportText]]))).toEqual({
      'XRAY-CHEST': ['completed', at(T0 + 50 * MIN), SIMULATED_REPORT_TEXT.imaging],
      ECG: ['completed', at(T0 + 15 * MIN), SIMULATED_REPORT_TEXT.other],
      CBC: ['completed', at(T0 + 30 * MIN), SIMULATED_LAB_REPORT_TEXT],
    })
    expect(await events(cbc.id)).toEqual([`->requested:doctor:actor@${at(T0)}`, `requested>in_progress:simulated_lab:-@${at(T0 + MIN)}`, `in_progress>completed:simulated_lab:-@${at(T0 + 30 * MIN)}`])
    expect(await events(xray.id)).toEqual([`->requested:doctor:actor@${at(T0 + 5 * MIN)}`, `requested>in_progress:simulated_lab:-@${at(T0 + 6 * MIN)}`, `in_progress>completed:simulated_lab:-@${at(T0 + 50 * MIN)}`])
    // The list read is audited with counts only. Changed deliberately: a list is audited once per viewer, list and window (the screen polls
    // it), so the doctor's first read (CBC and ECG moved to in progress) stands for the six that followed; asserted exactly, row for row.
    const reads = await audits('service_order.list')
    expect(reads.map((r) => [r.entity_type, r.entity_id, r.patient_id, r.details])).toEqual([
      ['encounter', e.id, p.id, { count: 3, open: 3, advanced: 2, repeatsNotLoggedForSeconds: 300 }],
      ['patient', p.id, p.id, { count: 3, open: 2, advanced: 1, repeatsNotLoggedForSeconds: 300 }],
    ])
  })

  it('an order first read long after its request takes both steps at once, each with its own time; a clock that goes back never undoes a step', async () => {
    const { e } = await consultation()
    const cbc = await place(e.id, 'CBC')
    nowMs = T0 + 3 * 24 * 60 * MIN
    expect((await listFor(e.id))[0]).toMatchObject({ status: 'completed', statusChangedAt: at(T0 + 30 * MIN), completedAt: at(T0 + 30 * MIN), reportText: SIMULATED_LAB_REPORT_TEXT })
    expect(await events(cbc.id)).toEqual([`->requested:doctor:actor@${at(T0)}`, `requested>in_progress:simulated_lab:-@${at(T0 + MIN)}`, `in_progress>completed:simulated_lab:-@${at(T0 + 30 * MIN)}`])
    nowMs = T0
    expect((await listFor(e.id))[0]!.status).toBe('completed')
    expect((await events(cbc.id)).length).toBe(3)
  })

  it('never writes an investigation result or a history entry, and an order’s report says only that nothing was performed', async () => {
    const { p, e } = await consultation()
    await place(e.id, 'CBC')
    await place(e.id, 'XRAY-CHEST')
    nowMs = T0 + 24 * 60 * MIN
    const orders = await listFor(e.id)
    expect(orders.every((o) => o.status === 'completed' && o.reportText?.startsWith('Simulated ') && o.simulated)).toBe(true)
    expect((await adminQuery('SELECT count(*)::int AS n FROM investigation_results')).rows[0].n).toBe(0)
    expect((await adminQuery("SELECT count(*)::int AS n FROM patient_history_events WHERE patient_id = $1 AND entity_type = 'investigation'", [p.id])).rows[0].n).toBe(0)
    const history = (await call(ctx.app, 'GET', `/api/patients/${p.id}/history`, { cookie: doctor })).json()
    expect(history.investigations).toEqual([])
  })
})

describe('cancelling an order', () => {
  it('only the doctor who placed it, only while it is open; the cancel is the doctor’s step in the history', async () => {
    const { e } = await consultation()
    const cbc = await place(e.id, 'CBC', { note: 'Evaluate persistent fever' })
    expect((await cancel(cbc.id, doctor2)).statusCode).toBe(403)
    expect((await cancel(cbc.id, nurse)).statusCode).toBe(403)
    expect((await cancel(crypto.randomUUID())).statusCode).toBe(404)
    expect((await cancel(cbc.id, doctor, { reason: 'x'.repeat(201) })).statusCode).toBe(400)

    nowMs = T0 + 2 * MIN
    const res = await cancel(cbc.id, doctor, { reason: 'Ordered in error' })
    expect(res.statusCode).toBe(200)
    expect(ServiceOrder.parse(res.json())).toMatchObject({ status: 'cancelled', cancelledAt: at(T0 + 2 * MIN), statusChangedAt: at(T0 + 2 * MIN), cancelReason: 'Ordered in error', reportText: null, canCancel: false })
    // It was in progress (since one minute) when cancelled: that step is kept, at its own time.
    expect(await events(cbc.id)).toEqual([`->requested:doctor:actor@${at(T0)}`, `requested>in_progress:simulated_lab:-@${at(T0 + MIN)}`, `in_progress>cancelled:doctor:actor@${at(T0 + 2 * MIN)}`])
    const again = await cancel(cbc.id)
    expect([again.statusCode, again.json().error]).toEqual([409, 'service_order_closed'])
    // A cancelled order stays cancelled whatever the schedule says.
    nowMs = T0 + 60 * MIN
    expect((await listFor(e.id))[0]!.status).toBe('cancelled')
  })

  it('an order the schedule has completed cannot be cancelled, even when nobody read it in between; the completion is kept', async () => {
    const { e } = await consultation()
    const ecg = await place(e.id, 'ECG')
    nowMs = T0 + 15 * MIN
    const res = await cancel(ecg.id)
    expect([res.statusCode, res.json().error, res.json().message]).toEqual([409, 'service_order_closed', 'This order is already completed and can no longer be cancelled.'])
    expect((await adminQuery('SELECT status, completed_at, cancelled_at FROM service_orders WHERE id = $1', [ecg.id])).rows[0]).toEqual({ status: 'completed', completed_at: new Date(T0 + 15 * MIN), cancelled_at: null })
  })

  it('two cancels at once: one cancels, the other is told it is already cancelled; a signed consultation’s open order can still be cancelled by its doctor', async () => {
    const { e, sign } = await consultation()
    const cbc = await place(e.id, 'CBC')
    const xray = await place(e.id, 'XRAY-CHEST')
    const both = await Promise.all([cancel(cbc.id), cancel(cbc.id)])
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect((await events(cbc.id)).filter((x) => x.includes('>cancelled')).length).toBe(1)
    await sign()
    expect((await cancel(xray.id)).statusCode).toBe(200)
  })
})

describe('audit', () => {
  it('records orders and cancels with ids, codes and flags, never the note or the reason', async () => {
    const { p, e } = await consultation()
    const cbc = await place(e.id, 'CBC', { note: 'NOTE-TEXT-7731 persistent fever' })
    await cancel(cbc.id, doctor, { reason: 'REASON-TEXT-7731 duplicate' })
    await listFor(e.id)
    expect(await audits('service_order.create')).toEqual([
      { outcome: 'success', entity_type: 'service_order', entity_id: cbc.id, patient_id: p.id, details: { encounterId: e.id, serviceCode: 'CBC', category: 'lab', simulated: true, withNote: true } },
    ])
    expect(await audits('service_order.cancel')).toEqual([
      { outcome: 'success', entity_type: 'service_order', entity_id: cbc.id, patient_id: p.id, details: { encounterId: e.id, serviceCode: 'CBC', from: 'requested', withReason: true } },
    ])
    const leaked = (await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE details::text LIKE '%7731%'")).rows[0].n
    expect(leaked).toBe(0)
  })

  it('a list read is audited once per viewer, list and window however often the screen polls it; the steps between are still in the order’s events', async () => {
    const { p, e } = await consultation()
    const cbc = await place(e.id, 'CBC')
    const readPatient = async (cookie: string) => expect((await call(ctx.app, 'GET', `/api/patients/${p.id}/service-orders`, { cookie })).statusCode).toBe(200)
    expect((await listFor(e.id))[0]!.status).toBe('requested')
    // The next polls: the one after a minute moves the order on (not audited, but it is the order's own step), the next changes nothing.
    nowMs = T0 + 2 * MIN
    expect((await listFor(e.id))[0]!.status).toBe('in_progress')
    expect((await listFor(e.id))[0]!.status).toBe('in_progress')
    await listFor(e.id, nurse)
    await listFor(e.id, nurse)
    await readPatient(doctor)
    await readPatient(doctor)
    const reads = (await adminQuery("SELECT actor_user_id, entity_type, entity_id, details FROM audit_events WHERE action = 'service_order.list' ORDER BY id")).rows
    expect(reads.map((r) => [r.actor_user_id, r.entity_type, r.entity_id, r.details])).toEqual([
      [fx.users.doctor, 'encounter', e.id, { count: 1, open: 1, advanced: 0, repeatsNotLoggedForSeconds: SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS }],
      [fx.users.nurse, 'encounter', e.id, { count: 1, open: 1, advanced: 0, repeatsNotLoggedForSeconds: SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS }],
      [fx.users.doctor, 'patient', p.id, { count: 1, open: 1, advanced: 0, repeatsNotLoggedForSeconds: SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS }],
    ])
    expect(SERVICE_ORDERS_READ_AUDIT_WINDOW_SECONDS).toBe(300)
    expect(await events(cbc.id)).toEqual([`->requested:doctor:actor@${at(T0)}`, `requested>in_progress:simulated_lab:-@${at(T0 + MIN)}`])
  })
})

describe('another facility', () => {
  it('a doctor of another facility finds none of these orders: both lists, ordering and cancelling are not found, each audited with its reason, and nothing moves', async () => {
    const { p, e } = await consultation()
    const cbc = await place(e.id, 'CBC')
    const [f] = await ctx.db.insert(facilities).values({ code: 'OTHER-ORD', name: 'Other facility' }).returning()
    const [stranger] = await ctx.db.insert(users).values({ facilityId: f!.id, username: 'other.orders', fullName: 'Other doctor', role: 'doctor', passwordHash: await hashPassword('Other-password-1') }).returning()
    const outsider = await login(ctx.app, 'other.orders', 'Other-password-1')
    // Due for its in-progress step: a refused read must not apply it.
    nowMs = T0 + 2 * MIN
    const attempts = [
      ['GET', `/api/encounters/${e.id}/service-orders`, undefined],
      ['GET', `/api/patients/${p.id}/service-orders`, undefined],
      ['POST', `/api/encounters/${e.id}/service-orders`, { serviceCode: 'ECG' }],
      ['POST', `/api/encounters/${e.id}/service-orders`, { serviceCode: 'ECG', idempotencyKey: crypto.randomUUID() }],
      ['POST', `/api/service-orders/${cbc.id}/cancel`, { reason: 'Not mine' }],
    ] as const
    for (const [method, url, body] of attempts) expect((await call(ctx.app, method, url, { cookie: outsider, body })).statusCode, `${method} ${url}`).toBe(404)
    const denied = (await adminQuery("SELECT entity_type, entity_id, details->>'reason' AS reason FROM audit_events WHERE action = 'access.not_found' AND actor_user_id = $1 ORDER BY id", [stranger!.id])).rows
    expect(denied).toEqual([
      { entity_type: 'encounter', entity_id: e.id, reason: 'other_facility' },
      { entity_type: 'patient', entity_id: p.id, reason: 'other_facility' },
      { entity_type: 'encounter', entity_id: e.id, reason: 'other_facility' },
      { entity_type: 'encounter', entity_id: e.id, reason: 'other_facility' },
      { entity_type: 'service_order', entity_id: cbc.id, reason: 'other_facility' },
    ])
    expect((await adminQuery('SELECT service_code, status, cancelled_at FROM service_orders')).rows).toEqual([{ service_code: 'CBC', status: 'requested', cancelled_at: null }])
    expect(await events(cbc.id)).toEqual([`->requested:doctor:actor@${at(T0)}`])
    expect((await adminQuery("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'service_order.%' AND actor_user_id = $1", [stranger!.id])).rows[0].n).toBe(0)
  })
})
