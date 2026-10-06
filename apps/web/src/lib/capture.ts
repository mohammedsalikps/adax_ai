import type { CaptureStatus, EncounterAi } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { api } from './api.ts'
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
