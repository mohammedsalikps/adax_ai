// Unit tests (node --test) of the pure logic behind the "Device readings" card: how a reading's age is worded, and how a device and its readings
// are aged ON THE SCREEN between two reads from the server (a live value turns stale, a silent gateway turns disconnected), by the same function
// the server uses. No browser, no server, no device.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachedDevice, DeviceReading, Observation, PatientDeviceReadings } from '@adaxai/contracts'
import { ageDevice, ageText, ageView, summarizeDevices } from '../src/lib/devices.ts'
import { latestPerKind, vitalsStatus } from '../src/lib/vitals.ts'

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0)
const iso = (secondsAfter: number) => new Date(T0 + secondsAfter * 1000).toISOString()
const limits = { liveSeconds: 30, disconnectedSeconds: 120 }

const reading = (kind: DeviceReading['kind'], value: number, measuredAt: number, over: Partial<DeviceReading> = {}): DeviceReading => ({
  observationId: `00000000-0000-4000-8000-00000000000${kind.length % 10}`,
  kind,
  value,
  unit: '',
  flag: null,
  measuredAt: iso(measuredAt),
  receivedAt: iso(measuredAt),
  state: 'live',
  validationStatus: 'device_unverified',
  ...over,
})

const device = (over: Partial<AttachedDevice> = {}): AttachedDevice => ({
  assignmentId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
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
  readings: [reading('heart_rate', 72, 0), reading('spo2', 97, -20)],
  readingsStored: 2,
  ...over,
})

test('an age is worded for a glance, and nothing that is seconds old is called "now"', () => {
  assert.equal(ageText(0), 'just now')
  assert.equal(ageText(4_900), 'just now')
  assert.equal(ageText(5_000), '5 s ago')
  assert.equal(ageText(59_999), '59 s ago')
  assert.equal(ageText(60_000), '1 min ago')
  assert.equal(ageText(59 * 60_000), '59 min ago')
  assert.equal(ageText(60 * 60_000), '1 h ago')
  assert.equal(ageText(125 * 60_000), '2 h 5 min ago')
  assert.equal(ageText(24 * 3_600_000), '1 day ago')
  assert.equal(ageText(3 * 24 * 3_600_000), '3 days ago')
  // A clock that is a little behind never shows a negative age.
  assert.equal(ageText(-2_000), 'just now')
})

test('between two reads a live reading turns stale and a silent gateway turns disconnected, each reading by its own age', () => {
  const d = device()
  const at = (seconds: number) => ageDevice(d, T0 + seconds * 1000, limits)
  // Just read: heart rate measured now, saturation 20 s ago: both live.
  assert.deepEqual(at(0).readings.map((r) => r.state), ['live', 'live'])
  assert.equal(at(0).state, 'live')
  assert.equal(at(0).reason, null)
  // 15 s later: saturation is 35 s old and stale; the device's newest reading is still live.
  assert.deepEqual(at(15).readings.map((r) => r.state), ['live', 'stale'])
  assert.equal(at(15).state, 'live')
  // 31 s later: everything is stale, and the screen says why in the server's words.
  assert.deepEqual(at(31).readings.map((r) => r.state), ['stale', 'stale'])
  assert.equal(at(31).state, 'stale')
  assert.equal(at(31).reason, 'The newest reading is more than 30 seconds old.')
  // 121 s with no contact: disconnected, the values kept as the last ones received.
  assert.deepEqual(at(121).readings.map((r) => [r.value, r.state]), [[72, 'disconnected'], [97, 'disconnected']])
  assert.equal(at(121).state, 'disconnected')
  assert.match(at(121).reason ?? '', /Any value shown is the last one received\./)
})

test('a device with no reading is "no data" while its gateway is in contact, and disconnected when it has never been heard from', () => {
  assert.equal(ageDevice(device({ readings: [], state: 'no_data' }), T0 + 5000, limits).state, 'no_data')
  const never = ageDevice(device({ readings: [], lastSeenAt: null, state: 'disconnected', reason: 'This device’s gateway has not been in contact since it was registered.' }), T0 + 5000, limits)
  assert.equal(never.state, 'disconnected')
  assert.equal(never.reason, 'This device’s gateway has not been in contact since it was registered.')
})

test('what the server called unavailable stays unavailable, and an assignment whose time runs out between two reads becomes unavailable', () => {
  const gone = ageDevice(device({ state: 'unavailable', reason: 'This device is retired.' }), T0 + 1000, limits)
  assert.equal(gone.state, 'unavailable')
  assert.equal(gone.reason, 'This device is retired.')
  assert.ok(gone.readings.every((r) => r.state === 'unavailable'))
  const timed = device({ validUntil: iso(10) })
  assert.equal(ageDevice(timed, T0 + 9_000, limits).state, 'live')
  const over = ageDevice(timed, T0 + 10_000, limits)
  assert.equal(over.state, 'unavailable')
  assert.equal(over.reason, 'The time this device was attached for is over. End the assignment; it can then be attached again.')
})

test('a simulated reading is aged like any other and stays marked simulated', () => {
  const sim = ageDevice(device({ simulated: true, integration: 'simulator', readings: [reading('heart_rate', 131, 0, { validationStatus: 'simulated' })] }), T0 + 40_000, limits)
  assert.equal(sim.simulated, true)
  assert.deepEqual(sim.readings.map((r) => [r.state, r.validationStatus]), [['stale', 'simulated']])
})

// --- the whole answer, aged; and its summary for the consultation header's chip ---
const view = (devices: AttachedDevice[]): PatientDeviceReadings => ({ serverTime: iso(0), thresholds: limits, consent: 'granted', devices })
const simulator = (over: Partial<AttachedDevice> = {}) => device({ assignmentId: '00000000-0000-4000-8000-000000000003', label: 'Simulator band', integration: 'simulator', simulated: true, ...over })

test('a whole answer is aged from the server’s clock: a live reading turns stale after the live limit, and a silent gateway disconnected', () => {
  // This computer's clock is an hour behind the server's: only the time since the answer arrived counts, not this clock's own time.
  const receivedAt = T0 - 3_600_000
  const data = { view: view([device()]), receivedAt }
  const at = (seconds: number) => ageView(data, receivedAt + seconds * 1000)
  assert.equal(at(0).now, T0)
  assert.equal(at(0).view.devices[0]!.state, 'live')
  assert.equal(at(30).view.devices[0]!.state, 'live')
  assert.equal(at(31).now, T0 + 31_000)
  assert.equal(at(31).view.devices[0]!.state, 'stale')
  assert.equal(at(120).view.devices[0]!.state, 'stale')
  assert.equal(at(121).view.devices[0]!.state, 'disconnected')
  assert.deepEqual(at(121).view.devices[0]!.readings.map((r) => r.state), ['disconnected', 'disconnected'])
  // Everything else in the answer is as the server sent it, and the answer itself is not changed.
  assert.equal(at(121).view.consent, 'granted')
  assert.deepEqual(at(121).view.thresholds, limits)
  assert.equal(data.view.devices[0]!.state, 'live')
})

test('nothing attached (or nothing read) is summarised as no device, never as a state', () => {
  for (const s of [summarizeDevices(null), summarizeDevices(view([]))]) {
    assert.equal(s.state, 'none')
    assert.equal(s.label, 'No device attached')
    assert.equal(s.attached, 0)
    assert.equal(s.simulated, false)
    assert.equal(s.unverified, false)
    assert.deepEqual(s.counts, { live: 0, stale: 0, disconnected: 0, no_data: 0, unavailable: 0 })
  }
})

test('one device is summarised by its own state, in plain words', () => {
  const one = (over: Partial<AttachedDevice>) => summarizeDevices(view([device(over)]))
  assert.deepEqual([one({ state: 'live' }).state, one({ state: 'live' }).label], ['live', 'Device live'])
  assert.deepEqual([one({ state: 'stale' }).state, one({ state: 'stale' }).label], ['stale', 'Device reading stale'])
  assert.deepEqual([one({ state: 'disconnected' }).state, one({ state: 'disconnected' }).label], ['disconnected', 'Device not connected'])
  assert.equal(one({ state: 'no_data' }).label, 'Device: no data')
  assert.equal(one({ state: 'unavailable' }).label, 'Device unavailable')
  assert.equal(one({ state: 'live' }).attached, 1)
})

test('several devices are summarised by the most concerning state among them, with how many are in it', () => {
  const s = summarizeDevices(view([device({ state: 'live' }), simulator({ state: 'disconnected' })]))
  assert.equal(s.state, 'disconnected')
  assert.equal(s.label, 'Device not connected (1 of 2)')
  assert.equal(s.attached, 2)
  assert.deepEqual(s.counts, { live: 1, stale: 0, disconnected: 1, no_data: 0, unavailable: 0 })
  // The order: disconnected, unavailable, no data, stale, live.
  const worst = (...states: AttachedDevice['state'][]) => summarizeDevices(view(states.map((state) => device({ state })))).state
  assert.equal(worst('live', 'unavailable', 'no_data'), 'unavailable')
  assert.equal(worst('stale', 'no_data'), 'no_data')
  assert.equal(worst('live', 'stale', 'live'), 'stale')
  assert.equal(worst('live', 'live'), 'live')
  assert.equal(summarizeDevices(view([device(), device()])).label, 'Device live (2 of 2)')
})

test('a summary says when a simulator is attached and when a device’s values are unverified, and a simulator alone is not "unverified"', () => {
  const sim = summarizeDevices(view([simulator()]))
  assert.equal(sim.simulated, true)
  assert.equal(sim.unverified, false)
  // The label is the state: what a simulator is, is said by the SIMULATED mark beside it, never by a word a device could also have.
  assert.equal(sim.label, 'Device live')
  const real = summarizeDevices(view([device()]))
  assert.equal(real.simulated, false)
  assert.equal(real.unverified, true)
  const both = summarizeDevices(view([device(), simulator()]))
  assert.equal(both.simulated, true)
  assert.equal(both.unverified, true)
})

test('a summary of an aged answer moves only towards stale and disconnected, never back to live', () => {
  const data = { view: view([device(), simulator()]), receivedAt: T0 }
  const at = (seconds: number) => summarizeDevices(ageView(data, T0 + seconds * 1000).view)
  assert.equal(at(0).state, 'live')
  assert.equal(at(31).state, 'stale')
  assert.equal(at(31).label, 'Device reading stale (2 of 2)')
  assert.equal(at(121).state, 'disconnected')
  assert.equal(at(3600).state, 'disconnected')
})

// --- the visit's vital signs: what staff measured stands ---
let n = 0
const obs = (kind: Observation['kind'], value: number, minutesAgo: number, over: Partial<Observation> = {}): Observation => ({
  id: `o${n++}`,
  kind,
  value,
  unit: '',
  flag: 'normal',
  source: 'manual',
  validationStatus: 'manual_entry',
  measuredAt: new Date(T0 - minutesAgo * 60_000).toISOString(),
  deviceLabel: null,
  recordedByName: null,
  visitId: null,
  enteredInError: false,
  ...over,
})
const fromDevice = { source: 'device', validationStatus: 'device_unverified' } as const

test('a stream of newer device readings never displaces what staff measured; a device value stands only where staff measured none', () => {
  const list = [
    obs('heart_rate', 88, 30),
    obs('heart_rate', 131, 1, { ...fromDevice, flag: 'high' }),
    obs('heart_rate', 128, 0, { ...fromDevice, flag: 'high' }),
    obs('spo2', 96, 2, fromDevice),
    obs('spo2', 93, 0, { ...fromDevice, flag: 'low' }),
  ]
  for (const ordered of [list, [...list].reverse()]) {
    const latest = latestPerKind(ordered)
    assert.equal(latest.find((o) => o.kind === 'heart_rate')!.value, 88)
    assert.equal(latest.find((o) => o.kind === 'heart_rate')!.source, 'manual')
    // Nobody measured the saturation: the device's newest value stands, and is counted as a device value.
    assert.equal(latest.find((o) => o.kind === 'spo2')!.value, 93)
    const status = vitalsStatus(ordered)
    assert.equal(status.fromDevice, 1)
    assert.deepEqual(status.outside.map((o) => o.kind), ['spo2'])
  }
})

test('among staff measurements the newest still stands (a re-check)', () => {
  const latest = latestPerKind([obs('temperature', 38.4, 40, { flag: 'high' }), obs('temperature', 37.2, 5), obs('temperature', 39.9, 1, fromDevice)])
  assert.equal(latest[0]!.value, 37.2)
})
