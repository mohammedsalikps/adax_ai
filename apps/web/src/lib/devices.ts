import { type AttachedDevice, type DeviceList, type PatientDeviceReadings, type ReadingState, readingState } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from './api.ts'

export const devicesKey = ['devices'] as const
export const deviceReadingsKey = (patientId: string) => ['patient', patientId, 'device-readings'] as const
/** How often an open screen asks the server again. There is no push channel: a value is at most this old plus what its state says. */
export const DEVICE_POLL_MS = 5000

export const useDevices = ({ enabled = true }: { enabled?: boolean } = {}) => useQuery({ queryKey: devicesKey, queryFn: () => api<DeviceList>('/devices'), enabled })

const clock = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })
/** A time of day with seconds: a reading that is seconds old must not look like one that is minutes old. */
export const fmtClock = (iso: string | null | undefined) => (iso ? clock.format(new Date(iso)) : '—')

/** A time on the device card: the time of day with seconds when it is today, the date as well when it is not (an assignment can last for weeks). */
export function fmtWhen(iso: string | null | undefined, now: number): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toDateString() === new Date(now).toDateString() ? clock.format(d) : `${day.format(d)}, ${clock.format(d)}`
}

/** How long ago, in words read at a glance. Never "now" for something that is not: under five seconds is "just now". */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

/**
 * One device as it stands at `now` (the server's clock, carried forward): between two reads a live value turns stale, and a silent gateway
 * turns disconnected, on the screen as they would on the server, by the same function. What the server called unavailable stays so, and an
 * assignment whose time runs out between two reads becomes unavailable.
 */
export function ageDevice(d: AttachedDevice, now: number, thresholds: PatientDeviceReadings['thresholds']): AttachedDevice {
  const expired = !!d.validUntil && Date.parse(d.validUntil) <= now
  const available = d.state !== 'unavailable' && !expired
  const lastSeenAt = d.lastSeenAt ? Date.parse(d.lastSeenAt) : null
  const stateOf = (measuredAt: number | null): ReadingState => readingState({ now, measuredAt, lastSeenAt, available }, thresholds)
  const readings = d.readings.map((r) => ({ ...r, state: stateOf(Date.parse(r.measuredAt)) }))
  const newest = readings.length ? Math.max(...readings.map((r) => Date.parse(r.measuredAt))) : null
  const state = stateOf(newest)
  return { ...d, readings, state, reason: state === d.state ? d.reason : (WHY[state]?.(thresholds, lastSeenAt !== null) ?? null) }
}

/** The same sentences the server uses, for a state reached between two reads. */
const WHY: Partial<Record<ReadingState, (t: PatientDeviceReadings['thresholds'], seen: boolean) => string>> = {
  disconnected: (t, seen) => (seen ? `Nothing has been heard from this device’s gateway for more than ${t.disconnectedSeconds} seconds. Any value shown is the last one received.` : 'This device’s gateway has not been in contact since it was registered.'),
  no_data: () => 'The gateway is in contact but has sent no reading since the device was attached.',
  stale: (t) => `The newest reading is more than ${t.liveSeconds} seconds old.`,
  unavailable: () => 'The time this device was attached for is over. End the assignment; it can then be attached again.',
}

/** What the server answered, and when it arrived on this computer's clock. */
export interface ReceivedDeviceReadings {
  view: PatientDeviceReadings
  receivedAt: number
}

const fetchDeviceReadings = async (patientId: string): Promise<ReceivedDeviceReadings> => ({ view: await api<PatientDeviceReadings>(`/patients/${patientId}/device-readings`), receivedAt: Date.now() })

/**
 * A whole answer as it stands at `nowLocal` (this computer's clock): `now` is the server's clock carried forward (the time it answered plus the
 * time since, on this computer's clock), so a wrong clock on this computer does not make an old value look new, and every device is aged to it.
 */
export function ageView(data: ReceivedDeviceReadings, nowLocal: number): { view: PatientDeviceReadings; now: number } {
  const now = Date.parse(data.view.serverTime) + (nowLocal - data.receivedAt)
  return { view: { ...data.view, devices: data.view.devices.map((d) => ageDevice(d, now, data.view.thresholds)) }, now }
}

/** Renders once a second while `on`, so that what is aged on the screen moves on between two reads. */
function useSecondTick(on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

/**
 * The devices attached to a patient and what they are saying, re-read every few seconds and aged every second in between. `now` is the server's
 * clock (the time it answered plus the time since, on this computer's clock), so a wrong clock on this computer does not make an old value look new.
 */
export function usePatientDeviceReadings(patientId: string) {
  const q = useQuery({ queryKey: deviceReadingsKey(patientId), queryFn: () => fetchDeviceReadings(patientId), refetchInterval: DEVICE_POLL_MS, staleTime: 0 })
  useSecondTick(!!q.data?.view.devices.length)
  const aged = q.data ? ageView(q.data, Date.now()) : null
  return { view: aged?.view ?? null, now: aged?.now ?? null, isPending: q.isPending, error: q.error, isError: q.isError, refetch: q.refetch, isFetching: q.isFetching, receivedAt: q.data?.receivedAt ?? null }
}

/** From the most concerning to the least: the state a summary of several devices takes is the first one any of them is in. */
const WORST_FIRST: readonly ReadingState[] = ['disconnected', 'unavailable', 'no_data', 'stale', 'live']

const SUMMARY_LABEL: Record<ReadingState | 'none', string> = {
  none: 'No device attached',
  disconnected: 'Device not connected',
  unavailable: 'Device unavailable',
  no_data: 'Device: no data',
  stale: 'Device reading stale',
  live: 'Device live',
}

export interface DeviceSummary {
  /** How many devices are attached. */
  attached: number
  /** The most concerning state among them ('none' when nothing is attached). */
  state: ReadingState | 'none'
  /** How many attached devices are in each state. */
  counts: Record<ReadingState, number>
  /** True when any attached record is a simulator: something shown with this summary is generated, not measured. */
  simulated: boolean
  /** True when any attached record is not a simulator: its values are device values, and no device has been validated (device_unverified). */
  unverified: boolean
  /** The state in plain words, for a chip; with the count when more than one device is attached. It never says what a simulator is: the chip does. */
  label: string
}

/**
 * The devices attached to a patient in one line: the most concerning state among them (disconnected, unavailable, no data, stale, live, in that
 * order), so that one device that has gone quiet is not hidden behind another that is live. It carries no value of any device.
 */
export function summarizeDevices(view: PatientDeviceReadings | null): DeviceSummary {
  const devices = view?.devices ?? []
  const counts: Record<ReadingState, number> = { live: 0, stale: 0, disconnected: 0, no_data: 0, unavailable: 0 }
  for (const d of devices) counts[d.state]++
  const worst = WORST_FIRST.find((s) => counts[s] > 0)
  const state = worst ?? 'none'
  const label = worst && devices.length > 1 ? `${SUMMARY_LABEL[worst]} (${counts[worst]} of ${devices.length})` : SUMMARY_LABEL[state]
  return { attached: devices.length, state, counts, simulated: devices.some((d) => d.simulated), unverified: devices.some((d) => !d.simulated), label }
}

/**
 * The summary of a patient's devices, for a chip outside the device card. It only OBSERVES the card's query (same key, same function, never
 * enabled): it never asks the server itself and never polls, so the "Device readings" card must be mounted on the same page for it to stay fresh.
 * Between two reads it is aged every second by the same function as the card, from the card's last answer. If that answer is older than two polls
 * and a second (the card is not mounted, or the server cannot be reached), it is still aged the same way, so what it says can only turn stale or
 * disconnected, never the other way; `behind` says so. `summary` is null while nothing has been read: the chip then says nothing rather than guess.
 */
export function useDeviceSummary(patientId: string): { summary: DeviceSummary | null; isError: boolean; behind: boolean } {
  const q = useQuery({ queryKey: deviceReadingsKey(patientId), queryFn: () => fetchDeviceReadings(patientId), enabled: false })
  useSecondTick(!!q.data?.view.devices.length)
  if (!q.data) return { summary: null, isError: q.isError, behind: false }
  const nowLocal = Date.now()
  return { summary: summarizeDevices(ageView(q.data, nowLocal).view), isError: q.isError, behind: q.isError || nowLocal - q.data.receivedAt > 2 * DEVICE_POLL_MS + 1000 }
}
