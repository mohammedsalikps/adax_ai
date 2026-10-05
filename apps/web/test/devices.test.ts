// Unit tests (node --test) of the pure logic behind the "Device readings" card: how a reading's age is worded, and how a device and its readings
// are aged ON THE SCREEN between two reads from the server (a live value turns stale, a silent gateway turns disconnected), by the same function
// the server uses. No browser, no server, no device.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AttachedDevice, DeviceReading, Observation } from '@adaxai/contracts'
import { ageDevice, ageText } from '../src/lib/devices.ts'
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
