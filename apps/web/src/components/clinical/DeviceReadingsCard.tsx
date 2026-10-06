import { type AttachedDevice, DEVICE_KINDS, type Device, type DeviceReading, READING_STATES, type ReadingState, usesGateway, VITALS, type VitalKind } from '@adaxai/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, Unlink } from 'lucide-react'
import { useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { ageText, deviceReadingsKey, devicesKey, fmtClock, fmtWhen, useDeviceSummary, useDevices, usePatientDeviceReadings } from '../../lib/devices.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert, Badge, type BadgeTone, ErrorState, Spinner } from '../ui/Feedback.tsx'
import { SelectField, TextField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'
import { FlagLabel, fmtValue } from './Vitals.tsx'

const STATE_TONE: Record<ReadingState, BadgeTone> = { live: 'ok', stale: 'warn', disconnected: 'down', no_data: 'neutral', unavailable: 'neutral' }

const CHIP_TONE: Record<ReadingState, string> = {
  live: 'bg-ok-soft text-ok border-ok/20',
  stale: 'bg-pending-soft text-pending border-pending/20',
  disconnected: 'bg-down-soft text-down border-down/20',
  no_data: 'bg-canvas text-ink-muted border-line',
  unavailable: 'bg-canvas text-ink-muted border-line',
}

/**
 * The state in words, always: colour is never the only thing that says a value is old. `compact` is the chip inside a reading tile, sized so
 * that the longest word (DISCONNECTED) fits the narrowest tile (two to a row from a 17rem list, else one; see DeviceBlock).
 */
export function ReadingStateBadge({ state, compact = false }: { state: ReadingState; compact?: boolean }) {
  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[0.6875rem] leading-4 font-semibold whitespace-nowrap ${CHIP_TONE[state]}`}>
        {state === 'live' && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
        <span data-testid="reading-state">{READING_STATES[state].toUpperCase()}</span>
      </span>
    )
  }
  return (
    <Badge tone={STATE_TONE[state]} dot={state === 'live'}>
      <span data-testid="reading-state">{READING_STATES[state].toUpperCase()}</span>
    </Badge>
  )
}

/**
 * Shown wherever a simulator's value or record appears. A simulator is a program that generates numbers; nothing it sends is a measurement.
 * `compact` is the size of the state chip inside a reading tile, for a row of small chips (the consultation header's).
 */
export function SimulatedBadge({ what = 'SIMULATED', compact = false }: { what?: string; compact?: boolean }) {
  return (
    <span
      data-testid="simulated-badge"
      className={
        compact
          ? 'inline-flex items-center rounded-md border border-dashed border-ink/60 bg-canvas px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide whitespace-nowrap text-ink'
          : 'inline-flex items-center rounded-md border border-dashed border-ink/60 bg-canvas px-2 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap text-ink'
      }
    >
      {what}
    </span>
  )
}

/**
 * Shown beside a device that is not a simulator: no device has been validated with this system, so what it sends is unverified. A solid edge,
 * where SIMULATED has a dashed one, so that the two are never taken for each other.
 */
export function UnverifiedBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      data-testid="unverified-badge"
      className={`inline-flex items-center rounded-md border border-ink/60 bg-surface font-semibold tracking-wide whitespace-nowrap text-ink ${compact ? 'px-1.5 py-px text-[0.6875rem] leading-4' : 'px-2 py-0.5 text-xs'}`}
    >
      UNVERIFIED
    </span>
  )
}

function ReadingTile({ kind, reading, simulated, now }: { kind: VitalKind; reading: DeviceReading | undefined; simulated: boolean; now: number }) {
  const def = VITALS[kind]
  if (!reading) {
    return (
      <li className="min-w-0 rounded-lg border border-line bg-canvas p-2.5" data-testid="device-reading" data-kind={kind} data-state="no_data">
        <p className="text-xs text-ink-muted">{def.label}</p>
        <p className="text-sm text-ink-muted">No reading</p>
      </li>
    )
  }
  const current = reading.state === 'live'
  return (
    <li className={`min-w-0 rounded-lg border p-2.5 ${simulated ? 'border-dashed border-ink/40 bg-canvas' : 'border-line bg-surface'}`} data-testid="device-reading" data-kind={kind} data-state={reading.state}>
      <p className="text-xs text-ink-muted">{def.label}</p>
      <p className="mt-0.5">
        <ReadingStateBadge state={reading.state} compact />
      </p>
      <p className={`mt-0.5 flex flex-wrap items-baseline gap-x-1 text-lg leading-tight font-semibold tabular-nums ${current ? '' : 'text-ink-muted'}`}>
        {fmtValue(reading)}
        <span className="text-xs font-normal text-ink-muted">{reading.unit}</span>
      </p>
      {!simulated && (
        <p className="min-h-4">
          <FlagLabel flag={reading.flag} />
        </p>
      )}
      <p className="text-[0.6875rem] leading-snug text-ink-muted">
        {current ? 'Measured' : 'Last measured'} {fmtWhen(reading.measuredAt, now)} · {ageText(now - Date.parse(reading.measuredAt))}
        <br />
        {simulated ? 'Simulated · not a measurement' : 'Device · unverified'}
      </p>
    </li>
  )
}

/**
 * The card's opt-in variants. `consultation`: an UNVERIFIED mark beside each device that is not a simulator, a disconnected device says so
 * first, and each device says that its signal quality is not reported (no device sends one: nothing here can tell a good contact from a bad one).
 */
export type DeviceCardVariant = 'consultation'

function DeviceBlock({ d, now, onEnd, ending, variant }: { d: AttachedDevice; now: number; onEnd: () => void; ending: boolean; variant?: DeviceCardVariant | undefined }) {
  const consultation = variant === 'consultation'
  const byKind = new Map(d.readings.map((r) => [r.kind, r]))
  // A kind the gate no longer allows but that was stored earlier is still shown: nothing received is hidden.
  const kinds = [...new Set<VitalKind>([...d.kinds, ...d.readings.map((r) => r.kind)])]
  return (
    // A container (its readings go two to a row only where two tiles each fit the longest state word; one to a row in a narrow column, such as
    // the consultation's clinical inputs at 1280px).
    <li className={`@container rounded-lg border p-3 ${d.simulated ? 'border-dashed border-ink/50' : 'border-line'}`} data-testid="attached-device" data-state={d.state} data-simulated={d.simulated}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-words">{d.label}</p>
          <p className="text-xs text-ink-muted">
            {DEVICE_KINDS[d.kind]} · attached {fmtWhen(d.assignedAt, now)}
            {d.validUntil ? ` · until ${fmtWhen(d.validUntil, now)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {d.simulated && <SimulatedBadge />}
          {consultation && !d.simulated && <UnverifiedBadge />}
          <ReadingStateBadge state={d.state} />
        </div>
      </div>
      {d.simulated && <p className="mt-2 text-xs font-medium">A simulator generates these values. They are not measurements of this patient and are not part of the record.</p>}
      <p className="mt-1 text-xs text-ink-muted" data-testid="device-contact">
        {d.lastSeenAt ? `Last contact from its gateway ${fmtWhen(d.lastSeenAt, now)} · ${ageText(now - Date.parse(d.lastSeenAt))}` : 'No contact from its gateway yet'}
      </p>
      {consultation && (
        <p className="mt-1 text-xs text-ink-muted" data-testid="device-signal-quality">
          Signal quality: not reported by the {d.simulated ? 'simulator' : 'device'}
        </p>
      )}
      {d.reason && (
        <p className="mt-1 text-xs" data-testid="device-reason">
          {consultation && d.state === 'disconnected' ? `Device not connected. ${d.reason}` : d.reason}
        </p>
      )}
      {kinds.length > 0 ? (
        <ul className="mt-2 grid grid-cols-1 gap-2 @min-[17rem]:grid-cols-2" aria-label={`Readings from ${d.label}`}>
          {kinds.map((k) => (
            <ReadingTile key={k} kind={k} reading={byKind.get(k)} simulated={d.simulated} now={now} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-ink-muted">This kind of device sends no readings. {d.kind === 'smart_stethoscope' ? 'Its recordings are listed under “Stethoscope recordings”.' : ''}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          {d.readingsStored} reading{d.readingsStored === 1 ? '' : 's'} stored since it was attached
        </p>
        <Button size="sm" variant="ghost" icon={<Unlink aria-hidden="true" className="size-4" />} loading={ending} onClick={onEnd}>
          End
          <span className="sr-only"> the assignment of {d.label}</span>
        </Button>
      </div>
    </li>
  )
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)

function AttachDialog({ patientId, encounterId, onClose }: { patientId: string; encounterId?: string | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const list = useDevices({ fresh: true })
  const [deviceId, setDeviceId] = useState('')
  const [until, setUntil] = useState('')
  const free = (list.data?.devices ?? []).filter((d) => d.status === 'active' && !d.assignment)
  const chosen = free.find((d) => d.id === deviceId)
  const attach = useMutation({
    mutationFn: () => api<Device>(`/devices/${deviceId}/assignments`, { method: 'POST', body: { patientId, ...(encounterId && { encounterId }), ...(until && { validUntil: new Date(until).toISOString() }) } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: deviceReadingsKey(patientId) })
      toast('success', 'Device attached')
      onClose()
    },
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title="Attach a device"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!deviceId} loading={attach.isPending} onClick={() => attach.mutate()}>
            Attach
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-muted">Readings are stored only for the time a device is attached, and only for the patient it is attached to. Administrators register devices.</p>
        {attach.isError && <Alert tone="error">{errorMessage(attach.error)}</Alert>}
        {list.isPending && <Spinner />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
        {list.data && !free.length && <Alert tone="info">No registered device is free. An administrator registers devices; a device in use must be ended first.</Alert>}
        {list.data && free.length > 0 && (
          <>
            <SelectField label="Device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">Choose…</option>
              {free.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} · {DEVICE_KINDS[d.kind]}
                  {d.simulated ? ' · SIMULATOR' : usesGateway(d.integration) ? '' : ' · no gateway'}
                </option>
              ))}
            </SelectField>
            {chosen?.simulated && <Alert tone="warning">This is a simulator, not a device. What it sends is generated, is shown as SIMULATED, and never becomes part of the patient’s record.</Alert>}
            {chosen && !usesGateway(chosen.integration) && <Alert tone="info">This device has no gateway, so no readings will arrive from it. Attaching it records who it is with.</Alert>}
            <TextField label="Attached until (optional)" type="datetime-local" value={until} min={toLocalInput(new Date(Date.now() + 120_000))} onChange={(e) => setUntil(e.target.value)} hint="Readings measured after this time are refused. Leave empty to keep it attached until someone ends it." />
          </>
        )}
      </div>
    </Dialog>
  )
}

/**
 * What the devices attached to this patient are saying NOW: the newest reading of each kind, when it was measured, and whether it is live, stale,
 * from a disconnected device, absent, or unavailable. It is re-read every few seconds; there is no value on this card that the server did not
 * store. No device has been validated with this build: every device value is "unverified", and a simulator's values are marked SIMULATED.
 * This card is the only place that reads them: `DeviceStatusChip` on the same page shows what this card last read, and needs it mounted.
 */
export function DeviceReadingsCard({ patientId, encounterId, variant }: { patientId: string; encounterId?: string | undefined; variant?: DeviceCardVariant | undefined }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { view, now, isPending, isError, error, refetch, isFetching, receivedAt } = usePatientDeviceReadings(patientId)
  const [attaching, setAttaching] = useState(false)
  const [ending, setEnding] = useState<{ assignmentId: string; label: string } | null>(null)
  const end = useMutation({
    mutationFn: (assignmentId: string) => api(`/device-assignments/${assignmentId}/end`, { method: 'POST', body: { reason: encounterId ? 'Ended in the consultation' : 'Ended on the patient record' } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: deviceReadingsKey(patientId) })
      toast('success', 'Assignment ended')
      setEnding(null)
    },
  })
  const consented = view?.consent === 'granted'
  return (
    <div data-testid="device-readings">
      <Card
        title="Device readings"
        actions={
          <Button size="sm" variant="secondary" icon={<Link2 aria-hidden="true" className="size-4" />} disabled={!consented} onClick={() => setAttaching(true)}>
            Attach a device
          </Button>
        }
      >
        <p className="mb-3 text-xs text-ink-muted">What a device’s gateway has sent for this patient. No device has been validated with this system: every device value is unverified. Blood pressure is not accepted from devices.</p>
        {isPending && <Spinner label="Reading the devices…" />}
        {isError && !view && <ErrorState title="Device readings could not be loaded" error={error} onRetry={() => void refetch()} retrying={isFetching} />}
        {isError && view && (
          <Alert tone="error" className="mb-3">
            The server cannot be reached. What is shown was last read at {fmtClock(receivedAt ? new Date(receivedAt).toISOString() : null)} and may have changed since.
          </Alert>
        )}
        {view && view.consent === 'outdated' && (
          <Alert tone="info" className="mb-3">
            The patient agreed to an earlier wording of the consent to device readings. What an attached device sends is still stored; record the consent again on the patient record before attaching a device.
          </Alert>
        )}
        {view && view.consent === 'missing' && (
          <Alert tone="info" className="mb-3">
            The patient’s consent to device readings is not recorded, so no device can be attached and nothing from a device is stored. Record it on the patient record first.
          </Alert>
        )}
        {view && !view.devices.length && (
          <p className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink-muted" data-testid="device-none">
            <span className="font-medium text-ink">Unavailable.</span> No device is attached to this patient.
          </p>
        )}
        {view && now !== null && view.devices.length > 0 && (
          <ul className="space-y-3" aria-label="Attached devices">
            {view.devices.map((d) => (
              <DeviceBlock key={d.assignmentId} d={d} now={now} variant={variant} ending={end.isPending && end.variables === d.assignmentId} onEnd={() => (end.reset(), setEnding({ assignmentId: d.assignmentId, label: d.label }))} />
            ))}
          </ul>
        )}
        {view && view.devices.length > 0 && (
          <p className="mt-3 text-[0.6875rem] leading-snug text-ink-muted">
            Live: measured in the last {view.thresholds.liveSeconds} seconds. Stale: older. Disconnected: nothing heard from the gateway for {view.thresholds.disconnectedSeconds} seconds; the value is the last one received. This card is re-read every few seconds; it is not a monitor and raises no alarm.
          </p>
        )}
      </Card>
      {attaching && <AttachDialog patientId={patientId} encounterId={encounterId} onClose={() => setAttaching(false)} />}
      {ending && (
        <Dialog
          open
          onClose={() => setEnding(null)}
          title="End this assignment?"
          footer={
            <>
              <Button variant="secondary" disabled={end.isPending} onClick={() => setEnding(null)}>
                Keep it attached
              </Button>
              <Button variant="danger" loading={end.isPending} onClick={() => end.mutate(ending.assignmentId)}>
                End assignment
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            {end.isError && <Alert tone="error">{errorMessage(end.error)}</Alert>}
            <p>
              <strong>{ending.label}</strong> will no longer be attached to this patient. What its gateway measures from now on is refused. What was stored stays in the record. The device can be attached again, as a new assignment.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/**
 * The devices attached to this patient in one chip, for the consultation header: the most concerning state among them in words, in that state's
 * colours; SIMULATED when any of them is a simulator; UNVERIFIED when any of them is not. It shows no value of any device. It is what the "Device
 * readings" card on the same page last read, aged every second (see `useDeviceSummary`): it asks the server nothing itself, says nothing until the
 * card has read once, and says "not updated" when the card's last read is more than two polls old. `onSelect` makes it a button that leads to the card.
 */
export function DeviceStatusChip({ patientId, onSelect }: { patientId: string; onSelect?: () => void }) {
  const { summary, behind } = useDeviceSummary(patientId)
  if (!summary) return null
  const { state } = summary
  const content = (
    <>
      <span className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap ${state === 'none' ? CHIP_TONE.unavailable : CHIP_TONE[state]}`}>
        {state === 'live' && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
        <span className={onSelect ? 'underline-offset-2 group-hover:underline' : undefined}>{summary.label}</span>
        {behind && <span className="font-normal">· not updated</span>}
      </span>
      {summary.simulated && <SimulatedBadge compact />}
      {summary.unverified && <UnverifiedBadge compact />}
    </>
  )
  const box = 'inline-flex max-w-full flex-wrap items-center gap-1'
  if (!onSelect) {
    return (
      <span className={box} data-testid="device-status-chip" data-state={state}>
        <span className="sr-only">Devices: </span>
        {content}
      </span>
    )
  }
  const said = [
    `Devices: ${summary.label}.`,
    summary.simulated && (summary.unverified ? 'Some values are simulated; device values are unverified.' : 'Simulated values, not measurements.'),
    summary.unverified && !summary.simulated && 'Device values are unverified.',
    behind && 'Not updated in the last few seconds; it may have changed.',
    'Show device readings',
  ]
  // The visible chip is 28 pixels high; the button's ::before reaches 8 pixels above and below it, so that it is a 44-pixel target that takes no more room.
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={said.filter(Boolean).join(' ')}
      data-testid="device-status-chip"
      data-state={state}
      className={`group relative rounded-full before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] ${box}`}
    >
      {content}
    </button>
  )
}
