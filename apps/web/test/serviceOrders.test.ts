// Unit tests (node --test) of the service orders' pure rules in the doctor's app (DESIGN §5.4 Orders, §5.6, spec 17C-17E): the catalogue
// grouped by category in the dialog, the status words (never colour alone) and their pill tones, the time line of a row, the honest empty
// state, the polling rule (every 30 s only while an order is still open) and what the list shows when a read fails. No browser.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ServiceCatalogue, ServiceOrderStatus } from '@adaxai/contracts'
import { statusPillSpec } from '../src/components/hero/spec.ts'
import { groupCatalogue, newOrderKey, noOrdersText, ordersListView, ordersPollInterval, orderStatusPill, orderTimeline, SERVICE_ORDERS_POLL_MS, serviceCatalogueKey, serviceOrdersKey, serviceOrdersRoot } from '../src/lib/serviceOrders.ts'

const svc = (code: string, category: 'lab' | 'imaging' | 'other'): ServiceCatalogue['services'][number] => ({ code, name: `${code} name`, category, turnaroundMinutes: 30, simulated: true })

test('the dialog groups the catalogue as Laboratory, Imaging, Other, each in the configured order, and leaves empty categories out', () => {
  const groups = groupCatalogue([svc('ECG', 'other'), svc('CBC', 'lab'), svc('MRI-BRAIN', 'imaging'), svc('CRP', 'lab'), svc('XRAY-CHEST', 'imaging')])
  assert.deepEqual(
    groups.map((g) => [g.category, g.label, g.services.map((s) => s.code)]),
    [
      ['lab', 'Laboratory', ['CBC', 'CRP']],
      ['imaging', 'Imaging', ['MRI-BRAIN', 'XRAY-CHEST']],
      ['other', 'Other', ['ECG']],
    ],
  )
  assert.deepEqual(
    groupCatalogue([svc('CBC', 'lab')]).map((g) => g.category),
    ['lab'],
  )
  assert.deepEqual(groupCatalogue([]), [])
})

test('every status is said in words — Requested, In progress, Completed, Cancelled — with the shared pill tones, never colour alone', () => {
  const statuses: ServiceOrderStatus[] = ['requested', 'in_progress', 'completed', 'cancelled']
  assert.deepEqual(
    statuses.map((s) => {
      const p = orderStatusPill(s)
      return [s, p.label, statusPillSpec(p.status).tone]
    }),
    [
      ['requested', 'Requested', 'pending'],
      ['in_progress', 'In progress', 'notice'],
      ['completed', 'Completed', 'ok'],
      ['cancelled', 'Cancelled', 'neutral'],
    ],
  )
  const words = statuses.map((s) => orderStatusPill(s).label)
  assert.equal(new Set(words).size, words.length)
})

test('a row says when the order was placed and, once it moved, since when it is in its status', () => {
  const t = (iso: string) => iso.slice(11, 16)
  const base = { requestedAt: '2026-10-06T10:42:00.000Z', statusChangedAt: '2026-10-06T10:42:00.000Z' }
  assert.equal(orderTimeline({ ...base, status: 'requested' }, t), 'Requested 10:42')
  assert.equal(orderTimeline({ ...base, status: 'in_progress', statusChangedAt: '2026-10-06T10:43:00.000Z' }, t), 'Requested 10:42 · in progress since 10:43')
  assert.equal(orderTimeline({ ...base, status: 'completed', statusChangedAt: '2026-10-06T11:12:00.000Z' }, t), 'Requested 10:42 · completed 11:12')
  assert.equal(orderTimeline({ ...base, status: 'cancelled', statusChangedAt: '2026-10-06T10:50:00.000Z' }, t), 'Requested 10:42 · cancelled 10:50')
})

test('the list is read again every 30 s only while an order is still requested or in progress', () => {
  assert.equal(SERVICE_ORDERS_POLL_MS, 30_000)
  assert.equal(ordersPollInterval(undefined), false)
  assert.equal(ordersPollInterval([]), false)
  assert.equal(ordersPollInterval([{ status: 'completed' }, { status: 'cancelled' }]), false)
  assert.equal(ordersPollInterval([{ status: 'completed' }, { status: 'requested' }]), 30_000)
  assert.equal(ordersPollInterval([{ status: 'in_progress' }]), 30_000)
})

test('a failed first load is an error; a failed later poll keeps the orders already read on screen and only says they may be out of date', () => {
  const data = { orders: [{ status: 'in_progress' as const }] }
  assert.deepEqual(ordersListView({ isError: false, data: undefined }), { kind: 'loading' })
  assert.deepEqual(ordersListView({ isError: true, data: undefined }), { kind: 'failed' })
  assert.deepEqual(ordersListView({ isError: false, data }), { kind: 'ready', data, stale: false })
  // TanStack Query keeps the last data with status 'error' after a failed refetch: the list (and its Cancel buttons) stays.
  const afterFailedPoll = ordersListView({ isError: true, data })
  assert.deepEqual(afterFailedPoll, { kind: 'ready', data, stale: true })
  // The poll goes on from the kept orders, so the list recovers on the next successful read.
  assert.equal(afterFailedPoll.kind === 'ready' && ordersPollInterval(afterFailedPoll.data.orders), SERVICE_ORDERS_POLL_MS)
  // An empty list read once stays an honest empty list (not an error) after a failed refetch.
  assert.deepEqual(ordersListView({ isError: true, data: { orders: [] } }), { kind: 'ready', data: { orders: [] }, stale: true })
})

test('the empty state says what is missing for what the list covers; keys keep a consultation’s and a patient’s orders apart', () => {
  assert.equal(noOrdersText({ encounterId: 'e1' }), 'No orders for this consultation')
  assert.equal(noOrdersText({}), 'No orders for this patient')
  assert.deepEqual(serviceOrdersKey({ encounterId: 'e1', patientId: 'p1' }), ['service-orders', 'encounter', 'e1'])
  assert.deepEqual(serviceOrdersKey({ patientId: 'p1' }), ['service-orders', 'patient', 'p1'])
  // Sending or cancelling refreshes every list of orders (one root) but not the catalogue.
  assert.deepEqual(serviceOrdersRoot, ['service-orders'])
  assert.notEqual(serviceCatalogueKey[0], serviceOrdersRoot[0])
})

test('each Send order gets its own key', () => {
  const a = newOrderKey()
  const b = newOrderKey()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, b)
})
