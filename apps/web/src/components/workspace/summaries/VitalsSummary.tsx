import type { Encounter, PatientDeviceReadings, VitalFlag } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../../lib/api.ts'
import { ageText, deviceReadingsKey, type ReceivedDeviceReadings } from '../../../lib/devices.ts'
import { fmtTime } from '../../../lib/format.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { ReadingStateBadge, SimulatedBadge, UnverifiedBadge } from '../../clinical/DeviceReadingsCard.tsx'
import { FlagLabel } from '../../clinical/Vitals.tsx'
import { CLOSED_ONLY, OPEN_ONLY } from '../ModuleShell.tsx'
import { type CompactVitals, deviceCore, NOT_UPDATED, safely, type SummaryState, type VitalTile, type VitalValue, type VitalsView, vitalsAnalysis, vitalsFacts, vitalsState, vitalsView, visitVitals } from './state.ts'

/*
 * Module 3, the vitals: what staff measured in this visit (the encounter) and what the devices attached to the patient are sending (the
 * "Device readings" card's query, re-read every five seconds by that card). The device query is observed with the card's key and function,
 * never enabled: nothing is asked of the server from this file. Between two reads the device values are aged every second on the server's
 * clock, as the card ages them, so a value can only turn stale or disconnected here, never the other way.
 */

const deviceQuery = (patientId: string) =>
  ({
    queryKey: deviceReadingsKey(patientId),
    queryFn: async (): Promise<ReceivedDeviceReadings> => ({ view: await api<PatientDeviceReadings>(`/patients/${patientId}/device-readings`), receivedAt: Date.now() }),
    enabled: false,
  }) as const

/** Aged when the card's answer arrives: the page hears of the devices only when what the chip says changes, not on every poll. */
const selectCore = (d: ReceivedDeviceReadings) => deviceCore(d, Date.now())

/**
 * For the page: the vitals module's chip, what the workflow strip counts (kinds staff measured, device readings, simulated readings), and the
 * same counts for the analysis' list of inputs.
 */
export function useVitalsModule(encounter: Pick<Encounter, 'patient' | 'vitals'>): {
  state: SummaryState
  facts: NonNullable<InputModuleFacts['vitals']>
  analysis: { staffVitals: number; deviceReadings: number; simulatedReadings: number }
} {
  const q = useQuery({ ...deviceQuery(encounter.patient.id), select: selectCore })
  const visit = useMemo(() => visitVitals(encounter.vitals), [encounter.vitals])
  const dev = q.data ?? null
  return { state: vitalsState(visit.staff.size, dev, q.isError), facts: vitalsFacts(visit.staff.size, visit.stored.size, dev), analysis: vitalsAnalysis(visit.staff.size, visit.stored.size, dev) }
}

const UNREADABLE: VitalsView = {
  state: NOT_UPDATED,
  facts: { staff: 0, device: 0, simulated: 0 },
  analysis: { staffVitals: 0, deviceReadings: 0, simulatedReadings: 0 },
  tiles: [],
  compact: null,
  also: null,
  deviceLine: 'The vital signs could not be read just now.',
  consentLine: null,
  paediatric: false,
  now: null,
  attached: 0,
  meta: null,
}

function useVitalsView(encounter: Pick<Encounter, 'patient' | 'vitals'>) {
  const q = useQuery(deviceQuery(encounter.patient.id))
  return safely(() => vitalsView({ vitals: encounter.vitals, dateOfBirth: encounter.patient.dateOfBirth, devices: q.data, devicesFailed: q.isError, nowLocal: Date.now() }), UNREADABLE)
}

/** Renders once a second while `on`, so that a device value's age and state move on between two reads (as on the device card). */
function useSecondTick(on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

const sourceText = (v: VitalValue, now: number | null) => {
  if (v.source === 'staff') return `Staff · ${fmtTime(v.at)}`
  if (v.source === 'stored') return `Stored with this visit · ${fmtTime(v.at)}`
  return `${v.simulated ? 'Simulator' : 'Device'} · ${now === null ? fmtTime(v.at) : ageText(now - Date.parse(v.at))}`
}

function Value({ v, now }: { v: VitalValue; now: number | null }) {
  // A device value that is not live is the last one received: it is shown greyed, as on the device card.
  const current = v.source !== 'device' || v.state === 'live'
  return (
    // A second value of the same kind is under a hairline, not in a box of its own; a simulator's says SIMULATED (and is never LIVE).
    <div
      className="mt-1 [&+&]:mt-1.5 [&+&]:border-t [&+&]:border-line [&+&]:pt-1.5"
      data-testid="summary-vital-value"
      data-source={v.source}
      data-state={v.state ?? undefined}
      data-simulated={v.simulated}
    >
      <p className={`flex flex-wrap items-baseline gap-x-1 ${current ? '' : 'text-ink-muted'}`}>
        <span className="text-xl leading-tight font-semibold">{v.value}</span>
        <span className="text-xs text-ink-muted">{v.unit}</span>
        {!v.simulated && <FlagLabel flag={v.flag} />}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[0.6875rem] leading-snug text-ink-muted">
        {v.simulated && <SimulatedBadge compact />}
        {v.source !== 'staff' && !v.simulated && <UnverifiedBadge compact />}
        {v.showState && v.state && <ReadingStateBadge state={v.state} compact />}
        <span>{sourceText(v, now)}</span>
      </p>
    </div>
  )
}

function Tile({ t, now }: { t: VitalTile; now: number | null }) {
  return (
    <li className="min-w-0 rounded-lg border border-line bg-canvas px-2.5 py-2" data-testid="summary-vital" data-kind={t.kind}>
      <p className="text-xs font-medium text-ink-muted">
        <span aria-hidden="true">{t.short}</span>
        <span className="sr-only">{t.label}</span>
      </p>
      {t.values.length ? t.values.map((v) => <Value key={v.source} v={v} now={now} />) : <p className="mt-1 text-sm text-ink-muted">No reading</p>}
    </li>
  )
}

const FLAG_WORDS: Record<Exclude<VitalFlag, 'normal'>, string> = { low: 'below the adult reference range', high: 'above the adult reference range', critical_low: 'critically low', critical_high: 'critically high' }

/** A value's adult reference-range flag in the closed line: an arrow (a warning sign when critical), and the words for a screen reader. */
function FlagMark({ flag }: { flag: VitalFlag | null }) {
  if (!flag || flag === 'normal') return null
  const critical = flag.startsWith('critical')
  const Icon = critical ? TriangleAlert : flag.endsWith('low') ? ArrowDown : ArrowUp
  return (
    <span className={critical ? 'text-down' : 'text-pending'}>
      <Icon aria-hidden="true" className="inline size-3.5 align-[-2px]" />
      <span className="sr-only"> ({FLAG_WORDS[flag]})</span>
    </span>
  )
}

/**
 * Where the values of the closed line came from, in words and the device marks: "Staff 7:03 am" or "Device UNVERIFIED 4 s ago" when they
 * all came from one place; "Device UNVERIFIED HR, SpO₂, RR   Staff Temp" when from several (the groups are set apart by the gap between them,
 * so a group that wraps to the next line never starts with a separator); a simulator's SIMULATED, a device's state when it is not live.
 */
function Sources({ c, now }: { c: CompactVitals; now: number | null }) {
  const several = c.sources.length > 1
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-muted" data-testid="summary-vitals-sources">
      {c.sources.map((g) => (
        <span key={`${g.mark}-${g.state ?? ''}`} className="inline-flex items-center gap-1 whitespace-nowrap" data-mark={g.mark}>
          {g.mark === 'staff' && <span>Staff</span>}
          {g.mark === 'device' && <span>Device</span>}
          {g.mark === 'stored' && <span>Stored with this visit</span>}
          {g.mark === 'simulated' ? <SimulatedBadge compact /> : g.mark !== 'staff' && <UnverifiedBadge compact />}
          {g.state && <ReadingStateBadge state={g.state} compact />}
          <span className="tabular-nums">{several ? g.kinds.join(', ') : g.at ? (g.mark === 'device' && now !== null ? ageText(now - Date.parse(g.at)) : fmtTime(g.at)) : ''}</span>
        </span>
      ))}
    </p>
  )
}

/**
 * The closed module's one line: heart rate, SpO₂, temperature and respiratory rate, large, each the newest of its kind that is not simulated (a
 * simulator's only where nothing else has that kind, in a dashed frame); a device's value that is not live is greyed. Under it, where the
 * values came from. The open module shows every value, each with its own source, in the tiles.
 */
function CompactLine({ c, now }: { c: CompactVitals; now: number | null }) {
  return (
    <div data-testid="summary-vitals-compact">
      <ul className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5" aria-label="Heart rate, SpO₂, temperature and respiratory rate">
        {c.values.map((v) => (
          <li key={v.kind} className={`inline-flex items-baseline gap-1 whitespace-nowrap ${v.mark === 'simulated' ? 'rounded border border-dashed border-ink/40 px-1' : ''}`} data-kind={v.kind} data-mark={v.mark ?? 'none'}>
            <span className="text-xs text-ink-muted">
              <span aria-hidden="true">{v.short}</span>
              <span className="sr-only">{v.label}</span>
            </span>
            {v.value === null ? (
              <span className="text-ink-muted">
                <span aria-hidden="true">—</span>
                <span className="sr-only">no reading</span>
              </span>
            ) : (
              <>
                <span className={`text-base leading-6 font-semibold ${v.current ? 'text-ink' : 'text-ink-muted'}`}>{v.value}</span>
                {/* Heart rate and respiratory rate are per minute by definition: their unit is read out, not drawn, so the four fit one line. */}
                <span className={v.kind === 'heart_rate' || v.kind === 'respiratory_rate' ? 'sr-only' : 'text-xs text-ink-muted'}>{v.unit}</span>
                <FlagMark flag={v.flag} />
              </>
            )}
          </li>
        ))}
      </ul>
      <Sources c={c} now={now} />
    </div>
  )
}

/**
 * The summary of module 3. Closed: one line of the four values, large, and where they came from. Open: heart rate, SpO₂, temperature and
 * respiratory rate in tiles, each value with where it came from (staff, a device with its state and UNVERIFIED, or a simulator, marked
 * SIMULATED and never LIVE) and when; other kinds staff measured in one line; and the module's fixed lines: blood pressure is never taken from a
 * device, and no reference range is applied to a child.
 */
export function VitalsSummary({ encounter }: { encounter: Pick<Encounter, 'patient' | 'vitals'> }) {
  const v = useVitalsView(encounter)
  useSecondTick(v.attached > 0)
  return (
    <div data-testid="summary-vitals" data-state={v.state.kind}>
      <div className={CLOSED_ONLY}>
        {v.compact ? <CompactLine c={v.compact} now={v.now} /> : <p className="text-ink-muted">No vital signs for this visit yet.</p>}
        {!v.compact && v.deviceLine && <p className="text-xs text-ink-muted">{v.deviceLine}</p>}
      </div>
      <div className={`space-y-2 ${OPEN_ONLY}`}>
        {v.tiles.length > 0 ? (
          <ul className="grid grid-cols-2 gap-2" aria-label="Heart rate, SpO₂, temperature and respiratory rate">
            {v.tiles.map((t) => (
              <Tile key={t.kind} t={t} now={v.now} />
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">No heart rate, SpO₂, temperature or respiratory rate for this visit yet.</p>
        )}
        {v.also && <p>Also measured by staff: {v.also}</p>}
        <div className="space-y-0.5 text-xs text-ink-muted">
          {v.deviceLine && <p data-testid="summary-vitals-devices">{v.deviceLine}</p>}
          {v.consentLine && <p>{v.consentLine}</p>}
          <p>Blood pressure is not accepted from devices.</p>
          {v.paediatric && <p data-testid="summary-vitals-paediatric">No paediatric range is applied.</p>}
        </div>
      </div>
    </div>
  )
}

/** Where the vitals came from and when: staff's newest measurement, and when the device gateway's answer was read. */
export function VitalsMeta({ encounter }: { encounter: Pick<Encounter, 'patient' | 'vitals'> }) {
  const v = useVitalsView(encounter)
  return v.meta ? <span data-testid="summary-vitals-meta">{v.meta}</span> : null
}
