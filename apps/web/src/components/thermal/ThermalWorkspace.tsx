import { BODY_SITES, type BodySite, type Encounter, THERMAL_SIM_CASES, type ThermalCapture, type ThermalSimCase, type ThermalWorkspaceEventRequest } from '@adaxai/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Camera, CircleAlert, FileImage, Pause, Play, Plug, Unplug, X } from 'lucide-react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ApiError, errorMessage } from '../../lib/api.ts'
import { useDevices } from '../../lib/devices.ts'
import type { NoteInserter } from '../../lib/insert.ts'
import { cacheThermalCapture, fmtC, noReadingShade, paletteLut, patientThermalKey, sendThermalEvent, usePatientThermal } from '../../lib/thermal.ts'
import {
  CAMERA_STATES,
  CameraReleasedError,
  type CameraState,
  type CameraStatus,
  colourize,
  findNativeBridge,
  frameIsLive,
  NativeBridgeAdapter,
  type NativeThermalBridge,
  type PreviewFrame,
  SimulatorAdapter,
  type ThermalCameraAdapter,
} from '../../lib/thermalCamera.ts'
import { nothingStored, submitCapture } from '../../lib/thermalCapture.ts'
import { fmtTime } from '../../lib/format.ts'
import { ageSex } from '../clinical/PatientBanner.tsx'
import { SimulatedBadge } from '../clinical/DeviceReadingsCard.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, Badge } from '../ui/Feedback.tsx'
import { SelectField, TextField } from '../ui/Form.tsx'
import { DiscardRegionsDialog } from './DiscardRegions.tsx'
import { ThermalSourceBadge } from './ThermalSourceBadge.tsx'
import { ThermalStudy } from './ThermalStudy.tsx'
import { ThermalUploadDialog } from './ThermalUploadDialog.tsx'

/** The words and colour of a camera state on this screen. Colour repeats the word; it is never the only cue. */
const STATE_TONE: Record<CameraState, 'ok' | 'warn' | 'down' | 'neutral' | 'brand'> = {
  disconnected: 'neutral',
  connecting: 'warn',
  connected: 'ok',
  previewing: 'ok',
  capturing: 'brand',
  processing: 'brand',
  capture_failed: 'down',
  device_error: 'down',
}

/** How long "Start live view" stays hidden after the live view was asked for, while the camera has not yet sent its first frame. */
const START_WAIT_MS = 5000

/** The camera's own words for a camera failure (the bridge or the simulator says what went wrong), the server's for a server refusal. */
const failure = (e: unknown) => (e instanceof ApiError ? errorMessage(e) : e instanceof Error && e.message ? e.message : errorMessage(e))

export type ReportEvent = (e: ThermalWorkspaceEventRequest) => void

/** What the workspace itself is doing after CAPTURE (on top of what the camera says). A failure says whether anything may have been stored. */
type Step = { kind: 'idle' } | { kind: 'capturing' } | { kind: 'processing' } | { kind: 'failed'; message: string; stored: 'no' | 'unknown' }

/** What this page asked of the current camera: connecting, starting its live view, or nothing; and the page's own error from it. */
interface Attempt {
  of: ThermalCameraAdapter
  phase: 'connecting' | 'starting' | 'idle'
  error: string | null
}

/**
 * The camera's status and preview, each kept with the adapter it came from: a status or frame from an adapter the screen no longer uses is
 * never shown, and never called live. LIVE needs the camera to say it is previewing and its own latest frame to be recent.
 */
function useCamera(adapter: ThermalCameraAdapter | null) {
  const [seen, setSeen] = useState<{ of: ThermalCameraAdapter; status: CameraStatus } | null>(null)
  const [shot, setShot] = useState<{ of: ThermalCameraAdapter; frame: PreviewFrame } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!adapter) return
    const stop = adapter.subscribe({
      status: (status) => {
        setSeen({ of: adapter, status })
        // A camera that is let go keeps no picture on the screen.
        if (status.state === 'disconnected') setShot(null)
      },
      frame: (frame) => setShot({ of: adapter, frame }),
    })
    setSeen({ of: adapter, status: adapter.getStatus() })
    return stop
  }, [adapter])
  const status = adapter ? (seen?.of === adapter ? seen.status : adapter.getStatus()) : null
  const frame = adapter && shot?.of === adapter ? shot.frame : null
  const hasFrame = frame !== null
  // LIVE is re-judged twice a second while there is a frame: a stream that stops is no longer called live.
  useEffect(() => {
    if (!hasFrame) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [hasFrame])
  const live = status?.state === 'previewing' && frame !== null && frameIsLive(frame.at, now)
  return { status, frame, live }
}

/** A preview frame: the camera's own rendered image (bridge), or the simulator's numbers coloured here (missing pixels in a grey checker). */
function Preview({ frame, live, simulated, label }: { frame: PreviewFrame | null; live: boolean; simulated: boolean; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const lut = useMemo(() => paletteLut('iron'), [])
  useEffect(() => {
    if (frame?.kind !== 'matrix' || !canvas.current) return
    const c = canvas.current
    c.width = frame.width
    c.height = frame.height
    c.getContext('2d')?.putImageData(new ImageData(colourize(frame.matrix, frame.width, frame.height, lut, frame.minC ?? 20, frame.maxC ?? 40, noReadingShade), frame.width, frame.height), 0, 0)
  }, [frame, lut])
  return (
    <figure className="relative overflow-hidden rounded-xl border border-line bg-ink" data-testid="thermal-preview" data-live={live ? 'true' : 'false'}>
      {frame?.kind === 'image' && <img src={frame.src} alt={`Live thermal preview from the ${label}`} className="block aspect-[4/3] w-full object-contain" />}
      {frame?.kind === 'matrix' && <canvas ref={canvas} role="img" aria-label="Simulated thermal preview (generated numbers, not a camera)" className="block aspect-[4/3] w-full" />}
      {!frame && <div className="flex aspect-[4/3] w-full items-center justify-center p-6 text-center text-sm text-white/80">No preview. A thermal preview appears here only while a connected camera is sending frames.</div>}
      <figcaption className="absolute top-2 left-2 flex flex-wrap items-center gap-1.5">
        {live ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-down px-2.5 py-0.5 text-xs font-semibold tracking-wide text-white" data-testid="thermal-live">
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-white" />
            LIVE
          </span>
        ) : (
          frame && <span className="rounded-full bg-ink/70 px-2.5 py-0.5 text-xs font-semibold text-white">NOT LIVE · last frame {fmtTime(new Date(frame.at).toISOString())}</span>
        )}
        {simulated && <SimulatedBadge />}
      </figcaption>
      {frame && frame.minC !== null && frame.maxC !== null && (
        <figcaption className="absolute right-2 bottom-2 rounded-md bg-ink/70 px-2 py-0.5 text-xs text-white tabular-nums">
          Scale {fmtC(frame.minC)} to {fmtC(frame.maxC)}
        </figcaption>
      )}
    </figure>
  )
}

/**
 * The camera, its live view and CAPTURE. Kept apart from the analysis so that preview frames (about 8 a second) and the LIVE check re-render
 * only this part. The adapter is made and let go in one effect, so a re-run (React's development double run included) never leaves the screen
 * holding an adapter that was disposed. The screen around it hears only when a capture is in flight and when one was stored. Used by the
 * consultation's thermal workspace and by the doctor's Thermal page; either way a capture goes into `encounterId`, the doctor's own
 * consultation of `patient` in progress (the API refuses any other), and `where` says so in words.
 */
export const CameraPane = memo(function CameraPane({
  patient: p,
  encounterId,
  where = 'this consultation',
  bridge,
  event,
  guard,
  onBusyChange,
  onCaptured,
}: {
  patient: { id: string; fullName: string; mrn: string }
  encounterId: string
  /** Which consultation the image goes into, in words ("this consultation", "your consultation in progress"). */
  where?: string
  bridge: NativeThermalBridge | null
  event: ReportEvent
  /** Runs `go` now, or after the doctor agrees to discard regions drawn but not saved. */
  guard: (go: () => void) => void
  onBusyChange: (busy: boolean) => void
  onCaptured: (c: ThermalCapture) => void
}) {
  const qc = useQueryClient()
  const devices = useDevices()
  const simulatorAllowed = devices.data?.simulatorAllowed === true
  // The camera: the FLIR ONE bridge when the tablet app provides one; the simulator only when chosen, and only where it is allowed. The
  // simulator's case matters only while it is in use: choosing another case otherwise leaves the real camera alone.
  const [simCase, setSimCase] = useState<ThermalSimCase>('normal')
  const [useSim, setUseSim] = useState(false)
  const simKey = useSim ? simCase : null
  const [adapter, setAdapter] = useState<ThermalCameraAdapter | null>(null)
  const current = useRef<ThermalCameraAdapter | null>(null)
  useEffect(() => {
    const a = simKey ? new SimulatorAdapter(simKey, 1) : bridge ? new NativeBridgeAdapter(bridge) : null
    current.current = a
    setAdapter(a)
    // Leaving (or changing camera) stops the preview and lets the adapter go; a connect still waiting ends with it.
    return () => {
      if (current.current === a) current.current = null
      a?.dispose()
    }
  }, [simKey, bridge])
  const { status, frame, live } = useCamera(adapter)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const att = attempt?.of === adapter ? attempt : null
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [site, setSite] = useState<BodySite | ''>('')
  const [detail, setDetail] = useState('')
  const busy = step.kind === 'capturing' || step.kind === 'processing'

  // "Start live view" comes back if the first frame does not arrive in time.
  useEffect(() => {
    if (att?.phase !== 'starting') return
    const t = setTimeout(() => setAttempt((cur) => (cur === att ? { ...cur, phase: 'idle' } : cur)), START_WAIT_MS)
    return () => clearTimeout(t)
  }, [att])

  const connect = async () => {
    const a = adapter
    if (!a) return
    setAttempt({ of: a, phase: 'connecting', error: null })
    try {
      await a.connect()
      if (current.current !== a) return
      event({ event: 'camera_connected', adapter: a.kind, state: a.getStatus().state, deviceModel: a.getDeviceInfo()?.model ?? null })
      setAttempt({ of: a, phase: 'starting', error: null })
      await a.startPreview()
    } catch (e) {
      // A connect that ended because this camera was let go (the workspace closed, another camera chosen) is nobody's failure.
      if (current.current !== a || e instanceof CameraReleasedError) return
      const reason = failure(e)
      setAttempt({ of: a, phase: 'idle', error: reason })
      event({ event: 'connect_failed', adapter: a.kind, state: a.getStatus().state, reason: reason.slice(0, 200) })
    }
  }
  const startLive = async () => {
    const a = adapter
    if (!a) return
    setAttempt({ of: a, phase: 'starting', error: null })
    try {
      await a.startPreview()
    } catch (e) {
      if (current.current !== a || e instanceof CameraReleasedError) return
      setAttempt({ of: a, phase: 'idle', error: failure(e) })
    }
  }
  const stopLive = () => {
    setAttempt(null)
    void adapter?.stopPreview().catch(() => undefined)
  }
  const disconnect = async () => {
    const a = adapter
    if (!a) return
    setAttempt(null)
    await a.disconnect()
    if (current.current === a) event({ event: 'camera_disconnected', adapter: a.kind, state: 'disconnected' })
  }

  const capture = async () => {
    const a = adapter
    if (!a || !site) return
    setStep({ kind: 'capturing' })
    onBusyChange(true)
    let stage: 'camera' | 'server' = 'camera'
    try {
      const shot = await a.capture()
      stage = 'server'
      setStep({ kind: 'processing' })
      const saved = await submitCapture(p.id, encounterId, shot, { bodyRegion: detail.trim() || BODY_SITES[site], bodySite: site, view: 'other' })
      cacheThermalCapture(qc, saved)
      setStep({ kind: 'idle' })
      onCaptured(saved)
    } catch (e) {
      if (e instanceof CameraReleasedError) return setStep({ kind: 'idle' })
      const message = failure(e)
      const stored = nothingStored(e, stage) ? 'no' : 'unknown'
      // The server may have stored the image before its answer was lost: the list of this consultation's images is read again.
      if (stored === 'unknown') void qc.invalidateQueries({ queryKey: patientThermalKey(p.id) })
      setStep({ kind: 'failed', message, stored })
      event({ event: 'capture_failed', adapter: a.kind, state: `${stage}_failed`, reason: message.slice(0, 200) })
    } finally {
      onBusyChange(false)
    }
  }

  const state = status?.state ?? null
  const connected = state === 'connected' || state === 'previewing' || state === 'capturing'
  // The badge says what the camera says; CAPTURE's own steps are shown on it while they run, and a failed capture only in its own alert.
  const shown: CameraState | null = step.kind === 'capturing' ? 'capturing' : step.kind === 'processing' ? 'processing' : state
  // The page's own connect error is shown only while the camera is not connected: one that connected after the page gave up is shown as it is.
  const errorText = (att?.error && !connected ? att.error : null) ?? status?.error?.message ?? null
  const canConnect = !!adapter && att?.phase !== 'connecting' && !connected
  const canStart = !!adapter && state === 'connected' && att?.phase !== 'connecting' && att?.phase !== 'starting' && !busy
  const canCapture = !!adapter && live && !!site && !busy
  const failedMessage = step.kind === 'failed' ? step.message.trim() : ''

  return (
    <>
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium" data-testid="thermal-camera-status" data-state={shown ?? 'disconnected'}>
            {adapter ? adapter.label : 'FLIR ONE'}:{' '}
            {shown ? (
              <Badge tone={STATE_TONE[shown]} dot>
                {CAMERA_STATES[shown].toUpperCase()}
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                NOT CONNECTED
              </Badge>
            )}
          </p>
          {adapter?.simulated && <SimulatedBadge />}
        </div>
        {!bridge && !useSim && (
          <p className="mt-2 text-sm" data-testid="thermal-no-camera">
            FLIR ONE not connected. This page is not running in the ADAXAI tablet app, so it has no way to reach a thermal camera: a FLIR ONE on the tablet&apos;s USB-C port is reached through that app&apos;s camera bridge, never through a browser.
          </p>
        )}
        {adapter && status?.device && (
          <p className="mt-2 text-xs text-ink-muted">
            {[status.device.model, status.device.serialNumber && `serial ${status.device.serialNumber}`, status.device.programVersion && `firmware ${status.device.programVersion}`, status.device.interface].filter(Boolean).join(' · ')}
          </p>
        )}
        {errorText && (
          <Alert tone="error" className="mt-2">
            {errorText}
          </Alert>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {canConnect && (
            <Button icon={<Plug aria-hidden="true" className="size-4" />} onClick={() => void connect()}>
              Connect
            </Button>
          )}
          {canStart && (
            <Button icon={<Play aria-hidden="true" className="size-4" />} onClick={() => void startLive()}>
              Start live view
            </Button>
          )}
          {adapter && state === 'previewing' && (
            <Button variant="secondary" icon={<Pause aria-hidden="true" className="size-4" />} onClick={stopLive} disabled={busy}>
              Stop live view
            </Button>
          )}
          {adapter && (state === 'connected' || state === 'previewing') && (
            <Button variant="secondary" icon={<Unplug aria-hidden="true" className="size-4" />} onClick={() => void disconnect()} disabled={busy}>
              Disconnect
            </Button>
          )}
        </div>
        {simulatorAllowed && (
          <details className="mt-3 text-sm">
            <summary className="min-h-control-sm cursor-pointer font-medium">Simulator (development and demonstrations)</summary>
            <p className="mt-1 text-xs text-ink-muted">Generated numbers, not a camera and not a measurement of this patient. Everything it produces is stored and shown as SIMULATED and never goes into the note.</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <SelectField label="Case" value={simCase} onChange={(e) => setSimCase(e.target.value as ThermalSimCase)} disabled={busy}>
                {Object.entries(THERMAL_SIM_CASES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </SelectField>
              <Button variant="secondary" onClick={() => setUseSim((u) => !u)} disabled={busy}>
                {useSim ? 'Stop using the simulator' : 'Use the simulator'}
              </Button>
            </div>
          </details>
        )}
      </div>
      <Preview frame={frame} live={live} simulated={!!adapter?.simulated} label={adapter?.label ?? 'camera'} />
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField label="Body region" required value={site} onChange={(e) => setSite(e.target.value as BodySite | '')} disabled={busy}>
            <option value="">Choose the region…</option>
            {Object.entries(BODY_SITES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
          <TextField label="Description (optional)" placeholder="Right knee, anterior" value={detail} maxLength={80} onChange={(e) => setDetail(e.target.value)} disabled={busy} />
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          For {p.fullName} (MRN {p.mrn}), {where}. The region is a label for the image: nothing is inferred from it.
        </p>
        <Button className="mt-3 min-h-14 w-full text-base" icon={<Camera aria-hidden="true" className="size-5" />} onClick={() => guard(() => void capture())} disabled={!canCapture} loading={busy} data-testid="thermal-capture">
          {step.kind === 'processing' ? 'Processing…' : step.kind === 'capturing' ? 'Capturing…' : 'CAPTURE'}
        </Button>
        {!canCapture && !busy && (
          <p className="mt-2 text-xs text-ink-muted">{!adapter ? 'No camera.' : state === 'connected' ? 'Start the live view to capture.' : !live ? 'Capture is possible while the preview is live.' : !site ? 'Choose the body region first.' : ''}</p>
        )}
        {step.kind === 'failed' && (
          <Alert tone="error" title="Capture failed" className="mt-3">
            {step.stored === 'no' ? (
              // The server's own refusals already end with it; it is said once.
              failedMessage.endsWith('Nothing was stored.') ? failedMessage : `${failedMessage} Nothing was stored.`
            ) : (
              <>{failedMessage} The image may or may not have been stored: check the patient&apos;s thermal images before capturing again.</>
            )}
          </Alert>
        )}
      </div>
    </>
  )
})

/**
 * The analysis of one capture: the doctor's thermal study (ThermalStudy, the same as on the Thermal page): the image with its regions, the
 * whole image's numbers, the review, the summary to review and add to the note, and the engineering detail behind "Details".
 */
const Analysis = memo(function Analysis({ captureId, encounter, inserter, canEdit, onDirtyChange }: { captureId: string; encounter: Encounter; inserter: NoteInserter; canEdit: boolean; onDirtyChange: (dirty: boolean) => void }) {
  return (
    <div data-testid="thermal-analysis">
      <ThermalStudy captureId={captureId} encounter={encounter} inserter={inserter} canEdit={canEdit} onDirtyChange={onDirtyChange} level={3} />
    </div>
  )
})

/**
 * THERMAL IMAGING (V6): capturing a thermal image for the consultation's patient and encounter, and reading it. Opened from the consultation's
 * tools column, over it, without leaving it: the consultation stays as it was underneath (a recording keeps recording), and closing this
 * returns to it. The camera is a FLIR ONE on the tablet's USB-C port through the native bridge when the page runs in the ADAXAI tablet app;
 * in a browser there is no camera and the screen says so (a simulator, labelled SIMULATED, where the deployment allows one). A capture is
 * stored for this patient and this encounter only, with where it came from, and measured; nothing reaches the note unless the doctor adds a
 * reviewed summary. The workspace stays open while a capture is in flight, and asks before it discards regions drawn but not saved.
 */
export function ThermalWorkspace({ encounter, inserter, canEdit, initialCaptureId, onClose }: { encounter: Encounter; inserter: NoteInserter; canEdit: boolean; initialCaptureId?: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const p = encounter.patient
  const studies = usePatientThermal(p.id)
  const mine = (studies.data ?? []).filter((c) => c.encounterId === encounter.id)
  const [selected, setSelected] = useState<string | null>(initialCaptureId ?? null)
  const [importing, setImporting] = useState(false)
  const bridge = useMemo(() => findNativeBridge(), [])
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<{ go: () => void } | null>(null)
  // Read by the dialog's own events, which cannot wait for a render.
  const busyRef = useRef(false)
  const dirtyRef = useRef(false)
  const leaving = useRef(false)
  const event = useCallback<ReportEvent>((e) => void sendThermalEvent(encounter.id, e), [encounter.id])
  const onBusyChange = useCallback((b: boolean) => {
    busyRef.current = b
    setBusy(b)
  }, [])
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  const onCaptured = useCallback((c: ThermalCapture) => setSelected(c.id), [])
  const guard = useCallback((go: () => void) => {
    if (dirtyRef.current) setAsk({ go })
    else go()
  }, [])
  const leave = () => {
    leaving.current = true
    dialog.current?.close()
    onClose()
  }
  const requestClose = () => {
    if (!busyRef.current) guard(leave)
  }

  useEffect(() => {
    const d = dialog.current
    if (d && !d.open) d.showModal()
    // The camera path tried on opening is the tablet app's bridge (present or not); the simulator is reported only once it is chosen.
    event({ event: 'workspace_opened', adapter: 'native_bridge', state: bridge ? 'bridge_present' : 'no_bridge' })
  }, [event, bridge])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        // A dialog inside this one (Import, the question about unsaved regions) answers its own Escape: React passes its event up to here.
        if (e.target !== e.currentTarget) return
        e.preventDefault()
        requestClose()
      }}
      onClose={(e) => {
        if (e.target !== e.currentTarget || leaving.current) return
        const d = dialog.current
        if (!d || d.open) return
        // The browser closed it without asking (Chromium lets a repeated Escape through). While a capture is in flight, or regions are unsaved,
        // it is shown again; otherwise the screen follows and the workspace closes.
        if (busyRef.current || dirtyRef.current) {
          d.showModal()
          requestClose()
        } else leave()
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto bg-canvas p-0 text-ink backdrop:bg-ink/50"
      data-testid="thermal-workspace"
    >
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Thermal imaging</p>
            <h2 id={titleId} className="text-lg font-semibold break-words">
              {p.fullName}
            </h2>
            <p className="text-sm text-ink-muted" data-testid="thermal-workspace-context">
              {ageSex(p)} · MRN <span className="font-mono text-ink">{p.mrn}</span> · Token {encounter.visit.tokenNumber} · {encounter.visit.departmentName} · this consultation
            </p>
          </div>
          <Button variant="secondary" icon={<X aria-hidden="true" className="size-4" />} onClick={requestClose} disabled={busy}>
            Back to the consultation
          </Button>
        </div>
      </header>
      <div className="grid grid-cols-1 gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(20rem,30rem)_minmax(0,1fr)]">
        <section aria-label="Camera and capture" className="min-w-0 space-y-4">
          <CameraPane patient={p} encounterId={encounter.id} bridge={bridge} event={event} guard={guard} onBusyChange={onBusyChange} onCaptured={onCaptured} />
          <div className="rounded-xl border border-dashed border-line p-4 text-sm">
            <p className="font-medium">Earlier images</p>
            <p className="mt-1 text-xs text-ink-muted">An earlier radiometric FLIR image from this device can be imported for this consultation. It is labelled IMPORTED.</p>
            <Button className="mt-2" variant="secondary" icon={<FileImage aria-hidden="true" className="size-4" />} onClick={() => guard(() => setImporting(true))} disabled={busy}>
              Import a thermal image
            </Button>
          </div>
          {mine.length > 0 && (
            <nav aria-label="Thermal images in this consultation" className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-medium">In this consultation</p>
              <ul className="mt-2 space-y-1.5">
                {mine.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (c.id !== selected) guard(() => setSelected(c.id))
                      }}
                      aria-current={selected === c.id ? 'true' : undefined}
                      className="flex min-h-control w-full flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-left text-sm hover:bg-canvas aria-[current=true]:border-brand aria-[current=true]:bg-brand-soft"
                    >
                      <ThermalSourceBadge capture={c} />
                      <span className="font-medium">{c.protocol.bodySite ? BODY_SITES[c.protocol.bodySite] : c.protocol.bodyRegion}</span>
                      <span className="text-ink-muted tabular-nums">{fmtTime(c.capturedAt ?? c.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </section>
        <section aria-label="Thermal analysis" className="@container min-w-0">
          {selected ? (
            <Analysis key={selected} captureId={selected} encounter={encounter} inserter={inserter} canEdit={canEdit} onDirtyChange={onDirtyChange} />
          ) : (
            <div className="flex min-h-48 items-center gap-3 rounded-xl border border-dashed border-line p-6 text-sm text-ink-muted">
              <CircleAlert aria-hidden="true" className="size-5 shrink-0" />
              No image yet. Connect the camera, choose the region, and capture; the measurements appear here.
            </div>
          )}
        </section>
      </div>
      {importing && (
        <ThermalUploadDialog
          patientId={p.id}
          encounterId={encounter.id}
          source="gallery_import"
          variant="simple"
          context={`For ${p.fullName} (MRN ${p.mrn}), this consultation.`}
          onClose={() => setImporting(false)}
          onUploaded={(c) => {
            // The dialog has cached the capture and refreshed the lists it appears in.
            setImporting(false)
            setSelected(c.id)
          }}
        />
      )}
      {ask && (
        <DiscardRegionsDialog
          onKeep={() => setAsk(null)}
          onDiscard={() => {
            const { go } = ask
            setAsk(null)
            go()
          }}
        />
      )}
    </dialog>
  )
}
