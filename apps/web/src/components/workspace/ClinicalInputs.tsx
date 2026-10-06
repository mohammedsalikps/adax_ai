import { type Encounter, SIMULATION_TICK_MS } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Activity, ChevronDown, ClipboardPlus, Radio } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { type InputTile, type InputValue, inputsDeviceLine, inputTiles, noAdultFlags } from '../../lib/clinicalInputs.ts'
import { ageText, deviceReadingsKey, devicesKey, useObservedDeviceReadings } from '../../lib/devices.ts'
import { encounterKey } from '../../lib/encounters.ts'
import { fmtTime } from '../../lib/format.ts'
import { createBandTick, createTicker, type SimulatorOffer, simulatorOffer, useSimulatorDevices } from '../../lib/simulation.ts'
import { DeviceReadingsCard, ReadingStateBadge } from '../clinical/DeviceReadingsCard.tsx'
import { FlagLabel, RecordVitalsDialog } from '../clinical/Vitals.tsx'
import { Panel } from '../hero/Panel.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'
import { Button } from '../ui/Button.tsx'
import { PanelBoundary } from '../ui/PanelBoundary.tsx'
import { StethoscopePanel } from './StethoscopePanel.tsx'

/** Props of the consultation's clinical inputs panel (DESIGN §5.4 column 2, §7). */
export interface ClinicalInputsProps {
  encounter: Encounter
}

const TAG: Record<InputValue['source'], 'staff' | 'device' | 'simulated'> = { staff: 'staff', device: 'device', stored: 'device', simulated: 'simulated' }

/** When, in the tile's words: staff and stored values by the time they were measured; a device's or a simulator's by its age (it moves on). */
function when(v: InputValue, now: number | null): string {
  if (v.source === 'staff' || v.source === 'stored' || now === null) return fmtTime(v.at)
  return ageText(now - Date.parse(v.at))
}

function ValueRow({ v, large, now }: { v: InputValue; large: boolean; now: number | null }) {
  return (
    <div
      data-testid="input-value"
      data-source={v.source}
      data-state={v.state ?? undefined}
      data-simulated={v.source === 'simulated'}
      className={large ? 'mt-0.5' : 'mt-1.5 border-t border-line pt-1.5'}
    >
      <p className={`flex flex-wrap items-baseline gap-x-1 ${v.current ? '' : 'text-ink-muted'}`}>
        <span className={`${large ? 'text-2xl' : 'text-base'} leading-tight font-semibold tabular-nums`}>{v.value}</span>
        <span className="text-sm text-ink-muted">{v.unit}</span>
        {v.missingHalf && <span className="sr-only">({v.missingHalf} not recorded)</span>}
        <FlagLabel flag={v.flag} />
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[0.6875rem] leading-4 text-ink-muted">
        <SourceTag kind={TAG[v.source]} />
        {v.showState && v.state && <ReadingStateBadge state={v.state} compact />}
        <span>{when(v, now)}</span>
      </p>
    </div>
  )
}

/**
 * One tile: the patient's value large (staff's first, else a device's), its source, and its time or state; a simulator's value, if one is
 * running, under a line, small, marked SIMULATED: never in the place of the patient's value. Nothing real: "Not recorded".
 */
function Tile({ t, now }: { t: InputTile; now: number | null }) {
  const real = t.values.filter((v) => v.source !== 'simulated')
  const sim = t.values.find((v) => v.source === 'simulated')
  return (
    <li className="min-w-0 rounded-lg bg-canvas px-3 py-2.5" data-testid="input-tile" data-kind={t.key} data-source={real[0]?.source ?? 'none'}>
      <p className="text-xs font-medium text-ink-muted">
        <span aria-hidden="true">{t.short}</span>
        <span className="sr-only">{t.label}</span>
      </p>
      {real.map((v, i) => (
        <ValueRow key={v.source} v={v} large={i === 0} now={now} />
      ))}
      {t.missing && (
        <p className="mt-1 text-sm text-ink-muted" data-testid="input-missing">
          {t.missing}
          {t.staffOnly && <span className="sr-only">. Blood pressure is entered by staff.</span>}
        </p>
      )}
      {sim && <ValueRow v={sim} large={false} now={now} />}
    </li>
  )
}

/**
 * The device card, memoised: this panel re-renders every second (the ages on the tiles), the card only when its own reads or ages say so. It is
 * the page's one reader of the device readings, so it stays mounted while "Device details" is folded.
 */
const DeviceCard = memo(function DeviceCard({ patientId, encounterId }: { patientId: string; encounterId: string }) {
  return <DeviceReadingsCard patientId={patientId} encounterId={encounterId} variant="consultation" />
})

/**
 * The "Simulate band" control: while on (and the page is shown), the server is asked for one batch of generated values every five seconds; it
 * attaches a simulator band first when none is attached (the server picks a free one, or one nobody is using now). It stops when switched off,
 * when the page closes, and when the server refuses (it then says why). The values arrive on the device card's next read, marked SIMULATED.
 */
function useBandSimulation(encounter: Encounter, offer: SimulatorOffer) {
  const qc = useQueryClient()
  const [on, setOn] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Whether a simulator band is attached already (then no attach is asked for). Set when the registry or the device card says so, and by the
  // ticker itself once it has attached one.
  const attached = useRef(offer === 'attached')
  useEffect(() => {
    attached.current = offer === 'attached'
  }, [offer])
  const runnable = encounter.status === 'in_progress' && encounter.canEdit
  const encounterId = encounter.id
  const patientId = encounter.patient.id

  useEffect(() => {
    if (!on || !runnable) return
    const ticker = createTicker({
      intervalMs: SIMULATION_TICK_MS,
      // Attaches when needed, and again (once) when the attachment this page believed in turns out to be gone; the registry is read again then,
      // after an attach and whenever the band stops, so that the control does not go on trusting an old list.
      tick: createBandTick({
        attached,
        attach: () => api(`/encounters/${encounterId}/simulation/attach`, { method: 'POST', body: { kind: 'band' } }),
        tick: () => api(`/encounters/${encounterId}/simulation/band-tick`, { method: 'POST', body: {} }),
        refreshDevices: () => void qc.invalidateQueries({ queryKey: devicesKey }),
        // The first values are shown at once; after that the device card's own five-second read brings them.
        onFirstValues: () => void qc.invalidateQueries({ queryKey: deviceReadingsKey(patientId) }),
        onStop: (e) => setProblem(`The simulated band stopped. ${errorMessage(e)}`),
      }),
      isVisible: () => document.visibilityState === 'visible',
      subscribeVisibility: (onChange) => {
        document.addEventListener('visibilitychange', onChange)
        return () => document.removeEventListener('visibilitychange', onChange)
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      onStop: () => setOn(false),
    })
    ticker.start()
    return () => ticker.stop()
  }, [on, runnable, encounterId, patientId, qc])

  const toggle = () => {
    setProblem(null)
    setOn((v) => !v)
  }
  return { on: on && runnable, toggle, problem }
}

/**
 * "Clinical inputs" (DESIGN §5.4 column 2): vital-sign tiles HR · SpO₂ · BP · Temp · RR, each with its value, unit, source (Staff, Device ·
 * UNVERIFIED, SIMULATED) and time or state; blood pressure from staff only, "Not recorded" when absent; a device's value says LIVE or STALE.
 * Under them: the devices in one phrase, "Device details" (the existing device card, kept MOUNTED while folded: it is the page's only reader
 * of the device readings, every five seconds, and this panel and the header only observe what it read), and, only where simulators are allowed
 * and a simulator band is registered (attached here, or one the server may attach), "Simulate band" (SIMULATED). Then the stethoscope
 * (StethoscopePanel, memoised: this panel's per-second renders do not reach it).
 *
 * Staff values come from the consultation (Encounter.vitals); device and simulator values from the device card's query. A simulator's values
 * are never put in a staff number, never flagged against a reference range, and never shown as LIVE. No device is claimed to work.
 *
 * Owner: the Inputs unit. Contract (DESIGN §7): `ClinicalInputs({encounter})`.
 */
export function ClinicalInputs({ encounter }: ClinicalInputsProps) {
  const qc = useQueryClient()
  const patientId = encounter.patient.id
  const { view, now, isError, unreadable } = useObservedDeviceReadings(patientId)
  const devices = useSimulatorDevices()
  const [details, setDetails] = useState(false)
  const [recording, setRecording] = useState(false)
  const detailsId = useId()
  const open = encounter.status === 'in_progress' && encounter.canEdit
  const tiles = inputTiles({ vitals: encounter.vitals, devices: view, paediatric: noAdultFlags(encounter.patient.dateOfBirth) })
  const offer = open ? simulatorOffer({ list: devices.data, readings: view, patientId, kind: 'band' }) : null
  const band = useBandSimulation(encounter, offer)
  // What the devices are doing, in one phrase; never a guess when the device card's answer could not be read (the card says why).
  const line = inputsDeviceLine(view) ?? (unreadable || isError ? 'Device readings could not be read just now · see Device details' : 'Reading the devices…')

  return (
    <Panel
      label="Clinical inputs"
      icon={Activity}
      testId="clinical-inputs"
      actions={
        open && (
          <Button size="sm" variant="ghost" icon={<ClipboardPlus aria-hidden="true" className="size-4" />} onClick={() => setRecording(true)}>
            Record vitals
          </Button>
        )
      }
    >
      <ul className="grid grid-cols-2 gap-2" aria-label="Vital signs" data-testid="input-tiles">
        {tiles.map((t) => (
          <Tile key={t.key} t={t} now={now} />
        ))}
      </ul>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="min-w-0 text-xs text-ink-muted" data-testid="clinical-inputs-devices">
          {line}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {(offer || band.on) && (
            <>
              <Button size="sm" variant={band.on ? 'subtle' : 'ghost'} aria-pressed={band.on} icon={<Radio aria-hidden="true" className="size-4" />} onClick={band.toggle} data-testid="simulate-band">
                Simulate band
              </Button>
              <SourceTag kind="simulated" />
            </>
          )}
          <button
            type="button"
            aria-expanded={details}
            aria-controls={detailsId}
            onClick={() => setDetails((v) => !v)}
            className="inline-flex min-h-control-sm items-center gap-1 rounded-md px-2 text-sm text-ink-muted hover:bg-canvas hover:text-ink"
            data-testid="device-details-toggle"
          >
            Device details
            <ChevronDown aria-hidden="true" className={`size-4 motion-safe:transition-transform motion-safe:duration-150 ${details ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>
      {band.problem && (
        <p role="status" className="mt-1 text-xs text-down" data-testid="simulate-band-problem">
          {band.problem}
        </p>
      )}
      {/* Folded, not unmounted: the card keeps reading the devices every five seconds for this panel and the header. */}
      <div id={detailsId} hidden={!details} className="mt-2" data-testid="device-details">
        {/* A fault in the card stays in the card, and unfolds it so that what failed is seen. */}
        <PanelBoundary label="The device readings" neutral onFault={() => setDetails(true)}>
          <DeviceCard patientId={patientId} encounterId={encounter.id} />
        </PanelBoundary>
      </div>

      {/* The divider is drawn here: the stethoscope group is the first thing in its boundary. */}
      <PanelBoundary label="The stethoscope" neutral className="mt-4 border-t border-line pt-3">
        <StethoscopePanel encounter={encounter} />
      </PanelBoundary>

      {recording && (
        <RecordVitalsDialog
          visitId={encounter.visit.id}
          patientName={encounter.patient.fullName}
          onClose={() => {
            setRecording(false)
            // The consultation's vital signs are read again (the tiles and the header show them).
            void qc.invalidateQueries({ queryKey: encounterKey(encounter.id) })
          }}
        />
      )}
    </Panel>
  )
}
