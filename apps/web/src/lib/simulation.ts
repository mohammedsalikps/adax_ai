import { type AttachedDevice, type DeviceKind, type DeviceList, type PatientDeviceReadings, SIMULATION_DEVICE_KINDS, type SimulationKind } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { api, ApiError } from './api.ts'
import { devicesKey } from './devices.ts'

/*
 * The device simulator as the consultation drives it (DESIGN §5.4, §6): the server generates every value and recording, behind the doctor's
 * session, through a record registered as a SIMULATOR (POST /api/encounters/:id/simulation/*). This file holds the pure parts (when the controls
 * are offered, what a failed tick means, the tick scheduler) and the one query they read. Nothing here generates a value.
 */

/**
 * The registered devices (GET /api/devices, the same query and key as the device list and the demo consultation): whether simulators are allowed
 * here, and which simulator records exist and are free. Read when a consultation opens and kept for five minutes (each read is audited).
 */
export function useSimulatorDevices() {
  return useQuery({ queryKey: devicesKey, queryFn: () => api<DeviceList>('/devices'), staleTime: 300_000 })
}

/**
 * How a simulator control is offered: one is attached to this patient ('attached'), one is registered and the server may attach it
 * ('attachable': free, or no longer used where it is attached; the server decides, and says why when it cannot), or none is offered (null).
 */
export type SimulatorOffer = 'attached' | 'attachable' | null

/** What the offer reads from the device card's answer: which devices are attached to this patient, and the consent. Nothing that ages. */
export interface AttachedDevicesSummary {
  consent?: PatientDeviceReadings['consent'] | null
  devices?: readonly Pick<AttachedDevice, 'kind' | 'simulated'>[]
}

/**
 * Whether the consultation offers a simulator of `kind`: only where simulators are allowed; "attached" when a simulator record of that kind is
 * attached to this patient (the device card says so, or the registry does) and the consent is not missing; "attachable" when a simulator record
 * of that kind is registered (free, or attached elsewhere: the server moves one that nobody is using now, and refuses with its reason when every
 * one is in use) and the consent is recorded in its current wording (attaching needs it). Otherwise nothing is offered: never a real device record.
 */
export function simulatorOffer(i: { list: DeviceList | null | undefined; readings: AttachedDevicesSummary | null | undefined; patientId: string; kind: SimulationKind }): SimulatorOffer {
  if (i.list?.simulatorAllowed !== true) return null
  const deviceKind: DeviceKind = SIMULATION_DEVICE_KINDS[i.kind]
  const consent = i.readings?.consent ?? null
  if (consent === 'missing') return null
  const records = (i.list.devices ?? []).filter((d) => d.simulated && d.kind === deviceKind && d.status === 'active')
  const attachedHere = (i.readings?.devices ?? []).some((d) => d.simulated && d.kind === deviceKind) || records.some((d) => d.assignment?.patientId === i.patientId)
  if (attachedHere) return 'attached'
  return records.length > 0 && consent === 'granted' ? 'attachable' : null
}

/** The server says the simulator this page believed attached is not (its assignment was ended from the device list, or by a consent withdrawal). */
export const lostAttachment = (e: unknown) => e instanceof ApiError && e.code === 'simulator_not_attached'

/**
 * Runs `act` (a band tick, a simulated recording) with a simulator attached: attaches first when none is believed attached; when the server says
 * the attachment this page believed in is gone, `onLost` is told, and it attaches and tries once more (never in a loop). Any other refusal is
 * the caller's to show.
 */
export async function withSimulatorAttached<T>(d: { believedAttached: boolean; attach: () => Promise<unknown>; act: () => Promise<T>; onLost?: () => void }): Promise<T> {
  if (!d.believedAttached) {
    await d.attach()
    return d.act()
  }
  try {
    return await d.act()
  } catch (e) {
    if (!lostAttachment(e)) throw e
    d.onLost?.()
    await d.attach()
    return d.act()
  }
}

export interface BandTickDeps {
  /** Whether a simulator band is believed attached to this patient (no attach is asked for then). The tick keeps it up to date. */
  attached: { current: boolean }
  attach: () => Promise<unknown>
  tick: () => Promise<unknown>
  /** The registry is read again: after an attach, when an attachment turns out to be gone, and whenever the band stops. */
  refreshDevices: () => void
  /** The first values of this run arrived (shown at once; after that the device card's own read brings them). */
  onFirstValues: () => void
  /** The band stops, and why (the refusal, or the last of `MAX_TICK_RETRIES` failures in a row). */
  onStop: (e: unknown) => void
}

/**
 * One tick of the "Simulate band" control, for the scheduler (createTicker): attaches when needed (and again, once, when the attachment this page
 * believed in is gone), asks for one batch, and decides what a failure means (tickFailure; stop after MAX_TICK_RETRIES in a row).
 */
export function createBandTick(d: BandTickDeps): () => Promise<'continue' | 'stop'> {
  let failures = 0
  let shown = false
  return async () => {
    try {
      await withSimulatorAttached({
        believedAttached: d.attached.current,
        attach: async () => {
          await d.attach()
          d.attached.current = true
          d.refreshDevices()
        },
        act: d.tick,
        onLost: () => {
          d.attached.current = false
          d.refreshDevices()
        },
      })
    } catch (e) {
      if (tickFailure(e) === 'stop' || ++failures >= MAX_TICK_RETRIES) {
        d.refreshDevices()
        d.onStop(e)
        return 'stop'
      }
      return 'continue'
    }
    failures = 0
    if (!shown) d.onFirstValues()
    shown = true
    return 'continue'
  }
}

/**
 * What a failed request of the running band means: try again at the next tick (the server could not be reached, was busy, or limited the rate),
 * or stop and say why (a refusal that the next tick would only repeat: not allowed here, no consent, not attached, the consultation closed).
 */
export function tickFailure(e: unknown): 'retry' | 'stop' {
  if (!(e instanceof ApiError)) return 'retry'
  if (e.status === 0 || e.status === 429 || e.status >= 500 || e.code === 'try_again' || e.code === 'network_error' || e.code === 'service_unavailable') return 'retry'
  return 'stop'
}

/** After this many failed ticks in a row that were worth retrying, the band stops anyway and says why. */
export const MAX_TICK_RETRIES = 3

export interface TickerDeps {
  intervalMs: number
  /** One tick. 'stop' ends the run (the ticker then calls onStop('refused')). */
  tick: () => Promise<'continue' | 'stop'>
  isVisible: () => boolean
  /** Calls `onChange` when the page is shown or hidden; returns the unsubscribe. */
  subscribeVisibility: (onChange: () => void) => () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  onStop?: (reason: 'refused') => void
}

export interface Ticker {
  start: () => void
  stop: () => void
  running: () => boolean
}

/**
 * The band's scheduler, client-driven (there is no server timer: nothing keeps writing after the page closes): a tick at once, then one
 * `intervalMs` after each tick ends (never two at a time); none while the page is hidden, one as soon as it is shown again; stopped for good by
 * `stop()` (on unmount), after which a tick still in flight changes nothing.
 */
export function createTicker(d: TickerDeps): Ticker {
  let running = false
  let busy = false
  let timer: unknown = null
  let generation = 0
  let unsubscribe: (() => void) | null = null

  const clear = () => {
    if (timer !== null) d.clearTimer(timer)
    timer = null
  }
  const run = async () => {
    timer = null
    if (!running || busy) return
    // Hidden: wait for the page to be shown (the visibility handler runs a tick then).
    if (!d.isVisible()) return
    busy = true
    const mine = generation
    let verdict: 'continue' | 'stop' = 'continue'
    try {
      verdict = await d.tick()
    } catch {
      verdict = 'continue'
    }
    busy = false
    if (!running) return
    // Stopped and started again while this tick was in flight: the new run goes on from here.
    if (mine !== generation) {
      if (timer === null) void run()
      return
    }
    if (verdict === 'stop') {
      stop()
      d.onStop?.('refused')
      return
    }
    clear()
    timer = d.setTimer(() => void run(), d.intervalMs)
  }
  const onVisibility = () => {
    if (!running) return
    if (!d.isVisible()) {
      clear()
      return
    }
    if (!busy && timer === null) void run()
  }
  const stop = () => {
    running = false
    generation++
    clear()
    unsubscribe?.()
    unsubscribe = null
  }
  return {
    start: () => {
      if (running) return
      running = true
      generation++
      unsubscribe = d.subscribeVisibility(onVisibility)
      void run()
    },
    stop,
    running: () => running,
  }
}
