import { useQuery } from '@tanstack/react-query'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clockOf, type Envelope, envelopeOf } from './envelope.ts'

/*
 * The amplitude of a recording, drawn from the recording itself: the browser reads the stored file, decodes it (Web Audio) and draws how loud
 * it is over time. That is all: nothing here listens for, measures, classifies or flags a sound, and the picture is labelled so. It is read
 * only when it is on the screen (a module that is closed, or a list scrolled away, reads nothing), once per file (kept for the page's life:
 * each read of a file is audited by the server).
 */

/** Reads and decodes the file. An OfflineAudioContext needs no permission and plays nothing. */
async function decode(src: string, signal: AbortSignal): Promise<Envelope> {
  const res = await fetch(src, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(`The recording could not be read (${res.status}).`)
  const bytes = await res.arrayBuffer()
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
  if (!Ctx) throw new Error('This browser cannot decode audio.')
  const audio = await new Ctx(1, 1, 44_100).decodeAudioData(bytes)
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i))
  return envelopeOf(channels, audio.duration)
}

/** Becomes true the first time the element is on the screen (and stays true). Hidden elements (a closed module) are never on the screen. */
function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') return setSeen(true)
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

const colour = (name: string, fallback: string) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  } catch {
    return fallback
  }
}

/**
 * The amplitude of one recording over time (`src`: the stored file), with the time at its start and end (the length of the decoded audio),
 * captioned "Amplitude of the recording. Not an analysis." Drawn relative to the recording's loudest moment, which its spoken name says. When
 * `audio` is the recording's player, the part already played is drawn in the brand colour as it plays (from the player's own time updates;
 * nothing moves otherwise). `label` names the recording for a screen reader ("Stethoscope recording, Mitral area (apex), …").
 */
export function Waveform({ src, label, audio, simulated = false }: { src: string; label: string; audio?: RefObject<HTMLAudioElement | null>; simulated?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const seen = useSeen(box)
  const q = useQuery({ queryKey: ['waveform', src], queryFn: ({ signal }) => decode(src, signal), enabled: seen, staleTime: Infinity, gcTime: Infinity, retry: 1 })
  const env = q.data
  const [played, setPlayed] = useState(0)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const a = audio?.current
    if (!a) return
    const update = () => setPlayed(a.duration && Number.isFinite(a.duration) ? a.currentTime / a.duration : 0)
    a.addEventListener('timeupdate', update)
    a.addEventListener('seeked', update)
    a.addEventListener('ended', update)
    return () => {
      a.removeEventListener('timeupdate', update)
      a.removeEventListener('seeked', update)
      a.removeEventListener('ended', update)
    }
  }, [audio])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const apply = () => setWidth(el.clientWidth)
    apply()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  useLayoutEffect(() => {
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx || !env || !width) return
    const dpr = window.devicePixelRatio || 1
    const h = 40
    c.width = Math.round(width * dpr)
    c.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, h)
    const muted = colour('--color-ink-muted', '#475569')
    const line = colour('--color-line-strong', '#cbd5e1')
    const brand = colour('--color-brand', '#2563eb')
    const mid = h / 2
    ctx.fillStyle = line
    ctx.fillRect(0, mid - 0.5, width, 1)
    const scale = env.max > 0 ? (mid - 1) / env.max : 0
    const n = env.peak.length
    for (let x = 0; x < width; x++) {
      const b = Math.min(n - 1, Math.floor((x / width) * n))
      const p = env.peak[b]! * scale
      const r = env.rms[b]! * scale
      const done = x / width < played
      ctx.globalAlpha = 0.35
      ctx.fillStyle = done ? brand : muted
      ctx.fillRect(x, mid - p, 1, Math.max(1, 2 * p))
      ctx.globalAlpha = 1
      ctx.fillRect(x, mid - r, 1, Math.max(1, 2 * r))
    }
  }, [env, width, played])

  const what = `Amplitude of ${label}${env ? `, ${clockOf(env.duration)} long, drawn relative to its loudest moment (${Math.round(env.max * 100)}% of full scale)` : ''}. Not an analysis.`
  return (
    <figure className="min-w-0" data-testid="waveform" data-state={env ? 'drawn' : q.isError ? 'failed' : seen ? 'loading' : 'waiting'} data-simulated={simulated || undefined}>
      <div ref={box} className={`relative h-10 w-full overflow-hidden rounded-md border bg-canvas ${simulated ? 'border-dashed border-ink/40' : 'border-line'}`}>
        <canvas ref={canvas} role={env ? 'img' : undefined} aria-label={env ? what : undefined} aria-hidden={env ? undefined : true} className={`absolute inset-0 size-full ${env ? '' : 'invisible'}`} />
        {!env &&
          (q.isError ? (
            <p className="flex h-full items-center px-2 text-xs leading-tight text-ink-muted">Not drawn: this browser could not decode the file.</p>
          ) : (
            // A flat line until the file is read (it pulses while it is read; still where motion is reduced). Nothing is drawn that was not read.
            <span aria-hidden="true" className={`absolute inset-x-2 top-1/2 h-px bg-line-strong ${seen ? 'animate-pulse' : ''}`} />
          ))}
      </div>
      <figcaption className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2 text-[0.6875rem] leading-4 text-ink-muted">
        <span>Amplitude of the recording. Not an analysis.</span>
        {env && (
          <span className="tabular-nums" aria-hidden="true">
            0:00 – {clockOf(env.duration)}
          </span>
        )}
      </figcaption>
    </figure>
  )
}
