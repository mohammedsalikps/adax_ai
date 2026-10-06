import { Mic, MicOff, Pause, Play, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorMessage } from '../../lib/api.ts'
import type { AiResponse } from '../../lib/ai.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import { clinicianReason, fmtOffset, useCaptureStatus } from '../../lib/capture.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'

const MAX_RECORDED_S = 30 * 60
const CONSENT_WITHDRAWN = 'Consent to recording was withdrawn. Recording stopped, and nothing more was captured or sent.'

type State = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing'

/** Answers after which nothing more can be recorded here: the consultation is closed to recording, or the doctor may not record it. Retrying them would only lose audio. */
const isClosed = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 403 || ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(e.code))
const isConsentRefusal = (e: unknown): e is ApiError => e instanceof ApiError && /^(ai_)?consent_/.test(e.code)

/** Why the browser would not give a microphone, in words a doctor can act on. */
function microphoneProblem(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow the microphone for this site in the browser’s settings, then try again. Nothing was recorded.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be opened (another application may be using it). Nothing was recorded.'
  return `The microphone could not be started: ${errorMessage(e)}`
}

/**
 * Live recording in the browser, to the local speech service. Nothing starts by itself: recording needs a click, the patient's recorded
 * consent and a ready local speech service, and the browser's own permission. The recorder is restarted every `chunkSeconds` so each part
 * is a complete audio file; parts are sent one at a time, each with where it starts on the recording's own timeline (recorded time only:
 * a pause adds nothing). It stops at once if consent is withdrawn (the part being recorded is discarded, not sent), if the recording was ended
 * elsewhere, or when the doctor stops it. The level bar is the microphone's real signal; there are no guessed words, only finished text per part.
 */
export function Recorder({
  encounterId,
  chunkSeconds,
  consentGranted,
  consentWithdrawn,
  onUpdate,
  onStopped,
}: {
  encounterId: string
  chunkSeconds: number
  /** The patient's recording consent as the screen last knew it: without it nothing is offered, and a recording in progress stops. */
  consentGranted: boolean
  /** The latest recording of this consultation was ended because consent was withdrawn (still true after a reload). */
  consentWithdrawn: boolean
  onUpdate: (r: AiResponse) => void
  /** Called when the doctor stops, after the last part was sent and the recording closed. */
  onStopped: (transcriptId: string) => void
}) {
  const [state, setState] = useState<State>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const [pending, setPending] = useState(0)
  const [sent, setSent] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const status = useCaptureStatus(encounterId, { poll: state === 'recording' || state === 'paused' })
  const samePerson = useStillSamePerson()
  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const transcriptId = useRef<string | null>(null)
  const index = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  /** Recording time (ms) before the current part started, and when the current part began running (null while paused or idle). */
  const doneMs = useRef(0)
  const partStartedAt = useRef<number | null>(null)
  const partOffset = useRef(0)
  const active = useRef(false)
  /** The part being recorded must be thrown away (consent withdrawn), not sent. */
  const discarding = useRef(false)
  /** Set when the server refuses a part for lack of consent or because the recording ended: nothing more leaves the browser. */
  const blocked = useRef(false)
  const timers = useRef<ReturnType<typeof setInterval>[]>([])
  /** When this recording began: a status read from before that says nothing about it. */
  const startedAt = useRef(0)
  const audio = useRef<{ ctx: AudioContext; stop: () => void } | null>(null)

  const elapsedMs = () => doneMs.current + (partStartedAt.current === null ? 0 : performance.now() - partStartedAt.current)

  const releaseAudio = () => {
    audio.current?.stop()
    audio.current = null
    setLevel(0)
  }
  const stopTracks = () => {
    timers.current.forEach(clearInterval)
    timers.current = []
    active.current = false
    if (recorder.current?.state === 'recording') recorder.current.stop()
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    releaseAudio()
  }
  useEffect(() => () => stopTracks(), [])

  // A recording in progress is not lost by a stray click on a link or a closed tab without a warning.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state])

  const meter = (s: MediaStream) => {
    try {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(s)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4))
      }, 100)
      audio.current = {
        ctx,
        stop: () => {
          clearInterval(timer)
          void ctx.close().catch(() => undefined)
        },
      }
    } catch {
      // No level bar where the browser has no Web Audio: recording does not depend on it.
    }
  }

  const upload = (blob: Blob, i: number, offsetMs: number) => {
    if (blocked.current || !samePerson()) return
    setPending((n) => n + 1)
    queue.current = queue.current.then(async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          if (blocked.current || !samePerson()) return
          try {
            const fd = new FormData()
            // Fields before the file, as the server reads them in order.
            fd.append('chunkIndex', String(i))
            fd.append('offsetMs', String(Math.round(offsetMs)))
            fd.append('file', blob, `chunk-${i}.webm`)
            onUpdate(await api<AiResponse>(`/transcripts/${transcriptId.current}/chunks`, { method: 'POST', body: fd }))
            setSent((n) => n + 1)
            return
          } catch (e) {
            if (e instanceof ApiError && e.code === 'chunk_already_received') return
            if (isConsentRefusal(e) || isClosed(e) || (e instanceof ApiError && e.code === 'transcript_not_live')) throw e
            // A network or server hiccup: try again a few times (1 s, 2 s, 4 s), then say the part was not sent.
            if (attempt >= 3) throw e
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
          }
        }
      } catch (e) {
        if (isConsentRefusal(e)) {
          haltForConsent()
          return
        }
        if (isClosed(e)) {
          haltClosed(e.message)
          return
        }
        if (e instanceof ApiError && e.code === 'transcript_not_live') {
          blocked.current = true
          stopTracks()
          setState('idle')
          setProblem('This recording was ended elsewhere (another window, or because consent changed). Nothing more was captured.')
          return
        }
        setWarning(`A part of the recording could not be sent (${errorMessage(e)}). Its audio is lost; recording continues.`)
      } finally {
        setPending((n) => n - 1)
      }
    })
  }

  /** Consent is gone: stop the microphone now, throw away the part being recorded, close the recording with that reason. */
  const haltForConsent = useCallback(() => {
    if (blocked.current) return
    blocked.current = true
    discarding.current = true
    stopTracks()
    setState('idle')
    setProblem(CONSENT_WITHDRAWN)
    const tid = transcriptId.current
    if (tid) void api<AiResponse>(`/transcripts/${tid}/end`, { method: 'POST', body: { reason: 'consent_withdrawn' } }).then(onUpdate, () => undefined)
  }, [onUpdate])

  // Consent was just recorded: what may be done changes at once, not at the next poll.
  const refetchStatus = status.refetch
  useEffect(() => {
    if (consentGranted) void refetchStatus()
  }, [consentGranted, refetchStatus])

  /** The consultation can no longer take a recording (signed, discarded, the visit moved on): stop the microphone now and say why. */
  const haltClosed = useCallback((why: string) => {
    if (blocked.current) return
    blocked.current = true
    discarding.current = true
    stopTracks()
    setState('idle')
    setProblem(`Recording stopped: ${why} Nothing more was captured.`)
  }, [])

  // The screen learned that consent is gone (another action refreshed it): stop now, without waiting for the next poll.
  useEffect(() => {
    if (!consentGranted && (state === 'recording' || state === 'paused')) haltForConsent()
  }, [consentGranted, state, haltForConsent])

  // The polled status is the early warning: consent withdrawn elsewhere, or the recording ended in another window.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    const s = status.data
    // Only an answer given after this recording began can say it has ended.
    if (!s || status.dataUpdatedAt <= startedAt.current) return
    if (!s.consent.granted) haltForConsent()
    else if (s.closedReason) haltClosed(s.closedReason)
    else if (s.live.transcriptId !== transcriptId.current && !blocked.current) {
      blocked.current = true
      discarding.current = true
      stopTracks()
      setState('idle')
      setProblem('This recording was ended elsewhere. Nothing more was captured.')
    } else if (!s.speech.available) setWarning(`${clinicianReason(s.speech.reason, 'Local transcription is unavailable.')} The audio is still being saved; it is transcribed when the service is back (use “Retry” under the transcript).`)
    else setWarning((w) => (w?.startsWith('A part') ? w : null))
  }, [status.data, status.dataUpdatedAt, state, haltForConsent, haltClosed])

  const startPart = () => {
    if (!stream.current || !active.current) return
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const r = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined)
    const parts: Blob[] = []
    const i = index.current++
    const offset = doneMs.current
    partOffset.current = offset
    partStartedAt.current = performance.now()
    r.ondataavailable = (e) => e.data.size && parts.push(e.data)
    r.onstop = () => {
      const ranFor = partStartedAt.current === null ? 0 : performance.now() - partStartedAt.current
      partStartedAt.current = null
      doneMs.current = offset + ranFor
      const blob = new Blob(parts, { type: (r.mimeType || 'audio/webm').split(';')[0] })
      if (blob.size && !discarding.current) upload(blob, i, offset)
      if (active.current) startPart()
    }
    recorder.current = r
    r.start()
  }

  const start = async () => {
    setProblem(null)
    setWarning(null)
    blocked.current = false
    discarding.current = false
    setState('starting')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setProblem(microphoneProblem(e))
      setState('idle')
      return
    }
    try {
      const res = await api<AiResponse & { transcriptId: string }>(`/encounters/${encounterId}/live-transcripts`, { method: 'POST' })
      onUpdate(res)
      transcriptId.current = res.transcriptId
    } catch (e) {
      s.getTracks().forEach((t) => t.stop())
      setProblem(errorMessage(e))
      setState('idle')
      void status.refetch()
      return
    }
    stream.current = s
    startedAt.current = Date.now()
    meter(s)
    index.current = 0
    doneMs.current = 0
    queue.current = Promise.resolve()
    setSent(0)
    setPending(0)
    setSeconds(0)
    active.current = true
    startPart()
    timers.current.push(setInterval(() => setSeconds(Math.floor(elapsedMs() / 1000)), 500))
    // Close the current part every chunkSeconds; onstop starts the next one.
    timers.current.push(setInterval(() => recorder.current?.state === 'recording' && recorder.current.stop(), chunkSeconds * 1000))
    setState('recording')
  }

  /** Pause ends the current part (so it is sent) and records nothing until resumed; the timeline continues from where it was. */
  const pause = () => {
    if (state !== 'recording') return
    active.current = false
    if (recorder.current?.state === 'recording') recorder.current.stop()
    setState('paused')
  }
  const resume = () => {
    if (state !== 'paused') return
    active.current = true
    startPart()
    setState('recording')
  }

  const finish = async (why: 'doctor' | 'limit' = 'doctor') => {
    setState('finishing')
    const tid = transcriptId.current
    const r = recorder.current
    active.current = false
    timers.current.forEach(clearInterval)
    timers.current = []
    // The last part is closed and handed to the queue before anything is waited for: its stop event, not a guess at how long it takes.
    if (r && r.state === 'recording') {
      await new Promise<void>((resolve) => {
        const done = r.onstop
        r.onstop = (ev) => {
          done?.call(r, ev)
          resolve()
        }
        r.stop()
      })
    }
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    releaseAudio()
    await queue.current
    try {
      onUpdate(await api<AiResponse>(`/transcripts/${tid}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }))
      if (tid && !blocked.current) onStopped(tid)
    } catch (e) {
      setProblem(errorMessage(e))
    }
    if (why === 'limit') setWarning('Recording stopped at the 30-minute limit for one recording. Start a new recording to continue.')
    setState('idle')
    setSeconds(0)
  }
  useEffect(() => {
    if (seconds >= MAX_RECORDED_S && state === 'recording') void finish('limit')
  })

  // No consent: nothing is offered. What stopped a recording stays on screen (the consent block above says what is needed).
  const shownProblem = problem ?? (state === 'idle' && !consentGranted && consentWithdrawn ? CONSENT_WITHDRAWN : null)
  if (!consentGranted && state === 'idle') return shownProblem ? <Alert tone="error">{shownProblem}</Alert> : null
  if (!supported) {
    return <Alert tone="info">This browser cannot record from a microphone. Use a current Chrome, Edge, Firefox or Safari, or add the transcript another way (below).</Alert>
  }

  const s = status.data
  const canStart = !!s?.canRecord && state === 'idle'
  const recording = state === 'recording' || state === 'paused' || state === 'finishing'
  return (
    <div className="space-y-2" data-testid="recorder">
      <div className="flex flex-wrap items-center gap-2">
        {state === 'idle' || state === 'starting' ? (
          <Button size="sm" icon={<Mic aria-hidden="true" className="size-4" />} onClick={() => void start()} disabled={!canStart} loading={state === 'starting'} aria-describedby={!canStart && s?.blockedReason ? 'recorder-blocked' : undefined}>
            Start recording
          </Button>
        ) : (
          <>
            {state === 'paused' ? (
              <Button size="sm" variant="secondary" icon={<Play aria-hidden="true" className="size-4" />} onClick={resume}>
                Resume
              </Button>
            ) : (
              <Button size="sm" variant="secondary" icon={<Pause aria-hidden="true" className="size-4" />} onClick={pause} disabled={state === 'finishing'}>
                Pause
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Square aria-hidden="true" className="size-4" />} onClick={() => void finish()} loading={state === 'finishing'}>
              Stop
            </Button>
          </>
        )}
        {recording && (
          <p role="status" className={`inline-flex items-center gap-2 text-sm font-medium ${state === 'paused' ? 'text-pending' : 'text-down'}`} data-testid="recording-state">
            {state === 'paused' ? <MicOff aria-hidden="true" className="size-4" /> : <span className="size-2.5 animate-pulse rounded-full bg-down motion-reduce:animate-none" aria-hidden="true" />}
            {state === 'finishing' ? 'Finishing…' : state === 'paused' ? 'Paused' : 'Recording'}
            <span className="tabular-nums" aria-label={`${fmtOffset(seconds * 1000)} recorded`}>
              {fmtOffset(seconds * 1000)}
            </span>
          </p>
        )}
      </div>
      {recording && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-canvas">
            <span className="block h-full rounded-full bg-ok transition-[width] duration-100 motion-reduce:transition-none" style={{ width: `${Math.round(level * 100)}%` }} />
          </span>
          <span>
            Microphone level · {sent} part{sent === 1 ? '' : 's'} sent{pending > 0 ? ` · ${pending} sending` : ''}
          </span>
        </div>
      )}
      {!canStart && state === 'idle' && s?.blockedReason && (
        <p id="recorder-blocked" className="text-sm text-ink-muted">
          {clinicianReason(s.blockedReason, 'Recording cannot start now.')}
        </p>
      )}
      {shownProblem && <Alert tone="error">{shownProblem}</Alert>}
      {warning && <Alert tone="warning">{warning}</Alert>}
      <p className="text-xs text-ink-muted">Sent in {chunkSeconds}-second parts to the speech service on this machine; each part appears when its transcription is finished. The audio is stored with the consultation.</p>
    </div>
  )
}
