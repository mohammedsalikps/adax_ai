import type { CaptureStatus, EncounterAi } from '@adaxai/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AUTO_EXTRACT, extractionDelay, newerAi } from '../components/capture/live.ts'
import { api, ApiError, errorMessage } from './api.ts'
import { type AiResponse, aiKey, newIdempotencyKey, useAiMutation } from './ai.ts'

export const captureKey = (encounterId: string) => ['encounter', encounterId, 'capture'] as const

/**
 * Whether recording may start, and (while recording) whether it must stop: consent and the local speech service, polled. The answer holds
 * no patient content. Not kept in the cache once the page is gone.
 */
export function useCaptureStatus(encounterId: string, opts: { poll: boolean }) {
  return useQuery({
    queryKey: captureKey(encounterId),
    queryFn: () => api<CaptureStatus>(`/encounters/${encounterId}/capture`),
    staleTime: 3_000,
    refetchInterval: opts.poll ? 4_000 : 20_000,
    // While recording, consent and the consultation's state are watched even when the tab is in the background.
    refetchIntervalInBackground: opts.poll,
    refetchOnWindowFocus: true,
    gcTime: 0,
  })
}

export const useAssignSpeakers = (encounterId: string, transcriptId: string) =>
  useAiMutation<{ assignments: { segmentId: string; speaker: string }[] }>(encounterId, (body) => api(`/transcripts/${transcriptId}/speakers`, { method: 'POST', body }))

export const useExtractPoints = (encounterId: string) => useAiMutation<string>(encounterId, (transcriptId) => api(`/transcripts/${transcriptId}/extract`, { method: 'POST', body: { idempotencyKey: newIdempotencyKey() } }))

/**
 * Finds the important points again after each transcribed part (DESIGN §5.4 "Important points automatically"), from the part's own answer: no
 * poller. `schedule(transcriptId)` is called when a part has been transcribed; the fixed rules then run once the parts pause for a moment
 * (debounced, never more than one run at a time, never more often than every few seconds), and only while `enabled` (the extractor is the
 * fixed rules on this computer: nothing is sent anywhere). The answer replaces the panel's AI state unless a newer part was shown meanwhile.
 * A run never confirms anything: what it finds are drafts. `runNow` is the doctor's "Find important points".
 */
export function useAutoExtract(encounterId: string, enabled: boolean) {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const s = useRef({ timer: null as ReturnType<typeof setTimeout> | null, tid: null as string | null, dirty: false, inFlight: false, lastRunAt: null as number | null, mounted: true, enabled })
  s.current.enabled = enabled
  const fire = useRef<() => Promise<void>>(async () => undefined)
  const arm = useRef((delay?: number) => {
    const st = s.current
    if (st.timer) clearTimeout(st.timer)
    st.timer = setTimeout(() => void fire.current(), delay ?? extractionDelay(st.lastRunAt, Date.now()))
  })
  fire.current = async () => {
    const st = s.current
    st.timer = null
    if (st.inFlight) {
      st.dirty = true
      return
    }
    const tid = st.tid
    if (!tid || !st.mounted) return
    st.dirty = false
    st.inFlight = true
    setRunning(true)
    let retryIn: number | undefined
    try {
      const r = await api<AiResponse>(`/transcripts/${tid}/extract`, { method: 'POST', body: { idempotencyKey: newIdempotencyKey() } })
      if (r.consent) qc.setQueryData<AiResponse>(aiKey(encounterId), (shown) => newerAi(shown, r))
      if (st.mounted) setError(null)
    } catch (e) {
      // Busy (the per-person limit on costly steps): quietly tried again a little later. Anything else is said, and the next part tries again.
      if (e instanceof ApiError && e.status === 429) {
        st.dirty = true
        retryIn = AUTO_EXTRACT.busyRetryMs
      } else if (st.mounted) setError(errorMessage(e))
    } finally {
      st.inFlight = false
      st.lastRunAt = Date.now()
      if (st.mounted) {
        setRunning(false)
        if (st.dirty && st.enabled) arm.current(retryIn)
      }
    }
  }
  useEffect(() => {
    const st = s.current
    st.mounted = true
    return () => {
      st.mounted = false
      if (st.timer) clearTimeout(st.timer)
      st.timer = null
    }
  }, [])
  const schedule = useCallback((transcriptId: string) => {
    const st = s.current
    if (!st.enabled) return
    st.tid = transcriptId
    if (st.inFlight) st.dirty = true
    else arm.current()
  }, [])
  const runNow = useCallback((transcriptId: string) => {
    s.current.tid = transcriptId
    void fire.current()
  }, [])
  return { schedule, runNow, running, error }
}

export { fmtOffset, languageName } from './transcriptTime.ts'

/** What the clinician is told when a service's own reason holds nothing but a setup instruction. */
export const SPEECH_NOT_RUNNING = 'Speech-to-text is not running on this computer.'

/**
 * A service's reason in the clinician's words. The speech service's reasons can end with an instruction for whoever runs the computer ('Start
 * it with "npm run speech:dev"', 'Set SPEECH_PROVIDER=local'): such a sentence is left out, and what is left says what is wrong. When nothing is
 * left, `fallback`. Nothing is added or reworded.
 */
export function clinicianReason(reason: string | null | undefined, fallback = SPEECH_NOT_RUNNING): string {
  const sentences = (reason ?? '').match(/[^.!?]+[.!?]+["”')]*\s*|[^.!?]+$/g) ?? []
  const kept = sentences
    .filter((s) => !/\bnpm\b|\bnpx\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+=|`/.test(s))
    .join('')
    .trim()
  return kept || fallback
}

export type { AiResponse, EncounterAi }
export { aiKey }
