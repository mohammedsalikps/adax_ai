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

/**
 * The devices attached to a patient and what they are saying, re-read every few seconds and aged every second in between. `now` is the server's
 * clock (the time it answered plus the time since, on this computer's clock), so a wrong clock on this computer does not make an old value look new.
 */
export function usePatientDeviceReadings(patientId: string) {
  const q = useQuery({
    queryKey: deviceReadingsKey(patientId),
    queryFn: async () => ({ view: await api<PatientDeviceReadings>(`/patients/${patientId}/device-readings`), receivedAt: Date.now() }),
    refetchInterval: DEVICE_POLL_MS,
    staleTime: 0,
  })
  const [, tick] = useState(0)
  const watching = !!q.data?.view.devices.length
  useEffect(() => {
    if (!watching) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [watching])
  const now = q.data ? Date.parse(q.data.view.serverTime) + (Date.now() - q.data.receivedAt) : null
  const view = q.data && now !== null ? { ...q.data.view, devices: q.data.view.devices.map((d) => ageDevice(d, now, q.data.view.thresholds)) } : null
  return { view, now, isPending: q.isPending, error: q.error, isError: q.isError, refetch: q.refetch, isFetching: q.isFetching, receivedAt: q.data?.receivedAt ?? null }
}
