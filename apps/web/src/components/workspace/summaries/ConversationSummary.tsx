import type { CaptureStatus, Encounter, EncounterAi } from '@adaxai/contracts'
import { useQuery } from '@tanstack/react-query'
import { aiKey } from '../../../lib/ai.ts'
import { api } from '../../../lib/api.ts'
import { captureKey } from '../../../lib/capture.ts'
import type { InputModuleFacts } from '../../../lib/workflow.ts'
import { CLOSED_ONLY, OPEN_ONLY } from '../ModuleShell.tsx'
import { conversationAiCore, conversationCaptureCore, conversationState, conversationView, NOT_UPDATED, safely, type SummaryState } from './state.ts'

/*
 * Module 1, the conversation: what the transcription panel (CapturePanel and its recorder) already read, observed. Both queries are the
 * panel's own, with the same key and the same function, never enabled here: nothing is asked of the server from this file, and the recorder's
 * status is kept no longer than the panel keeps it (gcTime 0).
 */

const aiQuery = (encounterId: string) => ({ queryKey: aiKey(encounterId), queryFn: () => api<EncounterAi>(`/encounters/${encounterId}/ai`), enabled: false }) as const
const captureQuery = (encounterId: string) => ({ queryKey: captureKey(encounterId), queryFn: () => api<CaptureStatus>(`/encounters/${encounterId}/capture`), enabled: false, gcTime: 0 }) as const

/**
 * For the page: the conversation module's chip and what the workflow strip counts (transcripts and important points; null until read), and the
 * points the doctor confirmed (what an analysis reads of it). It re-renders only when these change, not on every poll of the recorder's status.
 */
export function useConversationModule(encounter: Pick<Encounter, 'id'>): { state: SummaryState; facts: InputModuleFacts['conversation']; confirmedPoints: number | null } {
  const ai = useQuery({ ...aiQuery(encounter.id), select: conversationAiCore })
  const capture = useQuery({ ...captureQuery(encounter.id), select: conversationCaptureCore })
  const a = ai.data
  return { state: conversationState(a, capture.data, { ai: ai.isError, capture: capture.isError }), facts: a ? { transcripts: a.transcripts, points: a.points } : null, confirmedPoints: a ? a.confirmed : null }
}

function useConversationView(encounterId: string) {
  const ai = useQuery(aiQuery(encounterId))
  const capture = useQuery(captureQuery(encounterId))
  const failed = { ai: ai.isError, capture: capture.isError }
  return safely(() => conversationView({ ai: ai.data, capture: capture.data, failed, readAt: Math.max(ai.dataUpdatedAt, capture.dataUpdatedAt) || null }), {
    state: NOT_UPDATED,
    facts: null,
    confirmedPoints: null,
    lines: ['The conversation could not be read just now.'],
    compact: ['The conversation could not be read just now.'],
    meta: null,
  })
}

/**
 * The summary of module 1. Closed, at most two short lines: while recording, that it is (the Stop button is in the full panel) and since when;
 * with a transcript, how much there is and the important points (found by fixed rules) waiting for review or confirmed; with nothing yet, why
 * recording cannot start when the chip does not say it already. Open, the same with the fuller wording.
 */
export function ConversationSummary({ encounter }: { encounter: Pick<Encounter, 'id'> }) {
  const v = useConversationView(encounter.id)
  const lines = (list: string[], className: string) => (
    <div className={`space-y-0.5 ${className}`}>
      {list.map((line, i) => (
        <p key={i} className={i ? 'text-ink-muted' : v.state.kind === 'recording' ? 'font-medium text-down' : ''}>
          {line}
        </p>
      ))}
    </div>
  )
  return (
    <div data-testid="summary-conversation" data-state={v.state.kind}>
      {lines(v.compact, CLOSED_ONLY)}
      {lines(v.lines, OPEN_ONLY)}
    </div>
  )
}

/** Where the conversation came from and when: the newest transcript's source and time, or the speech service and when it was checked. */
export function ConversationMeta({ encounter }: { encounter: Pick<Encounter, 'id'> }) {
  const v = useConversationView(encounter.id)
  return v.meta ? <span data-testid="summary-conversation-meta">{v.meta}</span> : null
}
