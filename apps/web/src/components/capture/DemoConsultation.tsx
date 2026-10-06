import type { DeviceList, Encounter, EncounterAi } from '@adaxai/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, Square } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'
import { type AiResponse, aiKey } from '../../lib/ai.ts'
import { api, ApiError, errorMessage } from '../../lib/api.ts'
import { useStillSamePerson } from '../../lib/auth.tsx'
import { clinicianReason, useCaptureStatus, useExtractPoints } from '../../lib/capture.ts'
import {
  DEMO_AUDIO_LABEL,
  DEMO_MANIFEST_URL,
  DEMO_POLL_MS,
  type DemoPart,
  type DemoPhase,
  type DemoPlan,
  demoActive,
  demoGate,
  demoRefusal,
  demoStatusLine,
  parseDemoManifest,
  partMismatch,
  toHex,
} from '../../lib/demoConsultation.ts'
import { devicesKey } from '../../lib/devices.ts'
import { Button } from '../ui/Button.tsx'
import { Alert } from '../ui/Feedback.tsx'

/** The test id of the panel's own "Play demo consultation" button (the conversation module's quick action uses it). */
export const DEMO_PLAY_TESTID = 'demo-consultation-play'

const CONSENT_WITHDRAWN = 'Consent to recording was withdrawn. The demo stopped: the part playing was not sent, and nothing more was.'

/** The mark of the demo consultation's audio wherever its transcript is shown or summarised: computer voices, never a patient. */
export function DemoAudioMark({ children = 'Synthetic demo audio' }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-dashed border-ink/60 px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide whitespace-nowrap text-ink" data-testid="demo-audio-mark">
      {children}
    </span>
  )
}

/** Whether the person asked for reduced motion (followed while the page is open). */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches)
  useEffect(() => {
    const m = window.matchMedia?.(query)
    if (!m) return
    const on = () => setReduced(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduced
}

/**
 * Whether this deployment allows simulators (GET /devices' simulatorAllowed, the gate of the device and thermal simulators); null while not read
 * or when it could not be read (then nothing synthetic is offered). The device list's read is audited with the patients on devices, so it is
 * read once a page (not again for five minutes), whoever asks first.
 */
export function useSimulatorAllowed(): boolean | null {
  const q = useQuery({ queryKey: devicesKey, queryFn: () => api<DeviceList>('/devices'), staleTime: 300_000, select: (d) => d?.simulatorAllowed === true })
  return q.data ?? null
}

/**
 * For the page: whether "Play demo consultation" is offered for this consultation (the conversation module's quick action): simulators allowed,
 * the patient's recording consent present (as the transcription panel last read it), the consultation open to this doctor. Whether it can start
 * (the speech service ready, no microphone recording running) the panel's own button says.
 */
export function useDemoConsultationOffered(encounter: Pick<Encounter, 'id' | 'status' | 'canEdit'>): boolean {
  const simulatorAllowed = useSimulatorAllowed()
  const consent = useQuery({ queryKey: aiKey(encounter.id), queryFn: () => api<EncounterAi>(`/encounters/${encounter.id}/ai`), enabled: false, select: (ai) => !!ai?.consent?.granted })
  return demoGate({ open: encounter.status === 'in_progress' && !!encounter.canEdit, simulatorAllowed, consentGranted: consent.data === true, canRecord: true, recording: false }).offered
}

async function loadPlan(): Promise<DemoPlan> {
  const res = await fetch(DEMO_MANIFEST_URL, { cache: 'no-cache', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`The demo audio's manifest could not be read (${res.status}).`)
  return parseDemoManifest(await res.json())
}

/** One part's bytes, checked against the manifest (size, and SHA-256 where the browser can compute it): what is played is what is sent. */
async function loadPart(p: DemoPart): Promise<Blob> {
  const res = await fetch(p.url, { cache: 'no-cache', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`The demo audio ${p.file} could not be read (${res.status}).`)
  const buf = await res.arrayBuffer()
  // crypto.subtle exists only in a secure context (https, or this computer's own address); elsewhere the size is still checked.
  const sha256 = globalThis.crypto?.subtle ? toHex(await globalThis.crypto.subtle.digest('SHA-256', buf)) : null
  const wrong = partMismatch(p, { bytes: buf.byteLength, sha256 })
  if (wrong) throw new Error(`${wrong} Nothing was played or sent.`)
  return new Blob([buf], { type: 'audio/wav' })
}

const isConsentRefusal = (e: unknown): e is ApiError => e instanceof ApiError && /^(ai_)?consent_/.test(e.code)
const isClosed = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 403 || ['encounter_signed', 'encounter_discarded', 'visit_not_in_consultation'].includes(e.code))

/** One run of the demo: what it has done, and how to stop it. Kept outside React's state, as the run goes on between renders. */
interface Run {
  tid: string | null
  /** When its recording began (a status read from before says nothing about it). */
  startedAt: number
  /** No more parts are played (the doctor stopped it, or the panel left). */
  stopped: boolean
  /** Refused (consent withdrawn, consultation closed, recording ended elsewhere): nothing more is sent. */
  halted: boolean
  /** The panel left the page: the recording is ended, nothing else is done. */
  leaving: boolean
  paused: boolean
  audio: HTMLAudioElement | null
  /** Ends the wait for the part playing (stop), or for the doctor to resume (paused between parts). */
  wake: (() => void) | null
  resumed: (() => void) | null
  queue: Promise<void>
  played: number
  /** Parts the server answered for (stored, transcribed or not). */
  answered: number
}

/** A play() cut short by pause() (the doctor paused): not a failure, it is played again on resume. */
const isInterrupted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Plays one part through the speakers; settles when it ends, or when the run is stopped. */
function playPart(r: Run, blob: Blob): Promise<'ended' | 'stopped'> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const a = new Audio()
    let settled = false
    const finish = (how: 'ended' | 'stopped' | Error) => {
      if (settled) return
      settled = true
      a.onended = null
      a.onerror = null
      a.pause()
      URL.revokeObjectURL(url)
      if (r.audio === a) r.audio = null
      r.wake = null
      if (how instanceof Error) reject(how)
      else resolve(how)
    }
    a.onended = () => finish('ended')
    a.onerror = () => finish(new Error('The browser could not play the demo audio.'))
    r.audio = a
    r.wake = () => finish('stopped')
    a.src = url
    a.play().catch((e: unknown) => {
      if (!isInterrupted(e)) finish(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

const playbackProblem = (e: unknown) =>
  e instanceof DOMException && e.name === 'NotAllowedError'
    ? 'The browser did not allow the demo audio to play. Click “Play demo consultation” again; nothing more was sent.'
    : `The demo audio could not be played (${errorMessage(e)}). Nothing more was sent.`

/**
 * "Play demo consultation", in the transcription panel, where simulators are allowed and the patient's recording consent is present (and never
 * while the microphone records). It checks the demo's files against their manifest, starts a live recording through the existing API saying its
 * audio is synthetic demo audio (POST live-transcripts { audioOrigin: 'demo_synthetic' }), plays each part through the speakers and, as each
 * ends, sends it unchanged as the recording's next part, so the REAL local speech model transcribes it; the panel reads the AI state every second
 * meanwhile, and its lines appear as the transcription of each part is stored. At the end the recording is ended and the existing fixed-rule
 * extraction runs. The script's words and speakers are never shown: what the transcript says is what the model heard.
 *
 * It stops at once when the doctor stops it (the part playing is not sent), when consent is withdrawn (the recording is ended with that reason),
 * when the consultation closes, or when the recording is ended elsewhere. `onActiveChange` says while it holds the recording (the microphone
 * recorder waits meanwhile).
 */
export function DemoConsultation({
  encounter,
  ai,
  onUpdate,
  onActiveChange,
}: {
  encounter: Pick<Encounter, 'id' | 'status' | 'canEdit'>
  ai: EncounterAi
  onUpdate: (r: AiResponse) => void
  onActiveChange: (active: boolean) => void
}) {
  const id = encounter.id
  const qc = useQueryClient()
  const samePerson = useStillSamePerson()
  const headingId = useId()
  const labelId = useId()
  const reasonId = useId()
  const [phase, setPhase] = useState<DemoPhase>('idle')
  const [current, setCurrent] = useState(0)
  const [played, setPlayed] = useState(0)
  const [tid, setTid] = useState<string | null>(null)
  const [extracted, setExtracted] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const run = useRef<Run | null>(null)
  const active = demoActive(phase)
  const extract = useExtractPoints(id)

  const simulatorAllowed = useSimulatorAllowed()
  const status = useCaptureStatus(id, { poll: active })
  // While the demo holds the recording, the panel's AI state is read every second: a part shows as received, then as its lines.
  useQuery({ queryKey: aiKey(id), queryFn: () => api<EncounterAi>(`/encounters/${id}/ai`), enabled: active, refetchInterval: active ? DEMO_POLL_MS : false, refetchIntervalInBackground: active })
  const plan = useQuery({ queryKey: ['demo-consultation', 'manifest'], queryFn: loadPlan, staleTime: Number.POSITIVE_INFINITY, retry: 1, enabled: simulatorAllowed === true })

  const live = ai.transcripts.find((t) => t.status === 'live') ?? null
  const gate = demoGate({
    open: encounter.status === 'in_progress' && !!encounter.canEdit,
    simulatorAllowed,
    consentGranted: ai.consent.granted,
    canRecord: status.data ? status.data.canRecord : null,
    // In the clinician's words, as the recorder says it (a service's setup instruction, such as an npm command, is left out).
    blockedReason: status.data?.blockedReason ? clinicianReason(status.data.blockedReason, 'Recording cannot start now.') : null,
    recording: !!live && live.audioOrigin !== 'demo_synthetic',
  })

  useEffect(() => onActiveChange(active), [active, onActiveChange])

  // Play gives way to Pause and Stop, Pause to Resume, and the controls are off while the last parts are transcribed: a keyboard user whose
  // control went away is kept here, on the control that took its place (or on the demo's box), never dropped on the page.
  const box = useRef<HTMLElement>(null)
  const focusedHere = useRef(false)
  useEffect(() => {
    const el = box.current
    if (!el || !focusedHere.current) return
    const now = document.activeElement
    // Still on a control (here or elsewhere): left alone. On the box itself (while nothing could be used): moved to the control now offered.
    if (now && now !== document.body && now !== el) return
    const target = phase === 'playing' ? 'demo-consultation-pause' : phase === 'paused' ? 'demo-consultation-resume' : active ? null : DEMO_PLAY_TESTID
    const button = target ? el.querySelector<HTMLButtonElement>(`[data-testid="${target}"]`) : null
    ;(button && !button.disabled ? button : el).focus({ preventScroll: true })
  }, [phase, active])

  /** An answer of the API that holds the consultation's AI state: any read of it still on its way is dropped first (it would be older). */
  const apply = useCallback(
    async (res: AiResponse) => {
      await qc.cancelQueries({ queryKey: aiKey(id) })
      onUpdate(res)
    },
    [qc, id, onUpdate],
  )

  /** Nothing more is played or sent; `endReason` ends the recording with that reason (consent withdrawn). */
  const halt = useCallback(
    (why: string, endReason: 'consent_withdrawn' | null) => {
      const r = run.current
      if (!r || r.halted) return
      r.halted = true
      r.stopped = true
      r.wake?.()
      r.resumed?.()
      setProblem(why)
      setPhase('idle')
      if (endReason && r.tid) void api<AiResponse>(`/transcripts/${r.tid}/end`, { method: 'POST', body: { reason: endReason } }).then(apply, () => undefined)
    },
    [apply],
  )

  // Consent withdrawn (the panel's state, read every second while the demo plays): stop now.
  useEffect(() => {
    if (active && !ai.consent.granted) halt(CONSENT_WITHDRAWN, 'consent_withdrawn')
  }, [active, ai.consent.granted, halt])

  // The recorder's status is the early warning: consent withdrawn, the consultation closed, another recording replacing this one.
  useEffect(() => {
    const r = run.current
    if (!r?.tid || (phase !== 'playing' && phase !== 'paused' && phase !== 'finishing')) return
    const s = status.data
    if (!s || status.dataUpdatedAt <= r.startedAt) return
    if (!s.consent.granted) halt(CONSENT_WITHDRAWN, 'consent_withdrawn')
    else if (s.closedReason) halt(`The demo stopped: ${s.closedReason} Nothing more was sent.`, null)
    else if (s.live.transcriptId && s.live.transcriptId !== r.tid) halt('The demo’s recording was ended elsewhere (another window). Nothing more was sent.', null)
  }, [status.data, status.dataUpdatedAt, phase, halt])

  // Leaving the panel stops the playing; the parts already played are still transcribed and the recording is ended.
  useEffect(
    () => () => {
      const r = run.current
      if (!r || r.halted) return
      r.leaving = true
      r.stopped = true
      r.wake?.()
      r.resumed?.()
    },
    [],
  )

  // The demo's recording is not lost by a stray click on a link or a closed tab without a warning.
  useEffect(() => {
    if (!active) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [active])

  /** Sends a played part as the recording's next part, after those before it (the server orders the lines by part). */
  const send = (r: Run, p: DemoPart, blob: Blob) => {
    r.queue = r.queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (r.halted || !r.tid || !samePerson()) return
        try {
          const fd = new FormData()
          // Fields before the file, as the server reads them in order.
          fd.append('chunkIndex', String(p.chunkIndex))
          fd.append('offsetMs', String(p.offsetMs))
          fd.append('file', blob, p.file)
          await apply(await api<AiResponse>(`/transcripts/${r.tid}/chunks`, { method: 'POST', body: fd }))
          r.answered += 1
          return
        } catch (e) {
          if (e instanceof ApiError && e.code === 'chunk_already_received') {
            r.answered += 1
            return
          }
          if (isConsentRefusal(e)) return halt(CONSENT_WITHDRAWN, 'consent_withdrawn')
          if (isClosed(e)) return halt(`The demo stopped: ${e.message} Nothing more was sent.`, null)
          if (e instanceof ApiError && e.code === 'transcript_not_live') return halt('The demo’s recording was ended elsewhere (another window). Nothing more was sent.', null)
          // A network or server hiccup: try again (1 s, 2 s), then say the part was not sent.
          if (attempt >= 2) {
            setWarning(`Part ${p.chunkIndex + 1} of the demo could not be sent (${errorMessage(e)}).`)
            return
          }
          await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt))
        }
      }
    })
  }

  const play = async () => {
    if (active || !samePerson()) return
    const r: Run = { tid: null, startedAt: 0, stopped: false, halted: false, leaving: false, paused: false, audio: null, wake: null, resumed: null, queue: Promise.resolve(), played: 0, answered: 0 }
    run.current = r
    setProblem(null)
    setWarning(null)
    setExtracted(false)
    setCurrent(0)
    setPlayed(0)
    setTid(null)
    setPhase('loading')
    const p = plan.data
    let blobs: Blob[]
    try {
      if (!p) throw new Error('The demo audio’s manifest is not loaded.')
      blobs = await Promise.all(p.parts.map(loadPart))
    } catch (e) {
      setProblem(errorMessage(e))
      setPhase('idle')
      return
    }
    if (r.stopped) {
      setPhase('idle')
      return
    }
    setPhase('starting')
    try {
      const res = await api<AiResponse & { transcriptId: string }>(`/encounters/${id}/live-transcripts`, { method: 'POST', body: { audioOrigin: 'demo_synthetic' } })
      r.tid = res.transcriptId
      r.startedAt = Date.now()
      setTid(res.transcriptId)
      await apply(res)
    } catch (e) {
      setProblem((e instanceof ApiError && demoRefusal(e.code)) || errorMessage(e))
      setPhase('idle')
      void status.refetch()
      return
    }
    setPhase('playing')
    try {
      for (let i = 0; i < p.parts.length; i++) {
        if (r.stopped) break
        if (r.paused) await new Promise<void>((res) => (r.resumed = res))
        r.resumed = null
        if (r.stopped) break
        setCurrent(i + 1)
        if ((await playPart(r, blobs[i]!)) === 'stopped' || r.halted) break
        r.played += 1
        setPlayed(r.played)
        send(r, p.parts[i]!, blobs[i]!)
      }
    } catch (e) {
      // The browser would not play a part: nothing more is played; what was played is still transcribed, and the recording is ended.
      r.stopped = true
      setProblem(playbackProblem(e))
    }
    if (r.halted) return
    setPhase('finishing')
    await r.queue
    if (r.halted) return
    setPhase('ending')
    try {
      await apply(await api<AiResponse>(`/transcripts/${r.tid}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }))
    } catch (e) {
      if (r.leaving) return
      setProblem(`The demo’s recording could not be ended (${errorMessage(e)}).`)
      setPhase('stopped')
      return
    }
    if (r.leaving) return
    const canExtract = r.answered > 0 && ai.status.extraction.available
    if (canExtract && r.tid) {
      setPhase('extracting')
      try {
        await extract.mutateAsync(r.tid)
        setExtracted(true)
      } catch (e) {
        setProblem(`Important points could not be found (${errorMessage(e)}). Use “Find important points” under the transcript.`)
      }
    }
    setPhase(r.stopped ? 'stopped' : 'done')
  }

  const stop = () => {
    const r = run.current
    if (!r || r.stopped) return
    r.stopped = true
    r.wake?.()
    r.resumed?.()
  }
  const pause = () => {
    const r = run.current
    if (!r || phase !== 'playing') return
    r.paused = true
    r.audio?.pause()
    setPhase('paused')
  }
  const resume = () => {
    const r = run.current
    if (!r || phase !== 'paused') return
    r.paused = false
    setPhase('playing')
    r.audio?.play().catch((e: unknown) => {
      if (isInterrupted(e)) return
      setProblem(playbackProblem(e))
      stop()
    })
    r.resumed?.()
  }

  // A demo recording still open, but not played from here (its page was closed or reloaded before it ended): it can be ended now.
  const orphan = !active && live?.audioOrigin === 'demo_synthetic' && live.id !== tid ? live : null
  const endOrphan = async () => {
    if (!orphan) return
    try {
      await apply(await api<AiResponse>(`/transcripts/${orphan.id}/end`, { method: 'POST', body: { reason: 'doctor_stopped' } }))
    } catch (e) {
      setProblem(errorMessage(e))
    }
  }

  if (!gate.offered && !active && !problem && !orphan) return null

  const mine = tid ? ai.transcripts.find((t) => t.id === tid) : undefined
  const chunks = mine?.chunks ?? []
  const total = plan.data?.parts.length ?? 0
  const counts = {
    total,
    current,
    played,
    transcribed: chunks.filter((c) => c.status === 'transcribed').length,
    failed: chunks.filter((c) => c.status === 'failed').length,
  }
  const line = demoStatusLine(phase, counts, { extractor: ai.status.extraction.version ?? null, extracted })
  const seconds = plan.data ? Math.round(plan.data.totalMs / 1000) : null
  const showSteps = phase !== 'idle' && total > 0 && !!tid

  return (
    <section
      ref={box}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="rounded-lg border border-dashed border-ink/50 p-3 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      data-testid="demo-consultation"
      data-phase={phase}
      onFocus={() => (focusedHere.current = true)}
      onBlur={(e) => {
        // Only a move to somewhere else on the page counts as leaving (a control taken out of the page moves focus nowhere).
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focusedHere.current = false
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          Demo consultation
        </h3>
        <span id={labelId} className="inline-flex items-center rounded-md border border-dashed border-ink/60 px-1.5 py-px text-[0.6875rem] leading-4 font-semibold tracking-wide text-ink" data-testid="demo-audio-label">
          {DEMO_AUDIO_LABEL}
        </span>
      </div>
      {/* While it plays, only the mark stays above the controls, so that the transcript's new lines stay close by. */}
      {!active && (
        <p className="mt-1.5 text-xs text-ink-muted">
          Plays a written consultation about a fictional child{plan.data ? ` (${plan.data.parts.length} parts, about ${seconds} seconds)` : ''} through this computer’s speakers and sends each part, as it ends, to the speech model on this computer, as a
          recording would. The transcript shows only what the model heard. No patient is recorded; offered because this deployment allows simulators.
        </p>
      )}
      {plan.isError && (
        <Alert tone="error" className="mt-2">
          {errorMessage(plan.error)}
        </Alert>
      )}

      {orphan ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid="demo-consultation-orphan">
          <p className="min-w-0 flex-1">The demo’s recording is still open (its page was closed or reloaded before it ended). Recording from the microphone can start once it is ended.</p>
          <Button variant="secondary" icon={<Square aria-hidden="true" className="size-4" />} onClick={() => void endOrphan()}>
            End the demo’s recording
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {active ? (
            <>
              {phase === 'paused' ? (
                <Button variant="secondary" icon={<Play aria-hidden="true" className="size-4" />} onClick={resume} data-testid="demo-consultation-resume">
                  Resume demo
                </Button>
              ) : (
                <Button variant="secondary" icon={<Pause aria-hidden="true" className="size-4" />} onClick={pause} disabled={phase !== 'playing'} data-testid="demo-consultation-pause">
                  Pause demo
                </Button>
              )}
              <Button variant="secondary" icon={<Square aria-hidden="true" className="size-4" />} onClick={stop} disabled={phase !== 'playing' && phase !== 'paused' && phase !== 'loading'} data-testid="demo-consultation-stop">
                Stop demo
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              icon={<Play aria-hidden="true" className="size-4" />}
              onClick={() => void play()}
              disabled={!gate.canStart || !plan.data}
              aria-describedby={`${labelId}${!gate.canStart && gate.reason ? ` ${reasonId}` : ''}`}
              data-testid={DEMO_PLAY_TESTID}
            >
              Play demo consultation
            </Button>
          )}
          {!active && !gate.canStart && gate.reason && gate.offered && (
            <p id={reasonId} className="text-xs text-ink-muted">
              {gate.reason}
            </p>
          )}
        </div>
      )}

      {showSteps && (
        <ol aria-hidden="true" className="mt-2 flex gap-1" data-testid="demo-consultation-steps">
          {Array.from({ length: total }, (_, i) => {
            const c = chunks.find((x) => x.index === i)
            const state = c?.status === 'transcribed' ? 'transcribed' : c?.status === 'failed' ? 'failed' : i < played ? 'sent' : i === current - 1 && active ? 'playing' : 'waiting'
            const cls = {
              transcribed: 'bg-ok',
              failed: 'bg-down',
              sent: 'bg-brand/50',
              playing: 'bg-brand animate-pulse motion-reduce:animate-none',
              waiting: 'bg-line',
            }[state]
            return <li key={i} data-state={state} className={`h-1.5 min-w-0 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none ${cls}`} />
          })}
        </ol>
      )}
      {/* Always in the page (empty while idle), so that what it says is read out from the first change. */}
      <p role="status" className="text-xs font-medium [&:not(:empty)]:mt-1.5" data-testid="demo-consultation-status">
        {line}
      </p>
      {problem && (
        <Alert tone="error" className="mt-2">
          {problem}
        </Alert>
      )}
      {warning && (
        <Alert tone="warning" className="mt-2">
          {warning}
        </Alert>
      )}
    </section>
  )
}
