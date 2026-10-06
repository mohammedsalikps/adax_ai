import { useEffect, useRef, useState } from 'react'
import { fmtOffset } from '../../lib/capture.ts'
import { useReducedMotion } from './DemoConsultation.tsx'
import { pushLevel, rmsLevel, WAVEFORM, waveformBars } from './live.ts'

/**
 * The microphone's live waveform (DESIGN §5.4): 32px bars on a canvas, the newest at the right, one every 80 ms, each the loudness of the real
 * signal the recorder's AnalyserNode gives (nothing drawn is invented: silence is a flat line). Held, in a quieter colour, while paused. With
 * reduced motion, a plain level bar instead. Decorative for assistive technology: the status line next to it says what is happening.
 */
export function LiveWaveform({ getAnalyser, recording, className = '' }: { getAnalyser: () => AnalyserNode | null; recording: boolean; className?: string }) {
  const reduced = useReducedMotion()
  if (reduced) return <LevelBar getAnalyser={getAnalyser} active={recording} className={className} />
  return <WaveCanvas getAnalyser={getAnalyser} recording={recording} className={className} />
}

function WaveCanvas({ getAnalyser, recording, className }: { getAnalyser: () => AnalyserNode | null; recording: boolean; className: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const history = useRef<number[]>([])
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let frame = 0
    let last = -Infinity
    let buf = new Float32Array(WAVEFORM.maxHistory)
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw)
      if (t - last < WAVEFORM.sampleMs) return
      last = t
      const a = recording ? getAnalyser() : null
      if (a) {
        if (buf.length !== a.fftSize) buf = new Float32Array(a.fftSize)
        a.getFloatTimeDomainData(buf)
        history.current = pushLevel(history.current, rmsLevel(buf))
      }
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight || WAVEFORM.height
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // The colour of the element (a design token through its text colour class), so the bars follow the theme.
      ctx.fillStyle = getComputedStyle(canvas).color
      for (const b of waveformBars(history.current, { width: w, height: h })) ctx.fillRect(b.x, b.y, b.w, b.h)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [getAnalyser, recording])
  return <canvas ref={ref} aria-hidden="true" data-testid="live-waveform" className={`block h-8 min-w-0 ${recording ? 'text-brand' : 'text-ink-muted/40'} ${className}`} />
}

/** The microphone's level as a plain bar (reduced motion, and the capture panel's recorder): the real signal's loudness, about every 150 ms. */
export function LevelBar({ getAnalyser, active, className = '' }: { getAnalyser: () => AnalyserNode | null; active: boolean; className?: string }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!active) return
    let buf = new Float32Array(WAVEFORM.maxHistory)
    const timer = setInterval(() => {
      const a = getAnalyser()
      if (!a) return setLevel(0)
      if (buf.length !== a.fftSize) buf = new Float32Array(a.fftSize)
      a.getFloatTimeDomainData(buf)
      setLevel(rmsLevel(buf))
    }, 150)
    return () => clearInterval(timer)
  }, [getAnalyser, active])
  return (
    <span aria-hidden="true" data-testid="live-level" className={`block h-1.5 w-24 overflow-hidden rounded-full bg-canvas ${className}`}>
      <span className="block h-full rounded-full bg-ok" style={{ width: `${Math.round((active ? level : 0) * 100)}%` }} />
    </span>
  )
}

/** The time recorded so far, as mm:ss, ticking twice a second on its own (the panel around it does not re-render for the clock). */
export function RecordingClock({ elapsedMs, running }: { elapsedMs: () => number; running: boolean }) {
  const [ms, setMs] = useState(() => elapsedMs())
  useEffect(() => {
    setMs(elapsedMs())
    if (!running) return
    const timer = setInterval(() => setMs(elapsedMs()), 500)
    return () => clearInterval(timer)
  }, [elapsedMs, running])
  return <span className="tabular-nums">{fmtOffset(ms)}</span>
}
