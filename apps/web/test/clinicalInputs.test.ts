// Unit tests (node --test) of the pure logic behind the consultation's "Clinical inputs" panel, the header's "Last vitals" line and the in-app
// band simulator's scheduler (HERO final). No browser, no server, no device: the readings are made up here as fixtures, the way the server
// would answer. The rule under test throughout: a simulated value is never a real one, and missing is not none.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachedDevice, Device, DeviceList, DeviceReading, Observation, PatientDeviceReadings, Visit } from '@adaxai/contracts'
import { ApiError } from '../src/lib/api.ts'
import { inputsDeviceLine, inputTiles, noAdultFlags, previousVitals, snapshotLine, vitalsSnapshot } from '../src/lib/clinicalInputs.ts'
import { attachedDevicesNow } from '../src/lib/devices.ts'
import { type AttachedDevicesSummary, createBandTick, createTicker, MAX_TICK_RETRIES, simulatorOffer, tickFailure, withSimulatorAttached } from '../src/lib/simulation.ts'

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0)
const iso = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString()
let n = 0
const obs = (kind: Observation['kind'], value: number, secondsAfter = 0, over: Partial<Observation> = {}): Observation => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  kind,
  value,
  unit: '',
  flag: null,
  measuredAt: iso(secondsAfter),
  source: 'manual',
  validationStatus: 'manual_entry',
  deviceLabel: null,
  recordedByName: 'Nurse',
  visitId: null,
  enteredInError: false,
  ...over,
})
const reading = (kind: DeviceReading['kind'], value: number, over: Partial<DeviceReading> = {}): DeviceReading => ({
  observationId: `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`,
  kind,
  value,
  unit: kind === 'heart_rate' ? 'bpm' : '%',
  flag: null,
  measuredAt: iso(0),
  receivedAt: iso(0),
  state: 'live',
  validationStatus: 'device_unverified',
  ...over,
})
const device = (over: Partial<AttachedDevice> = {}): AttachedDevice => ({
  assignmentId: '00000000-0000-4000-8000-0000000000a1',
  deviceId: '00000000-0000-4000-8000-0000000000d1',
  label: 'Band',
  kind: 'wearable_band',
  integration: 'gateway_api',
  simulated: false,
  assignedAt: iso(-600),
  validUntil: null,
  visitId: null,
  encounterId: null,
  lastSeenAt: iso(0),
  state: 'live',
  reason: null,
  kinds: ['heart_rate', 'spo2', 'temperature', 'respiratory_rate'],
  readings: [],
  readingsStored: 0,
  ...over,
})
const view = (devices: AttachedDevice[], consent: PatientDeviceReadings['consent'] = 'granted'): PatientDeviceReadings => ({ serverTime: iso(0), thresholds: { liveSeconds: 30, disconnectedSeconds: 120 }, consent, devices })
const tile = (tiles: ReturnType<typeof inputTiles>, key: string) => tiles.find((t) => t.key === key)!

test('the five tiles in order; a kind with nothing real says "Not recorded", never 0 or a dash', () => {
  const tiles = inputTiles({ vitals: [obs('heart_rate', 124, 0, { flag: 'high' })], devices: view([]), paediatric: false })
  assert.deepEqual(
    tiles.map((t) => t.short),
    ['HR', 'SpO₂', 'BP', 'Temp', 'RR'],
  )
  assert.deepEqual(tile(tiles, 'heart_rate').values.map((v) => [v.source, v.value, v.unit, v.flag]), [['staff', '124', 'bpm', 'high']])
  assert.equal(tile(tiles, 'heart_rate').missing, null)
  for (const k of ['spo2', 'bp', 'temperature', 'respiratory_rate']) {
    assert.equal(tile(tiles, k).missing, 'Not recorded')
    assert.equal(tile(tiles, k).values.length, 0)
  }
  // Nothing read at all yet (the device card has not answered): still only what is known.
  assert.equal(inputTiles({ vitals: null, devices: null, paediatric: false }).every((t) => t.missing === 'Not recorded'), true)
})

test('blood pressure comes from staff only, as one pair; a missing half is said, the worst flag is kept', () => {
  const tiles = inputTiles({ vitals: [obs('systolic_bp', 148, 0, { flag: 'high' }), obs('diastolic_bp', 76, 0, { flag: 'normal' })], devices: view([]), paediatric: false })
  const bp = tile(tiles, 'bp')
  assert.equal(bp.staffOnly, true)
  assert.deepEqual(bp.values.map((v) => [v.source, v.value, v.unit, v.flag, v.missingHalf]), [['staff', '148/76', 'mmHg', 'high', undefined]])
  const half = tile(inputTiles({ vitals: [obs('systolic_bp', 118)], devices: null, paediatric: false }), 'bp')
  assert.equal(half.values[0]!.value, '118/—')
  assert.equal(half.values[0]!.missingHalf, 'diastolic')
})

test('a device sending now is shown after the staff value, unverified, with its state; a value that is not live is greyed', () => {
  const live = inputTiles({ vitals: [obs('heart_rate', 88)], devices: view([device({ readings: [reading('heart_rate', 92, { flag: 'normal' })] })]), paediatric: false })
  assert.deepEqual(tile(live, 'heart_rate').values.map((v) => [v.source, v.value, v.state, v.showState, v.current, v.device]), [
    ['staff', '88', null, false, true, null],
    ['device', '92', 'live', true, true, 'Band'],
  ])
  const stale = inputTiles({ vitals: [], devices: view([device({ state: 'stale', readings: [reading('spo2', 95, { state: 'stale' })] })]), paediatric: false })
  const v = tile(stale, 'spo2').values[0]!
  assert.deepEqual([v.source, v.state, v.showState, v.current], ['device', 'stale', true, false])
  assert.equal(tile(stale, 'spo2').missing, null)
})

test('when no device is sending, a device value stored with this visit stands where staff measured nothing', () => {
  const tiles = inputTiles({ vitals: [obs('temperature', 38.64, 0, { source: 'device', validationStatus: 'device_unverified', deviceLabel: 'Band' })], devices: view([]), paediatric: false })
  assert.deepEqual(tile(tiles, 'temperature').values.map((v) => [v.source, v.value, v.state, v.device]), [['stored', '38.6', null, 'Band']])
})

test('a simulator’s value is shown apart: after the real values, SIMULATED, never LIVE, never flagged, and it never fills a missing value', () => {
  const sim = device({ deviceId: '00000000-0000-4000-8000-0000000000d2', label: 'Simulator band', integration: 'simulator', simulated: true, readings: [reading('heart_rate', 131, { validationStatus: 'simulated', flag: 'high' }), reading('spo2', 90, { validationStatus: 'simulated', state: 'stale' })] })
  const tiles = inputTiles({ vitals: [obs('heart_rate', 92)], devices: view([sim]), paediatric: false })
  const hr = tile(tiles, 'heart_rate')
  assert.deepEqual(hr.values.map((v) => [v.source, v.value, v.flag, v.showState]), [
    ['staff', '92', null, false],
    ['simulated', '131', null, false],
  ])
  // Only a simulator has a value of this kind: the patient's is still not recorded; the simulator's value (stale) says its state.
  const spo2 = tile(tiles, 'spo2')
  assert.equal(spo2.missing, 'Not recorded')
  assert.deepEqual(spo2.values.map((v) => [v.source, v.state, v.showState, v.current]), [['simulated', 'stale', true, false]])
  // A simulated value that slipped into the consultation's vital signs is dropped (the server never sends one).
  const leaked = inputTiles({ vitals: [obs('respiratory_rate', 40, 0, { source: 'device', validationStatus: 'simulated' })], devices: view([]), paediatric: false })
  assert.equal(tile(leaked, 'respiratory_rate').missing, 'Not recorded')
})

test('no reference flag for a child, on any tile', () => {
  const tiles = inputTiles({ vitals: [obs('heart_rate', 140, 0, { flag: 'high' }), obs('systolic_bp', 150, 0, { flag: 'high' })], devices: view([device({ readings: [reading('spo2', 88, { flag: 'critical_low' })] })]), paediatric: true })
  assert.equal(
    tiles.flatMap((t) => t.values).every((v) => v.flag === null),
    true,
  )
  assert.equal(noAdultFlags('2020-03-01', new Date(T0)), true)
  assert.equal(noAdultFlags('1980-03-01', new Date(T0)), false)
  assert.equal(noAdultFlags('not a date', new Date(T0)), true)
})

test('the device line under the tiles: none attached, live, a simulator, a quiet device; a stethoscope (sends no vital signs) is left out', () => {
  assert.equal(inputsDeviceLine(null), null)
  assert.equal(inputsDeviceLine(view([])), 'No device attached')
  assert.equal(inputsDeviceLine(view([], 'missing')), 'No device attached · consent to device readings not recorded')
  assert.equal(inputsDeviceLine(view([device()])), 'Device live')
  assert.equal(inputsDeviceLine(view([device({ simulated: true, integration: 'simulator' })])), 'Simulator sending (not a device)')
  assert.equal(inputsDeviceLine(view([device({ state: 'disconnected' })])), 'Device not connected')
  assert.equal(inputsDeviceLine(view([device({ simulated: true, integration: 'simulator', state: 'stale' })])), 'Simulator reading stale')
  assert.equal(inputsDeviceLine(view([device({ kind: 'smart_stethoscope', kinds: [], state: 'disconnected' })])), 'No device attached')
})

test('the header line: HR · BP · SpO₂ · Temp from the consultation’s own vital signs, "not recorded" per missing kind, a device value marked', () => {
  const items = vitalsSnapshot({ vitals: [obs('heart_rate', 124, 0, { flag: 'high' }), obs('systolic_bp', 118), obs('diastolic_bp', 76), obs('spo2', 96), obs('temperature', 38.6, 0, { flag: 'high' })], paediatric: false })
  assert.equal(snapshotLine(items), 'HR 124 · BP 118/76 · SpO₂ 96% · Temp 38.6°C')
  assert.deepEqual(
    items.map((i) => i.flag),
    ['high', null, null, 'high'],
  )
  const partial = vitalsSnapshot({ vitals: [obs('temperature', 37.2), obs('spo2', 97, 0, { source: 'device', validationStatus: 'device_unverified', deviceLabel: 'Band' })], paediatric: false })
  assert.equal(snapshotLine(partial), 'HR not recorded · BP not recorded · SpO₂ 97% (device, unverified) · Temp 37.2°C')
  // Staff stand over a device; a simulator's value never reaches the line, even if one slipped in; nothing at all is said as not recorded.
  const mixed = vitalsSnapshot({ vitals: [obs('heart_rate', 110, -60, { source: 'device', validationStatus: 'device_unverified' }), obs('heart_rate', 96, -120), obs('spo2', 80, 0, { source: 'device', validationStatus: 'simulated' })], paediatric: false })
  assert.equal(snapshotLine(mixed), 'HR 96 · BP not recorded · SpO₂ not recorded · Temp not recorded')
  assert.equal(snapshotLine(vitalsSnapshot({ vitals: [], paediatric: false })), 'HR not recorded · BP not recorded · SpO₂ not recorded · Temp not recorded')
})

test('the header line has no reference flag under 18', () => {
  const items = vitalsSnapshot({ vitals: [obs('heart_rate', 140, 0, { flag: 'high' }), obs('systolic_bp', 150, 0, { flag: 'high' }), obs('temperature', 39.1, 0, { flag: 'high' })], paediatric: true })
  assert.equal(
    items.every((i) => i.flag === null),
    true,
  )
})

const visit = (id: string, checkedInSeconds: number, latestVitals: Observation[], over: Partial<Visit> = {}): Visit =>
  ({ id, visitDate: iso(checkedInSeconds).slice(0, 10), checkedInAt: iso(checkedInSeconds), status: 'completed', latestVitals, ...over }) as Visit

test('previous values: the most recent EARLIER visit that has each kind, measured by staff; not this visit, not a cancelled or later one', () => {
  const day = 86_400
  const visits = [
    visit('v-later', 2 * day, [obs('heart_rate', 150)]),
    visit('v-now', 0, [obs('heart_rate', 124)]),
    visit('v-cancelled', -1 * day, [obs('heart_rate', 99)], { status: 'cancelled' }),
    visit('v-1', -2 * day, [obs('heart_rate', 110), obs('spo2', 93, 0, { source: 'device', validationStatus: 'device_unverified' })]),
    visit('v-2', -30 * day, [obs('spo2', 98), obs('systolic_bp', 120), obs('diastolic_bp', 80), obs('temperature', 37)]),
  ]
  const prev = previousVitals(visits, { id: 'v-now', visitDate: iso(0).slice(0, 10) })
  assert.deepEqual(prev, {
    heart_rate: { text: '110', date: iso(-2 * day).slice(0, 10) },
    spo2: { text: '98%', date: iso(-30 * day).slice(0, 10) },
    bp: { text: '120/80', date: iso(-30 * day).slice(0, 10) },
    temperature: { text: '37.0°C', date: iso(-30 * day).slice(0, 10) },
  })
  const items = vitalsSnapshot({ vitals: [obs('heart_rate', 124)], previous: prev, paediatric: false })
  assert.equal(snapshotLine(items), 'HR 124 (prev 110) · BP not recorded (prev 120/80) · SpO₂ not recorded (prev 98%) · Temp not recorded (prev 37.0°C)')
  // No earlier visit, or the list could not be read: nothing is made up.
  assert.deepEqual(previousVitals([visit('v-now', 0, [])], { id: 'v-now', visitDate: '2026-10-06' }), {})
  assert.deepEqual(previousVitals(null, { id: 'v-now', visitDate: '2026-10-06' }), {})
})

const registry = (devices: Partial<Device>[], simulatorAllowed = true): DeviceList => ({ simulatorAllowed, devices: devices.map((d) => ({ simulated: true, kind: 'wearable_band', status: 'active', assignment: null, ...d }) as Device) })

test('a simulator control is offered only where simulators are allowed, for a simulator record that is attached here or registered, with consent', () => {
  const pid = '00000000-0000-4000-8000-0000000000p1'
  const offer = (list: DeviceList | null, readings: AttachedDevicesSummary | null, kind: 'band' | 'stethoscope' = 'band') => simulatorOffer({ list, readings, patientId: pid, kind })
  assert.equal(offer(registry([{}], false), view([])), null)
  assert.equal(offer(null, view([])), null)
  assert.equal(offer(registry([{}]), view([])), 'attachable')
  // Registered, but the consent is not in its current wording: attaching needs it.
  assert.equal(offer(registry([{}]), view([], 'outdated')), null)
  assert.equal(offer(registry([{}]), view([], 'missing')), null)
  // Attached here (the device card or the registry says so).
  assert.equal(offer(registry([]), view([device({ simulated: true, integration: 'simulator' })])), 'attached')
  assert.equal(offer(registry([{ assignment: { patientId: pid } as Device['assignment'] }]), view([], 'outdated')), 'attached')
  // Deliberate change (review fix): a simulator attached to someone else is still offered; the server moves it when nobody is using it there,
  // and otherwise refuses with its reason (shown under the control). Before, the control disappeared without a word.
  assert.equal(offer(registry([{ assignment: { patientId: 'someone-else' } as Device['assignment'] }]), view([])), 'attachable')
  assert.equal(offer(registry([{ assignment: { patientId: 'someone-else' } as Device['assignment'] }]), view([], 'outdated')), null)
  // A real device record, a retired simulator, or a simulator of the other kind: nothing.
  assert.equal(offer(registry([{ simulated: false }]), view([])), null)
  assert.equal(offer(registry([{ status: 'retired' }]), view([])), null)
  assert.equal(offer(registry([{}]), view([]), 'stethoscope'), null)
  assert.equal(offer(registry([{ kind: 'smart_stethoscope' }]), view([]), 'stethoscope'), 'attachable')
  // The narrow answer the stethoscope reads (no ages) gives the same offer as the whole answer.
  const sim = view([device({ simulated: true, integration: 'simulator' })])
  assert.equal(offer(registry([]), attachedDevicesNow({ view: sim, receivedAt: T0 })), 'attached')
})

test('what the stethoscope observes of the device card: which devices are attached and the consent, nothing that ages; an unreadable answer is null', () => {
  const sim = device({ simulated: true, integration: 'simulator', readings: [reading('heart_rate', 90)] })
  assert.deepEqual(attachedDevicesNow({ view: view([sim, device()], 'outdated'), receivedAt: T0 }), {
    consent: 'outdated',
    devices: [
      { kind: 'wearable_band', simulated: true },
      { kind: 'wearable_band', simulated: false },
    ],
  })
  // The same devices read again five seconds later, with new values and ages: the same summary (so the panel does not re-render).
  const later = device({ simulated: true, integration: 'simulator', lastSeenAt: iso(5), readings: [reading('heart_rate', 95, { measuredAt: iso(5) })] })
  assert.deepEqual(attachedDevicesNow({ view: view([later, device()], 'outdated'), receivedAt: T0 + 5000 }), attachedDevicesNow({ view: view([sim, device()], 'outdated'), receivedAt: T0 }))
  assert.equal(attachedDevicesNow(undefined), null)
  assert.equal(attachedDevicesNow({ view: { serverTime: iso(0) } as unknown as PatientDeviceReadings, receivedAt: T0 }), null)
})

test('a simulated action runs with a simulator attached: attach first when none is believed attached; a lost attachment is attached again, once', async () => {
  const calls: string[] = []
  const attach = async () => void calls.push('attach')
  const lost = () => new ApiError(409, 'simulator_not_attached', 'No simulator band is attached to this patient. Attach one first.')
  // Not believed attached: attach, then act.
  assert.equal(await withSimulatorAttached({ believedAttached: false, attach, act: async () => (calls.push('act'), 'ok') }), 'ok')
  assert.deepEqual(calls, ['attach', 'act'])
  // Believed attached, and it is: act only.
  calls.length = 0
  assert.equal(await withSimulatorAttached({ believedAttached: true, attach, act: async () => (calls.push('act'), 'ok') }), 'ok')
  assert.deepEqual(calls, ['act'])
  // Believed attached, but the attachment was ended elsewhere: told, attached again, acted again.
  calls.length = 0
  let first = true
  const recovered = await withSimulatorAttached({
    believedAttached: true,
    attach,
    onLost: () => calls.push('lost'),
    act: async () => {
      calls.push('act')
      if (first) {
        first = false
        throw lost()
      }
      return 'ok'
    },
  })
  assert.equal(recovered, 'ok')
  assert.deepEqual(calls, ['act', 'lost', 'attach', 'act'])
  // Still not attached after attaching again: no loop, the refusal is the caller's.
  calls.length = 0
  await assert.rejects(
    withSimulatorAttached({ believedAttached: true, attach, act: async () => (calls.push('act'), Promise.reject(lost())) }),
    (e: unknown) => e instanceof ApiError && e.code === 'simulator_not_attached',
  )
  assert.deepEqual(calls, ['act', 'attach', 'act'])
  // Any other refusal is not retried.
  calls.length = 0
  await assert.rejects(withSimulatorAttached({ believedAttached: true, attach, act: async () => (calls.push('act'), Promise.reject(new ApiError(409, 'consent_required', 'x'))) }))
  assert.deepEqual(calls, ['act'])
})

test('the band tick: a stale "attached" (the assignment was ended elsewhere) attaches again instead of stopping; a stop re-reads the registry', async () => {
  const log: string[] = []
  const attached = { current: true }
  let assigned = false
  const failures: unknown[] = []
  const tick = createBandTick({
    attached,
    attach: async () => {
      log.push('attach')
      assigned = true
    },
    tick: async () => {
      log.push('tick')
      if (!assigned) throw new ApiError(409, 'simulator_not_attached', 'No simulator band is attached to this patient. Attach one first.')
    },
    refreshDevices: () => log.push('refresh'),
    onFirstValues: () => log.push('first'),
    onStop: (e) => failures.push(e),
  })
  // The page believed a band attached (an old registry list); the server says it is not: the tick attaches one and goes on.
  assert.equal(await tick(), 'continue')
  assert.deepEqual(log, ['tick', 'refresh', 'attach', 'refresh', 'tick', 'first'])
  assert.equal(attached.current, true)
  assert.deepEqual(failures, [])
  // Then it ticks without attaching; the first values are announced once.
  log.length = 0
  assert.equal(await tick(), 'continue')
  assert.deepEqual(log, ['tick'])

  // A refusal stops the band, says why, and re-reads the registry.
  const stopped: unknown[] = []
  const refused = createBandTick({
    attached: { current: false },
    attach: async () => Promise.reject(new ApiError(409, 'no_free_simulator', 'Every simulator band is in use')),
    tick: async () => undefined,
    refreshDevices: () => stopped.push('refresh'),
    onFirstValues: () => undefined,
    onStop: (e) => stopped.push((e as ApiError).code),
  })
  assert.equal(await refused(), 'stop')
  assert.deepEqual(stopped, ['refresh', 'no_free_simulator'])

  // Failures worth retrying: it goes on, and stops after MAX_TICK_RETRIES in a row.
  const flaky: string[] = []
  const unreachable = createBandTick({
    attached: { current: true },
    attach: async () => undefined,
    tick: async () => Promise.reject(new ApiError(0, 'network_error', 'x')),
    refreshDevices: () => flaky.push('refresh'),
    onFirstValues: () => undefined,
    onStop: () => flaky.push('stop'),
  })
  const verdicts: string[] = []
  for (let i = 0; i < MAX_TICK_RETRIES; i++) verdicts.push(await unreachable())
  assert.deepEqual(verdicts, [...Array.from({ length: MAX_TICK_RETRIES - 1 }, () => 'continue'), 'stop'])
  assert.deepEqual(flaky, ['refresh', 'stop'])
})

test('a failed tick is retried when the server was unreachable, busy or limiting; a refusal stops the band', () => {
  assert.equal(tickFailure(new ApiError(0, 'network_error', 'x')), 'retry')
  assert.equal(tickFailure(new ApiError(503, 'service_unavailable', 'x')), 'retry')
  assert.equal(tickFailure(new ApiError(429, 'rate_limited', 'x')), 'retry')
  assert.equal(tickFailure(new ApiError(409, 'try_again', 'x')), 'retry')
  assert.equal(tickFailure(new Error('odd')), 'retry')
  for (const code of ['simulator_not_allowed', 'consent_required', 'simulator_not_attached', 'encounter_not_in_progress', 'no_free_simulator']) assert.equal(tickFailure(new ApiError(code === 'simulator_not_allowed' ? 403 : 409, code, 'x')), 'stop')
})

/** A hand-driven clock for the ticker: timers fire only when the test says so. */
function harness(tick: () => Promise<'continue' | 'stop'>) {
  let visible = true
  let listener: (() => void) | null = null
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let seq = 0
  const stops: string[] = []
  const t = createTicker({
    intervalMs: 5000,
    tick,
    isVisible: () => visible,
    subscribeVisibility: (cb) => {
      listener = cb
      return () => {
        listener = null
      }
    },
    setTimer: (fn, ms) => {
      timers.set(++seq, { fn, ms })
      return seq
    },
    clearTimer: (h) => void timers.delete(h as number),
    onStop: (r) => stops.push(r),
  })
  return {
    t,
    timers,
    stops,
    fire: () => {
      const [id, e] = [...timers.entries()][0] ?? []
      if (id === undefined || !e) return false
      timers.delete(id)
      e.fn()
      return true
    },
    setVisible: (v: boolean) => {
      visible = v
      listener?.()
    },
    subscribed: () => listener !== null,
  }
}
const settle = () => new Promise((r) => setImmediate(r))

test('the band scheduler: a tick at once, then one five seconds after each tick ends, never two at a time', async () => {
  let calls = 0
  let release: (() => void) | null = null
  const h = harness(
    () =>
      new Promise((r) => {
        calls++
        release = () => r('continue')
      }),
  )
  h.t.start()
  assert.equal(calls, 1)
  // While the first tick is in flight, nothing else is scheduled.
  assert.equal(h.timers.size, 0)
  h.t.start()
  assert.equal(calls, 1)
  release!()
  await settle()
  assert.deepEqual([...h.timers.values()].map((x) => x.ms), [5000])
  h.fire()
  assert.equal(calls, 2)
  release!()
  await settle()
  assert.equal(h.timers.size, 1)
})

test('the band scheduler: none while the page is hidden, one as soon as it is shown again', async () => {
  let calls = 0
  const h = harness(async () => {
    calls++
    return 'continue'
  })
  h.t.start()
  await settle()
  assert.equal(calls, 1)
  h.setVisible(false)
  assert.equal(h.timers.size, 0)
  h.setVisible(true)
  await settle()
  assert.equal(calls, 2)
  // A timer that fires while hidden ticks nothing; showing the page ticks once.
  h.t.stop()
  const h2 = harness(async () => {
    calls++
    return 'continue'
  })
  calls = 0
  h2.t.start()
  await settle()
  h2.setVisible(false)
  h2.setVisible(true)
  await settle()
  assert.equal(calls, 2)
  h2.setVisible(false)
  assert.equal(h2.fire(), false)
  assert.equal(calls, 2)
})

test('the band scheduler: stop (unmount) ends it for good, a tick in flight changes nothing; a refusal stops it and says so', async () => {
  let release: ((v: 'continue' | 'stop') => void) | null = null
  let calls = 0
  const h = harness(
    () =>
      new Promise((r) => {
        calls++
        release = r
      }),
  )
  h.t.start()
  h.t.stop()
  assert.equal(h.subscribed(), false)
  release!('continue')
  await settle()
  assert.equal(h.timers.size, 0)
  assert.equal(h.t.running(), false)
  h.setVisible(true)
  assert.equal(calls, 1)

  const r = harness(async () => 'stop')
  r.t.start()
  await settle()
  assert.equal(r.t.running(), false)
  assert.deepEqual(r.stops, ['refused'])
  assert.equal(r.timers.size, 0)
  // A tick that throws is treated as worth retrying (the caller decides when to give up).
  const thrown = harness(async () => {
    throw new Error('boom')
  })
  thrown.t.start()
  await settle()
  assert.equal(thrown.t.running(), true)
  assert.equal(thrown.timers.size, 1)
  thrown.t.stop()
})
