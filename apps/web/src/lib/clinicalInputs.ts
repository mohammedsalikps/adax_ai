import type { Observation, PatientDeviceReadings, ReadingState, Visit, VitalFlag, VitalKind } from '@adaxai/contracts'
import { VITALS } from '@adaxai/contracts'
import { latestPerKind } from './vitals.ts'

/*
 * The pure parts of the consultation's "Clinical inputs" panel and of the header's "Last vitals" line (DESIGN §5.4). No React, no DOM: they are
 * unit-tested in node (test/clinicalInputs.test.ts).
 *
 * Where values come from, and the one rule that matters: SIMULATED IS NEVER REAL.
 *   - Staff values: the consultation's vital signs (Encounter.vitals), typed by a nurse or a doctor.
 *   - Device values (unverified): what an attached device is sending now (the device card's query, aged on the server's clock), or the newest
 *     one a device stored with this visit (Encounter.vitals) when none is sending.
 *   - Simulated values: only from the device card's query, only beside the others, always marked; never in a staff number, never in the header
 *     (the server leaves them out of Encounter.vitals and of every visit's vital signs, and this file drops any that would slip through).
 * Missing is not none: a kind with no value is "Not recorded", never 0 or a bare dash. No reference flag under 18 (none is implemented for
 * children), and never for a simulator's value.
 */

/** The five tiles, in the order the panel shows them. Blood pressure is the two values together, and comes from staff only. */
export type InputTileKey = 'heart_rate' | 'spo2' | 'bp' | 'temperature' | 'respiratory_rate'

export interface InputTileSpec {
  key: InputTileKey
  short: string
  label: string
  unit: string
}

export const INPUT_TILES: readonly InputTileSpec[] = [
  { key: 'heart_rate', short: 'HR', label: 'Heart rate', unit: VITALS.heart_rate.unit },
  { key: 'spo2', short: 'SpO₂', label: 'Oxygen saturation', unit: VITALS.spo2.unit },
  { key: 'bp', short: 'BP', label: 'Blood pressure', unit: VITALS.systolic_bp.unit },
  { key: 'temperature', short: 'Temp', label: 'Temperature', unit: VITALS.temperature.unit },
  { key: 'respiratory_rate', short: 'RR', label: 'Respiratory rate', unit: VITALS.respiratory_rate.unit },
]

/** What "nothing" is called on a tile and in the header. */
export const NOT_RECORDED = 'Not recorded'

/** staff: typed by staff · device: an attached device sending now (unverified) · stored: a device's value stored with this visit · simulated. */
export type InputSource = 'staff' | 'device' | 'stored' | 'simulated'

export interface InputValue {
  source: InputSource
  /** As the kind's decimals ("38.6"; "118/76" for blood pressure). */
  value: string
  unit: string
  /** When it was measured (ISO). */
  at: string
  /** A device's or a simulator's state now (aged); null for staff and stored values. */
  state: ReadingState | null
  /** Whether the state is shown as a chip: a simulator's value is never said to be LIVE (SIMULATED and its age say what it is). */
  showState: boolean
  /** The adult reference flag; never for a simulator's value, never under 18. */
  flag: VitalFlag | null
  /** False for a device's or a simulator's value that is not live: it is the last one received, shown greyed. */
  current: boolean
  /** The device record it came through, when it came through one. */
  device: string | null
  /** Blood pressure: the half that was not recorded, when staff recorded only one of the two. */
  missingHalf?: 'systolic' | 'diastolic'
}

export interface InputTile extends InputTileSpec {
  /** In the order shown: staff's; then a device's (sending now) or one a device stored with this visit; then a simulator's. */
  values: InputValue[]
  /**
   * "Not recorded" when nothing real is there (no staff value and no device value), else null. A simulator's value does not change that: it is
   * shown under the words, apart, and never stands for the patient's value.
   */
  missing: string | null
  /** Blood pressure is entered by staff: no device pipeline for it has been validated. */
  staffOnly: boolean
}

export interface InputTilesInput {
  /** The consultation's vital signs (Encounter.vitals). */
  vitals: Observation[] | null | undefined
  /** The device card's answer, aged to now (lib/devices.ts ageView), or null when it has not been read. */
  devices: PatientDeviceReadings | null | undefined
  /** The patient is under 18: no reference flag at all. */
  paediatric: boolean
}

const fmt = (kind: VitalKind, v: number) => (Number.isFinite(v) ? v.toFixed(VITALS[kind]?.decimals ?? 0) : '?')

/** A reading the record may show: not entered in error, and never a simulator's (the server leaves those out; this is the second guard). */
const usable = (o: Observation | null | undefined): o is Observation => !!o && !o.enteredInError && o.validationStatus !== 'simulated'

function newestPerKind(xs: Observation[]): Map<VitalKind, Observation> {
  const m = new Map<VitalKind, Observation>()
  for (const o of xs) {
    const c = m.get(o.kind)
    if (!c || o.measuredAt > c.measuredAt) m.set(o.kind, o)
  }
  return m
}

const RANK = (f: VitalFlag | null) => (f === null ? -1 : f === 'normal' ? 0 : f.startsWith('critical') ? 2 : 1)
const worst = (a: VitalFlag | null, b: VitalFlag | null): VitalFlag | null => (RANK(a) >= RANK(b) ? a : b)

/** The staff values and the device values stored with this visit, newest of each kind. */
export function visitValues(vitals: Observation[] | null | undefined) {
  const all = (Array.isArray(vitals) ? vitals : []).filter(usable)
  return { staff: newestPerKind(all.filter((o) => o.source !== 'device')), stored: newestPerKind(all.filter((o) => o.source === 'device')) }
}

/** The newest reading of `kind` the attached devices are sending now: from devices that are not simulators, or from simulators only. */
function newestFromDevices(devices: PatientDeviceReadings | null | undefined, kind: VitalKind, simulated: boolean) {
  let best: { value: number; unit: string; at: string; state: ReadingState; flag: VitalFlag | null; device: string } | null = null
  for (const d of devices?.devices ?? []) {
    for (const r of d.readings ?? []) {
      const isSim = d.simulated || r.validationStatus === 'simulated'
      if (r.kind !== kind || isSim !== simulated) continue
      if (best && r.measuredAt <= best.at) continue
      best = { value: r.value, unit: r.unit, at: r.measuredAt, state: r.state, flag: r.flag, device: d.label }
    }
  }
  return best
}

/**
 * The five tiles. A staff value comes first; a device's value (sending now, unverified, with its state) or, when no device is sending, the one a
 * device stored with this visit, after it; a simulator's last, apart, never in place of the others. Blood pressure: staff only.
 */
export function inputTiles(i: InputTilesInput): InputTile[] {
  const { staff, stored } = visitValues(i.vitals)
  const flagOf = (f: VitalFlag | null | undefined) => (i.paediatric ? null : (f ?? null))
  return INPUT_TILES.map((spec): InputTile => {
    const values: InputValue[] = []
    if (spec.key === 'bp') {
      const s = staff.get('systolic_bp')
      const d = staff.get('diastolic_bp')
      if (s || d) {
        const at = [s?.measuredAt, d?.measuredAt].filter((x): x is string => !!x).sort().at(-1)!
        values.push({
          source: 'staff',
          value: `${s ? fmt('systolic_bp', s.value) : '—'}/${d ? fmt('diastolic_bp', d.value) : '—'}`,
          unit: spec.unit,
          at,
          state: null,
          showState: false,
          flag: flagOf(worst(s?.flag ?? null, d?.flag ?? null)),
          current: true,
          device: null,
          ...(!s ? { missingHalf: 'systolic' as const } : !d ? { missingHalf: 'diastolic' as const } : {}),
        })
      }
      return { ...spec, values, missing: values.length ? null : NOT_RECORDED, staffOnly: true }
    }
    const kind: VitalKind = spec.key
    const s = staff.get(kind)
    if (s) values.push({ source: 'staff', value: fmt(kind, s.value), unit: s.unit || spec.unit, at: s.measuredAt, state: null, showState: false, flag: flagOf(s.flag), current: true, device: null })
    const live = newestFromDevices(i.devices, kind, false)
    const kept = stored.get(kind)
    if (live) values.push({ source: 'device', value: fmt(kind, live.value), unit: live.unit || spec.unit, at: live.at, state: live.state, showState: true, flag: flagOf(live.flag), current: live.state === 'live', device: live.device })
    else if (kept) values.push({ source: 'stored', value: fmt(kind, kept.value), unit: kept.unit || spec.unit, at: kept.measuredAt, state: null, showState: false, flag: flagOf(kept.flag), current: true, device: kept.deviceLabel })
    const sim = newestFromDevices(i.devices, kind, true)
    const real = values.length
    if (sim) values.push({ source: 'simulated', value: fmt(kind, sim.value), unit: sim.unit || spec.unit, at: sim.at, state: sim.state, showState: sim.state !== 'live', flag: null, current: sim.state === 'live', device: sim.device })
    return { ...spec, values, missing: real ? null : NOT_RECORDED, staffOnly: false }
  })
}

/** The device line under the tiles: the devices that send vital signs (a stethoscope sends none; it is in its own section), in one phrase. */
export function inputsDeviceLine(devices: PatientDeviceReadings | null | undefined): string | null {
  if (!devices) return null
  const senders = (devices.devices ?? []).filter((d) => Array.isArray(d.kinds) && d.kinds.length > 0)
  if (!senders.length) return devices.consent === 'missing' ? 'No device attached · consent to device readings not recorded' : 'No device attached'
  const live = senders.filter((d) => d.state === 'live')
  if (live.length === senders.length) return live.every((d) => d.simulated) ? 'Simulator sending (not a device)' : live.some((d) => d.simulated) ? 'Device live · simulator sending' : 'Device live'
  const worstState = (['disconnected', 'unavailable', 'no_data', 'stale'] as const).find((s) => senders.some((d) => d.state === s))
  const words: Record<string, string> = { disconnected: 'not connected', unavailable: 'unavailable', no_data: 'no data yet', stale: 'reading stale' }
  const who = senders.every((d) => d.simulated) ? 'Simulator' : 'Device'
  return `${who} ${words[worstState ?? 'stale']}`
}

// --- The header's "Last vitals" line ----------------------------------------------------------------------------------------------------------

export type SnapshotKey = 'heart_rate' | 'bp' | 'spo2' | 'temperature'

const SNAPSHOT: readonly { key: SnapshotKey; short: string; label: string }[] = [
  { key: 'heart_rate', short: 'HR', label: 'Heart rate' },
  { key: 'bp', short: 'BP', label: 'Blood pressure' },
  { key: 'spo2', short: 'SpO₂', label: 'Oxygen saturation' },
  { key: 'temperature', short: 'Temp', label: 'Temperature' },
]

/** How a value is written in the header: "124", "118/76", "96%", "38.6°C". */
const SNAP_UNIT: Record<SnapshotKey, string> = { heart_rate: '', bp: '', spo2: '%', temperature: '°C' }

/** One earlier visit's value of a kind, as the header writes it, and that visit's date (YYYY-MM-DD). */
export type PreviousVitals = Partial<Record<SnapshotKey, { text: string; date: string }>>

export interface SnapshotItem {
  key: SnapshotKey
  short: string
  label: string
  /** "124", "118/76", "96%", "38.6°C"; null when not recorded. */
  text: string | null
  /** From a device that is not validated (staff measured none of this kind). */
  device: boolean
  /** The adult reference flag (never under 18). */
  flag: VitalFlag | null
  /** When it was measured (ISO), null when not recorded. */
  at: string | null
  previous: { text: string; date: string } | null
}

function bpText(s: Observation | undefined, d: Observation | undefined): string | null {
  if (!s && !d) return null
  return `${s ? fmt('systolic_bp', s.value) : '—'}/${d ? fmt('diastolic_bp', d.value) : '—'}`
}

/**
 * The header's line, from the consultation's vital signs ONLY (never the device card's query, which holds simulated values): what staff
 * measured stands over what a device stored (lib/vitals latestPerKind); a device's value is marked; a kind with neither is "not recorded".
 */
export function vitalsSnapshot(i: { vitals: Observation[] | null | undefined; previous?: PreviousVitals | null | undefined; paediatric: boolean }): SnapshotItem[] {
  const latest = latestPerKind((Array.isArray(i.vitals) ? i.vitals : []).filter(usable))
  const by = (k: VitalKind) => latest.find((o) => o.kind === k)
  return SNAPSHOT.map(({ key, short, label }): SnapshotItem => {
    const previous = i.previous?.[key] ?? null
    if (key === 'bp') {
      const s = by('systolic_bp')
      const d = by('diastolic_bp')
      const text = bpText(s, d)
      const at = [s?.measuredAt, d?.measuredAt].filter((x): x is string => !!x).sort().at(-1) ?? null
      return { key, short, label, text, device: [s, d].some((o) => o?.source === 'device'), flag: i.paediatric ? null : worst(s?.flag ?? null, d?.flag ?? null), at, previous }
    }
    const o = by(key)
    if (!o) return { key, short, label, text: null, device: false, flag: null, at: null, previous }
    const flag = i.paediatric || o.flag === 'normal' ? null : o.flag
    return { key, short, label, text: `${fmt(key, o.value)}${SNAP_UNIT[key]}`, device: o.source === 'device', flag, at: o.measuredAt, previous }
  })
}

/** The line as plain words ("HR 124 · BP not recorded · SpO₂ 96% · Temp 38.6°C"), for a title or a test. */
export function snapshotLine(items: SnapshotItem[]): string {
  return items.map((it) => `${it.short} ${it.text ?? 'not recorded'}${it.device ? ' (device, unverified)' : ''}${it.previous ? ` (prev ${it.previous.text})` : ''}`).join(' · ')
}

/**
 * Each kind's value at the most recent EARLIER visit that has one: other visits of the patient, checked in before this one, not cancelled; what
 * STAFF measured only (an unverified device value is not set beside a measurement, and a simulator's never reaches a visit). `visits` is GET
 * /api/patients/:id/visits (newest first, each with its latest vital signs).
 */
export function previousVitals(visits: Visit[] | null | undefined, current: { id: string; visitDate: string }): PreviousVitals {
  const list = Array.isArray(visits) ? visits : []
  const me = list.find((v) => v.id === current.id)
  const earlier = list
    .filter((v) => v.id !== current.id && v.status !== 'cancelled')
    .filter((v) => (me ? v.checkedInAt < me.checkedInAt : v.visitDate < current.visitDate))
    .sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt))
  const out: PreviousVitals = {}
  for (const v of earlier) {
    const staff = newestPerKind((v.latestVitals ?? []).filter((o) => usable(o) && o.source !== 'device'))
    for (const { key } of SNAPSHOT) {
      if (out[key]) continue
      if (key === 'bp') {
        const text = bpText(staff.get('systolic_bp'), staff.get('diastolic_bp'))
        if (text) out.bp = { text, date: v.visitDate }
        continue
      }
      const o = staff.get(key)
      if (o) out[key] = { text: `${fmt(key, o.value)}${SNAP_UNIT[key]}`, date: v.visitDate }
    }
  }
  return out
}

/** Whole years from a YYYY-MM-DD date of birth on `today`; NaN when it cannot be read. */
export function ageYears(dob: string | null | undefined, today: Date = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob ?? '')
  if (!m) return Number.NaN
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  let age = today.getFullYear() - y
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age--
  return age
}

/** Under 18, or an age that cannot be read: no reference flag is applied (none is implemented for children). */
export const noAdultFlags = (dob: string | null | undefined, today?: Date) => {
  const a = ageYears(dob, today)
  return !Number.isFinite(a) || a < 18
}
