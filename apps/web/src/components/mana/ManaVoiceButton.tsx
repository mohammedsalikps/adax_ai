import { LoaderCircle, Mic, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../lib/api.ts'
import { transcribeVoice } from '../../lib/manaAssistant.ts'
import { microphoneProblem, pickRecorderType, uploadType, VOICE_LIMIT_MS, voiceClock } from '../../lib/manaGlobal.ts'

type State = 'idle' | 'starting' | 'recording' | 'sending'

/**
 * Speak a question to Mana (DESIGN §5.8): press to record (at most 30 seconds; it stops by itself), press again to stop. The clip goes to the
 * server, where the local speech model transcribes it in memory (nothing is stored), and the words come back to be asked as the question. The
 * browser's own speech recognition is never used (Chrome would send the audio to Google). Every failure is said as it is: a blocked microphone,
 * nothing heard, the speech service not running, the patient's recording consent not on record.
 */
export function ManaVoiceButton({ conversationId, disabled, onText, onProblem }: { conversationId: string | undefined; disabled?: boolean; onText: (text: string) => void; onProblem: (message: string | null) => void }) {
  const [state, setState] = useState<State>('idle')
  const [ms, setMs] = useState(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const gone = useRef(false)
  const inflight = useRef<AbortController | null>(null)
  const latest = useRef({ conversationId, onText, onProblem })
  latest.current = { conversationId, onText, onProblem }

  const release = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }
  // Closing Mana (or leaving the page) stops the microphone and drops what was being recorded or sent.
  useEffect(
    () => () => {
      gone.current = true
      if (recorder.current?.state === 'recording') recorder.current.stop()
      release()
      inflight.current?.abort()
    },
    [],
  )

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  const finish = async (recorderType: string | null) => {
    const durationMs = Math.min(performance.now() - startedAt.current, VOICE_LIMIT_MS)
    release()
    if (gone.current) return
    const { type, name } = uploadType(recorderType)
    const clip = new Blob(chunks.current, { type })
    chunks.current = []
    if (!clip.size) {
      setState('idle')
      latest.current.onProblem('Nothing was recorded. Try again.')
      return
    }
    setState('sending')
    const ac = new AbortController()
    inflight.current = ac
    try {
      const out = await transcribeVoice(clip, { type, name, conversationId: latest.current.conversationId, durationMs, signal: ac.signal })
      if (gone.current) return
      if (out.empty || !out.text.trim()) latest.current.onProblem('Nothing was heard. Speak a little closer to the microphone and try again.')
      else latest.current.onText(out.text.trim())
    } catch (e) {
      if (!gone.current && (e as Error).name !== 'AbortError') latest.current.onProblem(errorMessage(e))
    } finally {
      inflight.current = null
      if (!gone.current) setState('idle')
    }
  }

  const start = async () => {
    latest.current.onProblem(null)
    const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
    if (!supported) {
      latest.current.onProblem(microphoneProblem('NotSupportedError'))
      return
    }
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t))
    setState('starting')
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setState('idle')
      latest.current.onProblem(microphoneProblem(e instanceof DOMException ? e.name : null))
      return
    }
    if (gone.current) {
      release()
      return
    }
    let r: MediaRecorder
    try {
      r = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined)
    } catch {
      release()
      setState('idle')
      latest.current.onProblem(microphoneProblem('NotSupportedError'))
      return
    }
    chunks.current = []
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data)
    }
    r.onstop = () => void finish(r.mimeType || type)
    recorder.current = r
    startedAt.current = performance.now()
    r.start()
    setMs(0)
    setState('recording')
    timer.current = setInterval(() => {
      const t = performance.now() - startedAt.current
      setMs(t)
      if (t >= VOICE_LIMIT_MS) stop()
    }, 200)
  }

  const recording = state === 'recording'
  const busy = state === 'starting' || state === 'sending'
  return (
    <button
      type="button"
      onClick={() => (recording ? stop() : void start())}
      disabled={(disabled && !recording) || busy}
      aria-pressed={recording}
      aria-label={recording ? `Stop and send the spoken question (${voiceClock(ms)})` : state === 'sending' ? 'Sending the spoken question' : 'Speak a question (up to 30 seconds)'}
      title={recording ? 'Stop and send' : 'Speak a question'}
      data-testid="mana-mic"
      data-state={state}
      className={`inline-flex min-h-control shrink-0 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${recording ? 'border-down bg-down/10 text-down' : 'border-line-strong bg-surface text-ink hover:bg-canvas'}`}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : recording ? <Square aria-hidden="true" className="size-4" /> : <Mic aria-hidden="true" className="size-4" />}
      {recording && <span className="text-xs tabular-nums">{voiceClock(ms)}</span>}
    </button>
  )
}
