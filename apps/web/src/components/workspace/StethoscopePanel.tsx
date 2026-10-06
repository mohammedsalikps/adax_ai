import { AUSCULTATION_SITES, type AuscultationRecording, type AuscultationSite, type Encounter } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AudioLines, CircleStop, FileAudio, Mic, Stethoscope } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { usePatient } from '../../lib/clinical.ts'
import { deviceReadingsKey, devicesKey, useObservedAttachedDevices } from '../../lib/devices.ts'
import { fmtTime } from '../../lib/format.ts'
import { simulatorOffer, useSimulatorDevices, withSimulatorAttached } from '../../lib/simulation.ts'
import { auscultationsKey, captureLine, deviceLine, MAX_RECORDING_SECONDS, microphoneProblem, PROVENANCE, RAW_AUDIO, UploadDialog } from '../clinical/AuscultationCard.tsx'
import { PanelGroup } from '../hero/Panel.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { useToast } from '../ui/Toast.tsx'
import { recordingClock } from './summaries/state.ts'
import { Waveform } from './Waveform.tsx'

/** Props of the consultation's stethoscope section (DESIGN §5.4 column 2, §7). */
export interface StethoscopePanelProps {
  encounter: Encounter
}

/** How many bars the live input level shows (one every tenth of a second: the last 2.4 s). */
const LEVEL_BARS = 24
const SITE_OPTIONS = Object.entries(AUSCULTATION_SITES) as [AuscultationSite, string][]

/**
 * How loud the audio input is now, from the real signal (Web Audio AnalyserNode, the root mean square of the last samples), ten times a second.
 * It measures loudness for the meter and nothing else: no sound is classified or analysed. Returns the function that stops it.
 */
function levelMeter(stream: MediaStream, onLevel: (v: number) => void): () => void {
  try {
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    const t = setInterval(() => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (const v of buf) sum += v * v
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
    }, 100)
    return () => {
      clearInterval(t)
      void ctx.close().catch(() => undefined)
    }
  } catch {
    // No meter where the browser has no Web Audio: recording does not depend on it.
    return () => undefined
  }
}

/** Where the meter's values go: straight to the bars (LevelBars), so that only the bars re-render ten times a second, never the panel. */
interface LevelFeed {
  push: (v: number) => void
  subscribe: (onLevel: (v: number) => void) => () => void
}

function createLevelFeed(): LevelFeed {
  let listener: ((v: number) => void) | null = null
  return {
    push: (v) => listener?.(v),
    subscribe: (onLevel) => {
      listener = onLevel
      return () => {
        if (listener === onLevel) listener = null
      }
    },
  }
}

type Phase = 'idle' | 'opening' | 'recording' | 'recorded'

/**
 * Records from an audio input of this computer, inline: Record opens the input (speech clean-up off) and starts at once; Stop ends the take,
 * which is played back before it is saved. A digital stethoscope that presents itself as an audio input can be chosen like any other; ADAXAI has
 * not been tested with one and cannot tell what an input is. Unmounting stops the recording and lets go of the input.
 */
function useInlineRecorder() {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
  const [phase, setPhase] = useState<Phase>('idle')
  const [problem, setProblem] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [feed] = useState(createLevelFeed)
  const [take, setTake] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null)
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([])
  const [inputId, setInputId] = useState('')
  const [inputLabel, setInputLabel] = useState('')
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const stopMeter = useRef<(() => void) | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAt = useRef(0)
  const takeUrl = useRef<string | null>(null)
  /** Counts attempts to open the input: one that finishes after another started, or after unmount, is let go. */
  const attempt = useRef(0)

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stopMeter.current?.()
    stopMeter.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }, [])
  const dropTake = useCallback(() => {
    if (takeUrl.current) URL.revokeObjectURL(takeUrl.current)
    takeUrl.current = null
    setTake(null)
  }, [])

  useEffect(
    () => () => {
      attempt.current++
      if (recorder.current) {
        recorder.current.onstop = null
        if (recorder.current.state === 'recording') recorder.current.stop()
      }
      release()
      if (takeUrl.current) URL.revokeObjectURL(takeUrl.current)
    },
    [release],
  )

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  const start = async () => {
    if (!supported || phase === 'opening' || phase === 'recording') return
    setProblem(null)
    dropTake()
    setPhase('opening')
    const mine = ++attempt.current
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW_AUDIO, ...(inputId && { deviceId: { exact: inputId } }) } })
    } catch (e) {
      if (mine !== attempt.current) return
      setProblem(microphoneProblem(e))
      setPhase('idle')
      return
    }
    if (mine !== attempt.current) {
      s.getTracks().forEach((t) => t.stop())
      return
    }
    stream.current = s
    const track = s.getAudioTracks()[0]
    setInputLabel(track?.label ?? '')
    setInputId(track?.getSettings().deviceId ?? inputId)
    void navigator.mediaDevices
      .enumerateDevices()
      .then((all) => setInputs(all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }))))
      .catch(() => undefined)
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    let r: MediaRecorder
    try {
      r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
    } catch {
      release()
      setProblem('This audio input cannot be recorded from. Choose another input, or upload a file. Nothing was recorded.')
      setPhase('idle')
      return
    }
    const parts: Blob[] = []
    r.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data)
    }
    r.onstop = () => {
      const durationMs = Math.round(performance.now() - startedAt.current)
      // The take is made: the input is let go at once, so nothing listens while it is reviewed.
      release()
      const blob = new Blob(parts, { type: (r.mimeType || 'audio/webm').split(';')[0] })
      if (!blob.size) {
        setProblem('Nothing was recorded. Try again.')
        setPhase('idle')
        return
      }
      const url = URL.createObjectURL(blob)
      takeUrl.current = url
      setTake({ blob, url, durationMs })
      setPhase('recorded')
    }
    recorder.current = r
    stopMeter.current = levelMeter(s, feed.push)
    startedAt.current = performance.now()
    setSeconds(0)
    try {
      r.start()
    } catch {
      recorder.current = null
      release()
      setProblem('Recording could not be started on this audio input. Choose another input and try again. Nothing was recorded.')
      setPhase('idle')
      return
    }
    timer.current = setInterval(() => {
      const sec = Math.floor((performance.now() - startedAt.current) / 1000)
      setSeconds(sec)
      if (sec >= MAX_RECORDING_SECONDS) stop()
    }, 250)
    setPhase('recording')
  }

  const reset = () => {
    dropTake()
    setPhase('idle')
  }
  return { supported, phase, problem, seconds, feed, take, inputs, inputId, setInputId, inputLabel, start, stop, reset }
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/**
 * The live input level: bars of the real signal's loudness over the last seconds (decorative: the words beside it say what is happening). It
 * holds the levels itself, fed by the meter, so a new level re-renders these bars only. Mounted while recording: each take starts empty.
 */
function LevelBars({ feed }: { feed: LevelFeed }) {
  const [levels, setLevels] = useState<number[]>([])
  useEffect(() => feed.subscribe((v) => setLevels((l) => [...l.slice(-(LEVEL_BARS - 1)), v])), [feed])
  const bars = [...Array.from({ length: Math.max(0, LEVEL_BARS - levels.length) }, () => 0), ...levels]
  return (
    <span aria-hidden="true" className="inline-flex h-6 items-center gap-px" data-testid="stethoscope-level">
      {bars.map((v, i) => (
        // A fixed row of bars: the position is the identity.
        <span key={i} className="w-1 rounded-sm bg-brand motion-safe:transition-[height] motion-safe:duration-100" style={{ height: `${Math.max(2, Math.round(v * 24))}px`, opacity: v > 0 ? 1 : 0.25 }} />
      ))}
    </span>
  )
}

/**
 * One recording: its site, where it came from (SIMULATED AUDIO for a simulator's tones), when, its length, the amplitude and the player, then,
 * small, how it was captured and through which device (the same lines as the patient record's stethoscope card). Memoised: the panel re-renders
 * while a recording is made, and a row (its waveform, its player) only when its recording changes.
 */
const RecordingRow = memo(function RecordingRow({ r }: { r: AuscultationRecording }) {
  const player = useRef<HTMLAudioElement>(null)
  const site = AUSCULTATION_SITES[r.site] ?? 'Site not stated'
  const name = `${r.simulated ? 'Simulated audio' : 'Stethoscope recording'}, ${site}, ${fmtTime(r.createdAt)}`
  return (
    <li className="border-t border-line py-2.5 first:border-t-0 first:pt-0" data-testid="auscultation" data-capture={r.captureMethod} data-simulated={r.simulated}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{site}</span>
        {r.simulated ? (
          <SourceTag kind="simulated" testId="simulated-badge">
            SIMULATED AUDIO
          </SourceTag>
        ) : (
          <SourceTag kind={r.captureMethod === 'gateway' ? 'device' : 'staff'} testId="auscultation-provenance">
            <span className="sr-only">Source: </span>
            {PROVENANCE[r.captureMethod]}
            {r.captureMethod === 'gateway' ? ' · UNVERIFIED' : ''}
          </SourceTag>
        )}
        <span className="text-xs text-ink-muted tabular-nums">
          {fmtTime(r.createdAt)} · {recordingClock(r)}
        </span>
      </p>
      {r.simulated && <p className="mt-0.5 text-xs text-ink-muted">Generated tones from a simulator: not a body sound, and not a recording of this patient.</p>}
      <div className="mt-1.5">
        <Waveform src={`/api/files/${r.fileId}`} label={name} audio={player} simulated={r.simulated} />
      </div>
      <audio ref={player} controls preload="none" src={`/api/files/${r.fileId}`} className="mt-1 h-9 w-full" aria-label={name} />
      <p className="mt-1 text-xs text-ink-muted" data-testid="auscultation-capture">
        {captureLine(r)}
      </p>
      <p className="text-xs text-ink-muted" data-testid="auscultation-device">
        {deviceLine(r)}
      </p>
    </li>
  )
})

/**
 * "Stethoscope" (DESIGN §5.4 column 2), a group of the clinical inputs panel: Record inline with the live input level of the real signal, the
 * site, this consultation's recordings with a player and the amplitude of each ("Amplitude of the recording. Not an analysis."), a SIMULATED
 * AUDIO recording only where simulators are allowed (generated tones through a simulator record), and the line that no model analyses a
 * recording. Nothing here claims a stethoscope is connected: no stethoscope has been connected to or tested with this system.
 *
 * Owner: the Inputs unit. Contract (DESIGN §7): `StethoscopePanel({encounter})`. It is a PanelGroup: put it inside a Panel (ClinicalInputs does).
 * Memoised on `encounter` (the consultation query's object): the clinical inputs panel re-renders every second for its ages, this does not.
 */
export const StethoscopePanel = memo(function StethoscopePanel({ encounter }: StethoscopePanelProps) {
  const patientId = encounter.patient.id
  const qc = useQueryClient()
  const toast = useToast()
  const patient = usePatient(patientId)
  const list = useQuery({ queryKey: auscultationsKey(patientId), queryFn: () => api<{ recordings: AuscultationRecording[] }>(`/patients/${patientId}/auscultations`), select: (d) => d.recordings })
  const devices = useSimulatorDevices()
  // Which devices are attached (not their ages): re-renders when that changes, never every second.
  const attachedNow = useObservedAttachedDevices(patientId)
  const rec = useInlineRecorder()
  const [site, setSite] = useState<AuscultationSite>('mitral')
  const [uploading, setUploading] = useState(false)
  const open = encounter.status === 'in_progress' && encounter.canEdit
  const consent = patient.data?.consents.find((c) => c.type === 'device_monitoring')?.status
  const consented = consent === 'granted'
  const offer = open ? simulatorOffer({ list: devices.data, readings: attachedNow, patientId, kind: 'stethoscope' }) : null
  const refresh = () => void qc.invalidateQueries({ queryKey: auscultationsKey(patientId) })

  const save = useMutation({
    mutationFn: () => {
      const take = rec.take!
      const fd = new FormData()
      fd.append('site', site)
      fd.append('encounterId', encounter.id)
      fd.append('captureMethod', 'browser_recording')
      fd.append('durationMs', String(take.durationMs))
      if (rec.inputLabel) fd.append('inputLabel', rec.inputLabel.slice(0, 120))
      fd.append('file', take.blob, `stethoscope-recording.${take.blob.type === 'audio/mp4' ? 'm4a' : 'webm'}`)
      return api<AuscultationRecording>(`/patients/${patientId}/auscultations`, { method: 'POST', body: fd })
    },
    onSuccess: () => {
      refresh()
      rec.reset()
      toast('success', 'Recording saved')
    },
  })

  const simulate = useMutation({
    // Attached first when this page does not believe one is attached; attached again, once, when the one it believed in is gone (the server
    // decides which record, and refuses with its reason when every one is in use).
    mutationFn: () =>
      withSimulatorAttached({
        believedAttached: offer === 'attached',
        attach: () => api(`/encounters/${encounter.id}/simulation/attach`, { method: 'POST', body: { kind: 'stethoscope' } }),
        act: () => api<AuscultationRecording>(`/encounters/${encounter.id}/simulation/stethoscope`, { method: 'POST', body: { site } }),
      }),
    onSuccess: () => {
      refresh()
      void qc.invalidateQueries({ queryKey: devicesKey })
      void qc.invalidateQueries({ queryKey: deviceReadingsKey(patientId) })
      toast('success', 'Simulated recording added (SIMULATED AUDIO)')
    },
    // A refusal (every simulator in use, none registered, consent) says why; the registry is read again so that the control reflects it.
    onError: () => void qc.invalidateQueries({ queryKey: devicesKey }),
  })

  const mine = (list.data ?? []).filter((r) => r.encounterId === encounter.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const earlier = (list.data?.length ?? 0) - mine.length
  const busy = rec.phase === 'opening' || rec.phase === 'recording' || save.isPending
  const canRecord = open && consented && rec.supported

  return (
    <PanelGroup label="Stethoscope" icon={Stethoscope} testId="stethoscope-panel">
      {/* A consultation that is not open (signed, or someone else's) shows its recordings only. */}
      <div className={open ? 'flex flex-wrap items-end gap-2' : 'hidden'}>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted">
          Site
          <select value={site} disabled={!open || save.isPending} onChange={(e) => setSite(e.target.value as AuscultationSite)} className="min-h-control-sm rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" data-testid="stethoscope-site">
            {SITE_OPTIONS.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {rec.phase !== 'recording' && rec.phase !== 'recorded' && (
          <Button size="sm" variant="secondary" icon={<Mic aria-hidden="true" className="size-4" />} disabled={!canRecord} loading={rec.phase === 'opening'} onClick={() => void rec.start()} data-testid="auscultation-record">
            Record
          </Button>
        )}
        {rec.phase === 'recording' && (
          <Button size="sm" variant="secondary" icon={<CircleStop aria-hidden="true" className="size-4" />} onClick={rec.stop}>
            Stop
          </Button>
        )}
        {rec.phase === 'idle' && open && consented && (
          <Button size="sm" variant="ghost" icon={<FileAudio aria-hidden="true" className="size-4" />} onClick={() => setUploading(true)}>
            Upload
          </Button>
        )}
        {rec.phase === 'idle' && rec.inputs.length > 1 && (
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted">
            Audio input
            <select value={rec.inputId} onChange={(e) => rec.setInputId(e.target.value)} className="min-h-control-sm max-w-56 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink">
              {rec.inputs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {rec.phase === 'recording' && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="inline-flex items-center gap-2 text-sm font-medium tabular-nums" data-testid="auscultation-recording">
            <span aria-hidden="true" className="size-2 rounded-full bg-down motion-safe:animate-pulse" />
            <span role="status">Recording…</span> {clock(rec.seconds)}
          </p>
          <LevelBars feed={rec.feed} />
          <span className="text-xs text-ink-muted">Stops by itself at {MAX_RECORDING_SECONDS / 60} min</span>
        </div>
      )}

      {rec.phase === 'recorded' && rec.take && (
        <div className="mt-2 space-y-2">
          <p className="text-sm font-medium">Recorded {(rec.take.durationMs / 1000).toFixed(1)} s. Listen before saving:</p>
          <audio controls src={rec.take.url} className="h-9 w-full" aria-label="The recording that has not been saved yet" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              Save recording
            </Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={rec.reset}>
              Discard
            </Button>
          </div>
        </div>
      )}

      {rec.problem && (
        <Alert tone="error" className="mt-2">
          {rec.problem}
        </Alert>
      )}
      {save.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
      {open && patient.data && !consented && <p className="mt-2 text-xs text-ink-muted">Record the patient’s consent to device readings before recording.</p>}
      {open && !rec.supported && <p className="mt-2 text-xs text-ink-muted">This browser cannot record audio here. Upload a file instead.</p>}

      {offer && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={<AudioLines aria-hidden="true" className="size-4" />} disabled={busy} loading={simulate.isPending} onClick={() => simulate.mutate()} data-testid="stethoscope-simulate">
            Simulated recording
          </Button>
          <SourceTag kind="simulated">SIMULATED AUDIO</SourceTag>
        </div>
      )}
      {simulate.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(simulate.error)}
        </Alert>
      )}

      <div className="mt-3">
        {list.isPending && <p className="text-sm text-ink-muted">Reading the recordings…</p>}
        {list.isError && !list.data && (
          <p className="text-sm text-ink-muted">
            The recordings could not be read.{' '}
            <button type="button" className="font-medium text-brand underline-offset-2 hover:underline" onClick={() => void list.refetch()}>
              Try again
            </button>
          </p>
        )}
        {list.data && !mine.length && <p className="text-sm text-ink-muted">Not recorded yet in this consultation.</p>}
        {mine.length > 0 && (
          <ul aria-label="Stethoscope recordings of this consultation" data-testid="stethoscope-recordings">
            {mine.map((r) => (
              <RecordingRow key={r.id} r={r} />
            ))}
          </ul>
        )}
        {earlier > 0 && (
          <p className="mt-1 text-xs text-ink-muted">
            {earlier} earlier recording{earlier === 1 ? '' : 's'} of this patient, on the patient record.
          </p>
        )}
      </div>

      <p className="mt-2 text-xs font-medium text-ink-muted" data-testid="auscultation-no-analysis">
        No clinical sound analysis: recordings are not analysed by any model.
      </p>
      {uploading && (
        <UploadDialog patientId={patientId} encounterId={encounter.id} onClose={() => setUploading(false)} />
      )}
    </PanelGroup>
  )
})
