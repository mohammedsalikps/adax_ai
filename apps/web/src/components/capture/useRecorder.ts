import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiResponse } from '../../lib/ai.ts'
import { api, ApiError, errorMessage } from '../../lib/api.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import { clinicianReason, useCaptureStatus } from '../../lib/capture.ts'
import { microphoneReason, type NotRecordingReason, startRefusalReason } from './live.ts'

/** The longest one recording may run; it is then stopped and the doctor told to start a new one. */
export const MAX_RECORDED_S = 30 * 60
export const CONSENT_WITHDRAWN = 'Consent to recording was withdrawn. Recording stopped, and nothing more was captured or sent.'

export type RecorderState = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing'

/** What stopped or refused a recording here: its reason (for the one-line status) and the full sentence (for the doctor to act on). */
export interface RecorderProblem {
  reason: NotRecordingReason
  text: string
  /** When it happened (Date.now()): only a capture status read after it can say it is over (live.ts problemResolved). */
  at: number
}

const problemOf = (reason: NotRecordingReason, text: string): RecorderProblem => ({ reason, text, at: Date.now() })

/** Answers after which nothing more can be recorded here: the consultation is closed to recording, or the doctor may not record it. Retrying them would only lose audio. */
const isClosed = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 403 || ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(e.code))
const isConsentRefusal = (e: unknown): e is ApiError => e instanceof ApiError && /^(ai_)?consent_/.test(e.code)

/** Why the browser would not give a microphone, in words a doctor can act on. */
export function microphoneProblem(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow the microphone for this site in the browser’s settings, then try again. Nothing was recorded.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one and try again.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be opened (another application may be using it). Nothing was recorded.'
  return `The microphone could not be started: ${errorMessage(e)}`
}

export interface RecorderOptions {
  encounterId: string
  chunkSeconds: number
  /** The patient's recording consent as the screen last knew it: a recording in progress stops when it goes. */
  consentGranted: boolean
  /** Every answer of the API that holds the consultation's AI state (the start, each part, the end). */
  onUpdate: (r: AiResponse) => void
  /** A part of the recording was stored and transcribed (its answer has already gone to onUpdate). */
  onPart?: (transcriptId: string) => void
  /** Called when the doctor stops, after the last part was sent and the recording closed. */
  onStopped?: (transcriptId: string) => void
}

/**
 * Live recording in the browser, to the local speech service (the pipeline of the capture panel and of the consultation's live transcription).
 * Nothing starts by itself here: `start` is called by a click, or by the panel when the workspace asked for it and nothing stands in the way
 * (the patient's recorded consent, a ready local speech service, the browser's own permission). The recorder is restarted every `chunkSeconds`
 * so each part is a complete audio file; parts are sent one at a time, each with where it starts on the recording's own timeline (recorded
 * time only: a pause adds nothing). It stops at once if consent is withdrawn (the part being recorded is discarded, not sent), if the recording
 * was ended elsewhere, or when the doctor stops it; leaving the page ends it properly (the last part is sent, then the recording is closed).
 * `getAnalyser` gives the microphone's real signal for the level and the waveform; there are no guessed words, only finished text per part.
 */
export function useRecorder({ encounterId, chunkSeconds, consentGranted, onUpdate, onPart, onStopped }: RecorderOptions) {
  const [state, setState] = useState<RecorderState>('idle')
  const [pending, setPending] = useState(0)
  const [sent, setSent] = useState(0)
  const [problem, setProblem] = useState<RecorderProblem | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const status = useCaptureStatus(encounterId, { poll: state === 'recording' || state === 'paused' })
  const samePerson = useStillSamePerson()
  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'

  // The latest callbacks, so that a part that arrives after a re-render (or after the page left) reaches the current ones.
  const cb = useRef({ onUpdate, onPart, onStopped })
  cb.current = { onUpdate, onPart, onStopped }
  const stateRef = useRef<RecorderState>('idle')
  stateRef.current = state

  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const transcriptId = useRef<string | null>(null)
  const index = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  /** Recording time (ms) before the current part started, and when the current part began running (null while paused or idle). */
  const doneMs = useRef(0)
  const partStartedAt = useRef<number | null>(null)
  const active = useRef(false)
  /** The part being recorded must be thrown away (consent withdrawn), not sent. */
  const discarding = useRef(false)
  /** Set when the server refuses a part for lack of consent or because the recording ended: nothing more leaves the browser. */
  const blocked = useRef(false)
  const timers = useRef<ReturnType<typeof setInterval>[]>([])
  /** When this recording began: a status read from before that says nothing about it. */
  const startedAt = useRef(0)
  const audio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; stop: () => void } | null>(null)
  /** The panel is on the page: a microphone or a recording that arrives after it left is let go at once. */
  const mounted = useRef(true)

  const elapsedMs = useCallback(() => doneMs.current + (partStartedAt.current === null ? 0 : performance.now() - partStartedAt.current), [])
  const clearProblem = useCallback(() => setProblem(null), [])
  const getAnalyser = useCallback(() => audio.current?.analyser ?? null, [])

  const releaseAudio = () => {
    audio.current?.stop()
    audio.current = null
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

  // A recording in progress is not lost by a stray click on a link or a closed tab without a warning.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state])

  /** The microphone's signal, for the level and the waveform. The context is resumed: after a reload it would otherwise start suspended and show nothing. */
  const meter = (s: MediaStream) => {
    try {
      const ctx = new AudioContext()
      // A browser may refuse to resume it without a click or a key on the page (a reload): then it resumes at the doctor's next one, and
      // until then the waveform is flat (it shows only what it reads; the recording itself does not depend on it).
      const wake = () => {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
      }
      const events = ['pointerdown', 'keydown'] as const
      if (ctx.state === 'suspended') {
        wake()
        for (const ev of events) document.addEventListener(ev, wake, { capture: true })
      }
      const src = ctx.createMediaStreamSource(s)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      src.connect(analyser)
      audio.current = {
        ctx,
        analyser,
        stop: () => {
          for (const ev of events) document.removeEventListener(ev, wake, { capture: true })
          void ctx.close().catch(() => undefined)
        },
      }
    } catch {
      // No level where the browser has no Web Audio: recording does not depend on it.
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
            const tid = transcriptId.current
            cb.current.onUpdate(await api<AiResponse>(`/transcripts/${tid}/chunks`, { method: 'POST', body: fd }))
            setSent((n) => n + 1)
            if (tid) cb.current.onPart?.(tid)
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
          setProblem(problemOf('ended', 'This recording was ended elsewhere (another window, or because consent changed). Nothing more was captured.'))
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
    setProblem(problemOf('withdrawn', CONSENT_WITHDRAWN))
    const tid = transcriptId.current
    if (tid) void api<AiResponse>(`/transcripts/${tid}/end`, { method: 'POST', body: { reason: 'consent_withdrawn' } }).then((r) => cb.current.onUpdate(r), () => undefined)
  }, [])

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
    setProblem(problemOf('closed', `Recording stopped: ${why} Nothing more was captured.`))
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
      setProblem(problemOf('ended', 'This recording was ended elsewhere. Nothing more was captured.'))
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
    if (stateRef.current !== 'idle') return
    setProblem(null)
    setWarning(null)
    blocked.current = false
    discarding.current = false
    setState('starting')
    stateRef.current = 'starting'
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setProblem(problemOf(microphoneReason(e instanceof DOMException ? e.name : ''), microphoneProblem(e)))
      setState('idle')
      return
    }
    if (!mounted.current) {
      s.getTracks().forEach((t) => t.stop())
      return
    }
    try {
      const res = await api<AiResponse & { transcriptId: string }>(`/encounters/${encounterId}/live-transcripts`, { method: 'POST' })
      cb.current.onUpdate(res)
      transcriptId.current = res.transcriptId
      if (!mounted.current) {
        // The page left while the recording was being opened: nothing was recorded, and the recording is closed again.
        s.getTracks().forEach((t) => t.stop())
        void api<AiResponse>(`/transcripts/${res.transcriptId}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }).then((r) => cb.current.onUpdate(r), () => undefined)
        return
      }
    } catch (e) {
      s.getTracks().forEach((t) => t.stop())
      setProblem(problemOf(e instanceof ApiError ? startRefusalReason(e.code, e.status) : 'error', errorMessage(e)))
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
    active.current = true
    startPart()
    // The 30-minute limit of one recording.
    timers.current.push(
      setInterval(() => {
        if (stateRef.current === 'recording' && elapsedMs() >= MAX_RECORDED_S * 1000) void finish('limit')
      }, 1000),
    )
    // Close the current part every chunkSeconds; onstop starts the next one.
    timers.current.push(setInterval(() => recorder.current?.state === 'recording' && recorder.current.stop(), chunkSeconds * 1000))
    setState('recording')
  }

  /** Pause ends the current part (so it is sent) and records nothing until resumed; the timeline continues from where it was. */
  const pause = () => {
    if (stateRef.current !== 'recording') return
    active.current = false
    if (recorder.current?.state === 'recording') recorder.current.stop()
    setState('paused')
  }
  const resume = () => {
    if (stateRef.current !== 'paused') return
    active.current = true
    startPart()
    setState('recording')
  }

  const finish = async (why: 'doctor' | 'limit' | 'leaving' = 'doctor') => {
    const leaving = why === 'leaving'
    if (!leaving) setState('finishing')
    stateRef.current = 'finishing'
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
    if (leaving && (blocked.current || !samePerson())) return
    try {
      cb.current.onUpdate(await api<AiResponse>(`/transcripts/${tid}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }))
      if (tid && !blocked.current) cb.current.onStopped?.(tid)
    } catch (e) {
      if (!leaving) setProblem(problemOf('error', errorMessage(e)))
    }
    if (leaving) return
    if (why === 'limit') setWarning('Recording stopped at the 30-minute limit for one recording. Start a new recording to continue.')
    setState('idle')
    // The status read during the recording still names it as open: read it again now rather than at the next slow poll.
    void status.refetch()
  }

  // Leaving the page while recording ends the recording properly (the last part is sent, then it is closed), rather than leaving it open.
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const s = stateRef.current
      if ((s === 'recording' || s === 'paused') && transcriptId.current && !blocked.current) void finishRef.current('leaving')
      else stopTracks()
    }
  }, [])

  return {
    state,
    pending,
    sent,
    problem,
    warning,
    status,
    supported,
    /** The recording being made here (null before the first start). */
    transcriptId: transcriptId.current,
    elapsedMs,
    getAnalyser,
    start,
    pause,
    resume,
    finish: () => finish('doctor'),
    /** Forget what stopped the last attempt (the doctor is about to try again or record consent, or the status shows it is over). */
    clearProblem,
  }
}

export type Recorder = ReturnType<typeof useRecorder>
