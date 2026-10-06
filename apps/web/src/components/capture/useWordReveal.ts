import type { Transcript } from '@adaxai/contracts'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { newLineIds, revealMs, revealText } from '../../lib/demoConsultation.ts'
import { useReducedMotion } from './DemoConsultation.tsx'

/**
 * A transcript as it is drawn. A line that arrives while the transcript is live (a recording, or the demo consultation) appears word by word,
 * in at most 600 ms (lines that arrived together, together): only the words that arrived, never others, and only on the screen (the transcript
 * is not changed). With reduced motion, and for the lines already there when the transcript is first shown, at once.
 */
export function useWordReveal(t: Transcript): Transcript {
  const reduced = useReducedMotion()
  const live = t.status === 'live'
  const known = useRef<{ tid: string; ids: Set<string> } | null>(null)
  const [starts, setStarts] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [now, setNow] = useState(0)
  // Before the browser paints the new line, so that it never shows whole and then starts again.
  useLayoutEffect(() => {
    const ids = t.segments.map((s) => s.id)
    const k = known.current
    if (!k || k.tid !== t.id) {
      known.current = { tid: t.id, ids: new Set(ids) }
      setStarts((m) => (m.size ? new Map() : m))
      return
    }
    const fresh = newLineIds(k.ids, ids)
    for (const x of fresh) k.ids.add(x)
    if (!fresh.length || !live || reduced) return
    const at = performance.now()
    setStarts((m) => new Map([...m, ...fresh.map((x) => [x, at] as const)]))
    setNow(at)
  }, [t.id, t.segments, live, reduced])
  // About 25 frames a second while words are appearing; nothing otherwise.
  useEffect(() => {
    if (!starts.size) return
    const timer = setInterval(() => setNow(performance.now()), 40)
    return () => clearInterval(timer)
  }, [starts])
  useEffect(() => {
    if (starts.size && [...starts].every(([x, at]) => now - at >= revealMs(t.segments.find((s) => s.id === x)?.text ?? ''))) setStarts(new Map())
  }, [now, starts, t.segments])
  return useMemo(() => {
    if (!starts.size || reduced) return t
    return {
      ...t,
      segments: t.segments.map((s) => {
        const at = starts.get(s.id)
        return at === undefined ? s : { ...s, text: revealText(s.text, now - at) }
      }),
    }
  }, [t, starts, now, reduced])
}
