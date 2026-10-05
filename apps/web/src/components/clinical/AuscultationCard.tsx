import { AUSCULTATION_CAPTURE, AUSCULTATION_SITES, type AuscultationRecording, type AuscultationSite } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleStop, Mic, Stethoscope } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../../lib/api.ts'
import { usePatient } from '../../lib/clinical.ts'
import { fmtDateTime } from '../../lib/format.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert, Badge, ErrorState, Spinner } from '../ui/Feedback.tsx'
import { SelectField, TextField } from '../ui/Form.tsx'
import { Card } from '../ui/Layout.tsx'
import { useToast } from '../ui/Toast.tsx'
import { SimulatedBadge } from './DeviceReadingsCard.tsx'

const key = (patientId: string) => ['patient', patientId, 'auscultations'] as const
/** A recording is stopped by itself after this long, so that a forgotten one does not grow without end. */
const MAX_RECORDING_SECONDS = 120
/** Speech clean-up (echo cancelling, noise suppression, automatic gain) is made for voices and changes other sounds: it is switched off. */
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as const

const SiteOptions = () =>
  Object.entries(AUSCULTATION_SITES).map(([k, v]) => (
    <option key={k} value={k}>
      {v}
    </option>
  ))

/** How a recording got here, in words. None of these is a verified stethoscope connection, and the list says which it was. */
function captureLine(r: AuscultationRecording): string {
  const parts: string[] = [AUSCULTATION_CAPTURE[r.captureMethod]]
  if (r.captureMethod === 'browser_recording') parts.push(r.inputLabel ? `audio input “${r.inputLabel}” (as named by the browser)` : 'audio input not named by the browser')
  if (r.device) parts.push(r.device.label)
  if (r.durationMs) parts.push(`${(r.durationMs / 1000).toFixed(1)} s`)
  return parts.join(' · ')
}

function microphoneProblem(e: unknown): string {
  const name = (e as { name?: string }).name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The browser did not allow the audio input. Allow the microphone for this site, then try again. Nothing was recorded.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No audio input was found on this computer. Nothing was recorded.'
  return 'The audio input could not be opened. Nothing was recorded.'
}

/**
 * Records from an audio input of this computer, in the browser. If a digital stethoscope presents itself to the computer as an audio input, it can
 * be chosen here like any other input; ADAXAI has not been tested with one and cannot tell what an input is. The recording is kept as "recorded in
 * the browser" with the name the browser gives the input. Nothing is sent until "Save recording".
 */
function RecordDialog({ patientId, encounterId, onClose }: { patientId: string; encounterId?: string | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
  const [phase, setPhase] = useState<'opening' | 'ready' | 'recording' | 'recorded'>('opening')
  const [problem, setProblem] = useState<string | null>(null)
  const [inputs, setInputs] = useState<{ id: string; label: string }[]>([])
  const [inputId, setInputId] = useState('')
  const [inputLabel, setInputLabel] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [take, setTake] = useState<{ blob: Blob; url: string; durationMs: number } | null>(null)
  const [site, setSite] = useState<AuscultationSite>('mitral')
  const [note, setNote] = useState('')
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const startedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const takeUrl = useRef<string | null>(null)
  /** Counts attempts to open an input, so that one that finishes late (after another was chosen, or the dialog closed) is let go. */
  const opening = useRef(0)

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }, [])

  const open = useCallback(
    async (deviceId?: string) => {
      setProblem(null)
      release()
      const mine = ++opening.current
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { ...RAW_AUDIO, ...(deviceId && { deviceId: { exact: deviceId } }) } })
        // Another input was chosen, or the dialog was closed, while this one was opening: let it go at once.
        if (mine !== opening.current) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream.current = s
        const track = s.getAudioTracks()[0]
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
        setInputs(all.map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` })))
        setInputId(track?.getSettings().deviceId ?? deviceId ?? '')
        setInputLabel(track?.label ?? '')
        setPhase('ready')
      } catch (e) {
        if (mine !== opening.current) return
        setProblem(microphoneProblem(e))
        setPhase('ready')
      }
    },
    [release],
  )

  useEffect(() => {
    if (supported) void open()
    return () => {
      // Closing the dialog ends the recording and lets go of the input; a take that was not saved is gone.
      opening.current++
      if (recorder.current) {
        recorder.current.onstop = null
        if (recorder.current.state === 'recording') recorder.current.stop()
      }
      release()
      if (takeUrl.current) URL.revokeObjectURL(takeUrl.current)
    }
  }, [supported, open, release])

  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop()

  const start = () => {
    if (!stream.current) return
    setProblem(null)
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    let r: MediaRecorder
    try {
      r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined)
    } catch {
      setProblem('This audio input cannot be recorded from. Choose another input, or use “Add recording” to upload a file. Nothing was recorded.')
      return
    }
    const parts: Blob[] = []
    r.ondataavailable = (e) => e.data.size && parts.push(e.data)
    r.onstop = () => {
      if (timer.current) clearInterval(timer.current)
      // The take is made: the input is let go at once (it is opened again for another take), so nothing listens while the take is reviewed.
      release()
      const blob = new Blob(parts, { type: (r.mimeType || 'audio/webm').split(';')[0] })
      if (!blob.size) {
        setProblem('Nothing was recorded. Try again.')
        setPhase('ready')
        return
      }
      const url = URL.createObjectURL(blob)
      takeUrl.current = url
      setTake({ blob, url, durationMs: Math.round(performance.now() - startedAt.current) })
      setPhase('recorded')
    }
    recorder.current = r
    startedAt.current = performance.now()
    setSeconds(0)
    try {
      r.start()
    } catch {
      recorder.current = null
      setProblem('Recording could not be started on this audio input. Choose another input and try again. Nothing was recorded.')
      return
    }
    timer.current = setInterval(() => {
      const s = Math.floor((performance.now() - startedAt.current) / 1000)
      setSeconds(s)
      if (s >= MAX_RECORDING_SECONDS) stop()
    }, 250)
    setPhase('recording')
  }

  const again = () => {
    if (takeUrl.current) URL.revokeObjectURL(takeUrl.current)
    takeUrl.current = null
    setTake(null)
    setPhase('opening')
    void open(inputId || undefined)
  }

  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('site', site)
      if (note) fd.append('note', note)
      if (encounterId) fd.append('encounterId', encounterId)
      fd.append('captureMethod', 'browser_recording')
      fd.append('durationMs', String(take!.durationMs))
      if (inputLabel) fd.append('inputLabel', inputLabel.slice(0, 120))
      fd.append('file', take!.blob, `stethoscope-recording.${take!.blob.type === 'audio/mp4' ? 'm4a' : 'webm'}`)
      return api(`/patients/${patientId}/auscultations`, { method: 'POST', body: fd })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(patientId) })
      toast('success', 'Recording saved')
      onClose()
    },
  })

  return (
    <Dialog
      open
      onClose={onClose}
      title="Record from an audio input"
      footer={
        <>
          <Button variant="secondary" disabled={save.isPending} onClick={onClose}>
            {phase === 'recorded' ? 'Discard' : 'Cancel'}
          </Button>
          {phase === 'recorded' && (
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save recording
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="auscultation-recorder">
        <p className="text-ink-muted">
          This records from an audio input of this computer. A digital stethoscope can be chosen below only if it is connected to this computer as an audio input. No stethoscope has been tested with this system, and it cannot tell what an input is: the recording is kept as “recorded in the browser”, with the input’s name as the browser gives it, and is not analysed.
        </p>
        {!supported && <Alert tone="warning">This browser cannot record audio. Use “Add file” to upload a recording instead.</Alert>}
        {problem && <Alert tone="error">{problem}</Alert>}
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {supported && phase === 'opening' && <Spinner label="Opening the audio input…" />}
        {supported && phase !== 'opening' && inputs.length > 0 && (
          <SelectField label="Audio input" value={inputId} disabled={phase !== 'ready'} onChange={(e) => void open(e.target.value)}>
            {inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </SelectField>
        )}
        {supported && phase === 'ready' && stream.current && (
          <Button icon={<Mic aria-hidden="true" className="size-4" />} onClick={start}>
            Start recording
          </Button>
        )}
        {supported && phase === 'ready' && !stream.current && !problem && <Spinner label="Opening the audio input…" />}
        {supported && phase === 'ready' && !stream.current && problem && (
          <Button variant="secondary" onClick={() => void open()}>
            Try again
          </Button>
        )}
        {phase === 'recording' && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-medium tabular-nums" data-testid="auscultation-recording">
              <span role="status">Recording…</span> {seconds} s
              <span className="font-normal text-ink-muted"> (stops by itself at {MAX_RECORDING_SECONDS} s)</span>
            </p>
            <Button variant="secondary" icon={<CircleStop aria-hidden="true" className="size-4" />} onClick={stop}>
              Stop
            </Button>
          </div>
        )}
        {phase === 'recorded' && take && (
          <>
            <div>
              <p className="font-medium">Recorded {(take.durationMs / 1000).toFixed(1)} s. Listen before saving:</p>
              <audio controls src={take.url} className="mt-1 w-full" aria-label="The recording that has not been saved yet" />
              <Button size="sm" variant="ghost" className="mt-1" onClick={again}>
                Record again
              </Button>
            </div>
            <SelectField label="Site" value={site} onChange={(e) => setSite(e.target.value as AuscultationSite)}>
              <SiteOptions />
            </SelectField>
            <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </>
        )}
      </div>
    </Dialog>
  )
}

function UploadDialog({ patientId, encounterId, onClose }: { patientId: string; encounterId?: string | undefined; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [site, setSite] = useState<AuscultationSite>('mitral')
  const [note, setNote] = useState('')
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('site', site)
      if (note) fd.append('note', note)
      if (encounterId) fd.append('encounterId', encounterId)
      fd.append('file', file!, file!.name)
      return api(`/patients/${patientId}/auscultations`, { method: 'POST', body: fd })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: key(patientId) })
      toast('success', 'Recording saved')
      onClose()
    },
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add stethoscope recording"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
            Save recording
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {upload.isError && <Alert tone="error">{errorMessage(upload.error)}</Alert>}
        <label className="block font-medium">
          Audio file (WAV, MP3, M4A, OGG or WebM)
          <input type="file" accept="audio/*" className="mt-1 block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <SelectField label="Site" value={site} onChange={(e) => setSite(e.target.value as AuscultationSite)}>
          <SiteOptions />
        </SelectField>
        <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  )
}

/**
 * Stethoscope recordings: an audio file chosen by staff (for example exported from a digital stethoscope's own app), a recording made in the
 * browser from an audio input, or one sent by a device gateway. Recording, upload and playback only: no stethoscope has been connected to or
 * tested with this build, and nothing is analysed. A recording made by a simulator is generated tones and is marked SIMULATED.
 * `variant="consultation"` (opt in): the recordings made in this consultation are marked as such, and a list that cannot be loaded says so with a retry.
 */
export function AuscultationCard({ patientId, encounterId, variant }: { patientId: string; encounterId?: string; variant?: 'consultation' | undefined }) {
  const patient = usePatient(patientId)
  const q = useQuery({ queryKey: key(patientId), queryFn: () => api<{ recordings: AuscultationRecording[] }>(`/patients/${patientId}/auscultations`), select: (d) => d.recordings })
  const [dialog, setDialog] = useState<'upload' | 'record' | null>(null)
  const consented = !!patient.data?.consents.some((c) => c.type === 'device_monitoring' && c.status === 'granted')
  const consultation = variant === 'consultation'
  return (
    <Card
      title="Stethoscope recordings"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Mic aria-hidden="true" className="size-4" />} disabled={!consented} onClick={() => setDialog('record')}>
            Record
          </Button>
          <Button size="sm" variant="secondary" icon={<Stethoscope aria-hidden="true" className="size-4" />} disabled={!consented} onClick={() => setDialog('upload')}>
            Add recording
          </Button>
        </div>
      }
    >
      <p className="mb-2 text-xs text-ink-muted">Audio recorded or uploaded by staff, or sent by a device gateway. No stethoscope has been connected to or tested with this system, and recordings are not analysed.</p>
      {patient.data && !consented && <Alert tone="info" className="mb-2">Record the patient’s consent to device readings before adding recordings.</Alert>}
      {q.isPending && <Spinner />}
      {consultation && q.isError && !q.data && <ErrorState title="Stethoscope recordings could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {consultation && q.isError && q.data && (
        <Alert tone="error" className="mb-2">
          The list could not be read again. A recording added since it was last read may be missing.
        </Alert>
      )}
      {q.data && !q.data.length && <p className="text-sm text-ink-muted">{consultation ? 'No recording available.' : 'No recordings.'}</p>}
      <ul className="space-y-3">
        {q.data?.map((r) => (
          <li key={r.id} className={`text-sm ${r.simulated ? 'rounded-lg border border-dashed border-ink/50 p-2' : ''}`} data-testid="auscultation" data-capture={r.captureMethod} data-simulated={r.simulated}>
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {AUSCULTATION_SITES[r.site]}
              {r.simulated && <SimulatedBadge what="SIMULATED AUDIO" />}
              {consultation && !!encounterId && r.encounterId === encounterId && (
                <Badge tone="brand">
                  <span data-testid="auscultation-this-consultation">This consultation</span>
                </Badge>
              )}
            </p>
            {r.simulated && <p className="text-xs font-medium">Generated tones from a simulator: not a body sound, and not a recording of this patient.</p>}
            <audio controls preload="none" src={`/api/files/${r.fileId}`} className="w-full" aria-label={`${r.simulated ? 'Simulated audio' : 'Stethoscope recording'}, ${AUSCULTATION_SITES[r.site]}, ${fmtDateTime(r.createdAt)}`} />
            <p className="text-xs text-ink-muted">
              {fmtDateTime(r.createdAt)}
              {r.createdByName ? ` · ${r.createdByName}` : ''} · {(r.sizeBytes / 1024).toFixed(0)} KB
              {r.dataOrigin !== 'clinical' ? ' · synthetic data' : ''}
              {r.note ? ` · ${r.note}` : ''}
            </p>
            <p className="text-xs text-ink-muted" data-testid="auscultation-capture">
              {captureLine(r)}
            </p>
          </li>
        ))}
      </ul>
      {dialog === 'upload' && <UploadDialog patientId={patientId} encounterId={encounterId} onClose={() => setDialog(null)} />}
      {dialog === 'record' && <RecordDialog patientId={patientId} encounterId={encounterId} onClose={() => setDialog(null)} />}
    </Card>
  )
}
