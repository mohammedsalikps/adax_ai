import type { VitalKind } from '@adaxai/contracts'

/**
 * A DEVICE SIMULATOR for development and tests. It is not a device and nothing here models one: it produces numbers from a seed, so that the
 * device boundary (gateway, reading states, the consultation screen, the AI read path) can be exercised with no hardware. The same seed and
 * index always give the same values. What it produces reaches the application only through the gateway API with the token of a device record
 * registered as a simulator, and the SERVER stores it as `simulated` because of that record, never because of anything said here.
 */
export const SIMULATOR_VERSION = 'device-sim-v1'

export const SIM_SCENARIOS = {
  steady: 'Values that stay within the adult reference ranges',
  rising_heart_rate: 'Heart rate that climbs from the seventies to above 130',
  low_spo2: 'Oxygen saturation that falls from 97 to 89',
  fever: 'Temperature that climbs from 37.2 to 39.4',
  no_readings: 'Steady, then the gateway stays in contact but sends no readings for a while (readings go stale)',
  dropout: 'Steady, then complete silence for a while (the device goes disconnected), then steady again',
} as const
export type SimScenario = keyof typeof SIM_SCENARIOS
export const isSimScenario = (s: string): s is SimScenario => s in SIM_SCENARIOS

/** Ticks during which `no_readings` sends only heartbeats and `dropout` sends nothing at all. */
const QUIET_FROM = 6
const QUIET_TO = 36

/** A small, well-known 32-bit generator (mulberry32): deterministic, no state outside its argument. */
function mulberry32(a: number): number {
  let t = (a + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
/** A number in [0, 1) that depends only on the seed, the tick and which value is asked for. */
const noise = (seed: number, index: number, salt: number) => mulberry32((seed | 0) ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b))
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round1 = (v: number) => Math.round(v * 10) / 10

export interface SimReading {
  kind: VitalKind
  value: number
}

export type SimTick =
  /** Post these readings (and so be seen). */
  | { send: 'readings'; readings: SimReading[] }
  /** Stay in contact, send no reading. */
  | { send: 'heartbeat' }
  /** Say nothing at all. */
  | { send: 'nothing' }

/** What the simulator does at tick `index` of a scenario. Only the kinds a wearable band may send are ever produced (never blood pressure). */
export function simulatedTick(scenario: SimScenario, seed: number, index: number): SimTick {
  const quiet = index >= QUIET_FROM && index < QUIET_TO
  if (scenario === 'dropout' && quiet) return { send: 'nothing' }
  if (scenario === 'no_readings' && quiet) return { send: 'heartbeat' }
  const n = (salt: number) => noise(seed, index, salt) - 0.5
  let heartRate = 72 + Math.round(n(1) * 4)
  let spo2 = 97 + Math.round(n(2) * 2)
  let temperature = 36.8 + round1(n(3) * 0.2)
  const respiratoryRate = 16 + Math.round(n(4) * 2)
  if (scenario === 'rising_heart_rate') heartRate = Math.min(132, 76 + 2 * index) + Math.round(n(1) * 2)
  if (scenario === 'low_spo2') spo2 = Math.max(89, 97 - Math.floor(index / 2))
  if (scenario === 'fever') temperature = Math.min(39.4, round1(37.2 + 0.1 * index))
  return {
    send: 'readings',
    readings: [
      { kind: 'heart_rate', value: clamp(heartRate, 30, 220) },
      { kind: 'spo2', value: clamp(spo2, 70, 100) },
      { kind: 'temperature', value: clamp(round1(temperature), 34, 42) },
      { kind: 'respiratory_rate', value: clamp(respiratoryRate, 6, 60) },
    ],
  }
}

export interface SimRun {
  scenario: SimScenario
  seed: number
  /** When tick 0 is "measured" (milliseconds since the epoch). */
  startMs: number
  intervalMs: number
}

/** The idempotency key of tick `index` of a run: the same run sends the same key for the same tick, so a retry stores nothing twice. */
export const simBatchKey = (run: SimRun, index: number) => `sim:${SIMULATOR_VERSION}:${run.scenario}:${run.seed}:${run.startMs.toString(36)}:${index}`

/** The gateway request body for tick `index`, or null when the scenario sends no readings at that tick. */
export function simulatedBatch(run: SimRun, index: number): { measuredAt: string; idempotencyKey: string; readings: SimReading[] } | null {
  const tick = simulatedTick(run.scenario, run.seed, index)
  if (tick.send !== 'readings') return null
  return { measuredAt: new Date(run.startMs + index * run.intervalMs).toISOString(), idempotencyKey: simBatchKey(run, index), readings: tick.readings }
}

/**
 * A short WAV file of GENERATED TONES for exercising the stethoscope boundary: two decaying low bursts, repeated at a fixed rate so that the
 * file is something other than silence and is recognisably the same on every playback. The rhythm is loosely that of a pulse and nothing more:
 * it is arithmetic, not a recording, not derived from one, not a physiological model, and it must never be listened to as a body sound. The
 * same seed gives the same bytes. 16-bit mono PCM.
 */
export function simulatedToneWav(seed: number, seconds = 4, sampleRate = 4000): Buffer {
  const samples = Math.floor(seconds * sampleRate)
  const data = Buffer.alloc(samples * 2)
  const beatsPerMinute = 66 + Math.round(noise(seed, 0, 9) * 12)
  const period = 60 / beatsPerMinute
  const burst = (t: number, hz: number, gain: number) => (t < 0 || t > 0.12 ? 0 : gain * Math.exp(-t * 38) * Math.sin(2 * Math.PI * hz * t))
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    const inBeat = t % period
    const v = burst(inBeat, 62, 0.8) + burst(inBeat - 0.3, 88, 0.55) + (noise(seed, i, 7) - 0.5) * 0.004
    data.writeInt16LE(Math.round(clamp(v, -1, 1) * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
